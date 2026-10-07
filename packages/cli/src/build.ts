// TSX prompt compiler (SPEC «Шар 3», «Збірка через mod», «Імпорти», Р1/Р3/Р5).
//
//   .claude/prompt/*.prompt.tsx  ──esbuild (bundle, jsx automatic, text/json loaders)──▶ temp bundle
//   temp bundle ──node child, 10 s timeout──▶ JSON of the default export (via @context-gate/jsx/compile)
//   (`.yaml`/`.toml` imports parsed to data; TSX level 2 rewrites native expressions first, transform.ts)
//   ──validate (G1xx exprs, G153, G156, G160, G161, G162, G163, G170)──▶ .claude/prompt/.compiled/<id>.json
//                                                     + .claude/prompt/prompt.lock.json (committed)
//                                                     + .claude/skills/<name>/SKILL.md for `as="skill"`
//   prompt.packages (`@acme/prompts`) ──exported `as="skill"` prompts──▶ the same, with `source: npm:<pkg>@<v>`

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as esbuild from 'esbuild'
import { loadEsbuild } from './esbuild-load.ts'
import type { CompiledPrompt, Diagnostic, GateConfig, Node, Scope, SectionNode } from '../../core/src/types.ts'
import { parseExpr } from '../../core/src/expr.ts'
import { argumentHint } from '../../core/src/argparse.ts'
import { preserveJsxText } from './jsx-text.ts'
import { loadTypescript, transformLevel2, wantsLevel2 } from './transform.ts'
import { parseToml, parseYaml } from './dataformats.ts'
import { buildModel, isDtsSchema, readDts, resolveSchemaRef, splitSchemaRef, type CtxModel, type Shape } from '../../lsp/src/model.ts'
import { checkExpr as checkCtxExpr } from '../../lsp/src/exprcheck.ts'
import { writeText } from './util.ts'

export { isStaleByMtime, isStaleByMtimes } from './stale.ts'

export const COMPILER = 'context-gate@0.1.0'
export const MAX_COMPILED_BYTES = 2 * 1024 * 1024
const SENTINEL = '@@context-gate:compiled@@'
const DEFAULT_DIR = '.claude/prompt'

export type ValidateExpr = (src: string) => Diagnostic[]

export interface BuildOptions {
  /** Repo root (absolute or relative to cwd). */
  root: string
  /** Prompt dir relative to root. Default `.claude/prompt`. */
  dir?: string
  /** Prompt ids or entry paths (repo-relative or file names) to build; default all. */
  only?: string[]
  /** Expression validator; default `parseExpr` from core. */
  validateExpr?: ValidateExpr
  /** Child process timeout, default 10 s. */
  timeoutMs?: number
  /** Override location of `@context-gate/jsx` sources. */
  jsxSrc?: string
  /** Write .compiled / lock / SKILL.md (default true). */
  write?: boolean
  /** gate.json (raw JSON); default: read `<root>/.claude/gate.json`. Drives level 2, packages, skillBody and G170. */
  config?: BuildConfig
  /** Ctx-model check of expressions (G170); default from `config`. `false` disables. */
  checkCtx?: CtxCheck | false
  /** Overwrite a `.claude/skills/<name>/SKILL.md` that context-gate did not generate (default: refuse, G001). */
  force?: boolean
}

/** The parts of gate.json the compiler reads (raw JSON, so options newer than the schema still apply). */
export type BuildConfig = Partial<GateConfig> & {
  prompt?: GateConfig['prompt'] & {
    /** `level2`: native TS expressions in runtime props (Р1 level 2). */
    transform?: 'level1' | 'level2'
    /** Prompt library packages whose exported `as="skill"` prompts are built into `.claude/skills/`. */
    packages?: string[]
    /** SKILL.md body: `live` (one `!\`…\`` render line, default), `static` (pre-rendered with default args), `both`. */
    skillBody?: 'live' | 'static' | 'both'
  }
}

/** Checks one expression against the Ctx model with the locals bound at that point. */
export type CtxCheck = (src: string, locals: ReadonlySet<string>) => Diagnostic[]

export interface BuildResult {
  compiled: CompiledPrompt[]
  diagnostics: Diagnostic[]
  /** Repo-relative POSIX paths of written files. */
  written: string[]
  /** Repo-relative POSIX paths removed as orphans (`.compiled` and generated SKILL.md of removed prompts). */
  removed?: string[]
}

export interface PromptLock {
  compiler: string
  prompts: Record<string, { entry?: string; sourceHash: string; sources: { path: string; hash: string }[]; package?: string }>
  /** `prompt.packages` as built: by the configured name, the resolved version and the hash of its package.json. */
  packages?: Record<string, { version?: string; hash: string }>
}

const posix = (p: string) => p.split(sep).join('/')
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

function diag(code: Diagnostic['code'], severity: Diagnostic['severity'], message: string, extra: Partial<Diagnostic> = {}): Diagnostic {
  return { code, severity, message, ...extra }
}

/** Locates `packages/jsx/src` both from sources (`packages/cli/src`) and from the bundle (`dist/cli.js`). */
export function defaultJsxSrc(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const c of [join(here, '../../jsx/src'), join(here, '../packages/jsx/src')]) if (existsSync(join(c, 'index.ts'))) return resolve(c)
  return resolve(here, '../../jsx/src')
}

