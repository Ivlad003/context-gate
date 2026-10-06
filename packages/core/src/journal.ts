// Decision journal (SPEC "Журнал рішень", "/gate why"): ring buffer, Markdown table, JSONL, `where` filter.

import type { DecisionLogEntry, Value } from './types.ts'

export const LOG_MAX = 200

/** Append to a ring buffer (pure: returns a new array, oldest dropped beyond `max`). */
export function pushLog<T>(buf: readonly T[], entry: T, max = LOG_MAX): T[] {
  const out = [...buf, entry]
  return out.length > max ? out.slice(out.length - max) : out
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

function listChanges(prev: DecisionLogEntry | undefined, cur: DecisionLogEntry, limit = 4): string {
  const short = (id: string) => id.replace(/^[a-z]+:/, '')
  const fmt = (sign: string, ids: string[]) => {
    if (!ids.length) return ''
    const head = ids.slice(0, limit).map((i) => sign + short(i)).join(' ')
    return ids.length > limit ? `${head} …(+${ids.length - limit})` : head
  }
  if (!prev) {
    return [`${cur.enabled.length} увімк.`, `${cur.disabled.length} вимк.`].join(', ')
  }
  const prevOn = new Set(prev.enabled)
  const prevOff = new Set(prev.disabled)
  const on = cur.enabled.filter((i) => !prevOn.has(i))
  const off = cur.disabled.filter((i) => !prevOff.has(i))
  const s = [fmt('+', on), fmt('−', off)].filter(Boolean).join(' ')
  return s || '—'
}

function triggerLabel(e: DecisionLogEntry): string {
  const proposed = e.data?.proposed as { profile: string; confidence: number } | undefined
  if (e.trigger === 'classify' && proposed) return `classify ${proposed.confidence.toFixed(2)}`
  return String(e.trigger)
}

/** Markdown table of the last `n` decision entries: хід, тригер, профіль, tier, зміни, причина. */
export function formatWhy(entries: readonly DecisionLogEntry[], n = 50): string {
  const decisions = entries.filter((e) => !e.kind || e.kind === 'decision')
  const start = Math.max(0, decisions.length - n)
  const rows = ['| хід | тригер | профіль | tier | зміни | причина |', '| --- | --- | --- | --- | --- | --- |']
  for (let i = start; i < decisions.length; i++) {
    const e = decisions[i]
    const proposed = e.data?.proposed as { profile: string; confidence: number } | undefined
    const profile = e.profile ?? (proposed ? `(${proposed.profile}?)` : '—')
    rows.push(`| ${e.turn} | ${esc(triggerLabel(e))} | ${esc(profile)} | ${esc(e.tier)} | ${esc(listChanges(decisions[i - 1], e))} | ${esc(e.reason.join('; ') || '—')} |`)
  }
  if (rows.length === 2) rows.push('| — | — | — | — | — | рішень ще не було |')
  return rows.join('\n')
}

export function toJsonl(entry: unknown): string {
  return JSON.stringify(entry) + '\n'
}

/** Parse JSONL; bad lines are skipped and counted. */
export function fromJsonl<T = unknown>(text: string): { items: T[]; bad: number } {
  const items: T[] = []
  let bad = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { items.push(JSON.parse(line) as T) } catch { bad++ }
  }
  return { items, bad }
}

// ───────────────────────── session snapshots ─────────────────────────
// Contract between the mod (writer, `.claude/gate.log.jsonl` with `log.file: true`) and the CLI
// (`run --ctx-from session:<id|latest>`, `run --diff session:…`). Entries:
//   { kind: 'snapshot', trigger: 'compose', tier, profile?, data: SnapshotData }       on each prompt.compose
//   { kind: 'skill-render', trigger: 'skill', tier, data: { sessionId, model, ctxPercent, skill, args, … } }
// `scope` is the render scope (our data, never the user's prompt); `text` is the rendered system-prompt text
// (ours). Both are truncated; a scope over the cap is dropped (the CLI then renders against the live context).

