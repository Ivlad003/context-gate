// Render context for the CLI (SPEC «Автономний інтерпретатор», «Провайдери»): live repo (git, cursor rules,
// gate decision, providers), a session snapshot from `.claude/gate.log.jsonl`, or a fixture JSON.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { loadEsbuild } from './esbuild-load.ts'
import type { CompiledPrompt, Diagnostic, Gate, GateConfig, Item, MdcRule, ProviderConfig, Signals, Tier, Value } from '../../core/src/types.ts'
import type { ProviderCallRequest } from '../../core/src/render.ts'
import { filterEnv, loadConfig, tierForModel } from '../../core/src/config.ts'
import { decideGate } from '../../core/src/decide.ts'
import { evalSource, newBudget } from '../../core/src/expr.ts'
import { cursorRuleDirs, markdownRuleId, parseMarkdownRule, parseMdc, providerRules, ruleIdFromPath, ruleSourcesOf, ruleToItem } from '../../core/src/mdc.ts'
import { compileGlob, detectWindows } from '../../core/src/glob.ts'
import { exampleValue, selectExamples } from '../../core/src/examples.ts'
import { makeItem, normalizeItems } from '../../core/src/items.ts'
import { parseDuration } from '../../core/src/duration.ts'
import { findSnapshot, fromJsonl, type Snapshot } from '../../core/src/journal.ts'
import { splitFrontmatter } from './build.ts'
import { markdownProviderValue as markdownValue } from '../../core/src/providers.ts'
import { assemblePrompts, buildScope, cursorMatch, dataScope, isMarkdownSectionFile, promptSectionDirs, type DataEntry, type MarkdownFile, type PromptSet } from '../../core/src/assemble.ts'
import { NodeHost, listSkills } from './host-node.ts'
import { parseToolHeader, parseToolHeaders, type ToolHeader } from '../../core/src/toolheader.ts'
import { scriptArgv, shimLang, usedFunctions } from '../../core/src/shims.ts'
import { scriptFnName, scriptLang } from './scripts.ts'
import { NODE_SHIM } from './shims.ts'
import { repoCacheDir, trustState, type TrustState } from './settings.ts'
import { lexicallyInside, posix, readJson, readText, runProcess, safeJoin, sha256, walkFiles, walkFilesInfo, writeJson } from './util.ts'
import { fileProviderValue, parseLoose, pickFields, providerResultOk } from '../../core/src/providers.ts'

/** Shared deadline of all provider values of one render (each process still has its own 10 s timeout). */
export const PROVIDERS_DEADLINE_MS = 12_000

export const BUILTIN_PROVIDERS = new Set(['git', 'fs', 'cursor', 'session', 'gate', 'ctx', 'scripts', 'data', 'args', 'budgets'])

// ───────────────────────── config ─────────────────────────

export interface Repo {
  root: string
  config: GateConfig
  configDiagnostics: Diagnostic[]
  hasConfig: boolean
  promptDir: string
  cacheDir: string
  /** `allowBinaries` in gate.json: the repo may only narrow the user whitelist (Р2). */
  narrowBinaries?: string[]
}

export const DEFAULT_PROMPT_DIR = '.claude/prompt'
/** The prompt dir when even `.claude/prompt` is a symlink out of the repo: a path nothing creates, so no prompt is
 *  read from outside and nothing is built there (an empty prompt set). */
const NO_PROMPT_DIR = '.claude/.context-gate-no-prompt-dir'