/** Top-level `*.prompt.tsx` files of the prompt dir (files in `shared/` etc. are imported components). */
export function findEntries(root: string, dir = DEFAULT_DIR): string[] {
  const abs = resolve(root, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.prompt.tsx'))
    .map((d) => join(abs, d.name))
    .sort()
}

export function promptIdOf(file: string): string {
  return basename(file).replace(/\.prompt\.tsx$/, '')
}

// Markdown frontmatter (text loader): shared with the mod via core providers.ts.
import { splitFrontmatter } from '../../core/src/providers.ts'
export { splitFrontmatter }

// ───────────────────────── esbuild plugin ─────────────────────────

interface PluginOptions { transform?: unknown }

function promptPlugin(jsxSrc: string, notes: Diagnostic[], root: string, po: PluginOptions = {}): esbuild.Plugin {
  const jsxMap: Record<string, string> = {
    '@context-gate/jsx': join(jsxSrc, 'index.ts'),
    '@context-gate/jsx/jsx-runtime': join(jsxSrc, 'jsx-runtime.ts'),
    '@context-gate/jsx/jsx-dev-runtime': join(jsxSrc, 'jsx-runtime.ts'),
    '@context-gate/jsx/compile': join(jsxSrc, 'compile.ts'),
  }
  const relOf = (p: string) => posix(relative(root, p))
  return {
    name: 'context-gate',
    setup(b) {
      b.onResolve({ filter: /^@context-gate\/jsx(\/.*)?$/ }, (a) => {
        const p = jsxMap[a.path]
        return p ? { path: p } : { errors: [{ text: `Невідомий модуль ${a.path}` }] }
      })
      b.onLoad({ filter: /\.(md|mdc|txt)$/ }, (a) => {
        const { meta, body } = splitFrontmatter(readFileSync(a.path, 'utf8'))
        return { contents: `export const meta = ${JSON.stringify(meta)};\nexport default ${JSON.stringify(body)};\n`, loader: 'js' }
      })
      // SPEC «Імпорти»: `.yaml` / `.toml` are parsed at build time into data (dataformats.ts).
      b.onLoad({ filter: /\.(ya?ml|toml)$/ }, (a) => {
        const r = (a.path.endsWith('.toml') ? parseToml : parseYaml)(readFileSync(a.path, 'utf8'))
        if (!r.ok) return { errors: [{ text: `Імпорт ${basename(a.path)}: ${r.error}`, location: { file: relOf(a.path), line: r.line, column: 0, lineText: '' } }] }
        return { contents: JSON.stringify(r.value), loader: 'json' }
      })
      b.onLoad({ filter: /\.[jt]sx$/ }, (a) => {
        // Package prompts (`node_modules/@acme/prompts/*.prompt.tsx`) keep Markdown text rules too.
        if (a.path.startsWith(jsxSrc) || (a.path.includes(`${sep}node_modules${sep}`) && !a.path.endsWith('.prompt.tsx'))) return undefined
        let src = readFileSync(a.path, 'utf8')
        const rel = relOf(a.path)
        if (a.path.endsWith('.tsx') && wantsLevel2(src, a.path.includes(`${sep}node_modules${sep}`) ? undefined : po.transform)) {
          const ts = loadTypescript(root)
          if (!ts.mod) return { errors: [{ text: ts.error!, location: { file: rel, line: 1, column: 0, lineText: '' } }] }
          const t = transformLevel2(ts.mod, src, { path: rel })
          notes.push(...t.diagnostics)
          src = t.code
        }
        const r = preserveJsxText(src)
        if (!r.ok) notes.push(diag('G001', 'warning', `Текст JSX нормалізовано за правилами JSX (переноси рядків втрачено): ${r.error}.`, { path: rel, hint: 'спрости синтаксис файлу або загорни текст у {`…`}' }))
        return { contents: r.code, loader: a.path.endsWith('.tsx') ? 'tsx' : 'jsx' }
      })
    },
  }
}

// ───────────────────────── Child process ─────────────────────────

function runChild(bundle: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; error?: string }> {
  return new Promise((done) => {
    execFile(process.execPath, ['--enable-source-maps', bundle], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (!err) { done({ stdout, stderr }); return }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
      const timedOut = e.killed || e.signal === 'SIGKILL'
      done({ stdout, stderr, error: timedOut ? `перевищено таймаут збірки ${Math.round(timeoutMs / 1000)} с` : `процес завершився з помилкою` })
    })
  })
}

function firstLines(s: string, n = 6): string {
  return s.split('\n').filter((l) => l.trim()).slice(0, n).join('\n')
}

// ───────────────────────── Validation ─────────────────────────

export interface ValidateOptions { validateExpr?: ValidateExpr; checkCtx?: CtxCheck }

const defaultValidateExpr: ValidateExpr = (src) => parseExpr(src).diagnostics

const MAX_IF_DEPTH = 3
const MAX_LOOP_DEPTH = 2

/** Expression strings of a node (its own, not its children's). */
function nodeExprs(n: Node): string[] {
  switch (n.t) {
    case 'expr': return [n.expr]
    case 'if': return [n.test]
    case 'each': return [n.of]
    case 'let': case 'set': return [n.value]
    case 'repeat': return [n.n]
    case 'call': return [...n.args, ...Object.values(n.kwargs ?? {})]
    case 'include': return Object.values(n.args ?? {})
    case 'table': return [n.rows, ...n.cells]
    case 'debug': return [...n.exprs, ...(n.message ? placeholders(n.message) : [])]
    case 'assert': return [n.test]
    case 'fence': return n.title ? placeholders(n.title) : []
    case 'el': return Object.values(n.attrs ?? {}).flatMap(placeholders)
    default: return []
  }
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{\s*([\s\S]*?)\s*\}\}/g)].map((m) => m[1]!)
}

