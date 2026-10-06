// Node-side RenderHost (SPEC «Виконавці скриптів», «Виклик функцій зі скриптових мов», Р2, Р3).
// Untrusted repo → no process and no MCP (the core renders `unverified` stubs); binaries outside the
// user whitelist are refused; cache lives in `~/.cache/context-gate/<repo>/` (XDG_CACHE_HOME respected).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Diagnostic, ExecutorConfig, GateConfig, Value } from '../../core/src/types.ts'
import type { ProviderCallRequest, RenderHostExt } from '../../core/src/render.ts'
import { parseDuration } from '../../core/src/duration.ts'
import { splitFrontmatter } from './build.ts'
import { BASH_SHIM, NODE_SHIM, PYTHON_SHIM, bashArgv, parseBashOutput, shimLang, type ShimCall, type ShimResponse } from './shims.ts'
import { binaryName, binaryWhitelist, readUserSettings, type UserSettings } from './settings.ts'
import { posix, readJson, readText, runProcess, sha256, writeJson } from './util.ts'

export const DEFAULT_EXECUTORS: Record<string, ExecutorConfig> = {
  bash: { command: ['bash', '-euo', 'pipefail', '-c', '{code}'], timeout: '10s' },
  node: { command: ['node', '--input-type=module', '-e', '{code}'], timeout: '10s' },
  python: { command: ['python3', '-c', '{code}'], timeout: '20s', env: { PYTHONDONTWRITEBYTECODE: '1' } },
  deno: { command: ['deno', 'run', '--no-prompt', '--allow-read=.', '-'], stdin: '{code}', timeout: '10s' },
}

const LANG_ALIASES: Record<string, string> = { sh: 'bash', js: 'node', javascript: 'node', ts: 'node', typescript: 'node', py: 'python', python3: 'python' }

export function executorsOf(config: Partial<GateConfig> | undefined): Record<string, ExecutorConfig> {
  return { ...DEFAULT_EXECUTORS, ...(config?.executors ?? {}) }
}

export interface NodeHostOptions {
  root: string
  config: GateConfig
  trusted: boolean
  dryScripts?: boolean
  cacheDir: string
  settings?: UserSettings
  /** Provider dispatcher (context.ts), set after construction. */
  provider?: (req: ProviderCallRequest) => Promise<Value>
  callables?: string[]
  now?: number
  /** Repo narrowing of the user whitelist (`allowBinaries` in gate.json). */
  narrowBinaries?: string[]
}

export interface LazyTool { name: string; description: string; ref: string }

export class NodeHost implements RenderHostExt {
  root: string
  config: GateConfig
  trusted: boolean
  dryScripts: boolean
  cacheDir: string
  settings: UserSettings
  whitelist: Set<string>
  executors: Record<string, ExecutorConfig>
  provider?: (req: ProviderCallRequest) => Promise<Value>
  callables?: string[]
  /** Host-side notes (refused binaries, failed shims) for trace / health. */
  notes: Diagnostic[] = []
  lazies: LazyTool[] = []
  processes = 0
  private t0: number
  private fileHashes = new Map<string, string>()
  private noteKeys = new Set<string>()

  constructor(o: NodeHostOptions) {
    this.root = resolve(o.root)
    this.config = o.config
    this.trusted = o.trusted && (o.settings ?? readUserSettings()).allowScripts !== false
    this.dryScripts = !!o.dryScripts
    this.cacheDir = o.cacheDir
    this.settings = o.settings ?? readUserSettings()
    this.executors = executorsOf(o.config)
    this.whitelist = binaryWhitelist(this.settings, o.narrowBinaries)
    this.provider = o.provider
    this.callables = o.callables
    this.t0 = o.now ?? Date.now()
  }

  now(): number { return Date.now() }

  note(d: Diagnostic): void {
    const k = `${d.code}|${d.message}`
    if (this.noteKeys.has(k)) return
    this.noteKeys.add(k)
    this.notes.push(d)
  }

  /** Absolute path inside the repo, or undefined when it escapes the root. */
  abs(path: string): string | undefined {
    const p = resolve(this.root, path)
    return p === this.root || p.startsWith(this.root + sep) ? p : undefined
  }

  async readFile(path: string): Promise<string | undefined> {
    const p = this.abs(path)
    return p ? readText(p) : undefined
  }

