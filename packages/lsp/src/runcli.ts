// Shared CLI preview helpers (VS Code panel, browser editor): argv for
// `context-gate run --only <id> --json --dry-scripts` and the parser of its RunJson output (core runjson.ts).

import { execFile } from 'node:child_process'
import type { Diagnostic, TraceEntry } from '../../core/src/types.ts'
import { parseRunJson } from '../../core/src/runjson.ts'

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

/** Parse `run --json` stdout (core `parseRunJson`: the RunJson shape; log lines before the JSON are skipped). */
export function parseRunOutput(stdout: string, stderr = '', exitCode: number | null = 0): RunView {
  const empty: RunView = { text: '', sections: [], trace: [], diagnostics: [] }
  if (stdout.indexOf('{') < 0) return { ...empty, error: (stderr || stdout || `context-gate завершився з кодом ${exitCode}`).trim() }
  const parsed = parseRunJson(stdout)
  if ('error' in parsed) return { ...empty, error: `${parsed.error} (context-gate)\n${(stderr || stdout).slice(0, 2000)}` }
  const j = parsed.json
  const view: RunView = { text: j.text, sections: j.sections, trace: j.trace, diagnostics: j.diagnostics, ms: j.ms }
  if (exitCode && exitCode !== 0 && !j.sections.length) view.error = (stderr || `код ${exitCode}`).trim()
  return view
}

/** Run the CLI and parse its JSON. Never rejects. `env` is merged over `process.env`. */
export function runCli(argv: string[], cwd: string, timeoutMs = 60_000, env?: Record<string, string>): Promise<RunView & { argv: string[] }> {
  const [bin, ...rest] = argv
  return new Promise((resolveP) => {
    execFile(bin!, rest, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', shell: process.platform === 'win32', ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number | string }).code ?? 1) : 0
      const view = parseRunOutput(stdout ?? '', stderr ?? '', typeof code === 'number' ? code : 1)
      if (err && !view.sections.length && !view.error) view.error = err.message
      resolveP({ ...view, argv })
    })
  })
}