const LEAKED = /^(NaN|undefined|Infinity)$|\[object |^function\b|=>/

function checkExpr(src: string, where: Partial<Diagnostic>, validate: ValidateExpr, out: Diagnostic[]): boolean {
  if (LEAKED.test(src.trim())) {
    out.push(diag('G160', 'error', `Вираз «${src}» — значення JS, обчислене на збірці, а не рядковий вираз.`, { ...where, hint: 'винести у module-провайдер або pipe-фільтр' }))
    return false
  }
  const ds = validate(src)
  for (const d of ds) out.push({ ...d, ...where, message: `${d.message} (вираз «${src}»)` })
  return !ds.some((d) => d.severity === 'error')
}

/** Names a node binds for the rest of its section (`as=`, `let`, `use`, loop variables). */
function boundBy(n: Node): string[] {
  switch (n.t) {
    case 'let': case 'set': return [n.name]
    case 'run': return [n.as ?? 'run']
    case 'call': return [n.as]
    case 'use': return [n.name]
    case 'include': return n.as ? [n.as] : []
    default: return []
  }
}

/**
 * Walks one section body: G1xx/G160 per expression, G153 (`let` redefined by a later `let`/`set`), G156
 * (`if` deeper than 3, `each`/`repeat` deeper than 2), G163, and the Ctx check (G170) with the locals bound
 * so far. Same limits as the Markdown form (mddsl.ts).
 */
function validateBody(nodes: Node[], scope: Scope | undefined, sectionId: string, where: Partial<Diagnostic>, o: Required<Pick<ValidateOptions, 'validateExpr'>> & ValidateOptions, out: Diagnostic[], initial: string[] = []): void {
  const lets = new Set<string>()
  const locals = new Set<string>(initial)
  const reported = new Set<string>()
  const once = (d: Diagnostic) => { const k = `${d.code}:${d.message}`; if (!reported.has(k)) { reported.add(k); out.push(d) } }
  const exprs = (n: Node) => {
    for (const e of nodeExprs(n)) {
      const ok = checkExpr(e, where, o.validateExpr, out)
      if (ok && o.checkCtx) for (const d of o.checkCtx(e, locals)) once({ ...d, ...where })
    }
  }
  const visit = (list: Node[], ifDepth: number, loopDepth: number): void => {
    for (const n of list) {
      exprs(n)
      if (n.t === 'let' || n.t === 'set') {
        if (lets.has(n.name)) once(diag('G153', 'error', `«${n.name}» оголошено через <Let> — його не можна перевизначати (<${n.t === 'let' ? 'Let' : 'Set'} name="${n.name}">).`, { ...where, hint: '<Let> з новим іменем або <Set> для змінної' }))
        if (n.t === 'let') lets.add(n.name)
      }
      if (n.t === 'run' && scope === 'static' && !n.cache) {
        out.push(diag('G163', 'error', `<Run lang="${n.lang}"> без cache у static-секції "${sectionId}": static рендериться один раз і має бути стабільною.`, { ...where, hint: 'додай cache="1h" або перенеси в scope="volatile"' }))
      }
      for (const b of boundBy(n)) locals.add(b)
      if (n.t === 'if') {
        if (ifDepth + 1 > MAX_IF_DEPTH) once(diag('G156', 'error', `Вкладення <If> глибше за ${MAX_IF_DEPTH} у секції "${sectionId}".`, { ...where, hint: 'розбий секцію' }))
        visit(n.then, ifDepth + 1, loopDepth)
        if (n.else) visit(n.else, ifDepth + 1, loopDepth)
        continue
      }
      if (n.t === 'each' || n.t === 'repeat') {
        if (loopDepth + 1 > MAX_LOOP_DEPTH) once(diag('G156', 'error', `Вкладення циклів (<Each>/<Repeat>) глибше за ${MAX_LOOP_DEPTH} у секції "${sectionId}".`, { ...where, hint: 'розбий секцію' }))
        if (n.t === 'each') { locals.add(n.as); if (n.index) locals.add(n.index) } else locals.add('i')
        visit(n.children, ifDepth, loopDepth + 1)
        continue
      }
      if (n.t === 'table') locals.add('row')
      if ('children' in n && Array.isArray(n.children)) visit(n.children, ifDepth, loopDepth)
    }
  }
  visit(nodes, 0, 0)
}

/**
 * Post-build checks over a compiled prompt: expression syntax (G1xx via `validateExpr`), leaked
 * build-time values (G160), duplicate section ids across imports (G161), `Run` without `cache`
 * in a `static` section (G163), language limits (G153, G156) and, with `checkCtx`, provider fields
 * without a schema (G170). Size (G162) is checked by the writer.
 */
export function validatePrompt(cp: Pick<CompiledPrompt, 'sections' | 'skill' | 'uses'>, opts: ValidateOptions = {}): Diagnostic[] {
  const o = { ...opts, validateExpr: opts.validateExpr ?? defaultValidateExpr }
  const out: Diagnostic[] = []
  const seen = new Map<string, SectionNode>()
  const uses = Object.keys(cp.uses ?? {})
  for (const s of cp.sections) {
    const where: Partial<Diagnostic> = s.source ? { path: s.source.path, ...(s.source.line ? { line: s.source.line } : {}) } : {}
    const prev = seen.get(s.id)
    if (prev) {
      const a = prev.source?.path ?? '?'
      const b = s.source?.path ?? '?'
      out.push(diag('G161', 'error', `Секцію "${s.id}" оголошено двічі: ${a}${prev.source?.line ? `:${prev.source.line}` : ''} і ${b}${s.source?.line ? `:${s.source.line}` : ''}.`, { ...where, hint: 'перейменуй одну з секцій' }))
    } else seen.set(s.id, s)
    if (s.when !== undefined) {
      const ok = checkExpr(s.when, where, o.validateExpr, out)
      if (ok && o.checkCtx) out.push(...o.checkCtx(s.when, new Set(uses)).map((d) => ({ ...d, ...where })))
    }
    validateBody(s.children, s.scope, s.id, where, o, out, uses)
  }
  if (cp.skill) validateBody(cp.skill.body, undefined, cp.skill.name, {}, o, out, uses)
  return out
}

/**
 * The Ctx-model check used at build (Р4): the LSP model from gate.json (providers, schemas — inline or as
 * `.schema.json` / `.d.ts` files), reporting only G170 (field access on a provider without a schema).
 */
export function ctxCheckFor(root: string, config: BuildConfig | undefined): CtxCheck | undefined {
  if (!config?.providers || !Object.keys(config.providers).length) return undefined
  const model: CtxModel = buildModel({ config, readFile: (p) => { try { return readFileSync(resolve(root, p), 'utf8') } catch { return undefined } } })
  if (!Object.values(model.roots).some((r) => r.k === 'unknown')) return undefined
  const any: Shape = { k: 'any' }
  return (src, locals) => {
    const bound = new Map<string, Shape>()
    for (const l of locals) bound.set(l, any)
    return checkCtxExpr(src, model, bound)
      .filter((d) => d.code === 'G170')
      .map((d) => ({ code: d.code, severity: d.severity, message: `${d.message} (вираз «${src}»)`, ...(d.hint ? { hint: d.hint } : {}) }))
  }
}

// ───────────────────────── SKILL.md ─────────────────────────

const yamlStr = (s: string) => JSON.stringify(s)

export interface SkillMdOptions {
  /** `live` (default): one `!\`…\`` render line; `static`: the pre-rendered body only; `both`: live line + static fallback. */
  body?: 'live' | 'static' | 'both'
  /** Pre-rendered body with default args (required for `static` / `both`). */
  staticText?: string
  /** Default args the static body was rendered with. */
  staticArgs?: Record<string, unknown>
  /** Provenance of a skill built from a prompt package: `npm:@acme/prompts@1.2.0`. */
  source?: string
}

export const STATIC_MARK = 'context-gate-body: static'

/** Frontmatter line that marks a SKILL.md as generated by `build`: only such files are overwritten or pruned. */
export const GENERATED_SKILL_MARK = 'generated-by: context-gate'

/**
 * The shell command of the live SKILL.md line. `$ARGUMENTS` is substituted as raw text before the shell runs,
 * so it sits in single quotes: `$(…)`, backticks and `$VAR` in arguments without a `'` are never expanded. Known
 * residual (M29, open): a `'` in the arguments ends the quote, and whatever follows it is shell code
 * (`x' $(cmd) 'y` runs `cmd`); a model-invoked skill gets its arguments from the model, so this is a prompt-injection
 * path wherever the line itself runs (without the mod, which replaces the body in `skill.prompt`). Closing it needs
 * arguments that never pass through shell text (a quoted heredoc needs a multi-line `!` the engine is not known to
 * support). The CLI is the plugin's bundle when `CLAUDE_PLUGIN_ROOT` is
 * set, else the repo's installed `context-gate` (`npx --no-install`: never downloads), so a teammate or CI
 * without the plugin still renders the skill.
 */
export function skillCommand(name: string): string {
  return `if [ -n "\${CLAUDE_PLUGIN_ROOT:-}" ]; then set -- node "\$CLAUDE_PLUGIN_ROOT/dist/cli.js"; else set -- npx --no-install context-gate; fi; "\$@" run ${name} --args '$ARGUMENTS' --ctx-from live`
}

/** A SKILL.md that context-gate generated (frontmatter `generated-by: context-gate`). */
export function isGeneratedSkillMd(text: string): boolean {
  const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1
  return end > 0 && text.slice(0, end).split('\n').some((l) => l.trim() === GENERATED_SKILL_MARK)
}

/**
 * `.claude/skills/<name>/SKILL.md` for a `<Prompt as="skill">`. Default: one live-render command line (SPEC
 * «Що генерує збірка»). With `prompt.skillBody: static | both` (Р6 fallback for harnesses without `!\`…\``):
 * the body pre-rendered with default args, marked `static` in the frontmatter and in the text.
 */
export function renderSkillMd(cp: CompiledPrompt, o: SkillMdOptions = {}): string {
  const skill = cp.skill!
  const body = o.staticText === undefined ? 'live' : o.body ?? 'live'
  const lines = ['---', `name: ${skill.name}`, `description: ${yamlStr(skill.description)}`]
  const hint = argumentHint(skill.args)
  if (hint) lines.push(`argument-hint: ${yamlStr(hint)}`)
  if (skill.invoke.model === false) lines.push('disable-model-invocation: true')
  lines.push(GENERATED_SKILL_MARK, `source-hash: ${cp.sourceHash.slice(0, 16)}`)
  if (o.source) lines.push(`source: ${yamlStr(o.source)}`)
  if (body !== 'live') lines.push(body === 'static' ? STATIC_MARK : 'context-gate-body: live+static')
  lines.push('---')
  const live = '!`' + skillCommand(skill.name) + '`'
  const argsText = Object.entries(o.staticArgs ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ') || 'без аргументів'
  const staticNote = `<!-- context-gate: static — тіло попередньо відрендерено на збірці з дефолтними аргументами (${argsText}); аргументи виклику ($ARGUMENTS) і живий контекст сесії тут не застосовано. Актуальний рендер: npx context-gate run ${skill.name} --args "<аргументи>". Файл згенеровано, не редагуй вручну. -->`
  if (body === 'static') {
    lines.push(staticNote, '', o.staticText!.trim())
    return lines.join('\n') + '\n'
  }
  lines.push(live)
  lines.push('')
  if (body === 'both') {
    lines.push(`<!-- context-gate: якщо рядок вище не виконався (harness без підтримки !\`…\`), нижче — статичний варіант. -->`, staticNote, '', o.staticText!.trim())
    return lines.join('\n') + '\n'
  }
  lines.push(`<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/${cp.id}.json. Якщо рядок вище не виконався (harness без підтримки !\`…\`), виконай: npx context-gate run ${skill.name} --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->`)
  return lines.join('\n') + '\n'
}

/** Default args of a skill for the static body: `default`, `false` for flags, else null. */
export function defaultArgs(args: Record<string, { type: string; default?: unknown }>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, a] of Object.entries(args)) out[k] = a.default !== undefined ? a.default : a.type === 'flag' ? false : a.type === 'list' || a.type === 'rest' ? [] : null
  return out
}