export function loadRepo(root: string): Repo {
  const text = readText(join(root, '.claude', 'gate.json'))
  const { config, diagnostics } = loadConfig(text)
  const cfg = config ?? loadConfig(undefined).config!
  const narrow = config?.allowBinaries
  const diags = [...diagnostics]
  // prompt.dir comes from the repo: it must stay inside it (.trace, .compiled, data/ are written there; Р2).
  let promptDir = cfg.prompt?.dir ?? DEFAULT_PROMPT_DIR
  if (!lexicallyInside(promptDir.replace(/^\.\//, '')) || !safeJoin(root, promptDir)) {
    diags.push({ code: 'G303', severity: 'error', message: `prompt.dir «${promptDir}» виходить за межі репозиторію — використано ${DEFAULT_PROMPT_DIR}`, path: '.claude/gate.json', hint: 'шлях відносно кореня, без .. і symlink назовні' })
    promptDir = DEFAULT_PROMPT_DIR
  }
  if (!safeJoin(root, promptDir)) {
    // The fallback itself is a symlink out of the repo: no prompt dir at all.
    diags.push({ code: 'G303', severity: 'error', message: `${promptDir} — symlink за межі репозиторію: промпти не читаються й не збираються`, path: promptDir, hint: 'заміни symlink текою всередині репозиторію' })
    promptDir = NO_PROMPT_DIR
  }
  return { root, config: cfg, configDiagnostics: diags, hasConfig: text !== undefined, promptDir, cacheDir: repoCacheDir(root), ...(narrow ? { narrowBinaries: narrow } : {}) }
}

// ───────────────────────── cursor rules ─────────────────────────

/** Repo files git knows (tracked + untracked, `.gitignore` honoured), or undefined outside git / on failure. */
export function gitListFiles(root: string): string[] | undefined {
  try {
    const out = execFileSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', 'ls-files', '-z', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    return out.split('\0').filter(Boolean)
  } catch { return undefined }
}

const NESTED_RULE = /(^|\/)\.cursor\/rules\/.+\.mdc$/

export function findMdcFiles(root: string, config: GateConfig, diagnostics?: Diagnostic[]): string[] {
  const { dirs, nested } = cursorRuleDirs(config)
  const out = new Set<string>()
  for (const d of dirs) for (const f of walkFiles(root, { under: d })) if (f.endsWith('.mdc')) out.add(f)
  if (nested) {
    // `git ls-files` honours .gitignore (build output never hides rules); the walk is the fallback outside git.
    const listed = gitListFiles(root)
    if (listed) { for (const f of listed) if (NESTED_RULE.test(f) && existsSync(join(root, f))) out.add(f) }
    else {
      const w = walkFilesInfo(root)
      for (const f of w.files) if (NESTED_RULE.test(f)) out.add(f)
      if (w.truncated) diagnostics?.push({ code: 'G313', severity: 'warning', message: `Пошук вкладених .cursor/rules зупинено на ${w.files.length} файлах — правила далі за списком не знайдено`, hint: 'ініціалізуй git (тоді враховується .gitignore) або вимкни cursorRules.nested' })
    }
  }
  return [...out].sort()
}

/** Files `sync` writes into `.claude/rules/cursor/`: never read back as rule sources. */
export const SYNC_RULES_DIR = '.claude/rules/cursor'
const SYNC_MARK = '<!-- generated by context-gate from '

/** `markdown-dir` sources (G-51): every `.md` under `dir`, through core `parseMarkdownRule`. */
export function loadMarkdownRules(root: string, config: GateConfig): { rules: MdcRule[]; diagnostics: Diagnostic[] } {
  const rules: MdcRule[] = []
  const diagnostics: Diagnostic[] = []
  for (const src of ruleSourcesOf(config)) {
    if (src.kind !== 'markdown-dir' || !src.dir) continue
    const dir = src.dir.replace(/^\.\//, '').replace(/\/+$/, '')
    for (const path of walkFiles(root, { under: dir }).filter((f) => /\.(md|markdown)$/i.test(f) && !/(^|\/)readme\.md$/i.test(f)).sort()) {
      // sync's own output (`.claude/rules/cursor/*.md`, marked) is not a source: it would nest one level per sync.
      if (path === SYNC_RULES_DIR || path.startsWith(SYNC_RULES_DIR + '/')) continue
      const text = readText(join(root, path))
      if (text === undefined || text.includes(SYNC_MARK)) continue
      const r = parseMarkdownRule(text, { path, id: markdownRuleId(path, dir), ...(src.frontmatter ? { frontmatter: src.frontmatter } : {}), ...(src.as ? { as: src.as } : {}) })
      rules.push(r.rule)
      diagnostics.push(...r.diagnostics)
    }
  }
  return { rules, diagnostics }
}

/** `provider` rule sources (G-51): values come from the providers (trusted CLI / file / module). `missing` names the
 * sources whose provider gave no data (untrusted, failed, unverified, a missing field): their rules are unknown. */
export async function loadProviderRules(config: GateConfig, value: (name: string) => Promise<Value>): Promise<{ rules: MdcRule[]; diagnostics: Diagnostic[]; missing: string[] }> {
  const rules: MdcRule[] = []
  const diagnostics: Diagnostic[] = []
  const missing: string[] = []
  if (config.cursorRules?.enabled === false) return { rules, diagnostics, missing }
  for (const src of ruleSourcesOf(config)) {
    if (src.kind !== 'provider' || !src.name) continue
    const v = await value(src.name)
    const r = providerRules(v, src)
    if (v === null || v === undefined || r.diagnostics.some((d) => d.code === 'G203' || d.code === 'G313')) missing.push(src.name)
    rules.push(...r.rules)
    diagnostics.push(...r.diagnostics)
  }
  return { rules, diagnostics, missing }
}

/**
 * Items for provider rule sources without data: one `rule` item per source, `status: unverified`, so `collect`,
 * `report` and `decide` show that its rules exist but are unknown (instead of silently dropping them).
 */
export function unverifiedProviderRuleItems(names: readonly string[], why: (name: string) => string): Item[] {
  return names.map((name) => makeItem('rule', `${name}/*`, { status: 'unverified', description: `правила провайдера ${name} не отримано: ${why(name)}`, provenance: { source: `provider:${name}` }, attach: { when: 'manual' } }))
}

export function loadRules(root: string, config: GateConfig): { rules: MdcRule[]; diagnostics: Diagnostic[] } {
  const rules: MdcRule[] = []
  const diagnostics: Diagnostic[] = []
  if (config.cursorRules?.enabled === false) return { rules, diagnostics }
  const { dirs } = cursorRuleDirs(config)
  for (const path of findMdcFiles(root, config, diagnostics)) {
    const text = readText(join(root, path))
    if (text === undefined) continue
    // Ids below a custom cursor-mdc dir, and one rule per id (core loadRuleSources, M41).
    const { id, dirPrefix } = ruleIdFromPath(path, dirs)
    const r = parseMdc(text, { path, id, dirPrefix })
    diagnostics.push(...r.diagnostics)
    const dup = rules.find((x) => x.id === r.rule.id)
    if (dup) { diagnostics.push({ code: 'G001', severity: 'warning', message: `Правило ${r.rule.id}: id уже має ${dup.path}; ${path} пропущено`, path }); continue }
    rules.push(r.rule)
  }
  const md = loadMarkdownRules(root, config)
  rules.push(...md.rules)
  diagnostics.push(...md.diagnostics)
  return { rules, diagnostics }
}

// ───────────────────────── git ─────────────────────────

/** git without optional locks (a render never holds index.lock against the user's commit) and with raw paths. */
async function git(root: string, args: string[], onTimeout?: (args: string[]) => void): Promise<string | undefined> {
  const r = await runProcess(['git', '--no-optional-locks', '-c', 'core.quotePath=false', ...args], { cwd: root, timeoutMs: 5000, env: { GIT_OPTIONAL_LOCKS: '0' } })
  if (r.timedOut) onTimeout?.(args)
  return r.exitCode === 0 ? r.stdout : undefined
}

/** `git status --porcelain=v1 -z` → changed paths (the new path of a rename/copy). */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split('\0')
  const changed: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!
    if (e.length < 4) continue
    changed.push(e.slice(3))
    if (e[0] === 'R' || e[0] === 'C') i++ // the next field is the original path
  }
  return changed
}

export async function gitInfo(root: string, diagnostics?: Diagnostic[]): Promise<Record<string, Value>> {
  const timedOut: string[] = []
  const onTimeout = (args: string[]) => { timedOut.push(args[0] ?? '') }
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'], onTimeout)
  const base: Record<string, Value> = { branch: '', head: '', dirty: false, ahead: 0, behind: 0, changed: [], name: basename(root), remote: '' }
  if (!inside || inside.trim() !== 'true') {
    if (timedOut.length) diagnostics?.push({ code: 'G203', severity: 'warning', message: 'git не відповів за 5 с — git.* порожні, профілі за шляхами не спрацюють' })
    return base
  }
  const [branch, head, status, remote, counts] = await Promise.all([
    git(root, ['branch', '--show-current'], onTimeout),
    git(root, ['rev-parse', '--short', 'HEAD'], onTimeout),
    git(root, ['status', '--porcelain=v1', '-z', '-uall'], onTimeout),
    git(root, ['config', '--get', 'remote.origin.url'], onTimeout),
    git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], onTimeout),
  ])
  if (timedOut.length) diagnostics?.push({ code: 'G203', severity: 'warning', message: `git ${timedOut.join(', ')} не відповів за 5 с — git.changed/dirty можуть бути неповні, профілі за шляхами можуть не спрацювати` })
  const changed = parsePorcelainZ(status ?? '')
  const [behind, ahead] = (counts ?? '0\t0').trim().split(/\s+/).map((x) => Number(x) || 0)
  const r = (remote ?? '').trim()
  return { ...base, branch: (branch ?? '').trim(), head: (head ?? '').trim(), dirty: changed.length > 0, changed, ahead: ahead ?? 0, behind: behind ?? 0, remote: r, name: r ? (r.split(/[/:]/).pop() ?? '').replace(/\.git$/, '') || basename(root) : basename(root) }
}

