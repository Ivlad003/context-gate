// Pure part of the in-editor compiler: which CLI to run, what to rebuild on save, how to read
// `context-gate build --json` and where its diagnostics go. No `vscode` import (tested with node:test).

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Diagnostic } from '../../../packages/core/src/types.ts'
import { cliArgv } from '../../../packages/lsp/src/runcli.ts'

export interface CliCommand {
  argv: string[]
  env: Record<string, string>
  source: 'setting' | 'workspace' | 'bundled'
}

export interface ResolveCliInput {
  /** `contextGate.cliPath`; empty or unset → the next source. */
  setting?: string
  /** Repo root of the file (where `.claude/` is). */
  root?: string
  /** Extension directory (`context.extensionPath`), holds `cli/dist/cli.js`. */
  extensionPath: string
  /** Node-compatible runtime of the extension host (`process.execPath`, Electron in VS Code). */
  execPath: string
  /** `vscode.env.appRoot`: its `extensions/node_modules` has the `typescript` the CLI needs for TSX level 2. */
  appRoot?: string
  /** Whether execPath is Electron (needs ELECTRON_RUN_AS_NODE=1 to act as Node). */
  electron?: boolean
  exists?: (p: string) => boolean
}

/** CLI resolution: setting → `<root>/node_modules/.bin/context-gate` → the CLI bundled in the extension. */
export function resolveCli(i: ResolveCliInput): CliCommand {
  const exists = i.exists ?? existsSync
  if (i.setting?.trim()) return { argv: cliArgv(i.setting.trim()), env: {}, source: 'setting' }
  if (i.root) {
    const bin = join(i.root, 'node_modules', '.bin', process.platform === 'win32' ? 'context-gate.cmd' : 'context-gate')
    if (exists(bin)) return { argv: [bin], env: {}, source: 'workspace' }
  }
  const env: Record<string, string> = {}
  if (i.electron) env.ELECTRON_RUN_AS_NODE = '1'
  if (i.appRoot) {
    const tsDir = join(i.appRoot, 'extensions', 'node_modules')
    if (exists(join(tsDir, 'typescript'))) env.NODE_PATH = tsDir
  }
  return { argv: [i.execPath, join(i.extensionPath, 'cli', 'dist', 'cli.js')], env, source: 'bundled' }
}

