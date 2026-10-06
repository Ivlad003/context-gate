// Render context for the CLI (SPEC «Автономний інтерпретатор», «Провайдери»): live repo (git, cursor rules,
// gate decision, providers), a session snapshot from `.claude/gate.log.jsonl`, or a fixture JSON.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import type { CompiledPrompt, Diagnostic, Gate, GateConfig, Item, MdcRule, ProviderConfig, Signals, Tier, Value } from '../../core/src/types.ts'
import type { ProviderCallRequest } from '../../core/src/render.ts'
import { loadConfig, tierForModel } from '../../core/src/config.ts'
import { decideGate } from '../../core/src/decide.ts'
import { evalSource, newBudget } from '../../core/src/expr.ts'
import { parseMdc, ruleIdFromPath, ruleToItem } from '../../core/src/mdc.ts'
import { compileGlob, detectWindows } from '../../core/src/glob.ts'
import { exampleValue, selectExamples } from '../../core/src/examples.ts'
import { makeItem, normalizeItems } from '../../core/src/items.ts'
import { parseDuration } from '../../core/src/duration.ts'
import { findSnapshot, fromJsonl, type Snapshot } from '../../core/src/journal.ts'
import { splitFrontmatter } from './build.ts'
import { assemblePrompts, buildScope, cursorMatch, dataScope, type DataEntry, type MarkdownFile, type PromptSet } from '../../core/src/assemble.ts'
import { NodeHost, listSkills } from './host-node.ts'
import { parseToolHeader } from '../../core/src/toolheader.ts'
import { scriptFnName, scriptLang } from './scripts.ts'
import { NODE_SHIM } from './shims.ts'
import { repoCacheDir, trustState, type TrustState } from './settings.ts'
import { posix, readJson, readText, runProcess, sha256, walkFiles, writeJson } from './util.ts'

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

export function loadRepo(root: string): Repo {
  const text = readText(join(root, '.claude', 'gate.json'))
  const { config, diagnostics } = loadConfig(text)
  const cfg = config ?? loadConfig(undefined).config!
  const narrow = config?.allowBinaries
  const diags = diagnostics
  return { root, config: cfg, configDiagnostics: diags, hasConfig: text !== undefined, promptDir: cfg.prompt?.dir ?? '.claude/prompt', cacheDir: repoCacheDir(root), ...(narrow ? { narrowBinaries: narrow } : {}) }
}

// ───────────────────────── cursor rules ─────────────────────────

export function findMdcFiles(root: string, config: GateConfig): string[] {
  const dirs = new Set<string>(['.cursor/rules'])
  for (const s of [...(config.itemSources ?? []), ...(config.ruleSources ?? [])]) if (s.kind === 'cursor-mdc' && s.dir) dirs.add(s.dir.replace(/\/+$/, ''))
  const out = new Set<string>()
  for (const d of dirs) for (const f of walkFiles(root, { under: d })) if (f.endsWith('.mdc')) out.add(f)
  if (config.cursorRules?.nested || [...(config.itemSources ?? []), ...(config.ruleSources ?? [])].some((s) => s.kind === 'cursor-mdc' && s.nested)) {
    for (const f of walkFiles(root)) if (/(^|\/)\.cursor\/rules\/.+\.mdc$/.test(f)) out.add(f)
  }
  return [...out].sort()
}

export function loadRules(root: string, config: GateConfig): { rules: MdcRule[]; diagnostics: Diagnostic[] } {
  const rules: MdcRule[] = []
  const diagnostics: Diagnostic[] = []
  if (config.cursorRules?.enabled === false) return { rules, diagnostics }
  for (const path of findMdcFiles(root, config)) {
    const text = readText(join(root, path))
    if (text === undefined) continue
    const { id, dirPrefix } = ruleIdFromPath(path)
    const r = parseMdc(text, { path, id, dirPrefix })
    rules.push(r.rule)
    diagnostics.push(...r.diagnostics)
  }
  return { rules, diagnostics }
}

// ───────────────────────── git ─────────────────────────

async function git(root: string, args: string[]): Promise<string | undefined> {
  const r = await runProcess(['git', ...args], { cwd: root, timeoutMs: 5000 })
  return r.exitCode === 0 ? r.stdout : undefined
}

export async function gitInfo(root: string): Promise<Record<string, Value>> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'])
  const base: Record<string, Value> = { branch: '', head: '', dirty: false, ahead: 0, behind: 0, changed: [], name: basename(root), remote: '' }
  if (!inside || inside.trim() !== 'true') return base
  const [branch, head, status, remote, counts] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['rev-parse', '--short', 'HEAD']),
    git(root, ['status', '--porcelain']),
    git(root, ['config', '--get', 'remote.origin.url']),
    git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
  ])
  const changed = (status ?? '').split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''))
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
  const dir = dataDir(repo)
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue
      const key = f.slice(0, -5)
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