export async function gitLog(root: string, n: number): Promise<Value> {
  const out = await git(root, ['log', `-n${Math.max(1, Math.min(500, Math.floor(n) || 10))}`, '--pretty=format:%h%x1f%s%x1f%an%x1f%aI'])
  if (!out) return []
  return out.split('\n').filter(Boolean).map((l) => {
    const [hash = '', subject = '', author = '', date = ''] = l.split('\x1f')
    const cc = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.*)$/.exec(subject)
    return { hash, subject, author, date, ...(cc ? { type: cc[1]!, ...(cc[2] ? { scope: cc[2] } : {}) } : {}) }
  })
}

// ───────────────────────── fs ─────────────────────────

/** `fs.examples(glob, n)`: core `selectExamples` over the repo listing, bodies via `exampleValue`. */
export function fsExamples(root: string, glob: string, n = 1): Value {
  const files = walkFiles(root).map((path) => { try { return { path, size: statSync(join(root, path)).size } } catch { return { path, size: Infinity } } })
  return selectExamples(files, glob, n).map((f) => exampleValue(f, readText(join(root, f.path)) ?? ''))
}

// ───────────────────────── data store ─────────────────────────

export function dataDir(repo: Repo): string {
  return join(repo.root, repo.promptDir, 'data')
}

export function dataMetaPath(repo: Repo): string {
  return join(repo.cacheDir, 'data-meta.json')
}

export function loadData(repo: Repo): DataEntry[] {
  const meta = readJson<Record<string, { fetchedAt?: number; cache?: string }>>(dataMetaPath(repo)) ?? {}
  const out = new Map<string, DataEntry>()
  // data/ and its files are repo-controlled: neither may be a symlink out of the repo (H02).
  const dir = safeJoin(repo.root, join(repo.promptDir, 'data'))
  if (dir && existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue
      const key = f.slice(0, -5)
      if (!safeJoin(repo.root, join(repo.promptDir, 'data', f))) continue
      const value = readJson<Value>(join(dir, f))
      if (value === undefined) continue
      let fetchedAt = meta[key]?.fetchedAt
      if (fetchedAt === undefined) try { fetchedAt = statSync(join(dir, f)).mtimeMs } catch { /* none */ }
      out.set(key, { key, value, ...(fetchedAt !== undefined ? { fetchedAt: Math.round(fetchedAt) } : {}), ...(meta[key]?.cache ? { cache: meta[key]!.cache } : {}) })
    }
  }
  // Values stored by renders (`store=`) without `persist: true` live in the cache.
  const cacheStore = readJson<Record<string, { value: Value; at: number; cache?: string }>>(join(repo.cacheDir, 'data.json')) ?? {}
  for (const [key, e] of Object.entries(cacheStore)) {
    const cur = out.get(key)
    if (!cur || (cur.fetchedAt ?? 0) < e.at) out.set(key, { key, value: e.value, fetchedAt: e.at, ...(e.cache ? { cache: e.cache } : {}) })
  }
  return [...out.values()]
}

/**
 * Writes `data.<key>`. `key` must pass `validDataKey` (render `store=`/`<Store name>` keys come from the repo):
 * anything else is refused with `[]` and no write, so `../` never leaves `data/` (Р2). With `persist` the value
 * lives only in `<prompt dir>/data/<key>.json` — deleting that file deletes the value; the cache store holds the
 * render-only (`persist: false`) values.
 */
export function setData(repo: Repo, key: string, value: Value, opts: { cache?: string; persist?: boolean; fetchedAt?: number } = {}): string[] {
  if (!validDataKey(key)) return []
  const written: string[] = []
  const now = opts.fetchedAt ?? Date.now()
  const persist = opts.persist ?? true
  if (persist) {
    const p = safeJoin(repo.root, join(repo.promptDir, 'data', `${key}.json`))
    if (!p) return []
    writeJson(p, value)
    written.push(posix(relative(repo.root, p)))
  }
  const metaP = dataMetaPath(repo)
  const meta = readJson<Record<string, { fetchedAt?: number; cache?: string }>>(metaP) ?? {}
  meta[key] = { fetchedAt: now, ...(opts.cache ? { cache: opts.cache } : {}) }
  writeJson(metaP, meta)
  const storeP = join(repo.cacheDir, 'data.json')
  const store = readJson<Record<string, { value: Value; at: number; cache?: string }>>(storeP) ?? {}
  if (persist) delete store[key]
  else store[key] = { value, at: now, ...(opts.cache ? { cache: opts.cache } : {}) }
  writeJson(storeP, store)
  return written
}

export function validDataKey(key: string): boolean {
  return /^[\w][\w.-]{0,127}$/.test(key) && !key.includes('..')
}

// ───────────────────────── prompts ─────────────────────────

export function loadCompiled(repo: Repo): { compiled: CompiledPrompt[]; from: 'repo' | 'cache' | 'none' } {
  // With a lock, only the ids it lists: an orphan of a removed or renamed prompt never renders.
  const lock = readJson<{ prompts?: Record<string, unknown> }>(join(repo.root, repo.promptDir, 'prompt.lock.json'))
  const listed = lock?.prompts && Object.keys(lock.prompts).length ? lock.prompts : undefined
  const read = (dir: string): CompiledPrompt[] => {
    if (!existsSync(dir)) return []
    const out: CompiledPrompt[] = []
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue
      const cp = readJson<CompiledPrompt>(join(dir, f))
      if (cp && cp.version === 1 && Array.isArray(cp.sections) && (!listed || Object.hasOwn(listed, cp.id))) out.push(cp)
    }
    return out
  }
  const own = read(join(repo.root, repo.promptDir, '.compiled'))
  if (own.length) return { compiled: own, from: 'repo' }
  const cached = read(join(repo.cacheDir, 'compiled'))
  return cached.length ? { compiled: cached, from: 'cache' } : { compiled: [], from: 'none' }
}

/** Markdown sections of `prompt.dir` and of every `prompt-dir` item source (core `promptSectionDirs`). */
export function loadMarkdown(repo: Repo): MarkdownFile[] {
  const out = new Map<string, MarkdownFile>()
  for (const rel of promptSectionDirs({ ...repo.config, prompt: { ...repo.config.prompt, dir: repo.promptDir } })) {
    // A section dir linked out of the repo is never read (H02); a linked file is not a plain file (isFile) either.
    const dir = safeJoin(repo.root, rel)
    if (!dir || !existsSync(dir)) continue
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isFile() || !isMarkdownSectionFile(d.name)) continue
      const path = posix(join(rel, d.name))
      if (!out.has(path)) out.set(path, { path, text: readFileSync(join(dir, d.name), 'utf8') })
    }
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** The prompts for `tier`; `preload` (the gate's `skills.preload`) adds the generated `preload` section (Р5). */
export function loadPrompts(repo: Repo, tier: Tier, preload?: readonly string[], override?: readonly CompiledPrompt[]): PromptSet & { compiledFrom: string } {
  const { compiled, from } = override ? { compiled: [...override], from: 'memory' } : loadCompiled(repo)
  const set = assemblePrompts(compiled, loadMarkdown(repo), tier, Object.keys(repo.config.tiers ?? {}), preload?.length ? { preload } : {})
  return { ...set, compiledFrom: from }
}

// ───────────────────────── items (collect) ─────────────────────────

export function scriptFiles(repo: Repo): string[] {
  const dir = join(repo.promptDir, 'scripts')
  return existsSync(join(repo.root, dir)) ? walkFiles(repo.root, { under: dir }) : []
}

export interface ScriptToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  tiers?: string[]
  /** Repo-relative script (whole-script tool) or module (function tool). */
  path: string
  /** Function tools: the export served through the language shim with the tool input as kwargs. */
  fn?: string
  line: number
}

