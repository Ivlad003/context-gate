// Small Node helpers shared by CLI modules: repo paths, JSON/JSONL IO, hashing, process spawning, file walking.

import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, fstatSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const posix = (p: string): string => p.split(sep).join('/')
export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/**
 * Repo root: walking up from `start`, the nearest directory with `.git` or `.claude/gate.json` (one pass, so a
 * nested repo wins over an ancestor's gate.json); else the nearest one with a bare `.claude/`; else `start`.
 * The home directory never becomes a root through `.claude` (every Claude Code user has `~/.claude`), only
 * through its own `.git`.
 */
export function findRoot(start: string): string {
  const abs = resolve(start)
  const home = realOr(process.env.HOME || homedir())
  let weak: string | undefined
  for (let d = abs; ; d = dirname(d)) {
    const isHome = realOr(d) === home
    if (existsSync(join(d, '.git')) || (!isHome && existsSync(join(d, '.claude', 'gate.json')))) return d
    if (!weak && !isHome && existsSync(join(d, '.claude'))) weak = d
    if (dirname(d) === d) break
  }
  return weak ?? abs
}

function realOr(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

/** Lexically inside `root`: relative, no `..` segment, not absolute. */
export function lexicallyInside(rel: string): boolean {
  if (!rel || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false
  return !rel.replace(/\\/g, '/').split('/').includes('..')
}

/**
 * `join(root, rel)` when the result stays inside `root` after resolving symlinks: the deepest existing ancestor
 * is realpath-ed and must be `root` (realpath-ed) or under it. Undefined for `..`, absolute paths and symlinks
 * that leave the repo (SPEC Р2: an untrusted repo may read and write only inside itself).
 */
export function safeJoin(root: string, rel: string): string | undefined {
  const base = resolve(root)
  const p = resolve(base, rel)
  if (p !== base && !p.startsWith(base + sep)) return undefined
  const realBase = realOr(base)
  let probe = p
  while (!existsSync(probe) && probe !== base && dirname(probe) !== probe) probe = dirname(probe)
  let real: string
  try { real = realpathSync(probe) } catch { return undefined }
  return real === realBase || real.startsWith(realBase + sep) ? p : undefined
}

export function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

export function readJson<T = unknown>(path: string): T | undefined {
  const t = readText(path)
  if (t === undefined) return undefined
  try { return JSON.parse(t.replace(/^﻿/, '')) as T } catch { return undefined }
}

/**
 * A repo path whose real file stays inside the repo: no directory link out of it on the way (`safeJoin`) and, when
 * the file itself is a link, its target inside too. The repo controls its links (Р2).
 */
export function repoPathInside(root: string, path: string): boolean {
  if (!safeJoin(root, relative(resolve(root), resolve(path)))) return false
  try {
    if (!lstatSync(path).isSymbolicLink()) return true
  } catch { return true } // a new file
  try {
    const real = realpathSync(path)
    const base = realOr(root)
    return real === base || real.startsWith(base + sep)
  } catch { return true } // a dangling link: renamed over, never followed
}

/**
 * Atomic write: a unique temp file next to the target, then rename. With `root` (a write into the repo): a path
 * whose real file leaves the repo (`CLAUDE.md` → `~/.profile`, a symlinked `.claude/`) is refused with an Error, so
 * an untrusted repo never gets its text written outside itself (Р2); a link inside the repo (`CLAUDE.md` →
 * `AGENTS.md`) is written through: the temp file goes next to the real file, so the link stays a link. Without
 * `root` a link is replaced by the file itself, never followed.
 */
export function writeText(path: string, text: string, root?: string): void {
  if (root !== undefined && !repoPathInside(root, path)) throw new Error(`${path}: шлях веде за межі репозиторію — не записано`)
  let target = path
  try { if (root !== undefined && lstatSync(path).isSymbolicLink()) target = realpathSync(path) } catch { /* new file or dangling link */ }
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, target)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* nothing to clean */ }
    throw e
  }
}

export function writeJson(path: string, value: unknown, root?: string): void {
  writeText(path, JSON.stringify(value, null, 2) + '\n', root)
}

export function mtimeMs(path: string): number | undefined {
  try { return statSync(path).mtimeMs } catch { return undefined }
}

/** Reads all of stdin (empty string for a TTY). */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Stdin carries data worth waiting for: a pipe or a redirected file. Not a TTY and not a socket — agent
 * harnesses and `spawn` with default stdio leave an open socket/pipe that never ends, which would hang a
 * source stage (`collect`, `why`, `signals`) that only optionally reads input.
 */
export function stdinHasData(): boolean {
  return stdinKind() === 'data'
}

/** `data`: a pipe or a file; `socket`: maybe input (Node's child_process `pipe` stdio is a socketpair, but so is an
 *  agent harness's never-ending stdin); `none`: a TTY or nothing. */
export function stdinKind(): 'data' | 'socket' | 'none' {
  if (process.stdin.isTTY) return 'none'
  try {
    const st = fstatSync(0)
    return st.isFIFO() || st.isFile() ? 'data' : st.isSocket() ? 'socket' : 'none'
  } catch { return 'none' }
}