// ───────────────────────── Lock file ─────────────────────────

export function lockPath(root: string, dir = DEFAULT_DIR): string {
  return join(resolve(root, dir), 'prompt.lock.json')
}

export function readLock(root: string, dir = DEFAULT_DIR): PromptLock | undefined {
  try { return JSON.parse(readFileSync(lockPath(root, dir), 'utf8')) as PromptLock } catch { return undefined }
}

export function computeSourceHash(sources: { path: string; hash: string }[], compiler = COMPILER): string {
  return sha256([compiler, ...sources.map((s) => `${s.path}:${s.hash}`)].join('\n'))
}

// ───────────────────────── Build ─────────────────────────

interface EntryBuild { entry: string; rel: string; compiled?: CompiledPrompt; diagnostics: Diagnostic[]; package?: string }

type Part = Pick<CompiledPrompt, 'sections' | 'skill' | 'uses' | 'diagnostics'> & { id?: string }

interface EntryJob {
  /** Absolute entry file (the prompt, or the package module). */
  entry: string
  /** `default`: the default export is one `<Prompt>`; `skills`: every exported `<Prompt as="skill">`. */
  kind: 'default' | 'skills'
  /** Package name@version for package skills. */
  package?: string
}

interface EntryEnv { root: string; jsxSrc: string; timeoutMs: number; validate: ValidateExpr; checkCtx?: CtxCheck; transform?: unknown }

function wrapperFor(job: EntryJob, rel: string, root: string): string {
  const opts = `{ root: ${JSON.stringify(posix(root))}, file: ${JSON.stringify(rel)} }`
  if (job.kind === 'default') {
    return [
      `import def from ${JSON.stringify(job.entry)}`,
      `import { compilePrompt } from '@context-gate/jsx/compile'`,
      `const r = compilePrompt(def, ${opts})`,
      `process.stdout.write('\\n' + ${JSON.stringify(SENTINEL)} + JSON.stringify(r) + '\\n')`,
    ].join('\n')
  }
  return [
    `import * as m from ${JSON.stringify(job.entry)}`,
    `import { compilePrompt } from '@context-gate/jsx/compile'`,
    `const isSkill = (v) => v && typeof v === 'object' && v.$cg === 'prompt' && v.skill`,
    `const vals = [...Object.values(m), ...(m.default && typeof m.default === 'object' && !m.default.$cg ? Object.values(m.default) : [])]`,
    `const r = [...new Set(vals.filter(isSkill))].map((v) => compilePrompt(v, ${opts}))`,
    `process.stdout.write('\\n' + ${JSON.stringify(SENTINEL)} + JSON.stringify({ multi: r }) + '\\n')`,
  ].join('\n')
}