/** Modules whose exports may be tools, as the mod (`hooks/layers/dsl.ts toolModules`): `<prompt dir>/lib/*`,
 * gate.json `module` providers and the `use` paths of the prompts. Repo-relative, inside the root. */
export function toolModules(repo: Repo, prompts: readonly CompiledPrompt[]): string[] {
  const out = new Set<string>()
  const lib = join(repo.root, repo.promptDir, 'lib')
  if (existsSync(lib)) for (const d of readdirSync(lib, { withFileTypes: true })) if (d.isFile() && shimLang(d.name)) out.add(posix(join(repo.promptDir, 'lib', d.name)))
  for (const p of Object.values(repo.config.providers ?? {})) if (p.kind === 'module' && p.path) out.add(p.path.replace(/^\.\//, ''))
  for (const path of usedFunctions(prompts).keys()) out.add(path.replace(/^\.\//, ''))
  const inside = (p: string) => !p.startsWith('/') && !p.split('/').includes('..')
  return [...out].filter(inside).sort()
}

/**
 * Model tools of the repo (SPEC «Скрипти як інструменти моделі», «Функції як інструменти моделі»): `# gate-tool:`
 * headers of `<prompt dir>/scripts/*` (core `parseToolHeader`) and function-level headers over exports of the
 * tool modules (core `parseToolHeaders`). The first tool of a name wins, scripts first, as the mod registers them.
 */
export function scriptTools(repo: Repo, prompts?: readonly CompiledPrompt[]): { tools: ScriptToolInfo[]; diagnostics: Diagnostic[] } {
  const tools: ScriptToolInfo[] = []
  const diagnostics: Diagnostic[] = []
  const add = (t: ScriptToolInfo) => { if (!tools.some((x) => x.name === t.name)) tools.push(t) }
  const info = (h: ToolHeader, path: string, fn?: string): ScriptToolInfo => ({ name: h.name, ...(h.description ? { description: h.description } : {}), inputSchema: h.inputSchema, ...(h.tiers ? { tiers: h.tiers } : {}), path, ...(fn ? { fn } : {}), line: h.line })
  for (const f of scriptFiles(repo)) {
    const { header, diagnostics: d } = parseToolHeader(readText(join(repo.root, f)) ?? '')
    diagnostics.push(...d.map((x) => ({ ...x, path: f })))
    if (header) add(info(header, f))
  }
  const set = prompts ?? (() => { const p = loadPrompts(repo, 'standard'); return [...p.system, ...Object.values(p.skills)] })()
  for (const path of toolModules(repo, set)) {
    const text = readText(join(repo.root, path))
    if (!text?.includes('gate-tool')) continue
    const r = parseToolHeaders(text)
    diagnostics.push(...r.diagnostics.map((x) => ({ ...x, path })))
    for (const h of r.headers) add(info(h, path, h.name))
  }
  return { tools, diagnostics }
}

export function collectItems(repo: Repo, rules?: MdcRule[], extra: readonly Item[] = []): Item[] {
  const items: Item[] = [...extra]
  for (const r of rules ?? loadRules(repo.root, repo.config).rules) items.push(ruleToItem(r))
  for (const s of listSkills(repo.root)) {
    // Skills transpiled from .mdc by `sync` are the same rules: don't count them twice.
    if (s.name.startsWith('cursor-') && s.body.includes('generated by context-gate from')) continue
    items.push(makeItem('skill', s.name, { body: s.body, attach: { when: 'on-demand' }, provenance: { source: s.generated ? 'prompt-tsx' : 'claude-skills', path: s.path }, ...(s.description ? { description: s.description } : {}) }))
  }
  const agentsDir = join(repo.root, '.claude', 'agents')
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).sort()) {
      if (!f.endsWith('.md')) continue
      const { meta, body } = splitFrontmatter(readText(join(agentsDir, f)) ?? '')
      const name = typeof meta.name === 'string' ? meta.name : f.slice(0, -3)
      items.push(makeItem('agent', name, { body, provenance: { source: 'claude-agents', path: `.claude/agents/${f}` }, ...(typeof meta.description === 'string' ? { description: meta.description } : {}) }))
    }
  }
  const prompts = loadPrompts(repo, 'standard')
  for (const t of scriptTools(repo, [...prompts.system, ...Object.values(prompts.skills)]).tools) {
    items.push(makeItem('tool', t.name, { provenance: { source: 'gate-tool', path: t.path }, ...(t.description ? { description: t.description } : {}), ...(t.tiers ? { tags: t.tiers.map((x) => `tier:${x}`) } : {}) }))
  }
  for (const cp of prompts.system) {
    for (const s of cp.sections) {
      const chars = JSON.stringify(s.children).length
      items.push(makeItem('section', s.id, { cost: { chars }, attach: { when: 'always' }, provenance: { source: cp.compiler === 'markdown' ? 'prompt-md' : 'prompt-tsx', ...(s.source?.path ? { path: s.source.path } : {}) }, tags: [`scope:${s.scope}`] }))
    }
  }
  for (const [name, p] of Object.entries(repo.config.providers ?? {})) {
    if (p.builtin) continue
    items.push(makeItem('datum', name, { provenance: { source: `provider:${p.kind}`, ...(p.path ? { path: p.path } : {}) } }))
  }
  return normalizeItems(items)
}

// ───────────────────────── gate decision ─────────────────────────

export interface GateFlags { tier?: string; profile?: string; model?: string; paths?: string[]; branch?: string }

export function decide(config: GateConfig, items: readonly Item[], flags: GateFlags, data: Record<string, unknown> = {}): Gate {
  const model = flags.model
  const signals: Signals = {
    paths: flags.paths ?? [],
    ...(flags.branch ? { branch: flags.branch } : {}),
    ...(model ? { model } : {}),
    ...(flags.profile ? { manual: { profile: flags.profile, add: [], remove: [] } } : {}),
    data,
  }
  const evalExpr = (expr: string, d: Record<string, unknown>): boolean => {
    const v = evalSource(expr, d as Record<string, Value>, newBudget())
    return !!v && v !== 0 && v !== ''
  }
  const { gate } = decideGate(config, signals, { turn: 0 }, items, { evalExpr, ...(flags.tier ? { tier: flags.tier } : {}) })
  return gate
}

// ───────────────────────── providers ─────────────────────────

function fill(template: string[], args: Value[], kwargs: Record<string, Value>): string[] {
  let i = 0
  const str = (v: Value | undefined): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))
  return template.map((part) => part.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (/^\d+$/.test(name)) return str(args[Number(name)])
    if (name in kwargs) return str(kwargs[name])
    return str(args[i++])
  }))
}

