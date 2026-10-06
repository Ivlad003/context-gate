// TSX prompt compiler (SPEC «Шар 3», «Збірка через mod», «Імпорти», Р1/Р3/Р5).
//
//   .claude/prompt/*.prompt.tsx  ──esbuild (bundle, jsx automatic, text/json loaders)──▶ temp bundle
//   temp bundle ──node child, 10 s timeout──▶ JSON of the default export (via @context-gate/jsx/compile)
//   ──validate (G1xx exprs, G160, G161, G162, G163)──▶ .claude/prompt/.compiled/<id>.json
//                                                     + .claude/prompt/prompt.lock.json (committed)
//                                                     + .claude/skills/<name>/SKILL.md for `as="skill"`

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import type { CompiledPrompt, Diagnostic, GateConfig, Node, SectionNode } from '../../core/src/types.ts'
import { parseExpr } from '../../core/src/expr.ts'
import { argumentHint } from '../../core/src/argparse.ts'
import { preserveJsxText } from './jsx-text.ts'

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
}

export interface BuildResult {
  compiled: CompiledPrompt[]
  diagnostics: Diagnostic[]
  /** Repo-relative POSIX paths of written files. */
  written: string[]
}

export interface PromptLock {
  compiler: string
  prompts: Record<string, { entry?: string; sourceHash: string; sources: { path: string; hash: string }[] }>
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

// ───────────────────────── Markdown frontmatter (text loader) ─────────────────────────

function scalar(v: string): unknown {
  const s = v.trim()
  if (s === '') return ''
  if (s === 'true' || s === 'false') return s === 'true'
  if (s === 'null' || s === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== '')
  return s
}

/** Splits `---` frontmatter (lenient, no YAML library: `globs: *.ts` must survive). */
export function splitFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, unknown> = {}
  let lastKey: string | undefined
  for (const line of m[1]!.split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line)
    if (item && lastKey) {
      const cur = meta[lastKey]
      meta[lastKey] = [...(Array.isArray(cur) ? cur : cur === '' || cur === undefined ? [] : [cur]), scalar(item[1]!)]
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) { lastKey = kv[1]!; meta[lastKey] = scalar(kv[2]!) }
  }
  return { meta, body: text.slice(m[0].length) }
}

// ───────────────────────── esbuild plugin ─────────────────────────

function promptPlugin(jsxSrc: string, notes: Diagnostic[], root: string): esbuild.Plugin {
  const jsxMap: Record<string, string> = {
    '@context-gate/jsx': join(jsxSrc, 'index.ts'),
    '@context-gate/jsx/jsx-runtime': join(jsxSrc, 'jsx-runtime.ts'),
    '@context-gate/jsx/jsx-dev-runtime': join(jsxSrc, 'jsx-runtime.ts'),
    '@context-gate/jsx/compile': join(jsxSrc, 'compile.ts'),
  }
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
      b.onLoad({ filter: /\.(ya?ml|toml)$/ }, (a) => ({
        errors: [{ text: `Імпорт ${basename(a.path)}: YAML/TOML не підтримується без парсера; конвертуй у JSON або імпортуй як текст (.txt).` }],
      }))
      b.onLoad({ filter: /\.[jt]sx$/ }, (a) => {
        if (a.path.startsWith(jsxSrc) || a.path.includes(`${sep}node_modules${sep}`)) return undefined
        const src = readFileSync(a.path, 'utf8')
        const r = preserveJsxText(src)
        if (!r.ok) notes.push(diag('G001', 'warning', `Текст JSX нормалізовано за правилами JSX (переноси рядків втрачено): ${r.error}.`, { path: posix(relative(root, a.path)), hint: 'спрости синтаксис файлу або загорни текст у {`…`}' }))
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

export interface ValidateOptions { validateExpr?: ValidateExpr }

const defaultValidateExpr: ValidateExpr = (src) => parseExpr(src).diagnostics

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
    case 'debug': return n.exprs
    case 'assert': return [n.test]
    case 'fence': return n.title ? placeholders(n.title) : []
    case 'el': return Object.values(n.attrs ?? {}).flatMap(placeholders)
    default: return []
  }
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{\s*([\s\S]*?)\s*\}\}/g)].map((m) => m[1]!)
}