/**
 * Optional stdin input: a pipe or file is read to the end; a socket only if data arrives within `idleMs` (then to
 * its end), so `execFile(…, { input })` from Node feeds `pipe` while a harness's silent open stdin does not hang it.
 */
export async function readOptionalStdin(read: () => Promise<string> = readStdin, idleMs = 200): Promise<string> {
  const kind = stdinKind()
  if (kind === 'data') return read()
  if (kind === 'none') return ''
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer) clearTimeout(timer)
      process.stdin.off('data', onData)
      process.stdin.off('end', finish)
      process.stdin.off('error', finish)
      process.stdin.destroy() // an idle socket must not keep the process alive
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onData = (c: Buffer): void => {
      chunks.push(c)
      if (timer) { clearTimeout(timer); timer = undefined } // data began: read to the end
    }
    timer = setTimeout(finish, idleMs)
    process.stdin.on('data', onData)
    process.stdin.once('end', finish)
    process.stdin.once('error', finish)
  })
}

/** JSONL (or a single JSON array) → records; bad lines are counted. */
export function parseJsonl(text: string): { items: unknown[]; bad: number } {
  const t = text.trim()
  if (!t) return { items: [], bad: 0 }
  if (t.startsWith('[')) {
    try { const a = JSON.parse(t); if (Array.isArray(a)) return { items: a, bad: 0 } } catch { /* fall through to lines */ }
  }
  const items: unknown[] = []
  let bad = 0
  for (const line of t.split('\n')) {
    const l = line.trim()
    if (!l) continue
    try { items.push(JSON.parse(l)) } catch { bad++ }
  }
  return { items, bad }
}

export interface ProcResult { exitCode: number; stdout: string; stderr: string; ms: number; timedOut?: boolean }

export interface ProcOptions {
  cwd: string
  stdin?: string
  timeoutMs?: number
  env?: Record<string, string | undefined>
  /** Cap of stdout and of stderr (each), bytes. Default 16 MiB. */
  maxBytes?: number
  /** SIGTERM → SIGKILL delay on timeout. Default 500 ms. */
  killGraceMs?: number
  /** How long to wait for the stdio pipes after the child exited (a grandchild may hold them). Default 2 s. */
  drainMs?: number
}

/**
 * Runs argv without a shell. Never throws: a spawn failure is exit code -1 with the message in stderr.
 * On POSIX the child leads its own process group, so a timeout reaches its grandchildren too (`bash -c 'a; b'`,
 * npm, pipelines): SIGTERM first (git can drop its index.lock), SIGKILL after `killGraceMs`. The result settles
 * once the child exited and its pipes closed, or `drainMs` after the exit when a grandchild still holds them;
 * that leftover process group is killed.
 */
/** Process groups of children still running: each child runs detached in its own group (so a timeout reaches its
 *  grandchildren), which also keeps a signal to the CLI's own group from reaching them. */
const liveGroups = new Set<number>()
let reaperInstalled = false

/** On exit or SIGINT/SIGTERM/SIGHUP of the CLI, its children's groups go too: no orphaned @run script or git (M50). */
function installReaper(): void {
  if (reaperInstalled) return
  reaperInstalled = true
  const reap = (): void => {
    for (const pgid of liveGroups) try { process.kill(-pgid, 'SIGTERM') } catch { /* gone */ }
    liveGroups.clear()
  }
  process.on('exit', reap)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = (): void => {
      reap()
      // Default behaviour once the children are signalled: die by the same signal.
      process.off(sig, onSignal)
      process.kill(process.pid, sig)
    }
    process.on(sig, onSignal)
  }
}

/** The binary for `node` in argv: this Node (O8: a GUI-launched or PATH-less environment still runs it, at the
 *  CLI's version), except under Electron (the VS Code extension), whose embedded Node is not the user's `node`. */
function nodeBinary(): string {
  return process.versions.electron ? 'node' : process.execPath
}