export interface ProviderOptions { repo: Repo; host: NodeHost; rules: MdcRule[]; liveGit: boolean; onlyNames?: Set<string> }

/** Provider values and functions: builtin git/fs/cursor/scripts plus `cli` / `file` / `module` / `mcp` from gate.json. */
export class Providers {
  o: ProviderOptions
  values: Record<string, Value> = {}
  failed: { name: string; mode: 'unverified' | 'skip' | 'fail'; message: string }[] = []
  private moduleFiles = new Map<string, string | undefined>()

  constructor(o: ProviderOptions) { this.o = o }

  get cfg(): Record<string, ProviderConfig> {
    const out: Record<string, ProviderConfig> = { ...(this.o.repo.config.providers ?? {}) }
    // `.claude/prompt/lib/*.ts` are module providers named by file.
    const lib = join(this.o.repo.root, this.o.repo.promptDir, 'lib')
    if (existsSync(lib)) {
      for (const f of readdirSync(lib).sort()) {
        const m = /^([\w-]+)\.(ts|mts|js|mjs)$/.exec(f)
        if (m && !out[m[1]!]) out[m[1]!] = { kind: 'module', path: posix(join(this.o.repo.promptDir, 'lib', f)) }
      }
    }
    return out
  }

  callables(): string[] {
    const out = ['git.log', 'fs.examples', 'fs.glob', 'fs.exists', 'cursor.match', 'scripts.*']
    for (const [name, p] of Object.entries(this.cfg)) if (!p.builtin && !BUILTIN_PROVIDERS.has(name)) out.push(`${name}.*`)
    return out
  }

  private fail(name: string, p: ProviderConfig, message: string): Value {
    const mode = p.onError ?? 'unverified'
    this.failed.push({ name, mode, message })
    this.o.host.note({ code: 'G203', severity: mode === 'fail' ? 'error' : 'warning', message: `Провайдер ${name}: ${message}`, hint: `onError: ${mode}` })
    return null
  }

  private untrusted(name: string, what: string): Value {
    this.o.host.note({ code: 'G204', severity: 'warning', message: `Провайдер ${name} (${what}) не запущено: репозиторій не довірений`, hint: 'context-gate trust grant або --trust-repo' })
    return null
  }

  private async cached(key: string, ttl: string | undefined, compute: () => Promise<Value | undefined>): Promise<Value | undefined> {
    const ttlMs = parseDuration(ttl)
    const host = this.o.host
    if (ttlMs !== undefined) {
      const e = await host.cacheGet(key)
      if (e && Date.now() - e.at <= ttlMs) return e.value
    }
    if (host.dryScripts) {
      const e = await host.cacheGet(key)
      if (e) return e.value
    }
    const v = await compute()
    if (v !== undefined && ttlMs !== undefined) await host.cacheSet(key, v)
    return v
  }

  private async cliRun(name: string, p: ProviderConfig, argv: string[]): Promise<Value> {
    const host = this.o.host
    if (!host.trusted) return this.untrusted(name, argv[0] ?? 'cli')
    if (!host.allowed(argv[0] ?? '')) return this.fail(name, p, `бінарник ${argv[0]} поза білим списком (~/.claude/context-gate.json allowBinaries)`)
    const key = `prov:${name}:${sha256(JSON.stringify(argv)).slice(0, 16)}`
    const v = await this.cached(key, p.cache, async () => {
      if (host.dryScripts) return undefined
      host.processes++
      const r = await runProcess(argv, { cwd: this.o.repo.root, timeoutMs: 10_000 })
      const res = providerResultOk(p, r.exitCode, r.stdout)
      if (!res.ok) { this.fail(name, p, `${res.error}: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}`); return undefined }
      return res.value
    })
    return v === undefined ? null : pickFields(v, p.pick)
  }