function walk(nodes: Node[], fn: (n: Node) => void): void {
  for (const n of nodes) {
    fn(n)
    if (n.t === 'if') { walk(n.then, fn); if (n.else) walk(n.else, fn) }
    else if ('children' in n && Array.isArray(n.children)) walk(n.children, fn)
  }
}

const LEAKED = /^(NaN|undefined|Infinity)$|\[object |^function\b|=>/

function checkExpr(src: string, where: Partial<Diagnostic>, validate: ValidateExpr, out: Diagnostic[]): void {
  if (LEAKED.test(src.trim())) {
    out.push(diag('G160', 'error', `Вираз «${src}» — значення JS, обчислене на збірці, а не рядковий вираз.`, { ...where, hint: 'винести у module-провайдер або pipe-фільтр' }))
    return
  }
  for (const d of validate(src)) out.push({ ...d, ...where, message: `${d.message} (вираз «${src}»)` })
}

/**
 * Post-build checks over a compiled prompt: expression syntax (G1xx via `validateExpr`), leaked
 * build-time values (G160), duplicate section ids across imports (G161), `Run` without `cache`
 * in a `static` section (G163). Size (G162) is checked by the writer.
 */
export function validatePrompt(cp: Pick<CompiledPrompt, 'sections' | 'skill'>, opts: ValidateOptions = {}): Diagnostic[] {
  const validate = opts.validateExpr ?? defaultValidateExpr
  const out: Diagnostic[] = []
  const seen = new Map<string, SectionNode>()
  for (const s of cp.sections) {
    const where: Partial<Diagnostic> = s.source ? { path: s.source.path, ...(s.source.line ? { line: s.source.line } : {}) } : {}
    const prev = seen.get(s.id)
    if (prev) {
      const a = prev.source?.path ?? '?'
      const b = s.source?.path ?? '?'
      out.push(diag('G161', 'error', `Секцію "${s.id}" оголошено двічі: ${a}${prev.source?.line ? `:${prev.source.line}` : ''} і ${b}${s.source?.line ? `:${s.source.line}` : ''}.`, { ...where, hint: 'перейменуй одну з секцій' }))
    } else seen.set(s.id, s)
    if (s.when !== undefined) checkExpr(s.when, where, validate, out)
    walk(s.children, (n) => {
      for (const e of nodeExprs(n)) checkExpr(e, where, validate, out)
      if (n.t === 'run' && s.scope === 'static' && !n.cache) {
        out.push(diag('G163', 'error', `<Run lang="${n.lang}"> без cache у static-секції "${s.id}": static рендериться один раз і має бути стабільною.`, { ...where, hint: 'додай cache="1h" або перенеси в scope="volatile"' }))
      }
    })
  }
  if (cp.skill) walk(cp.skill.body, (n) => { for (const e of nodeExprs(n)) checkExpr(e, {}, validate, out) })
  return out
}

// ───────────────────────── SKILL.md ─────────────────────────

const yamlStr = (s: string) => JSON.stringify(s)

/** `.claude/skills/<name>/SKILL.md` for a `<Prompt as="skill">`: one live-render command line. */
export function renderSkillMd(cp: CompiledPrompt): string {
  const skill = cp.skill!
  const lines = ['---', `name: ${skill.name}`, `description: ${yamlStr(skill.description)}`]
  const hint = argumentHint(skill.args)
  if (hint) lines.push(`argument-hint: ${yamlStr(hint)}`)
  if (skill.invoke.model === false) lines.push('disable-model-invocation: true')
  lines.push('generated-by: context-gate', `source-hash: ${cp.sourceHash.slice(0, 16)}`, '---')
  lines.push('!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" run ' + skill.name + ' --args "$ARGUMENTS" --ctx-from live`')
  lines.push('')
  lines.push(`<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/${cp.id}.json. Якщо рядок вище не виконався (harness без підтримки !\`…\`), виконай: npx context-gate run ${skill.name} --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->`)
  return lines.join('\n') + '\n'
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

interface EntryBuild { entry: string; rel: string; compiled?: CompiledPrompt; diagnostics: Diagnostic[] }

async function buildEntry(root: string, entry: string, jsxSrc: string, timeoutMs: number, validate: ValidateExpr): Promise<EntryBuild> {
  const rel = posix(relative(root, entry))
  const notes: Diagnostic[] = []
  const tmp = mkdtempSync(join(tmpdir(), 'context-gate-build-'))
  const outfile = join(tmp, 'bundle.mjs')
  try {
    const wrapper = [
      `import def from ${JSON.stringify(entry)}`,
      `import { compilePrompt } from '@context-gate/jsx/compile'`,
      `const r = compilePrompt(def, { root: ${JSON.stringify(posix(root))}, file: ${JSON.stringify(rel)} })`,
      `process.stdout.write('\\n' + ${JSON.stringify(SENTINEL)} + JSON.stringify(r) + '\\n')`,
    ].join('\n')
    let result: esbuild.BuildResult<{ write: false; metafile: true }>
    try {
      result = await esbuild.build({
        stdin: { contents: wrapper, resolveDir: dirname(entry), sourcefile: '<context-gate-entry>', loader: 'ts' },
        absWorkingDir: root,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        jsx: 'automatic',
        jsxImportSource: '@context-gate/jsx',
        loader: { '.json': 'json' },
        plugins: [promptPlugin(jsxSrc, notes, root)],
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
      return { entry, rel, diagnostics: [...notes, ...diags] }
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
      return { entry, rel, diagnostics: [...notes, diag('G164', 'error', `Виконання ${rel}: ${child.error ?? 'немає результату'}.\n${detail}`, { path: rel, hint: 'збірка виконує модуль у Node; перевір імпорти й код верхнього рівня' })] }
    }
    const part = JSON.parse(child.stdout.slice(at + SENTINEL.length).trim()) as Pick<CompiledPrompt, 'sections' | 'skill' | 'uses' | 'diagnostics'> & { id?: string }
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
    const diagnostics = [...notes, ...part.diagnostics, ...validatePrompt(compiled, { validateExpr: validate })]
    compiled.diagnostics = diagnostics
    const size = Buffer.byteLength(JSON.stringify(compiled, null, 2))
    if (size > MAX_COMPILED_BYTES) {
      const d = diag('G162', 'error', `.compiled/${id}.json має ${(size / 1024 / 1024).toFixed(1)} МБ (ліміт 2 МБ).`, { path: rel, hint: 'винеси дані в <Include mode="lazy"> або провайдер' })
      diagnostics.push(d)
    }
    return { entry, rel, compiled, diagnostics }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function matchesOnly(only: string[] | undefined, root: string, entry: string): boolean {
  if (!only?.length) return true
  const rel = posix(relative(root, entry))
  return only.some((o) => o === promptIdOf(entry) || o === rel || o === basename(entry) || resolve(root, o) === entry)
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

/**
 * Builds `*.prompt.tsx` entry points of `<root>/<dir>`. Prompts with error diagnostics are not
 * written (the previous `.compiled` stays, SPEC «Помилки збірки») but are returned with them.
 */
export async function buildPrompts(opts: BuildOptions): Promise<BuildResult> {
  const root = resolve(opts.root)
  const dir = opts.dir ?? DEFAULT_DIR
  const jsxSrc = opts.jsxSrc ? resolve(opts.jsxSrc) : defaultJsxSrc()
  const write = opts.write ?? true
  const validate = opts.validateExpr ?? defaultValidateExpr
  const entries = findEntries(root, dir).filter((e) => matchesOnly(opts.only, root, e))
  const built = await Promise.all(entries.map((e) => buildEntry(root, e, jsxSrc, opts.timeoutMs ?? 10_000, validate)))

  const diagnostics: Diagnostic[] = []
  const compiled: CompiledPrompt[] = []
  const written: string[] = []
  const ids = new Map<string, string>()
  for (const b of built) {
    diagnostics.push(...b.diagnostics)
    if (!b.compiled) continue
    const other = ids.get(b.compiled.id)
    if (other) {
      const d = diag('G001', 'error', `Промпт з id "${b.compiled.id}" зібрано з двох файлів: ${other} і ${b.rel}.`, { path: b.rel })
      b.compiled.diagnostics.push(d)
      diagnostics.push(d)
    }
    ids.set(b.compiled.id, b.rel)
    compiled.push(b.compiled)
  }

  if (write) {
    const promptDir = resolve(root, dir)
    const prevLock = readLock(root, dir)
    const entryRels = new Set(findEntries(root, dir).map((e) => posix(relative(root, e))))
    const lock: PromptLock = { compiler: COMPILER, prompts: {} }
    // Keep entries of prompts not rebuilt now (failed or filtered by `only`) whose entry still exists.
    for (const [id, p] of Object.entries(prevLock?.prompts ?? {})) if (!p.entry || entryRels.has(p.entry)) lock.prompts[id] = p
    for (const cp of compiled) {
      if (cp.diagnostics.some((d) => d.severity === 'error')) continue
      const out = join(promptDir, '.compiled', `${cp.id}.json`)
      writeJson(out, cp)
      written.push(posix(relative(root, out)))
      lock.prompts[cp.id] = { entry: cp.sources[0]?.path, sourceHash: cp.sourceHash, sources: cp.sources }
      if (cp.skill) {
        const md = join(root, '.claude', 'skills', cp.skill.name, 'SKILL.md')
        mkdirSync(dirname(md), { recursive: true })
        writeFileSync(md, renderSkillMd(cp))
        written.push(posix(relative(root, md)))
      }
    }
    lock.prompts = Object.fromEntries(Object.entries(lock.prompts).sort(([a], [b]) => a.localeCompare(b)))
    const lp = lockPath(root, dir)
    const next = JSON.stringify(lock, null, 2) + '\n'
    let prevText: string | undefined
    try { prevText = readFileSync(lp, 'utf8') } catch { prevText = undefined }
    if (next !== prevText && (compiled.length || prevLock)) {
      mkdirSync(dirname(lp), { recursive: true })
      writeFileSync(lp, next)
      written.push(posix(relative(root, lp)))
    }
  }
  return { compiled, diagnostics, written }
}

// ───────────────────────── Staleness ─────────────────────────

export interface StaleResult {
  /** Repo-relative entry paths whose `.compiled` exists but no longer matches the sources. */
  stale: string[]
  /** Repo-relative entry paths without a `.compiled`. */
  missing: string[]
}

/** Compares current source hashes with `.compiled/*.json` (falls back to the lock for the id) without building. */
export function checkStale(opts: { root: string; dir?: string }): StaleResult {
  const root = resolve(opts.root)
  const dir = opts.dir ?? DEFAULT_DIR
  const compiledDir = join(resolve(root, dir), '.compiled')
  const byEntry = new Map<string, CompiledPrompt>()
  if (existsSync(compiledDir)) {
    for (const f of readdirSync(compiledDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const cp = JSON.parse(readFileSync(join(compiledDir, f), 'utf8')) as CompiledPrompt
        const entry = cp.sources?.[0]?.path
        if (entry) byEntry.set(entry, cp)
      } catch { /* unreadable compiled = missing */ }
    }
  }
  const stale: string[] = []
  const missing: string[] = []
  for (const e of findEntries(root, dir)) {
    const rel = posix(relative(root, e))
    const cp = byEntry.get(rel)
    if (!cp) { missing.push(rel); continue }
    if (cp.compiler !== COMPILER) { stale.push(rel); continue }
    const current = cp.sources.map((s) => {
      try { return { path: s.path, hash: sha256(readFileSync(join(root, s.path))) } } catch { return { path: s.path, hash: 'missing' } }
    })
    if (computeSourceHash(current) !== cp.sourceHash) stale.push(rel)
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
    const schema = p.schema && typeof p.schema === 'object' ? jsonSchemaToTs(p.schema, '    ') : 'unknown'
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
    const typesDir = join(resolve(opts.root), config.prompt?.dir ?? DEFAULT_DIR, '.types')
    mkdirSync(typesDir, { recursive: true })
    writeFileSync(join(typesDir, 'ctx.d.ts'), text)
    writeFileSync(join(typesDir, 'assets.d.ts'), [
      '// Generated by context-gate: ambient types for text imports in prompts.',
      ...['md', 'mdc', 'txt'].map((x) => `declare module '*.${x}' {\n  const text: string\n  export default text\n  export const meta: Record<string, unknown>\n}`),
      '',
    ].join('\n'))
  }
  return text
}