export function setData(repo: Repo, key: string, value: Value, opts: { cache?: string; persist?: boolean; fetchedAt?: number } = {}): string[] {
  const written: string[] = []
  const now = opts.fetchedAt ?? Date.now()
  if (opts.persist ?? true) {
    const p = join(dataDir(repo), `${key}.json`)
    writeJson(p, value)
    written.push(posix(relative(repo.root, p)))
  }
  const metaP = dataMetaPath(repo)
  const meta = readJson<Record<string, { fetchedAt?: number; cache?: string }>>(metaP) ?? {}
  meta[key] = { fetchedAt: now, ...(opts.cache ? { cache: opts.cache } : {}) }
  writeJson(metaP, meta)
  const storeP = join(repo.cacheDir, 'data.json')
  const store = readJson<Record<string, { value: Value; at: number; cache?: string }>>(storeP) ?? {}
  store[key] = { value, at: now, ...(opts.cache ? { cache: opts.cache } : {}) }
  writeJson(storeP, store)
  return written
}

export function validDataKey(key: string): boolean {
  return /^[\w][\w.-]{0,127}$/.test(key) && !key.includes('..')
}

// ───────────────────────── prompts ─────────────────────────

export function loadCompiled(repo: Repo): { compiled: CompiledPrompt[]; from: 'repo' | 'cache' | 'none' } {
  const read = (dir: string): CompiledPrompt[] => {
    if (!existsSync(dir)) return []
    const out: CompiledPrompt[] = []
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue
      const cp = readJson<CompiledPrompt>(join(dir, f))
      if (cp && cp.version === 1 && Array.isArray(cp.sections)) out.push(cp)
    }
    return out
  }
  const own = read(join(repo.root, repo.promptDir, '.compiled'))
  if (own.length) return { compiled: own, from: 'repo' }
  const cached = read(join(repo.cacheDir, 'compiled'))
  return cached.length ? { compiled: cached, from: 'cache' } : { compiled: [], from: 'none' }
}