export const SNAPSHOT_TEXT_MAX = 20_000
export const SNAPSHOT_SCOPE_MAX = 40_000
/** Snapshot lines kept in the JSONL file (older ones are pruned on write). */
export const SNAPSHOT_KEEP = 20

export interface SnapshotData {
  sessionId: string
  model: string
  ctxPercent: number
  tier: string
  profile: string | null
  scope?: Record<string, Value>
  text?: string
}

export interface Snapshot { ts?: number; sessionId?: string; profile?: string; tier?: string; model?: string; ctxPercent?: number; scope?: Record<string, Value>; text?: string; args?: Record<string, Value>; skill?: string }

/** `data` of a `snapshot` entry: text cut to SNAPSHOT_TEXT_MAX, scope dropped beyond SNAPSHOT_SCOPE_MAX JSON chars. */
export function snapshotData(d: SnapshotData): SnapshotData {
  const out: SnapshotData = { sessionId: d.sessionId, model: d.model, ctxPercent: d.ctxPercent, tier: d.tier, profile: d.profile }
  if (d.scope) {
    const { args: _args, ...scope } = d.scope
    if (JSON.stringify(scope).length <= SNAPSHOT_SCOPE_MAX) out.scope = scope
  }
  if (d.text !== undefined) out.text = d.text.length > SNAPSHOT_TEXT_MAX ? d.text.slice(0, SNAPSHOT_TEXT_MAX) : d.text
  return out
}

/** A full `snapshot` log entry. */
export function snapshotEntry(d: SnapshotData, at: { ts: number; turn: number }): DecisionLogEntry {
  const data = snapshotData(d)
  return { ts: at.ts, turn: at.turn, trigger: 'compose', ...(d.profile ? { profile: d.profile } : {}), tier: d.tier, enabled: [], disabled: [], reason: [], kind: 'snapshot', data: data as unknown as Record<string, unknown> }
}

/** Keep the last `keep` snapshot lines of a JSONL text (other lines untouched). */
export function pruneSnapshots(text: string, keep = SNAPSHOT_KEEP): string {
  const lines = text.split('\n')
  const idx: number[] = []
  lines.forEach((l, i) => { if (l.includes('"kind":"snapshot"')) idx.push(i) })
  if (idx.length <= keep) return text
  const drop = new Set(idx.slice(0, idx.length - keep))
  return lines.filter((_, i) => !drop.has(i)).join('\n')
}

/**
 * Latest (`which = 'latest'`) or session-`which` snapshot from journal entries: the scope and text come from
 * the last `snapshot` (falling back to the last `decision` for profile/tier), skill `args` from the last
 * `skill-render` of the same session.
 */
export function findSnapshot(entries: readonly unknown[], which: string): Snapshot | undefined {
  const want = which === 'latest' ? undefined : which
  const rec = (e: unknown): Record<string, unknown> | undefined => (e && typeof e === 'object' && !Array.isArray(e) ? e as Record<string, unknown> : undefined)
  const dataOf = (e: Record<string, unknown>): Record<string, unknown> => rec(e.data) ?? {}
  const ofId = (e: Record<string, unknown>): string | undefined => {
    const d = dataOf(e)
    const v = d.sessionId ?? e.sessionId ?? rec(d.session)?.id
    return typeof v === 'string' ? v : undefined
  }
  const all = entries.map(rec).filter((e): e is Record<string, unknown> => !!e && (!want || ofId(e) === want))
  const last = (kind: string, sid?: string) => [...all].reverse().find((e) => String(e.kind ?? 'decision') === kind && (!sid || ofId(e) === sid))
  const e = last('snapshot') ?? last('decision')
  if (!e) return undefined
  const sid = ofId(e)
  const skill = last('skill-render', sid)
  const d = dataOf(e)
  const sd = skill ? dataOf(skill) : {}
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const scope = rec(d.scope) as Record<string, Value> | undefined
  const args = rec(sd.args) as Record<string, Value> | undefined
  const out: Snapshot = {}
  if (num(e.ts) !== undefined) out.ts = num(e.ts)
  if (sid) out.sessionId = sid
  const profile = str(d.profile) ?? str(e.profile)
  if (profile) out.profile = profile
  const tier = str(d.tier) ?? str(e.tier)
  if (tier) out.tier = tier
  if (str(d.model)) out.model = str(d.model)
  if (num(d.ctxPercent) !== undefined) out.ctxPercent = num(d.ctxPercent)
  if (scope) out.scope = scope
  if (typeof d.text === 'string') out.text = d.text
  if (args) out.args = args
  if (str(sd.skill)) out.skill = str(sd.skill)
  return out
}

