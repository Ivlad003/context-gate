// Node-side RenderHost (SPEC «Виконавці скриптів», «Виклик функцій зі скриптових мов», Р2, Р3).
// Untrusted repo → no process and no MCP (the core renders `unverified` stubs); binaries outside the
// user whitelist are refused; cache lives in `~/.cache/context-gate/<repo>/` (XDG_CACHE_HOME respected).

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { Diagnostic, ExecutorConfig, GateConfig, Value } from '../../core/src/types.ts'
import type { ProviderCallRequest, RenderHostExt } from '../../core/src/render.ts'
import { parseDuration } from '../../core/src/duration.ts'
import { splitFrontmatter } from './build.ts'
import { DEFAULT_EXECUTORS, executorEnv, executorFor, executorInvocation, executorsOf as coreExecutorsOf, parseShimOutput, shimCommand, type ShimCall, type ShimResponse } from '../../core/src/shims.ts'
import { binaryWhitelist, readUserSettings, type UserSettings } from './settings.ts'
import { commandAllowed } from '../../core/src/config.ts'
import { posix, readJson, readText, runProcess, safeJoin, sha256, writeJson } from './util.ts'

export { DEFAULT_EXECUTORS }

export function executorsOf(config: Partial<GateConfig> | undefined): Record<string, ExecutorConfig> {
  return coreExecutorsOf(config)
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

/** Largest `@run` input passed as the CONTEXT_GATE_INPUT env string (bytes); bigger inputs go to a file. */
export const INPUT_ENV_MAX = 64 * 1024

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

  /** Absolute path inside the repo, or undefined when it escapes the root (`..`, absolute, or a symlink out of it). */
  abs(path: string): string | undefined {
    return safeJoin(this.root, path)
  }

  async readFile(path: string): Promise<string | undefined> {
    const p = this.abs(path)
    return p ? readText(p) : undefined
  }

  /** Core `commandAllowed`: the binary's basename on the effective whitelist (user ∩ repo narrowing). */
  allowed(bin: string): boolean {
    return commandAllowed([bin], this.whitelist)
  }

  // ───────────────────────── run ─────────────────────────

  async run(req: { lang: string; code: string; stdin: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string; ms: number }> {
    const ex = executorFor(this.executors, req.lang)
    if (!ex) {
      this.note({ code: 'G202', severity: 'warning', message: `Виконавця для мови «${req.lang}» немає в executors`, hint: 'додай його в gate.json executors' })
      return { exitCode: 127, stdout: '', stderr: `немає виконавця ${req.lang}`, ms: 0 }
    }
    const bin = ex.command[0] ?? ''
    if (!this.allowed(bin)) {
      this.note({ code: 'G201', severity: 'warning', message: `Бінарник «${bin}» поза білим списком ~/.claude/context-gate.json (allowBinaries)` })
      return { exitCode: 126, stdout: '', stderr: `бінарник ${bin} не дозволено`, ms: 0 }
    }
    const inv = executorInvocation(ex, req.code, req.stdin)
    const timeout = Math.min(parseDuration(ex.timeout) ?? 10_000, req.timeoutMs > 0 ? req.timeoutMs : Infinity)
    // The input also goes to the env for executors that take the code on stdin (deno). One env string is capped
    // (Linux MAX_ARG_STRLEN 128 KiB, Windows 32 K for the block): above INPUT_ENV_MAX it goes to a temp file
    // named by CONTEXT_GATE_INPUT_FILE instead, so a big scope never fails the spawn with E2BIG.
    let inputDir: string | undefined
    const inputEnv: Record<string, string> = {}
    if (Buffer.byteLength(req.stdin) <= INPUT_ENV_MAX) inputEnv.CONTEXT_GATE_INPUT = req.stdin
    else {
      try {
        inputDir = mkdtempSync(join(tmpdir(), 'context-gate-input-'))
        writeFileSync(join(inputDir, 'input.json'), req.stdin)
        inputEnv.CONTEXT_GATE_INPUT_FILE = join(inputDir, 'input.json')
      } catch { inputDir = undefined }
    }
    this.processes++
    try {
      const r = await runProcess(inv.argv, {
        cwd: this.root,
        stdin: inv.stdin,
        timeoutMs: timeout,
        // A repo executor cannot redirect a bare command through PATH or preload code (S5/L33).
        env: { ...executorEnv(ex.env).env, ...inputEnv, CONTEXT_GATE_ROOT: this.root },
      })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, ms: r.ms }
    } finally {
      if (inputDir) rmSync(inputDir, { recursive: true, force: true })
    }
  }

  // ───────────────────────── call (shims) ─────────────────────────

  /** Runs one shim batch for a repo module; per-call errors become `errors[i]`. */
  async shim(path: string, calls: ShimCall[], timeoutMs = 10_000): Promise<ShimResponse> {
    const file = this.abs(path)
    const fail = (msg: string): ShimResponse => ({ results: calls.map(() => null), errors: calls.map(() => msg) })
    if (!file || !existsSync(file)) return fail(`модуль ${path} не знайдено`)
    const cmd = shimCommand(path, file, calls, this.executors)
    if (!cmd.ok) return fail(cmd.error)
    const argv = cmd.argv
    if (!this.allowed(argv[0]!)) {
      this.note({ code: 'G201', severity: 'warning', message: `Бінарник «${argv[0]}» поза білим списком ~/.claude/context-gate.json (allowBinaries)` })
      return fail(`бінарник ${argv[0]} не дозволено`)
    }
    this.processes++
    const r = await runProcess(argv, { cwd: this.root, stdin: cmd.stdin, timeoutMs })
    return parseShimOutput(cmd, r, calls)
  }

  async call(req: { path: string; calls: { fn: string; args: Value[]; kwargs?: Record<string, Value> }[]; timeoutMs?: number }): Promise<Value[]> {
    // The render passes what is left of its budget: the shim never outlives the render deadline (M62).
    const r = await this.shim(req.path, req.calls, req.timeoutMs !== undefined && req.timeoutMs > 0 ? Math.min(req.timeoutMs, 10_000) : 10_000)
    const err = r.errors.find((e) => e)
    if (err) throw new Error(err)
    return r.results
  }

  /** Exported function names of a module (G158 validation); undefined when the shim can't tell. */
  async listExports(path: string): Promise<string[] | undefined> {
    // Keyed by the module's hash: an added or removed export is seen on the next run (no stale G158).
    const key = `exports:${path}#${this.fileHash(path)}`
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
    if (/#[0-9a-f]+$/.test(key)) return key // core already keyed it by the module hash (render.ts callCacheKey)
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

let userSkillsOff = false

/** User skills (`~/.claude/skills`) count unless `--no-user-skills` or `CONTEXT_GATE_NO_USER_SKILLS=1` (bench, CI). */
export function userSkillsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !userSkillsOff && env.CONTEXT_GATE_NO_USER_SKILLS !== '1'
}

/** Runs `fn` with user skills switched on or off (the CLI's `--no-user-skills`), restoring the previous state. */
export async function withUserSkills<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const prev = userSkillsOff
  userSkillsOff = !on || prev
  try { return await fn() } finally { userSkillsOff = prev }
}

/** Skill roots: repo `.claude/skills`, then `~/.claude/skills` (unless user skills are off, see `userSkillsEnabled`). */
export function skillDirs(root: string): string[] {
  const home = process.env.HOME
  return [join(root, '.claude', 'skills'), ...(home && userSkillsEnabled() ? [join(home, '.claude', 'skills')] : [])].filter((d) => existsSync(d))
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