async function buildEntry(env: EntryEnv, job: EntryJob): Promise<EntryBuild[]> {
  const { root, jsxSrc, timeoutMs, validate } = env
  const { entry } = job
  const rel = posix(relative(root, entry))
  const notes: Diagnostic[] = []
  const tmp = mkdtempSync(join(tmpdir(), 'context-gate-build-'))
  const outfile = join(tmp, 'bundle.mjs')
  const fail = (diagnostics: Diagnostic[]): EntryBuild[] => [{ entry, rel, diagnostics, ...(job.package ? { package: job.package } : {}) }]
  try {
    let result: esbuild.BuildResult<{ write: false; metafile: true }>
    try {
      result = await (await loadEsbuild(root)).build({
        stdin: { contents: wrapperFor(job, rel, root), resolveDir: dirname(entry), sourcefile: '<context-gate-entry>', loader: 'ts' },
        absWorkingDir: root,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        jsx: 'automatic',
        jsxImportSource: '@context-gate/jsx',
        loader: { '.json': 'json' },
        plugins: [promptPlugin(jsxSrc, notes, root, { transform: env.transform })],
        metafile: true,
        sourcemap: 'inline',
        sourcesContent: false,
        write: false,
        outfile,
        logLevel: 'silent',
      })
    } catch (err) {
      const errors = (err as { errors?: esbuild.Message[] }).errors ?? []
      const diags = errors.length
        ? errors.map((m) => diag('G164', 'error', `Збірка: ${m.text}`, m.location ? { path: m.location.file, line: m.location.line } : { path: rel }))
        : [diag('G164', 'error', `Збірка: ${(err as Error).message}`, { path: rel })]
      return fail([...notes, ...diags])
    }
    writeFileSync(outfile, result.outputFiles[0]!.contents)

    const sources = Object.keys(result.metafile.inputs)
      .filter((p) => !p.startsWith('..') && !p.includes(':') && !p.startsWith('/') && !p.endsWith('<context-gate-entry>') && existsSync(join(root, p)))
      .map((p) => ({ path: posix(p), hash: sha256(readFileSync(join(root, p))) }))
      .sort((a, b) => (a.path === rel ? -1 : b.path === rel ? 1 : a.path.localeCompare(b.path)))

    const child = await runChild(outfile, root, timeoutMs)
    const at = child.stdout.lastIndexOf(SENTINEL)
    if (child.error || at < 0) {
      const esc = (x: string) => new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      const detail = firstLines(child.stderr.replace(esc(tmp), '<build>').replace(esc(posix(root) + '/'), '')) || 'немає виводу'
      return fail([...notes, diag('G164', 'error', `Виконання ${rel}: ${child.error ?? 'немає результату'}.\n${detail}`, { path: rel, hint: 'збірка виконує модуль у Node; перевір імпорти й код верхнього рівня' })])
    }
    // Only the line right after the sentinel is the result: a late console.log or an exit handler may print more.
    const line = child.stdout.slice(at + SENTINEL.length).split('\n')[0]!.trim()
    let raw: Part | { multi: Part[] }
    try { raw = JSON.parse(line) as Part | { multi: Part[] } } catch (e) {
      return fail([...notes, diag('G164', 'error', `Виконання ${rel}: результат збірки не розібрано (${(e as Error).message}).`, { path: rel, hint: 'модуль пише в stdout після результату? прибери console.log верхнього рівня' })])
    }
    const parts: Part[] = 'multi' in raw ? raw.multi : [raw]
    if ('multi' in raw && !parts.length) return fail([...notes, diag('G001', 'warning', `Пакет ${job.package ?? rel} не експортує жодного <Prompt as="skill">.`, { path: rel })])
    return parts.map((part, k): EntryBuild => {
      const id = part.skill?.name ?? part.id ?? promptIdOf(entry)
      const compiled: CompiledPrompt = {
        version: 1,
        compiler: COMPILER,
        id,
        sourceHash: computeSourceHash(sources),
        sources,
        sections: part.sections,
        ...(part.skill ? { skill: part.skill } : {}),
        ...(part.uses ? { uses: part.uses } : {}),
        diagnostics: [],
      }
      const diagnostics = [...(k === 0 ? notes : []), ...part.diagnostics, ...validatePrompt(compiled, { validateExpr: validate, ...(env.checkCtx ? { checkCtx: env.checkCtx } : {}) })]
      compiled.diagnostics = diagnostics
      const size = Buffer.byteLength(JSON.stringify(compiled, null, 2))
      if (size > MAX_COMPILED_BYTES) {
        const d = diag('G162', 'error', `.compiled/${id}.json має ${(size / 1024 / 1024).toFixed(1)} МБ (ліміт 2 МБ).`, { path: rel, hint: 'винеси дані в <Include mode="lazy"> або провайдер' })
        diagnostics.push(d)
      }
      return { entry, rel, compiled, diagnostics, ...(job.package ? { package: job.package } : {}) }
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function matchesOnly(only: string[] | undefined, root: string, entry: string): boolean {
  if (!only?.length) return true
  const rel = posix(relative(root, entry))
  return only.some((o) => o === promptIdOf(entry) || o === rel || o === basename(entry) || resolve(root, o) === entry)
}

/** Atomic (tmp + rename): a reader of `.compiled` never sees a half-written prompt (R9). */
function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2) + '\n')
}

/** Raw `.claude/gate.json` (undefined when missing or not JSON). */
export function readBuildConfig(root: string): BuildConfig | undefined {
  try { return JSON.parse(readFileSync(join(resolve(root), '.claude', 'gate.json'), 'utf8').replace(/^\uFEFF/, '')) as BuildConfig } catch { return undefined }
}

// ───────────────────────── Prompt packages (SPEC «Спільні бібліотеки промптів») ─────────────────────────

export interface PromptPackage {
  /** `name@version` label (provenance in SKILL.md). */
  name: string
  /** The name as configured in `prompt.packages` (the lock key). */
  spec: string
  version?: string
  /** sha256 of the resolved package.json: a new version or a changed manifest makes its skills stale. */
  hash: string
  dir: string
  jobs: EntryJob[]
}

/**
 * Resolves `prompt.packages` entries: npm names (looked up in `node_modules` from the root upwards) or
 * repo-relative paths. A package lists its skill files in `package.json` `"context-gate": { "skills": [...] }`
 * (each default-exports one `<Prompt as="skill">`); otherwise every `<Prompt as="skill">` exported by its
 * entry module (`exports["."]`, `module`, `main`, `index.ts(x)`) is built.
 */
export function resolvePromptPackages(root: string, names: readonly string[]): { packages: PromptPackage[]; diagnostics: Diagnostic[] } {
  const packages: PromptPackage[] = []
  const diagnostics: Diagnostic[] = []
  for (const name of names) {
    let dir: string | undefined
    if (name.startsWith('.') || name.startsWith('/')) dir = resolve(root, name)
    else {
      for (let d = resolve(root); ; d = dirname(d)) {
        const c = join(d, 'node_modules', ...name.split('/'))
        if (existsSync(join(c, 'package.json'))) { dir = c; break }
        if (dirname(d) === d) break
      }
    }
    let pkg: Record<string, unknown> | undefined
    let manifest = ''
    try { manifest = dir ? readFileSync(join(dir, 'package.json'), 'utf8') : ''; pkg = dir ? JSON.parse(manifest) as Record<string, unknown> : undefined } catch { pkg = undefined }
    if (!dir || !pkg) { diagnostics.push(diag('G164', 'error', `Пакет промптів «${name}» не знайдено (prompt.packages).`, { path: '.claude/gate.json', hint: `npm i -D ${name}` })); continue }
    const label = `${typeof pkg.name === 'string' ? pkg.name : name}${typeof pkg.version === 'string' ? `@${pkg.version}` : ''}`
    const cg = (pkg['context-gate'] ?? pkg.contextGate) as { skills?: unknown } | undefined
    const jobs: EntryJob[] = []
    if (cg && Array.isArray(cg.skills)) {
      for (const f of cg.skills) {
        const abs = resolve(dir, String(f))
        if (existsSync(abs)) jobs.push({ entry: abs, kind: 'default', package: label })
        else diagnostics.push(diag('G164', 'error', `Пакет ${label}: файл skill «${String(f)}» не знайдено.`, { path: '.claude/gate.json' }))
      }
    } else {
      const exp = pkg.exports
      const dot = typeof exp === 'string' ? exp : exp && typeof exp === 'object' ? (exp as Record<string, unknown>)['.'] : undefined
      const dotPath = typeof dot === 'string' ? dot : dot && typeof dot === 'object' ? ((dot as Record<string, unknown>).import ?? (dot as Record<string, unknown>).default) : undefined
      const cands = [dotPath, pkg.module, pkg.main, 'index.tsx', 'index.ts', 'index.js'].filter((x): x is string => typeof x === 'string')
      const entry = cands.map((c) => resolve(dir!, c)).find((c) => existsSync(c))
      if (entry) jobs.push({ entry, kind: 'skills', package: label })
      else diagnostics.push(diag('G164', 'error', `Пакет ${label}: немає вхідного модуля (exports, module, main або context-gate.skills).`, { path: '.claude/gate.json' }))
    }
    packages.push({ name: label, spec: name, ...(typeof pkg.version === 'string' ? { version: pkg.version } : {}), hash: sha256(manifest), dir, jobs })
  }
  return { packages, diagnostics }
}

// ───────────────────────── Static skill bodies (Р6 fallback) ─────────────────────────

/** Renders a skill body with default args and the context of the repo (scripts from cache only). */
export async function renderStaticSkill(root: string, cp: CompiledPrompt): Promise<{ text: string; args: Record<string, unknown> } | undefined> {
  try {
    const { buildContext } = await import('./context.ts')
    const { renderPrompt } = await import('../../core/src/render.ts')
    const args = defaultArgs(cp.skill!.args)
    const ctx = await buildContext({ root, dryScripts: true, args: args as Record<string, never> })
    ctx.scope.args = args as never
    const cfg = ctx.repo.config
    const r = await renderPrompt([...ctx.prompts.system, cp], ctx.scope, ctx.host, { tier: ctx.tier, only: cp.skill!.name, ...(cfg.prompt?.runCacheDefault ? { runCacheDefault: cfg.prompt.runCacheDefault } : {}) } as never)
    return { text: r.text, args }
  } catch {
    return undefined
  }
}

/**
 * Builds `*.prompt.tsx` entry points of `<root>/<dir>` and the skills of `prompt.packages`. Prompts with
 * error diagnostics are not written (the previous `.compiled` stays, SPEC «Помилки збірки») but are returned
 * with them.
 */
export async function buildPrompts(opts: BuildOptions): Promise<BuildResult> {
  const root = resolve(opts.root)
  const dir = opts.dir ?? DEFAULT_DIR
  const jsxSrc = opts.jsxSrc ? resolve(opts.jsxSrc) : defaultJsxSrc()
  const write = opts.write ?? true
  const validate = opts.validateExpr ?? defaultValidateExpr
  const config = opts.config ?? readBuildConfig(root)
  const checkCtx = opts.checkCtx === false ? undefined : opts.checkCtx ?? ctxCheckFor(root, config)
  const env: EntryEnv = { root, jsxSrc, timeoutMs: opts.timeoutMs ?? 10_000, validate, ...(checkCtx ? { checkCtx } : {}), transform: config?.prompt?.transform }
  const entries = findEntries(root, dir).filter((e) => matchesOnly(opts.only, root, e))
  const jobs: EntryJob[] = entries.map((entry) => ({ entry, kind: 'default' }))
  const diagnostics: Diagnostic[] = []
  const pkgNames = Array.isArray(config?.prompt?.packages) ? config!.prompt!.packages! : []
  // `only` may name packages as `npm:<name>` (what `checkStale` reports); without `only` every package builds.
  const onlyPkgs = opts.only?.filter((o) => o.startsWith('npm:')).map((o) => o.slice(4))
  const wantPkgs = !opts.only?.length ? pkgNames : pkgNames.filter((n) => onlyPkgs!.includes(n))
  const builtPkgs: PromptPackage[] = []
  if (wantPkgs.length) {
    const pk = resolvePromptPackages(root, wantPkgs)
    diagnostics.push(...pk.diagnostics)
    for (const p of pk.packages) { jobs.push(...p.jobs); builtPkgs.push(p) }
  }
  // One entry that throws (esbuild internals, fs errors) becomes its own G164, never a rejected build.
  const built = (await Promise.all(jobs.map((j) => buildEntry(env, j).catch((e): EntryBuild[] => [{ entry: j.entry, rel: posix(relative(root, j.entry)), diagnostics: [diag('G164', 'error', `Збірка: ${(e as Error)?.message ?? String(e)}`, { path: posix(relative(root, j.entry)) })], ...(j.package ? { package: j.package } : {}) }])))).flat()

  const compiled: CompiledPrompt[] = []
  const written: string[] = []
  const removed: string[] = []
  const ids = new Map<string, string>()
  const packageOf = new Map<CompiledPrompt, string>()
  for (const b of built) {
    diagnostics.push(...b.diagnostics)
    if (!b.compiled) continue
    const other = ids.get(b.compiled.id)
    if (other) {
      const d = diag('G001', 'error', `Промпт з id "${b.compiled.id}" зібрано з двох файлів: ${other} і ${b.rel}.`, { path: b.rel })
      b.compiled.diagnostics.push(d)
      diagnostics.push(d)
    }
    ids.set(b.compiled.id, b.package ? `${b.package} (${b.rel})` : b.rel)
    if (b.package) {
      packageOf.set(b.compiled, b.package)
      if (!b.compiled.skill) {
        const d = diag('G001', 'warning', `${b.package}: ${b.rel} не є <Prompt as="skill">; з пакетів збираються лише skills.`, { path: b.rel })
        diagnostics.push(d)
        continue
      }
    }
    compiled.push(b.compiled)
  }

  if (write) {
    const promptDir = resolve(root, dir)
    const prevLock = readLock(root, dir)
    const entryRels = new Set(findEntries(root, dir).map((e) => posix(relative(root, e))))
    const lock: PromptLock = { compiler: COMPILER, prompts: {} }
    // Entries built cleanly now: every id they produced before but not any more (a renamed skill or id) is dropped.
    const rebuilt = new Set(built.filter((b) => b.compiled && !b.diagnostics.some((d) => d.severity === 'error')).map((b) => b.rel))
    const fresh = new Set(compiled.map((c) => c.id))
    // Keep entries of prompts not rebuilt now (failed or filtered by `only`) whose entry still exists.
    for (const [id, p] of Object.entries(prevLock?.prompts ?? {})) {
      if (p.entry && rebuilt.has(p.entry) && !fresh.has(id)) continue
      if (!p.entry || entryRels.has(p.entry) || (p.package && opts.only?.length && !builtPkgs.some((b) => b.name === p.package))) lock.prompts[id] = p
    }
    // Package versions (G-19 staleness): kept for packages not rebuilt now, still configured.
    const pkgLock: NonNullable<PromptLock['packages']> = {}
    for (const [n, v] of Object.entries(prevLock?.packages ?? {})) if (pkgNames.includes(n)) pkgLock[n] = v
    for (const b of builtPkgs) {
      const failed = built.some((x) => x.package === b.name && x.diagnostics.some((d) => d.severity === 'error'))
      if (!failed) pkgLock[b.spec] = { ...(b.version ? { version: b.version } : {}), hash: b.hash }
    }
    if (Object.keys(pkgLock).length) lock.packages = Object.fromEntries(Object.entries(pkgLock).sort(([a], [b]) => a.localeCompare(b)))
    const skillBody = config?.prompt?.skillBody ?? 'live'
    const skillsToWrite: CompiledPrompt[] = []
    for (const cp of compiled) {
      if (cp.diagnostics.some((d) => d.severity === 'error')) continue
      const out = join(promptDir, '.compiled', `${cp.id}.json`)
      writeJson(out, cp)
      written.push(posix(relative(root, out)))
      const pkg = packageOf.get(cp)
      lock.prompts[cp.id] = { entry: cp.sources[0]?.path, sourceHash: cp.sourceHash, sources: cp.sources, ...(pkg ? { package: pkg } : {}) }
      if (cp.skill) skillsToWrite.push(cp)
    }
    for (const cp of skillsToWrite) {
      const pkg = packageOf.get(cp)
      const md = join(root, '.claude', 'skills', cp.skill!.name, 'SKILL.md')
      // A hand-written skill of the same name is never replaced (only with `force`).
      const cur = existsSync(md) ? readFileSync(md, 'utf8') : undefined
      if (cur !== undefined && !opts.force && !isGeneratedSkillMd(cur)) {
        diagnostics.push(diag('G001', 'error', `Skill "${cp.skill!.name}": .claude/skills/${cp.skill!.name}/SKILL.md написано вручну — не перезаписую.`, { path: cp.sources[0]?.path ?? '', hint: 'перейменуй <Prompt as="skill" name> або build --force' }))
        continue
      }
      const mdo: SkillMdOptions = { body: skillBody, ...(pkg ? { source: `npm:${pkg}` } : {}) }
      if (skillBody !== 'live') {
        const st = await renderStaticSkill(root, cp)
        if (st) { mdo.staticText = st.text; mdo.staticArgs = st.args }
        else diagnostics.push(diag('G001', 'warning', `Skill "${cp.skill!.name}": статичне тіло не відрендерено, SKILL.md лишився live.`, { path: cp.sources[0]?.path ?? '' }))
      }
      const text = renderSkillMd(cp, mdo)
      if (cur === text) continue
      writeText(md, text)
      written.push(posix(relative(root, md)))
    }
    lock.prompts = Object.fromEntries(Object.entries(lock.prompts).sort(([a], [b]) => a.localeCompare(b)))
    // Orphans (a removed or renamed prompt): its .compiled is no longer loaded, its generated SKILL.md removed.
    removed.push(...pruneOrphans(root, promptDir, prevLock, lock))
    const lp = lockPath(root, dir)
    const next = JSON.stringify(lock, null, 2) + '\n'
    let prevText: string | undefined
    try { prevText = readFileSync(lp, 'utf8') } catch { prevText = undefined }
    if (next !== prevText && (compiled.length || prevLock)) {
      writeText(lp, next)
      written.push(posix(relative(root, lp)))
    }
  }
  return { compiled, diagnostics, written, ...(removed.length ? { removed } : {}) }
}

/**
 * Orphans of a rebuild: ids of the previous lock missing from the new one (a removed or renamed prompt). Their
 * `.compiled/<id>.json` goes (it would keep rendering), and so does their SKILL.md when it is generated
 * (`generated-by: context-gate`; hand-written ones stay). Returns the removed repo-relative paths.
 */
export function pruneOrphans(root: string, promptDir: string, prev: PromptLock | undefined, next: PromptLock): string[] {
  const out: string[] = []
  const rm = (p: string): void => { rmSync(p, { force: true }); out.push(posix(relative(root, p))) }
  for (const id of Object.keys(prev?.prompts ?? {})) {
    if (next.prompts[id] || !/^[\w.-]+$/.test(id)) continue
    const cj = join(promptDir, '.compiled', `${id}.json`)
    if (existsSync(cj)) rm(cj)
    const md = join(root, '.claude', 'skills', id, 'SKILL.md')
    let text: string | undefined
    try { text = readFileSync(md, 'utf8') } catch { continue }
    if (!isGeneratedSkillMd(text)) continue
    rm(md)
    try { rmdirSync(dirname(md)) } catch { /* other files in the skill dir stay */ }
  }
  return out
}

// ───────────────────────── Staleness ─────────────────────────

export interface StaleResult {
  /** Repo-relative entry paths whose `.compiled` exists but no longer matches the sources. */
  stale: string[]
  /** Repo-relative entry paths without a `.compiled`. */
  missing: string[]
}

/**
 * Compares current source hashes with `.compiled/*.json` (falls back to the lock for the id) without building.
 * `prompt.packages` (G-19): a package whose resolved package.json (version, manifest) differs from the one recorded in
 * `prompt.lock.json` is stale, one never built is missing; both are reported as `npm:<name>`, which `buildPrompts`
 * accepts in `only`. A package that does not resolve is left to the build (G164).
 */
export function checkStale(opts: { root: string; dir?: string; config?: BuildConfig }): StaleResult {
  const root = resolve(opts.root)
  const dir = opts.dir ?? DEFAULT_DIR
  const compiledDir = join(resolve(root, dir), '.compiled')
  const byEntry = new Map<string, CompiledPrompt[]>()
  if (existsSync(compiledDir)) {
    for (const f of readdirSync(compiledDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const cp = JSON.parse(readFileSync(join(compiledDir, f), 'utf8')) as CompiledPrompt
        const entry = cp.sources?.[0]?.path
        if (entry) byEntry.set(entry, [...(byEntry.get(entry) ?? []), cp])
      } catch { /* unreadable compiled = missing */ }
    }
  }
  // Several .compiled files per entry (a renamed skill left its old id behind): the lock says which ids the
  // entry produces now; only those decide staleness (else every run would rebuild for the orphan).
  const lock = readLock(root, dir)
  const stale: string[] = []
  const missing: string[] = []
  for (const e of findEntries(root, dir)) {
    const rel = posix(relative(root, e))
    const all = byEntry.get(rel) ?? []
    const locked = all.filter((cp) => lock?.prompts[cp.id]?.entry === rel)
    const cps = locked.length ? locked : all
    if (!cps.length) { missing.push(rel); continue }
    const isStale = (cp: CompiledPrompt): boolean => {
      if (cp.compiler !== COMPILER) return true
      const current = cp.sources.map((s) => {
        try { return { path: s.path, hash: sha256(readFileSync(join(root, s.path))) } } catch { return { path: s.path, hash: 'missing' } }
      })
      return computeSourceHash(current) !== cp.sourceHash
    }
    if (cps.some(isStale)) stale.push(rel)
  }
  const config = opts.config ?? readBuildConfig(root)
  const pkgNames = Array.isArray(config?.prompt?.packages) ? config!.prompt!.packages! : []
  if (pkgNames.length) {
    for (const p of resolvePromptPackages(root, pkgNames).packages) {
      const rec = lock?.packages?.[p.spec]
      if (!rec) missing.push(`npm:${p.spec}`)
      else if (rec.hash !== p.hash || rec.version !== p.version) stale.push(`npm:${p.spec}`)
    }
  }
  return { stale, missing }
}

// ───────────────────────── ctx.d.ts ─────────────────────────

const BUILTIN_PROVIDERS = new Set(['git', 'fs', 'cursor', 'session', 'ctx', 'gate'])
const TS_IDENT = /^[A-Za-z_$][\w$]*$/

/** Simple JSON Schema → TS type (type, enum, const, anyOf/oneOf/allOf, object, array, required). */
export function jsonSchemaToTs(schema: unknown, indent = ''): string {
  if (!schema || typeof schema !== 'object') return 'unknown'
  const s = schema as Record<string, unknown>
  if ('const' in s) return JSON.stringify(s.const)
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(' | ') || 'never'
  for (const k of ['anyOf', 'oneOf'] as const) if (Array.isArray(s[k])) return (s[k] as unknown[]).map((x) => jsonSchemaToTs(x, indent)).join(' | ')
  if (Array.isArray(s.allOf)) return (s.allOf as unknown[]).map((x) => jsonSchemaToTs(x, indent)).join(' & ')
  if (Array.isArray(s.type)) return (s.type as unknown[]).map((t) => jsonSchemaToTs({ ...s, type: t }, indent)).join(' | ')
  const type = s.type ?? (s.properties ? 'object' : s.items ? 'array' : undefined)
  switch (type) {
    case 'string': return 'string'
    case 'number': case 'integer': return 'number'
    case 'boolean': return 'boolean'
    case 'null': return 'null'
    case 'array': {
      const item = jsonSchemaToTs(s.items, indent)
      return /^[\w.]+$/.test(item) ? `${item}[]` : `Array<${item}>`
    }
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>
      const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : [])
      const inner = indent + '  '
      const lines = Object.entries(props).map(([k, v]) => `${inner}${TS_IDENT.test(k) ? k : JSON.stringify(k)}${req.has(k) ? '' : '?'}: ${jsonSchemaToTs(v, inner)}`)
      if (s.additionalProperties && typeof s.additionalProperties === 'object') lines.push(`${inner}[key: string]: ${jsonSchemaToTs(s.additionalProperties, inner)}`)
      else if (s.additionalProperties === true || (!lines.length && s.additionalProperties !== false)) lines.push(`${inner}[key: string]: unknown`)
      return `{\n${lines.join('\n')}\n${indent}}`
    }
    default: return 'unknown'
  }
}