export function loadMarkdown(repo: Repo): MarkdownFile[] {
  const dir = join(repo.root, repo.promptDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md') && !/^readme\.md$/i.test(d.name))
    .map((d) => ({ path: posix(join(repo.promptDir, d.name)), text: readFileSync(join(dir, d.name), 'utf8') }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

export function loadPrompts(repo: Repo, tier: Tier): PromptSet & { compiledFrom: string } {
  const { compiled, from } = loadCompiled(repo)
  const set = assemblePrompts(compiled, loadMarkdown(repo), tier, Object.keys(repo.config.tiers ?? {}))
  return { ...set, compiledFrom: from }
}

// ───────────────────────── items (collect) ─────────────────────────

export function scriptFiles(repo: Repo): string[] {
  const dir = join(repo.promptDir, 'scripts')
  return existsSync(join(repo.root, dir)) ? walkFiles(repo.root, { under: dir }) : []
}

export function collectItems(repo: Repo, rules?: MdcRule[]): Item[] {
  const items: Item[] = []
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
  for (const f of scriptFiles(repo)) {
    const { header } = parseToolHeader(readText(join(repo.root, f)) ?? '')
    if (header) items.push(makeItem('tool', header.name, { provenance: { source: 'gate-tool', path: f }, ...(header.description ? { description: header.description } : {}), ...(header.tiers ? { tags: header.tiers.map((t) => `tier:${t}`) } : {}) }))
  }
  const prompts = loadPrompts(repo, 'standard')
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

function pickFields(v: Value, pick: string[] | undefined): Value {
  if (!pick?.length || !v || typeof v !== 'object' || Array.isArray(v)) return v
  const out: Record<string, Value> = {}
  for (const p of pick) {
    const parts = p.split('.')
    let cur: Value | undefined = v
    for (const k of parts) cur = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, Value>)[k] : undefined
    if (cur === undefined) continue
    let o = out
    for (const k of parts.slice(0, -1)) o = (o[k] ??= {}) as Record<string, Value>
    o[parts[parts.length - 1]!] = cur
  }
  return out
}

function parseLoose(stdout: string): Value {
  const t = stdout.trim()
  if (!t) return null
  try { return JSON.parse(t) as Value } catch { return t }
}

/** Markdown file provider: `{ body, meta, headings }`. */
function markdownValue(text: string): Value {
  const { meta, body } = splitFrontmatter(text)
  const headings = [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({ level: m[1]!.length, text: m[2]!.trim() }))
  return { meta: JSON.parse(JSON.stringify(meta)) as Value, body, headings }
}

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
      if (r.exitCode !== 0) { this.fail(name, p, `exit ${r.exitCode}: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}`); return undefined }
      return parseLoose(r.stdout)
    })
    return v === undefined ? null : pickFields(v, p.pick)
  }

  /** Bundles a module provider with esbuild into the cache (once per content hash). */
  private async moduleFile(name: string, p: ProviderConfig): Promise<string | undefined> {
    if (this.moduleFiles.has(name)) return this.moduleFiles.get(name)
    const src = p.path ? resolve(this.o.repo.root, p.path) : undefined
    let out: string | undefined
    if (src && existsSync(src)) {
      const hash = sha256(readFileSync(src)).slice(0, 16)
      out = join(this.o.repo.cacheDir, 'modules', `${name}-${hash}.mjs`)
      if (!existsSync(out)) {
        try {
          await esbuild.build({ entryPoints: [src], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: out, logLevel: 'silent', packages: 'external', loader: { '.md': 'text', '.txt': 'text' } })
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
    const key = `prov:${name}:${basename(file)}:${fn}:${sha256(JSON.stringify([args, kwargs])).slice(0, 16)}`
    const v = await this.cached(key, p.cache, async () => {
      if (host.dryScripts) return undefined
      const rel = posix(relative(host.root, file))
      const inRepo = !rel.startsWith('..')
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
      else if (/\.json$/i.test(p.path!)) {
        try { v = pickFields(JSON.parse(text) as Value, p.pick) } catch (e) { v = this.fail(name, p, `JSON: ${(e as Error).message}`) }
      } else v = /\.mdx?$/i.test(p.path!) ? markdownValue(text) : text
    } else if (p.kind === 'cli') v = p.command?.length ? await this.cliRun(name, p, p.command) : null
    else if (p.kind === 'module') v = await this.moduleCall(name, p, '__default__', [], {})
    else if (p.kind === 'mcp') {
      this.o.host.note({ code: 'G205', severity: 'info', message: `Провайдер ${name} (mcp ${p.tool ?? ''}) недоступний у CLI — значення unverified`, hint: 'MCP працює лише всередині Claude Code (mod)' })
      v = null
    }
    this.values[name] = v
    return v
  }

  /** Values for providers referenced by the prompts (all when `names` is undefined). */
  async resolveAll(names?: Set<string>): Promise<Record<string, Value>> {
    const out: Record<string, Value> = {}
    await Promise.all(Object.keys(this.cfg).filter((n) => !BUILTIN_PROVIDERS.has(n) && !this.cfg[n]!.builtin && (!names || names.has(n))).map(async (n) => { out[n] = await this.value(n) }))
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
    if (ns === 'scripts') return this.script(fn, args, kwargs)
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
  private async script(fn: string, args: Value[], kwargs: Record<string, Value>): Promise<Value> {
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
      const r = await runProcess(argv, { cwd: this.o.repo.root, stdin: JSON.stringify({ ctx: {}, args: Object.keys(kwargs).length ? [...args, kwargs] : args }), timeoutMs: 10_000 })
      if (r.exitCode !== 0) { this.fail(`scripts.${fn}`, p, `exit ${r.exitCode}: ${r.stderr.trim().split('\n')[0] ?? ''}`); return undefined }
      return parseLoose(r.stdout)
    })
    return v ?? null
  }
}

async function shimAbs(host: NodeHost, file: string, calls: { fn: string; args: Value[]; kwargs?: Record<string, Value> }[]) {
  // Bundled module providers live in the cache dir: run the node shim on the absolute path.
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
  const git = live ? await gitInfo(root) : undefined
  const items = collectItems(repo, rules)
  const gate = decide(repo.config, items, { ...flags, paths: o.paths ?? (live ? ((git?.changed as string[] | undefined) ?? []) : []), branch: o.branch ?? (typeof git?.branch === 'string' ? git.branch : undefined) }, {})
  const tier = gate.tier
  const prompts = loadPrompts(repo, tier)
  diagnostics.push(...prompts.diagnostics)
  const trust = trustState(root, repo.config, { flag: o.trustRepo, ...(typeof git?.remote === 'string' ? { remote: git.remote } : {}) })
  const host = new NodeHost({ root, config: repo.config, trusted: trust.trusted, dryScripts: o.dryScripts, cacheDir: repo.cacheDir, ...(repo.narrowBinaries ? { narrowBinaries: repo.narrowBinaries } : {}) })
  host.rules = rules.map((r) => ({ id: r.id, path: r.path, body: r.body, ...(r.description ? { description: r.description } : {}) }))
  const providers = new Providers({ repo, host, rules, liveGit: live })
  host.provider = (req) => providers.call(req)
  host.callables = providers.callables()
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
      providers: providerValues,
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