  allowed(bin: string): boolean {
    return this.whitelist.has(binaryName(bin))
  }

  // ───────────────────────── run ─────────────────────────

  async run(req: { lang: string; code: string; stdin: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string; ms: number }> {
    const lang = LANG_ALIASES[req.lang] ?? req.lang
    const ex = this.executors[lang] ?? this.executors[req.lang]
    if (!ex) {
      this.note({ code: 'G202', severity: 'warning', message: `Виконавця для мови «${req.lang}» немає в executors`, hint: 'додай його в gate.json executors' })
      return { exitCode: 127, stdout: '', stderr: `немає виконавця ${req.lang}`, ms: 0 }
    }
    const bin = ex.command[0] ?? ''
    if (!this.allowed(bin)) {
      this.note({ code: 'G201', severity: 'warning', message: `Бінарник «${bin}» поза білим списком ~/.claude/context-gate.json (allowBinaries)` })
      return { exitCode: 126, stdout: '', stderr: `бінарник ${bin} не дозволено`, ms: 0 }
    }
    const viaStdin = ex.stdin !== undefined && ex.stdin.includes('{code}')
    const argv = ex.command.map((a) => a.split('{code}').join(req.code))
    const timeout = Math.min(parseDuration(ex.timeout) ?? 10_000, req.timeoutMs > 0 ? req.timeoutMs : Infinity)
    this.processes++
    const r = await runProcess(argv, {
      cwd: this.root,
      stdin: viaStdin ? ex.stdin!.split('{code}').join(req.code) : req.stdin,
      timeoutMs: timeout,
      env: { ...(ex.env ?? {}), CONTEXT_GATE_INPUT: req.stdin, CONTEXT_GATE_ROOT: this.root },
    })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, ms: r.ms }
  }

  // ───────────────────────── call (shims) ─────────────────────────

  /** Runs one shim batch for a repo module; per-call errors become `errors[i]`. */
  async shim(path: string, calls: ShimCall[], timeoutMs = 10_000): Promise<ShimResponse> {
    const file = this.abs(path)
    const fail = (msg: string): ShimResponse => ({ results: calls.map(() => null), errors: calls.map(() => msg) })
    if (!file || !existsSync(file)) return fail(`модуль ${path} не знайдено`)
    const lang = shimLang(path)
    let argv: string[]
    let stdin = JSON.stringify({ file, calls })
    if (lang === 'node') argv = ['node', '--input-type=module', '-e', NODE_SHIM]
    else if (lang === 'python') argv = ['python3', '-c', PYTHON_SHIM]
    else if (lang === 'bash') { argv = ['bash', '-c', BASH_SHIM, 'cg-shim', ...bashArgv({ file, calls })]; stdin = '' }
    else {
      const ext = /\.([\w]+)$/.exec(path)?.[1] ?? ''
      const ex = Object.entries(this.executors).find(([k, e]) => e.callTemplate && (k === ext || LANG_ALIASES[ext] === k))?.[1]
      if (!ex?.callTemplate) return fail(`немає shim для ${path} (додай executors.<мова>.callTemplate)`)
      argv = ex.callTemplate.map((a) => a.split('{file}').join(file))
    }
    if (!this.allowed(argv[0]!)) {
      this.note({ code: 'G201', severity: 'warning', message: `Бінарник «${argv[0]}» поза білим списком ~/.claude/context-gate.json (allowBinaries)` })
      return fail(`бінарник ${argv[0]} не дозволено`)
    }
    this.processes++
    const r = await runProcess(argv, { cwd: this.root, stdin, timeoutMs })
    if (lang === 'bash') return parseBashOutput(r.stdout, calls)
    if (r.exitCode !== 0) return fail(`exit ${r.exitCode}: ${r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`)
    try {
      const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as ShimResponse | Value[]
      if (Array.isArray(out)) return { results: out, errors: out.map(() => null) }
      return out
    } catch {
      return fail(`shim повернув не JSON: ${r.stdout.slice(0, 200)}`)
    }
  }

  async call(req: { path: string; calls: { fn: string; args: Value[]; kwargs?: Record<string, Value> }[] }): Promise<Value[]> {
    const r = await this.shim(req.path, req.calls)
    const err = r.errors.find((e) => e)
    if (err) throw new Error(err)
    return r.results
  }