  /**
   * Bundles a module provider with esbuild, keyed by the hashes of every bundled input (the entry and its
   * imports) and the esbuild version: editing a helper rebuilds it. npm imports stay external, so the bundle is
   * written where Node resolves them from the repo — `<root>/node_modules/.cache/context-gate/modules/` when the
   * repo has node_modules, else the per-repo cache dir.
   */
  private async moduleFile(name: string, p: ProviderConfig): Promise<string | undefined> {
    if (this.moduleFiles.has(name)) return this.moduleFiles.get(name)
    const root = this.o.repo.root
    const src = p.path ? safeJoin(root, p.path) : undefined
    let out: string | undefined
    if (src && existsSync(src)) {
      const dir = existsSync(join(root, 'node_modules')) ? join(root, 'node_modules', '.cache', 'context-gate', 'modules') : join(this.o.repo.cacheDir, 'modules')
      const manifestPath = join(dir, `${name}-${sha256(src).slice(0, 12)}.inputs.json`)
      const manifest = readJson<{ out: string; esbuild?: string; inputs: { path: string; hash: string }[] }>(manifestPath)
      // A bundle of another esbuild version is stale too; with no esbuild at all (the installed plugin ships none) a
      // bundle whose inputs are unchanged is still used.
      const available = await loadEsbuild(root).catch(() => undefined)
      const version = (available as { version?: string } | undefined)?.version
      const fresh = (m: typeof manifest): boolean => !!m && (!version || m.esbuild === version) && existsSync(join(dir, m.out)) && m.inputs.every((i) => { try { return sha256(readFileSync(resolve(root, i.path))) === i.hash } catch { return false } })
      if (fresh(manifest)) out = join(dir, manifest!.out)
      else {
        try {
          const esbuild = available ?? (await loadEsbuild(root))
          const r = await esbuild.build({ entryPoints: [src], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, outdir: dir, metafile: true, absWorkingDir: root, logLevel: 'silent', packages: 'external', loader: { '.md': 'text', '.txt': 'text' } })
          const code = r.outputFiles[0]!.contents
          const inputs = Object.keys(r.metafile.inputs).filter((i) => !i.includes(':')).map((i) => ({ path: i, hash: (() => { try { return sha256(readFileSync(resolve(root, i))) } catch { return 'missing' } })() }))
          const file = `${name}-${sha256(Buffer.from(code)).slice(0, 16)}.mjs`
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, file), code)
          writeJson(manifestPath, { out: file, esbuild: (esbuild as { version?: string }).version, inputs })
          out = join(dir, file)
        } catch (e) {
          this.fail(name, p, `збірка модуля ${p.path}: ${String((e as Error).message).split('\n')[0]}`)
          out = undefined
        }
      }
    } else this.fail(name, p, `модуль ${p.path ?? '(немає path)'} не знайдено`)
    this.moduleFiles.set(name, out)
    return out
  }

  private async moduleCall(name: string, p: ProviderConfig, fn: string, args: Value[], kwargs: Record<string, Value>): Promise<Value> {
    const host = this.o.host
    if (!host.trusted) return this.untrusted(name, 'module')
    const file = await this.moduleFile(name, p)
    if (!file) return null
    // The bundle's name carries the hash of its content, so a changed import invalidates cached results too.
    const key = `prov:${name}:${basename(file)}:${fn}:${sha256(JSON.stringify([args, kwargs])).slice(0, 16)}`
    const v = await this.cached(key, p.cache, async () => {
      if (host.dryScripts) return undefined
      const rel = posix(relative(host.root, file))
      const inRepo = !rel.startsWith('..') && !!host.abs(rel) // a symlinked node_modules resolves outside: absolute shim
      const r = inRepo ? await host.shim(rel, [{ fn, args, kwargs }]) : await shimAbs(host, file, [{ fn, args, kwargs }])
      if (r.errors[0]) { this.fail(name, p, r.errors[0]); return undefined }
      return r.results[0] ?? null
    })
    return v === undefined ? null : fn === '__default__' ? pickFields(v, p.pick) : v
  }

  /** Value of a non-builtin provider (computed once per render). */
  async value(name: string): Promise<Value> {
    if (name in this.values) return this.values[name]!
    const p = this.cfg[name]
    let v: Value = null
    if (!p || p.builtin) v = null
    else if (p.kind === 'file') {
      const text = p.path ? await this.o.host.readFile(p.path) : undefined
      if (text === undefined) v = this.fail(name, p, `файл ${p.path} не знайдено`)
      else {
        const f = fileProviderValue(p.path!, text, p.pick)
        v = 'markdown' in f ? markdownValue(text) : 'error' in f ? this.fail(name, p, f.error) : f.value
      }
    } else if (p.kind === 'cli') v = p.command?.length ? await this.cliRun(name, p, p.command) : null
    else if (p.kind === 'module') v = await this.moduleCall(name, p, '__default__', [], {})
    else if (p.kind === 'mcp') {
      this.o.host.note({ code: 'G205', severity: 'info', message: `Провайдер ${name} (mcp ${p.tool ?? ''}) недоступний у CLI — значення unverified`, hint: 'MCP працює лише всередині Claude Code (mod)' })
      v = null
    }
    this.values[name] = v
    return v
  }

  /**
   * Values for providers referenced by the prompts (all when `names` is undefined), in parallel under one shared
   * deadline (P2): a provider still running at `deadlineMs` is `null` with a G203 warning instead of holding the
   * whole render (its process is still bounded by its own 10 s timeout).
   */
  async resolveAll(names?: Set<string>, deadlineMs = PROVIDERS_DEADLINE_MS): Promise<Record<string, Value>> {
    const out: Record<string, Value> = {}
    const todo = Object.keys(this.cfg).filter((n) => !BUILTIN_PROVIDERS.has(n) && !this.cfg[n]!.builtin && (!names || names.has(n)))
    if (!todo.length) return out
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<'late'>((done) => { timer = setTimeout(() => done('late'), deadlineMs) })
    await Promise.all(todo.map(async (n) => {
      const v = await Promise.race([this.value(n), deadline])
      if (v === 'late') {
        out[n] = null
        this.o.host.note({ code: 'G203', severity: 'warning', message: `Провайдер ${n}: не встиг за спільний дедлайн ${Math.round(deadlineMs / 1000)} с — значення null`, hint: 'додай cache або pick, або винеси повільну команду з рендера' })
      } else out[n] = v
    }))
    if (timer) clearTimeout(timer)
    return out
  }

  /** `host.provider`: functions `git.log`, `fs.*`, `cursor.match`, `scripts.*`, `<provider>.<fn>`. */
  async call(req: ProviderCallRequest): Promise<Value> {
    const { ns, fn, args, kwargs } = req
    const root = this.o.repo.root
    if (ns === 'git' && fn === 'log') return this.o.liveGit ? gitLog(root, typeof args[0] === 'number' ? args[0] : 10) : []
    if (ns === 'fs' && fn === 'examples') return fsExamples(root, String(args[0] ?? '**/*'), typeof args[1] === 'number' ? args[1] : 1)
    if (ns === 'fs' && fn === 'glob') { const m = compileGlob(String(args[0] ?? ''), { matchBase: true }); return walkFiles(root).filter((f) => m(f)) }
    if (ns === 'fs' && fn === 'exists') { const p = this.o.host.abs(String(args[0] ?? '')); return !!p && existsSync(p) }
    if (ns === 'cursor' && fn === 'match') return cursorMatch(this.o.rules, String(args[0] ?? ''), { nocase: detectWindows(root) })
    if (ns === 'scripts') return this.script(fn, args, kwargs, req.timeoutMs)
    const p = this.cfg[ns]
    if (!p) return null
    if (p.kind === 'cli') {
      const fns = p.functions
      const tpl = fns && !Array.isArray(fns) ? fns[fn] : undefined
      if (tpl) return this.cliRun(ns, p, fill(tpl, args, kwargs))
      if (Array.isArray(fns) && fns.includes(fn) && p.command) return this.cliRun(ns, p, [...p.command, fn, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))])
      return null
    }
    if (p.kind === 'module') return this.moduleCall(ns, p, fn, args, kwargs)
    if (p.kind === 'mcp') { await this.value(ns); return null }
    if (p.kind === 'file') { const v = await this.value(ns); return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Value>)[fn] ?? null : null }
    return null
  }

  /** `scripts.<name>(…)`: run `.claude/prompt/scripts/<name>.*` with `{ ctx, args }` on stdin. */
  private async script(fn: string, args: Value[], kwargs: Record<string, Value>, timeoutMs?: number): Promise<Value> {
    const host = this.o.host
    const file = scriptFiles(this.o.repo).find((f) => scriptFnName(f) === fn)
    const p: ProviderConfig = { kind: 'cli', onError: 'unverified', cache: this.o.repo.config.prompt?.runCacheDefault ?? '5m' }
    if (!file) return this.fail(`scripts.${fn}`, p, `скрипт ${fn} не знайдено в ${this.o.repo.promptDir}/scripts`)
    if (!host.trusted) return this.untrusted(`scripts.${fn}`, file)
    const text = readText(join(this.o.repo.root, file)) ?? ''
    const lang = scriptLang(file, text)
    const interp: Record<string, string[]> = { bash: ['bash'], node: ['node'], python: ['python3'], deno: ['deno', 'run', '--no-prompt', '--allow-read=.'] }
    const argv = [...(interp[lang ?? ''] ?? [lang ?? 'sh']), join(this.o.repo.root, file)]
    if (!host.allowed(argv[0]!)) return this.fail(`scripts.${fn}`, p, `бінарник ${argv[0]} поза білим списком`)
    const key = `scripts:${fn}:${sha256(text).slice(0, 16)}:${sha256(JSON.stringify([args, kwargs])).slice(0, 16)}`
    const v = await this.cached(key, p.cache, async () => {
      if (host.dryScripts) return undefined
      host.processes++
      const r = await runProcess(argv, { cwd: this.o.repo.root, stdin: JSON.stringify({ ctx: {}, args: Object.keys(kwargs).length ? [...args, kwargs] : args }), timeoutMs: timeoutMs !== undefined && timeoutMs > 0 ? Math.min(timeoutMs, 10_000) : 10_000 })
      if (r.exitCode !== 0) { this.fail(`scripts.${fn}`, p, `exit ${r.exitCode}: ${r.stderr.trim().split('\n')[0] ?? ''}`); return undefined }
      return parseLoose(r.stdout)
    })
    return v ?? null
  }
}