// ───────────────────────── where filter ─────────────────────────

export interface WhereCond { key: string; op: '=' | '!=' | '~' | '>' | '<' | '>=' | '<='; value: string }

/** Parse `where status=unverified kind!=tool` (also `and`-joined, quoted values). `where` prefix is optional. */
export function parseWhere(expr: string): { conds: WhereCond[] } | { error: string } {
  let s = expr.trim().replace(/^where\b/, '').trim()
  const conds: WhereCond[] = []
  const re = /^([A-Za-z_][\w.]*)\s*(!=|>=|<=|=|~|>|<)\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+)\s*/
  while (s) {
    if (/^(and|&&)\s+/i.test(s)) { s = s.replace(/^(and|&&)\s+/i, ''); continue }
    const m = re.exec(s)
    if (!m) return { error: `G508 Невірний фільтр where: «${s}». Форма: where key=value` }
    let v = m[3]
    if (v.startsWith('"')) { try { v = JSON.parse(v) as string } catch { v = v.slice(1, -1) } }
    else if (v.startsWith("'")) v = v.slice(1, -1)
    conds.push({ key: m[1], op: m[2] as WhereCond['op'], value: v })
    s = s.slice(m[0].length)
  }
  if (!conds.length) return { error: 'G508 Порожній фільтр where' }
  return { conds }
}

export function getPath(obj: unknown, key: string): unknown {
  let cur: unknown = obj
  for (const k of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function eqValue(actual: unknown, want: string): boolean {
  if (Array.isArray(actual)) return actual.some((a) => eqValue(a, want))
  if (actual === undefined || actual === null) return want === 'null' || want === ''
  return String(actual) === want
}

export function matchCond(obj: unknown, c: WhereCond, resolve?: (obj: unknown, key: string) => unknown): boolean {
  const actual = resolve ? resolve(obj, c.key) : getPath(obj, c.key)
  switch (c.op) {
    case '=': return eqValue(actual, c.value)
    case '!=': return !eqValue(actual, c.value)
    case '~': {
      const vals = Array.isArray(actual) ? actual : [actual]
      return vals.some((a) => a !== undefined && a !== null && String(a).toLowerCase().includes(c.value.toLowerCase()))
    }
    default: {
      const a = typeof actual === 'number' ? actual : Number(actual)
      const b = Number(c.value)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      return c.op === '>' ? a > b : c.op === '<' ? a < b : c.op === '>=' ? a >= b : a <= b
    }
  }
}

/** Filter any JSON-like records with a `where` expression. */
export function filterWhere<T>(records: readonly T[], expr: string, resolve?: (obj: unknown, key: string) => unknown): { items: T[] } | { error: string } {
  const p = parseWhere(expr)
  if ('error' in p) return p
  return { items: records.filter((r) => p.conds.every((c) => matchCond(r, c, resolve))) }
}

/** Journal-specific resolver: `status` reads `data.status`, `id` checks enabled/disabled ids. */
export function journalResolve(obj: unknown, key: string): unknown {
  const direct = getPath(obj, key)
  if (direct !== undefined) return direct
  return getPath((obj as { data?: unknown })?.data, key)
}