/** Shell line for a terminal (`expand` code action): quoted argv, env prefix on POSIX. */
export function shellLine(cmd: CliCommand, args: string[]): string {
  // POSIX double quotes still expand `$`, backticks and `\`: escape them (JSON.stringify did not).
  const q = (a: string) => (!/[\s"'$`\\;&|<>()*?!#~{}[\]]/.test(a) ? a : process.platform === 'win32' ? JSON.stringify(a) : `"${a.replace(/(["\\$`])/g, '\\$1')}"`)
  return [...cmd.argv, ...args].map(q).join(' ')
}

const isIn = (root: string, p: string): string | undefined => {
  const rel = relative(root, p)
  return !rel || rel.startsWith('..') || isAbsolute(rel) ? undefined : rel.split(sep).join('/')
}

export interface PromptLock { prompts?: Record<string, { entry?: string; sources?: { path: string }[] }> }

export function readLock(root: string, promptDir = '.claude/prompt'): PromptLock | undefined {
  try { return JSON.parse(readFileSync(join(root, promptDir, 'prompt.lock.json'), 'utf8')) as PromptLock } catch { return undefined }
}

/** What to rebuild after saving `file`: `full`, `{ only }` (prompt ids / entry paths), or undefined (nothing). */
export function buildTargetFor(file: string, root: string, promptDir = '.claude/prompt', lock?: PromptLock): 'full' | { only: string[] } | undefined {
  const rel = isIn(root, file)
  if (!rel) return undefined
  if (rel === '.claude/gate.json') return 'full'
  const dir = promptDir.replace(/^\.\//, '').replace(/\/+$/, '')
  if (rel.startsWith(dir + '/')) {
    const inner = rel.slice(dir.length + 1)
    if (/^\.(compiled|trace|types)\//.test(inner) || inner === 'prompt.lock.json' || inner === 'tsconfig.json' || inner.startsWith('proposals/')) return undefined
    // A top-level entry builds alone.
    if (/^[^/]+\.prompt\.tsx$/.test(inner)) return { only: [rel] }
  }
  // Imported files (shared components, data, Markdown includes, also outside the prompt dir): the prompts whose
  // lock lists them as a source.
  const users = Object.entries(lock?.prompts ?? {}).filter(([, p]) => p.sources?.some((s) => s.path === rel)).map(([id]) => id)
  if (users.length) return { only: users }
  if (rel.startsWith(dir + '/') && /\.(tsx?|jsx?|json|ya?ml|toml|md|mdc|txt)$/.test(rel)) return 'full'
  return undefined
}

export interface BuildJson { ok: boolean; compiled: string[]; written: string[]; diagnostics: Diagnostic[]; ms?: number }

/** `build --json` stdout → result (the JSON line is the last one starting with `{`). */
export function parseBuildJson(stdout: string): BuildJson | { error: string } {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
  const last = lines[lines.length - 1]
  if (!last) return { error: 'context-gate build --json не надрукував JSON' }
  try {
    const j = JSON.parse(last) as Partial<BuildJson>
    if (!Array.isArray(j.diagnostics)) return { error: 'context-gate build --json: немає diagnostics' }
    return { ok: Boolean(j.ok), compiled: j.compiled ?? [], written: j.written ?? [], diagnostics: j.diagnostics, ...(j.ms !== undefined ? { ms: j.ms } : {}) }
  } catch (e) {
    return { error: `context-gate build --json: ${(e as Error).message}` }
  }
}

/** Codes the tsserver plugin reports live (with exact ranges) in `*.prompt.tsx`; build copies would duplicate them. */
export const LIVE_TSX_CODES = /^G1(0\d|5[47]|63|7\d)$/

/** Build diagnostics by absolute file path; ones without a path go to `fallback` (the saved file / gate.json). */
export function diagnosticsByFile(diags: Diagnostic[], root: string, fallback: string): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>()
  for (const d of diags) {
    const file = d.path ? resolve(root, d.path) : fallback
    if (/\.prompt\.tsx$/.test(file) && LIVE_TSX_CODES.test(d.code)) continue
    const list = out.get(file) ?? []
    list.push(d)
    out.set(file, list)
  }
  return out
}

/** Files whose old build diagnostics a (partial) build replaces: the saved file and the sources of the built prompts. */
export function filesOfPrompts(root: string, lock: PromptLock | undefined, ids: string[] | undefined): string[] {
  const out = new Set<string>()
  for (const [id, p] of Object.entries(lock?.prompts ?? {})) {
    if (ids && !ids.includes(id) && !ids.includes(p.entry ?? '\0')) continue
    if (p.entry) out.add(resolve(root, p.entry))
    for (const s of p.sources ?? []) out.add(resolve(root, s.path))
  }
  return [...out]
}

/** 0-based [line, startCol, endCol] of a 1-based diagnostic line in `text`: the line without its indentation. */
export function lineRange(text: string | undefined, line: number | undefined): [number, number, number] {
  const l = Math.max(1, line ?? 1) - 1
  const src = text?.split('\n')[l]
  if (src === undefined) return [l, 0, 0]
  const lead = /^\s*/.exec(src)![0].length
  return [l, lead, Math.max(lead + 1, src.replace(/\s+$/, '').length)]
}

export type StatusState = { kind: 'idle' } | { kind: 'building' } | { kind: 'done'; errors: number; warnings: number } | { kind: 'failed'; message: string }

/** Status bar text: `context-gate: ✓ built` / `⚠ N` / `building…`. */
export function statusText(s: StatusState): string {
  switch (s.kind) {
    case 'idle': return 'context-gate'
    case 'building': return '$(sync~spin) context-gate: building…'
    case 'failed': return '$(error) context-gate: ✗ CLI'
    case 'done': return s.errors + s.warnings ? `$(warning) context-gate: ⚠ ${s.errors + s.warnings}` : '$(check) context-gate: ✓ built'
  }
}