  /** Exported function names of a module (G158 validation); undefined when the shim can't tell. */
  async listExports(path: string): Promise<string[] | undefined> {
    const key = `exports:${path}`
    const hit = await this.cacheGet(key)
    if (hit && Array.isArray(hit.value)) return hit.value as string[]
    const r = await this.shim(path, [{ fn: '__exports__', args: [] }])
    const v = r.results[0]
    if (r.errors[0] || !Array.isArray(v)) return undefined
    await this.cacheSet(key, v)
    return v as string[]
  }

  // ───────────────────────── cache ─────────────────────────

  fileHash(path: string): string {
    const hit = this.fileHashes.get(path)
    if (hit) return hit
    const p = this.abs(path)
    let h = 'missing'
    try { if (p) h = sha256(readFileSync(p)).slice(0, 16) } catch { /* missing */ }
    this.fileHashes.set(path, h)
    return h
  }

  /** `call:<module>:…` keys include the module's file hash, so editing the module invalidates its cache. */
  storageKey(key: string): string {
    const m = /^call:([^:]+):/.exec(key)
    return m ? `${key}#${this.fileHash(m[1]!)}` : key
  }

  cachePath(key: string): string {
    return join(this.cacheDir, 'kv', `${sha256(this.storageKey(key)).slice(0, 32)}.json`)
  }

  async cacheGet(key: string): Promise<{ value: Value; at: number } | undefined> {
    const e = readJson<{ key: string; value: Value; at: number }>(this.cachePath(key))
    return e && e.key === this.storageKey(key) ? { value: e.value, at: e.at } : undefined
  }

  async cacheSet(key: string, value: Value): Promise<void> {
    try { writeJson(this.cachePath(key), { key: this.storageKey(key), value, at: Date.now() }) } catch { /* best effort */ }
  }

  // ───────────────────────── items / lazies ─────────────────────────

  registerLazy(name: string, description: string, ref: string): void {
    if (!this.lazies.some((l) => l.name === name)) this.lazies.push({ name, description, ref })
  }

  /** Rule bodies are filled by context.ts (`rules`); skills come from `.claude/skills/<name>/SKILL.md`. */
  rules: { id: string; path: string; body: string; description?: string }[] = []

  async itemBody(kind: 'skill' | 'rule', name: string): Promise<{ description?: string; body?: string; path?: string } | undefined> {
    if (kind === 'rule') {
      const r = this.rules.find((x) => x.id === name || x.id.endsWith('/' + name))
      return r ? { body: r.body, path: r.path, ...(r.description ? { description: r.description } : {}) } : undefined
    }
    for (const dir of skillDirs(this.root)) {
      const p = join(dir, name, 'SKILL.md')
      const text = readText(p)
      if (text === undefined) continue
      const { meta, body } = splitFrontmatter(text)
      const rel = p.startsWith(this.root + sep) ? posix(p.slice(this.root.length + 1)) : p
      return { body: body.replace(/^\n+/, ''), path: rel, ...(typeof meta.description === 'string' ? { description: meta.description } : {}) }
    }
    return undefined
  }
}

/** Skill roots: repo `.claude/skills`, then `~/.claude/skills`. */
export function skillDirs(root: string): string[] {
  const home = process.env.HOME
  return [join(root, '.claude', 'skills'), ...(home ? [join(home, '.claude', 'skills')] : [])].filter((d) => existsSync(d))
}

export function listSkills(root: string): { name: string; description?: string; path: string; body: string; generated: boolean }[] {
  const out: { name: string; description?: string; path: string; body: string; generated: boolean }[] = []
  const seen = new Set<string>()
  for (const dir of skillDirs(root)) {
    let names: string[] = []
    try { names = readdirSync(dir).sort() } catch { continue }
    for (const n of names) {
      const p = join(dir, n, 'SKILL.md')
      const text = readText(p)
      if (text === undefined || seen.has(n)) continue
      seen.add(n)
      const { meta, body } = splitFrontmatter(text)
      const rel = p.startsWith(root + sep) ? posix(p.slice(root.length + 1)) : p
      out.push({ name: typeof meta.name === 'string' ? meta.name : n, path: rel, body, generated: meta['generated-by'] === 'context-gate', ...(typeof meta.description === 'string' ? { description: meta.description } : {}) })
    }
  }
  return out
}