export function runProcess(argv: string[], opts: ProcOptions): Promise<ProcResult> {
  const t0 = Date.now()
  const max = opts.maxBytes ?? 16 * 1024 * 1024
  const group = process.platform !== 'win32'
  return new Promise((done) => {
    let settled = false
    const timers: NodeJS.Timeout[] = []
    let pgid: number | undefined
    const finish = (r: Omit<ProcResult, 'ms'>): void => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      if (pgid !== undefined) liveGroups.delete(pgid)
      done({ ...r, ms: Date.now() - t0 })
    }
    let child: ReturnType<typeof spawn>
    try {
      const bin = argv[0] === 'node' ? nodeBinary() : argv[0]!
      child = spawn(bin, argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: group })
    } catch (e) {
      finish({ exitCode: -1, stdout: '', stderr: String((e as Error).message) })
      return
    }
    if (group && child.pid) {
      pgid = child.pid
      liveGroups.add(pgid)
      installReaper()
    }
    const kill = (sig: NodeJS.Signals): void => {
      try { if (group && child.pid) process.kill(-child.pid, sig); else child.kill(sig) } catch { try { child.kill(sig) } catch { /* gone */ } }
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLen = 0
    let errLen = 0
    child.stdout!.on('data', (b: Buffer) => { outLen += b.length; if (outLen <= max) out.push(b) })
    child.stderr!.on('data', (b: Buffer) => { errLen += b.length; if (errLen <= max) err.push(b) })
    let timedOut = false
    let exitCode: number | null | undefined
    const result = (): Omit<ProcResult, 'ms'> => {
      const stderr = Buffer.concat(err).toString('utf8')
      return { exitCode: timedOut ? -1 : exitCode ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: timedOut ? `таймаут ${opts.timeoutMs} мс\n${stderr}` : stderr, ...(timedOut ? { timedOut } : {}) }
    }
    const abandonPipes = (): void => {
      kill('SIGKILL')
      child.stdout?.destroy()
      child.stderr?.destroy()
      finish(result())
    }
    if (opts.timeoutMs) {
      timers.push(setTimeout(() => {
        timedOut = true
        kill('SIGTERM')
        timers.push(setTimeout(() => { kill('SIGKILL'); timers.push(setTimeout(abandonPipes, 200)) }, opts.killGraceMs ?? 500))
      }, Math.max(1, opts.timeoutMs)))
    }
    child.on('error', (e) => finish({ exitCode: -1, stdout: '', stderr: e.message }))
    child.on('exit', (code) => {
      exitCode = code
      timers.push(setTimeout(abandonPipes, timedOut ? 200 : opts.drainMs ?? 2000))
    })
    child.on('close', (code) => {
      if (exitCode === undefined) exitCode = code
      finish(result())
    })
    child.stdin!.on('error', () => { /* child closed stdin early */ })
    child.stdin!.end(opts.stdin ?? '')
  })
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.compiled', '.cache', '.next', 'coverage', '__pycache__', '.venv', '.turbo', '.gradle'])

export interface WalkResult { files: string[]; truncated: boolean }

/**
 * Repo-relative POSIX paths of all files under `root` (skipping VCS/build dirs), sorted. Capped at `limit`
 * (`truncated` says so). Symlinks are followed when their target resolves inside the root (loops cut by realpath).
 */
export function walkFilesInfo(root: string, opts: { limit?: number; under?: string } = {}): WalkResult {
  const out: string[] = []
  const limit = opts.limit ?? 50_000
  let truncated = false
  const realRoot = realOr(root)
  const inside = (real: string): boolean => real === realRoot || real.startsWith(realRoot + sep)
  const seen = new Set<string>()
  const start = opts.under ? join(root, opts.under) : root
  const visit = (dir: string): void => {
    if (out.length >= limit) { truncated = true; return }
    const real = realOr(dir)
    if (seen.has(real) || !inside(real)) return
    seen.add(real)
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (out.length >= limit) { truncated = true; return }
      const abs = join(dir, e.name)
      let isDir = e.isDirectory()
      let isFile = e.isFile()
      if (e.isSymbolicLink()) {
        try {
          const target = realpathSync(abs)
          if (!inside(target)) continue
          const st = statSync(target)
          isDir = st.isDirectory()
          isFile = st.isFile()
        } catch { continue }
      }
      if (isDir) { if (!SKIP_DIRS.has(e.name)) visit(abs) }
      else if (isFile) out.push(posix(relative(root, abs)))
    }
  }
  visit(start)
  return { files: out, truncated }
}

/** `walkFilesInfo` without the truncation flag. */
export function walkFiles(root: string, opts: { limit?: number; under?: string } = {}): string[] {
  return walkFilesInfo(root, opts).files
}

/** Appends missing lines to `.gitignore`; returns the lines added. */
export function ensureGitignore(root: string, lines: string[]): string[] {
  const path = join(root, '.gitignore')
  if (!repoPathInside(root, path)) return [] // a .gitignore linked out of the repo is neither read nor written
  const cur = readText(path) ?? ''
  const have = new Set(cur.split('\n').map((l) => l.trim()))
  const add = lines.filter((l) => !have.has(l))
  if (!add.length) return []
  const text = cur + (cur && !cur.endsWith('\n') ? '\n' : '') + (cur ? '\n' : '') + '# context-gate\n' + add.join('\n') + '\n'
  writeText(path, text, root)
  return add
}

/** Minimal line diff (LCS) → unified-like `-`/`+`/` ` lines. */
export function lineDiff(a: string, b: string): string {
  const x = a.split('\n')
  const y = b.split('\n')
  if (x.length * y.length > 4_000_000) return a === b ? '' : `--- було (${x.length} рядків)\n+++ стало (${y.length} рядків)`
  const n = x.length
  const m = y.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const out: string[] = []
  let i = 0
  let j = 0
  let changed = false
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { out.push(`  ${x[i]}`); i++; j++ }
    else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) { out.push(`+ ${y[j]}`); j++; changed = true }
    else { out.push(`- ${x[i]}`); i++; changed = true }
  }
  return changed ? out.join('\n') : ''
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}