async function shimAbs(host: NodeHost, file: string, calls: { fn: string; args: Value[]; kwargs?: Record<string, Value> }[]) {
  // Bundled module providers in the cache dir: the node shim on the absolute path, under the same whitelist.
  if (!host.allowed('node')) {
    host.note({ code: 'G201', severity: 'warning', message: 'Бінарник «node» поза білим списком ~/.claude/context-gate.json (allowBinaries)' })
    return { results: calls.map(() => null), errors: calls.map(() => 'бінарник node не дозволено') }
  }
  host.processes++
  const r = await runProcess(['node', '--input-type=module', '-e', NODE_SHIM], { cwd: host.root, stdin: JSON.stringify({ file, calls }), timeoutMs: 10_000 })
  try { return JSON.parse(r.stdout) as { results: Value[]; errors: (string | null)[] } } catch { return { results: calls.map(() => null), errors: calls.map(() => `exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`) } }
}

// ───────────────────────── session snapshots ─────────────────────────

export type { Snapshot }

/** Latest (or `<id>`) snapshot from `.claude/gate.log.jsonl` (the mod writes it with `log.file: true`); core `findSnapshot`. */
export function readSnapshot(root: string, which: string): Snapshot | undefined {
  const text = readText(join(root, '.claude', 'gate.log.jsonl'))
  if (!text) return undefined
  return findSnapshot(fromJsonl<unknown>(text).items, which)
}

// ───────────────────────── the whole context ─────────────────────────

export interface ContextOptions extends GateFlags {
  root: string
  ctxFrom?: string
  trustRepo?: boolean
  dryScripts?: boolean
  args?: Record<string, Value>
  /** Names referenced by the prompts: only those providers are resolved (default all). */
  providerNames?: Set<string>
  /** Compiled prompts to use instead of `.compiled` (an in-memory build: bench). */
  compiled?: CompiledPrompt[]
}

export interface RenderContext {
  repo: Repo
  gate: Gate
  tier: Tier
  scope: Record<string, Value>
  host: NodeHost
  providers: Providers
  rules: MdcRule[]
  diagnostics: Diagnostic[]
  trust: TrustState
  source: 'live' | 'session' | 'fixture'
  snapshot?: Snapshot
  prompts: PromptSet & { compiledFrom: string }
}

function deepMerge(a: Record<string, Value>, b: Record<string, Value>): Record<string, Value> {
  const out: Record<string, Value> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) ? deepMerge(cur as Record<string, Value>, v as Record<string, Value>) : v
  }
  return out
}

