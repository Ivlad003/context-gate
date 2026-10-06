// `context-gate run --json` output and `.claude/prompt/.trace/last.json`: one shape, written by the CLI and
// read by the LSP, the browser editor and the VS Code preview.

import type { Diagnostic, HealthReport, RenderedSection, TraceEntry, Value } from './types.ts'

/** Run metadata (not needed to show a preview). */
export interface RunJsonMeta {
  /** No usage error, no error diagnostics. */
  ok: boolean
  mode: 'prompt' | 'skill' | 'section'
  id?: string
  tier: string
  profile: string | null
  /** Where the scope came from: the live repo, a journal snapshot or a fixture. */
  source: 'live' | 'session' | 'fixture'
  trusted: boolean
  /** Skill argument error: the usage text (also in `text`). */
  usage?: string
  stored: Record<string, Value>
  lazies: { name: string; ref: string; description?: string }[]
  gate: { profile: string | null; tier: string; trigger: string; groups: string[]; reason: string[] }
  at: number
  /** `run --diff <src> --json`: the line diff against `against`. */
  diff?: string
  against?: string
}

export interface RunJson {
  sections: RenderedSection[]
  /** Rendered text without section markers (`run --no-markers`). */
  text: string
  trace: TraceEntry[]
  diagnostics: Diagnostic[]
  ms: number
  /** The render scope the expressions were evaluated in. */
  scope: Record<string, Value>
  /** Prompt health of this render (system-prompt mode). */
  health?: HealthReport
  meta: RunJsonMeta
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Parse `run --json` stdout or `last.json`. Leading log lines before the JSON object are skipped. */
export function parseRunJson(text: string): { json: RunJson } | { error: string } {
  const i = text.indexOf('{')
  if (i < 0) return { error: 'немає JSON' }
  let v: unknown
  try { v = JSON.parse(text.slice(i)) } catch (e) { return { error: `Невірний JSON: ${(e as Error).message}` } }
  if (!isObj(v)) return { error: 'JSON не є об\'єктом' }
  const missing = (['sections', 'text', 'trace', 'diagnostics', 'ms', 'scope'] as const).filter((k) => !(k in v))
  if (missing.length) return { error: `Не формат run --json: немає ${missing.join(', ')}` }
  if (!Array.isArray(v.sections) || typeof v.text !== 'string' || !Array.isArray(v.trace) || !Array.isArray(v.diagnostics) || typeof v.ms !== 'number' || !isObj(v.scope)) {
    return { error: 'Не формат run --json: невірні типи полів' }
  }
  return { json: v as unknown as RunJson }
}
