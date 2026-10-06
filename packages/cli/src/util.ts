// Small Node helpers shared by CLI modules: repo paths, JSON/JSONL IO, hashing, process spawning, file walking.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const posix = (p: string): string => p.split(sep).join('/')
export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/** Repo root: the nearest ancestor of `start` with `.claude/gate.json`, `.git` or `.claude`; else `start`. */
export function findRoot(start: string): string {
  const abs = resolve(start)
  for (const marker of [join('.claude', 'gate.json'), '.git', '.claude']) {
    let d = abs
    for (;;) {
      if (existsSync(join(d, marker))) return d
      const up = dirname(d)
      if (up === d) break
      d = up
    }
  }
  return abs
}

export function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

export function readJson<T = unknown>(path: string): T | undefined {
  const t = readText(path)
  if (t === undefined) return undefined
  try { return JSON.parse(t.replace(/^﻿/, '')) as T } catch { return undefined }
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2) + '\n')
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

/** Runs argv without a shell. Never throws: a spawn failure is exit code -1 with the message in stderr. */
export function runProcess(argv: string[], opts: { cwd: string; stdin?: string; timeoutMs?: number; env?: Record<string, string | undefined>; maxBytes?: number }): Promise<ProcResult> {
  const t0 = Date.now()
  const max = opts.maxBytes ?? 16 * 1024 * 1024
  return new Promise((done) => {
    let settled = false
    const finish = (r: Omit<ProcResult, 'ms'>): void => { if (!settled) { settled = true; done({ ...r, ms: Date.now() - t0 }) } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      finish({ exitCode: -1, stdout: '', stderr: String((e as Error).message) })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLen = 0
    child.stdout!.on('data', (b: Buffer) => { outLen += b.length; if (outLen <= max) out.push(b) })
    child.stderr!.on('data', (b: Buffer) => { err.push(b) })
    let timedOut = false
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, Math.max(1, opts.timeoutMs)) : undefined
    child.on('error', (e) => { if (timer) clearTimeout(timer); finish({ exitCode: -1, stdout: '', stderr: e.message }) })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const stderr = Buffer.concat(err).toString('utf8')
      finish({ exitCode: timedOut ? -1 : code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: timedOut ? `таймаут ${opts.timeoutMs} мс\n${stderr}` : stderr, ...(timedOut ? { timedOut } : {}) })
    })
    child.stdin!.on('error', () => { /* child closed stdin early */ })
    child.stdin!.end(opts.stdin ?? '')
  })
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.compiled', '.cache', '.next', 'coverage', '__pycache__', '.venv'])

/** Repo-relative POSIX paths of all files under `root` (skipping VCS/build dirs), sorted. Capped at `limit`. */
export function walkFiles(root: string, opts: { limit?: number; under?: string } = {}): string[] {
  const out: string[] = []
  const limit = opts.limit ?? 50_000
  const start = opts.under ? join(root, opts.under) : root
  const visit = (dir: string): void => {
    if (out.length >= limit) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (out.length >= limit) return
      const abs = join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) visit(abs) }
      else if (e.isFile()) out.push(posix(relative(root, abs)))
    }
  }
  visit(start)
  return out
}

/** Appends missing lines to `.gitignore`; returns the lines added. */
export function ensureGitignore(root: string, lines: string[]): string[] {
  const path = join(root, '.gitignore')
  const cur = readText(path) ?? ''
  const have = new Set(cur.split('\n').map((l) => l.trim()))
  const add = lines.filter((l) => !have.has(l))
  if (!add.length) return []
  const text = cur + (cur && !cur.endsWith('\n') ? '\n' : '') + (cur ? '\n' : '') + '# context-gate\n' + add.join('\n') + '\n'
  writeText(path, text)
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