/** Which of `candidates` (provider names) the prompts mention as an identifier (expressions or text). */
export function referencedNames(prompts: readonly CompiledPrompt[], candidates: Iterable<string>): Set<string> {
  const s = JSON.stringify(prompts)
  const out = new Set<string>()
  for (const name of candidates) if (new RegExp(`(?<![\\w.$-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(s)) out.add(name)
  return out
}

function providerWhy(providers: Providers, host: NodeHost, name: string): string {
  const f = providers.failed.find((x) => x.name === name)
  if (f) return f.message
  const p = providers.cfg[name]
  if (!host.trusted && p && (p.kind === 'cli' || p.kind === 'module')) return 'репозиторій не довірений (trust grant або --trust-repo)'
  if (p?.kind === 'mcp') return 'MCP працює лише в mod'
  if (host.dryScripts) return 'немає кешованого значення (--dry-scripts)'
  return 'немає даних'
}

/**
 * Every item of the repo with the `provider` rule sources resolved (async): what `collect` and `report` use, so they
 * see the same rules as `run` / `decide`. Provider data is loaded only when the repo is trusted (cli / module) —
 * otherwise, and for any source without data, an `unverified` placeholder item stands for its rules.
 */
export async function collectRepoItems(repo: Repo, o: { trustRepo?: boolean; dryScripts?: boolean } = {}): Promise<{ items: Item[]; rules: MdcRule[]; diagnostics: Diagnostic[] }> {
  const { rules, diagnostics } = loadRules(repo.root, repo.config)
  let extra: Item[] = []
  if (ruleSourcesOf(repo.config).some((s) => s.kind === 'provider' && s.name)) {
    const trust = trustState(repo.root, repo.config, { flag: o.trustRepo })
    const host = new NodeHost({ root: repo.root, config: repo.config, trusted: trust.trusted, dryScripts: o.dryScripts, cacheDir: repo.cacheDir, ...(repo.narrowBinaries ? { narrowBinaries: repo.narrowBinaries } : {}) })
    const providers = new Providers({ repo, host, rules, liveGit: false })
    const pr = await loadProviderRules(repo.config, (name) => providers.value(name))
    rules.push(...pr.rules)
    diagnostics.push(...pr.diagnostics, ...host.notes)
    extra = unverifiedProviderRuleItems(pr.missing, (n) => providerWhy(providers, host, n))
  }
  return { items: collectItems(repo, rules, extra), rules, diagnostics }
}

export async function buildContext(o: ContextOptions): Promise<RenderContext> {
  const root = resolve(o.root)
  const repo = loadRepo(root)
  const diagnostics: Diagnostic[] = [...repo.configDiagnostics]
  const ctxFrom = o.ctxFrom ?? 'live'
  const source: RenderContext['source'] = ctxFrom.startsWith('session:') ? 'session' : ctxFrom === 'live' ? 'live' : 'fixture'
  const snapshot = source === 'session' ? readSnapshot(root, ctxFrom.slice('session:'.length)) : undefined
  if (source === 'session' && !snapshot) diagnostics.push({ code: 'G206', severity: 'warning', message: `Знімок ${ctxFrom} не знайдено в .claude/gate.log.jsonl — використано живий контекст` })
  let fixture: Record<string, Value> | undefined
  if (source === 'fixture') {
    const f = readJson<Record<string, Value>>(resolve(root, ctxFrom)) ?? readJson<Record<string, Value>>(resolve(ctxFrom))
    if (!f || typeof f !== 'object') diagnostics.push({ code: 'G206', severity: 'error', message: `Fixture ${ctxFrom} не знайдено або це не JSON-об'єкт` })
    else fixture = f
  }
  const fixGate = (fixture?.gate ?? {}) as Record<string, Value>
  const flags: GateFlags = {
    tier: o.tier ?? (typeof fixGate.tier === 'string' ? fixGate.tier : undefined) ?? (o.model ? undefined : snapshot?.tier),
    profile: o.profile ?? (typeof fixGate.profile === 'string' ? fixGate.profile : undefined) ?? snapshot?.profile,
    model: o.model ?? snapshot?.model ?? (typeof (fixture?.session as Record<string, Value> | undefined)?.model === 'string' ? String((fixture!.session as Record<string, Value>).model) : undefined),
  }
  const live = source === 'live' || (source === 'session' && !snapshot?.scope)
  const { rules, diagnostics: ruleDiags } = loadRules(root, repo.config)
  diagnostics.push(...ruleDiags)
  const git = live ? await gitInfo(root, diagnostics) : undefined
  const trust = trustState(root, repo.config, { flag: o.trustRepo, ...(typeof git?.remote === 'string' ? { remote: git.remote } : {}) })
  const host = new NodeHost({ root, config: repo.config, trusted: trust.trusted, dryScripts: o.dryScripts, cacheDir: repo.cacheDir, ...(repo.narrowBinaries ? { narrowBinaries: repo.narrowBinaries } : {}) })
  const providers = new Providers({ repo, host, rules, liveGit: live })
  host.provider = (req) => providers.call(req)
  host.callables = providers.callables()
  // `provider` rule sources (G-51) need provider values, so they join the rules before items and the gate.
  let unverifiedRules: Item[] = []
  if (live) {
    const pr = await loadProviderRules(repo.config, (name) => providers.value(name))
    rules.push(...pr.rules)
    diagnostics.push(...pr.diagnostics)
    unverifiedRules = unverifiedProviderRuleItems(pr.missing, (n) => providerWhy(providers, host, n))
  }
  host.rules = rules.map((r) => ({ id: r.id, path: r.path, body: r.body, ...(r.description ? { description: r.description } : {}) }))
  const items = collectItems(repo, rules, unverifiedRules)
  const gate = decide(repo.config, items, { ...flags, paths: o.paths ?? (live ? ((git?.changed as string[] | undefined) ?? []) : []), branch: o.branch ?? (typeof git?.branch === 'string' ? git.branch : undefined) }, {})
  const tier = gate.tier
  const prompts = loadPrompts(repo, tier, gate.skills.preload, o.compiled)
  diagnostics.push(...prompts.diagnostics)
  let scope: Record<string, Value>
  if (snapshot?.scope) {
    scope = { ...snapshot.scope }
    if (o.args) scope.args = o.args
    else if (snapshot.args) scope.args = snapshot.args
  } else {
    const names = o.providerNames ?? referencedNames([...prompts.system, ...Object.values(prompts.skills)], Object.keys(providers.cfg))
    const providerValues = source === 'fixture' ? {} : await providers.resolveAll(names)
    scope = buildScope({
      config: repo.config,
      gate,
      ...(git ? { git } : {}),
      rules,
      session: { id: snapshot?.sessionId ?? 'cli', model: flags.model ?? '', cwd: process.cwd(), root, turn: 0 },
      ...(snapshot?.ctxPercent !== undefined ? { ctxPercent: snapshot.ctxPercent } : {}),
      data: dataScope(loadData(repo)),
      args: o.args ?? snapshot?.args ?? {},
      providers: { ...providerValues, env: filterEnv(process.env, repo.config.env) },
    })
    if (fixture) {
      const { gate: _g, ...rest } = fixture
      scope = deepMerge(scope, rest)
      scope.gate = deepMerge(scope.gate as Record<string, Value>, { ...fixGate, tier })
      if (o.args) scope.args = o.args
    }
  }
  return { repo, gate, tier, scope, host, providers, rules, diagnostics, trust, source, ...(snapshot ? { snapshot } : {}), prompts }
}

// ───────────────────────── serving model tools ─────────────────────────

export type ToolCallResult = { result: string } | { deny: string } | { isError: true; result: string }

/**
 * Serve one model tool like the mod's `serveOwnTool`: gate (`tool:<name>` off → deny), `tiers`, trust, then a
 * function tool through the language shim (input as kwargs) or a whole script with `{ args, ctx }` on stdin.
 */
export async function callScriptTool(ctx: RenderContext, name: string, input: Record<string, Value>): Promise<ToolCallResult> {
  const all = [...ctx.prompts.system, ...Object.values(ctx.prompts.skills)]
  const tool = scriptTools(ctx.repo, all).tools.find((t) => t.name === name)
  if (!tool) return { isError: true, result: `Інструмент ${name} не знайдено (# gate-tool: у scripts/ або над експортом модуля)` }
  if (ctx.gate.items[`tool:${name}`] === 'off') return { deny: `Інструмент ${name} вимкнено профілем ${ctx.gate.profile ?? '—'}` }
  if (tool.tiers && !tool.tiers.includes(ctx.tier)) return { deny: `Інструмент ${name} недоступний для tier ${ctx.tier} (tiers: ${tool.tiers.join(', ')})` }
  if (!ctx.host.trusted) return { deny: `Інструмент ${name}: репозиторій не довірений` }
  if (tool.fn) {
    const r = await ctx.host.shim(tool.path, [{ fn: tool.fn, args: [], kwargs: input }], 30_000)
    if (r.errors[0]) return { isError: true, result: r.errors[0] }
    const v = r.results[0]
    return { result: typeof v === 'string' ? v : JSON.stringify(v ?? null) }
  }
  const abs = join(ctx.repo.root, tool.path)
  const argv = scriptArgv(abs, scriptLang(tool.path, readText(abs) ?? ''))
  if (!ctx.host.allowed(argv[0]!)) return { deny: `Інструмент ${name}: ${argv[0]} не в білому списку бінарників` }
  ctx.host.processes++
  const r = await runProcess(argv, { cwd: ctx.repo.root, stdin: JSON.stringify({ args: input, ctx: { tier: ctx.tier, profile: ctx.gate.profile ?? null } }), timeoutMs: 30_000 })
  if (r.exitCode !== 0) return { isError: true, result: `exit ${r.exitCode}\n${r.stderr.slice(-2000)}` }
  return { result: r.stdout }
}
