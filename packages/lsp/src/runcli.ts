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

/**
 * Default CLI command. `--no` stops npx from installing a package of that name from the registry: only an
 * installed `context-gate` runs (S4: the npm name is not ours to trust).
 */
export const DEFAULT_CLI = 'npx --no context-gate'

/** Split `contextGate.cliPath` (`npx context-gate`, `node dist/cli.js`) into argv. */
export function cliArgv(cliPath: string | string[] | undefined): string[] {
  const c = cliPath ?? DEFAULT_CLI
  if (Array.isArray(c)) return [...c]
  const out: string[] = []
  for (const m of c.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!)
  return out
}

/** Section, tier and profile ids: letters of any script (core accepts `id: правила`), digits, `_ . : @ / -`; no
 *  leading dash (not an option) and no shell metacharacters. */
export const SAFE_ID = /^[\p{L}\p{N}_][\p{L}\p{N}_.:@/-]*$/u

/** Why a preview state cannot become CLI args (Ukrainian), or undefined when it can. */
export function invalidRunState(state: PreviewState): string | undefined {
  for (const [k, v] of [['id секції', state.section], ['tier', state.tier], ['профіль', state.profile]] as const) {
    if (v !== undefined && v !== '' && !SAFE_ID.test(v)) return `Невірний ${k}: «${v}»`
  }
  if (state.ctxFrom !== undefined && (state.ctxFrom.startsWith('-') || /[\0\r\n]/.test(state.ctxFrom))) return `Невірний ctx-from: «${state.ctxFrom}»`
  return undefined
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

export interface SpawnPlan {
  file: string
  args: string[]
  /** cmd.exe gets one pre-quoted command line (`/d /s /c "…"`); Node must not re-quote it. */
  windowsVerbatimArguments?: boolean
}

/** cmd.exe metacharacters that quoting cannot neutralize (`%VAR%`, `!VAR!`, `"`, `^`) plus line breaks. */
const CMD_UNSAFE = /["%!^\r\n\0]/

/** One argument for a cmd.exe command line (inside `/s /c "…"`): quoted when needed, refused when unsafe. */
function cmdQuote(a: string): string | undefined {
  if (CMD_UNSAFE.test(a)) return undefined
  if (a && !/[\s&|<>()@,;=]/.test(a)) return a
  // Quoted: `&|<>()` are literal inside quotes; trailing backslashes must not escape the closing quote.
  return `"${a.replace(/(\\+)$/, '$1$1')}"`
}

/**
 * How to start `argv` without a shell (S12, DEP0190). On Windows `npx`/`npm` are `.cmd` shims that need
 * cmd.exe: each argument is quoted, and an argument cmd.exe would still expand is refused (`{ error }`).
 */
export function spawnPlan(argv: string[], platform: string = process.platform, comspec = process.env.ComSpec ?? 'cmd.exe'): SpawnPlan | { error: string } {
  const [bin0, ...rest] = argv
  if (!bin0) return { error: 'Порожня команда CLI' }
  if (platform !== 'win32') return { file: bin0, args: rest }
  const bin = /^(npx|npm|pnpm|yarn|context-gate)$/i.test(bin0) ? `${bin0}.cmd` : bin0
  if (!/\.(cmd|bat)$/i.test(bin)) return { file: bin, args: rest }
  const parts = [bin, ...rest].map(cmdQuote)
  const bad = parts.findIndex((x) => x === undefined)
  if (bad >= 0) return { error: `Аргумент «${[bin, ...rest][bad]}» містить символи, які cmd.exe підставляє (" % ! ^): запуск через ${bin} відхилено` }
  return { file: comspec, args: ['/d', '/s', '/c', `"${parts.join(' ')}"`], windowsVerbatimArguments: true }
}

/** Run the CLI and parse its JSON. Never rejects. `env` is merged over `process.env`. */
export function runCli(argv: string[], cwd: string, timeoutMs = 60_000, env?: Record<string, string>): Promise<RunView & { argv: string[] }> {
  const plan = spawnPlan(argv)
  if ('error' in plan) return Promise.resolve({ text: '', sections: [], trace: [], diagnostics: [], error: plan.error, argv })
  return new Promise((resolveP) => {
    execFile(plan.file, plan.args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}), ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number | string }).code ?? 1) : 0
      const view = parseRunOutput(stdout ?? '', stderr ?? '', typeof code === 'number' ? code : 1)
      if (err && !view.sections.length && !view.error) view.error = err.message
      resolveP({ ...view, argv })
    })
  })
}
