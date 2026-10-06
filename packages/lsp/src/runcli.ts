// Shared CLI preview helpers (VS Code panel, browser editor): argv for
// `context-gate run --only <id> --json --dry-scripts` and a tolerant parser of its JSON output.

import { execFile } from 'node:child_process'
import type { Diagnostic, TraceEntry } from '../../core/src/types.ts'

export interface PreviewState {
  section: string
  tier?: string
  profile?: string
  /** `session:latest`, a fixture path, or empty for the live repo. */
  ctxFrom?: string
}

/** Split `contextGate.cliPath` (`npx context-gate`, `node dist/cli.js`) into argv. */
export function cliArgv(cliPath: string | string[] | undefined): string[] {
  const c = cliPath ?? 'npx context-gate'
  if (Array.isArray(c)) return [...c]
  const out: string[] = []
  for (const m of c.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!)
  return out
}

/** argv for one preview render. `dryScripts: false` only after the user confirmed «виконати скрипти». */
export function buildRunArgs(state: PreviewState, opts: { dryScripts: boolean }): string[] {
  const args = ['run', '--only', state.section, '--json']
  if (opts.dryScripts) args.push('--dry-scripts')
  if (state.tier) args.push('--tier', state.tier)
  if (state.profile) args.push('--profile', state.profile)
  if (state.ctxFrom) args.push('--ctx-from', state.ctxFrom)
  return args
}

export interface RunView {
  text: string
  sections: { id: string; scope?: string; tokens?: number; chars?: number; included?: boolean; reason?: string; truncated?: boolean; text?: string }[]
  trace: TraceEntry[]
  diagnostics: Diagnostic[]
  ms?: number
  error?: string
}

/** Parse `run --json` stdout (tolerates log lines before the JSON object). */
export function parseRunOutput(stdout: string, stderr = '', exitCode: number | null = 0): RunView {
  const empty: RunView = { text: '', sections: [], trace: [], diagnostics: [] }
  const i = stdout.indexOf('{')
  if (i < 0) return { ...empty, error: (stderr || stdout || `context-gate завершився з кодом ${exitCode}`).trim() }
  try {
    const j = JSON.parse(stdout.slice(i)) as Record<string, unknown>
    const r = (j.result && typeof j.result === 'object' ? j.result : j) as Record<string, unknown>
    const sections = Array.isArray(r.sections) ? (r.sections as RunView['sections']) : []
    const text = typeof r.text === 'string' ? r.text : sections.map((s) => s.text ?? '').join('\n\n')
    const view: RunView = {
      text,
      sections,
      trace: Array.isArray(r.trace) ? (r.trace as TraceEntry[]) : [],
      diagnostics: Array.isArray(r.diagnostics) ? (r.diagnostics as Diagnostic[]) : [],
    }
    if (typeof r.ms === 'number') view.ms = r.ms
    if (exitCode && exitCode !== 0 && !sections.length) view.error = (stderr || `код ${exitCode}`).trim()
    return view
  } catch (e) {
    return { ...empty, error: `Невірний JSON від context-gate: ${(e as Error).message}\n${(stderr || stdout).slice(0, 2000)}` }
  }
}

/** Run the CLI and parse its JSON. Never rejects. */
export function runCli(argv: string[], cwd: string, timeoutMs = 60_000): Promise<RunView & { argv: string[] }> {
  const [bin, ...rest] = argv
  return new Promise((resolveP) => {
    execFile(bin!, rest, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', shell: process.platform === 'win32' }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number | string }).code ?? 1) : 0
      const view = parseRunOutput(stdout ?? '', stderr ?? '', typeof code === 'number' ? code : 1)
      if (err && !view.sections.length && !view.error) view.error = err.message
      resolveP({ ...view, argv })
    })
  })
}