const union = (xs: string[]) => (xs.length ? xs.map((x) => JSON.stringify(x)).join(' | ') : 'string')

const typesDirOf = (root: string, config: Partial<GateConfig>) => join(resolve(root), config.prompt?.dir ?? DEFAULT_DIR, '.types')

/**
 * TS type of a provider `schema` (Р4): an inline JSON Schema, a repo-relative `.schema.json` (read and
 * converted), or a `.d.ts` / `.ts` file whose type is re-exported (`types/arch.d.ts#ArchResult`; without
 * `#Name` — the default export, else the root exported declaration found by the LSP reader).
 */
export function providerSchemaTs(root: string, typesDir: string, schema: unknown): string {
  if (schema && typeof schema === 'object') return jsonSchemaToTs(schema, '    ')
  if (typeof schema !== 'string') return 'unknown'
  const { path, type } = splitSchemaRef(schema)
  const abs = resolve(root, path)
  if (!existsSync(abs)) return 'unknown'
  if (isDtsSchema(schema)) {
    const d = readDts(readFileSync(abs, 'utf8'), type)
    const name = d.isDefault ? 'default' : d.pick ?? type
    if (!name) return 'unknown'
    let spec = posix(relative(typesDir, abs)).replace(/\.d\.([cm]?)ts$/, '.$1js').replace(/\.ts$/, '.js')
    if (!spec.startsWith('.')) spec = './' + spec
    return `import(${JSON.stringify(spec)})${name === 'default' ? '.default' : `.${name}`}`
  }
  const json = resolveSchemaRef(schema, (p) => { try { return readFileSync(resolve(root, p), 'utf8') } catch { return undefined } })
  return json && typeof json === 'object' ? jsonSchemaToTs(json, '    ') : 'unknown'
}

export interface CtxTypesOptions {
  root: string
  config: GateConfig
  /** `gate.index.json`: item ids become the `ItemId` union. */
  index?: { items?: { id: string }[] }
  /** Write the files (default true). */
  write?: boolean
}

/**
 * Generates `.claude/prompt/.types/ctx.d.ts`: augments `CtxOverrides` of `@context-gate/jsx` with
 * `gate.profile`/`gate.tier` unions from gate.json and typed non-builtin providers (from `schema`,
 * else `unknown`). Also writes `.types/assets.d.ts` (ambient `.md`/`.mdc`/`.txt` modules).
 */
export function generateCtxTypes(opts: CtxTypesOptions): string {
  const { config } = opts
  const profiles = Object.keys(config.profiles ?? {})
  const tiers = Object.keys(config.tiers ?? {})
  const lines: string[] = [
    '// Generated by context-gate from .claude/gate.json; regenerated on build. Do not edit.',
    "import type { GateCtx } from '@context-gate/jsx'",
    '',
    "declare module '@context-gate/jsx' {",
    '  interface CtxOverrides {',
    `    gate: GateCtx<${union(profiles)}, ${union(tiers)}>`,
  ]
  for (const [name, p] of Object.entries(config.providers ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (BUILTIN_PROVIDERS.has(name)) continue
    const key = TS_IDENT.test(name) ? name : JSON.stringify(name)
    const schema = providerSchemaTs(opts.root, typesDirOf(opts.root, config), p.schema)
    const fns = Array.isArray(p.functions) ? p.functions : p.functions ? Object.keys(p.functions) : []
    if (fns.length && schema === 'unknown') {
      lines.push(`    ${key}: {`)
      for (const f of fns) lines.push(`      ${TS_IDENT.test(f) ? f : JSON.stringify(f)}(...args: unknown[]): unknown`)
      lines.push('    }')
    } else lines.push(`    ${key}: ${schema}`)
  }
  lines.push('  }', '}', '')
  const items = opts.index?.items?.map((i) => i.id) ?? []
  lines.push(`export type ProfileName = ${profiles.length ? union(profiles) : 'never'}`)
  lines.push(`export type TierName = ${tiers.length ? union(tiers) : 'never'}`)
  if (items.length) lines.push(`export type ItemId = ${union([...new Set(items)].sort())}`)
  const text = lines.join('\n') + '\n'
  if (opts.write ?? true) {
    const typesDir = typesDirOf(opts.root, config)
    writeText(join(typesDir, 'ctx.d.ts'), text)
    writeText(join(typesDir, 'assets.d.ts'), [
      '// Generated by context-gate: ambient types for text imports in prompts.',
      ...['md', 'mdc', 'txt'].map((x) => `declare module '*.${x}' {\n  const text: string\n  export default text\n  export const meta: Record<string, unknown>\n}`),
      '',
    ].join('\n'))
  }
  return text
}
