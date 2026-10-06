// Decision journal (SPEC "Журнал рішень", "/gate why"): ring buffer, Markdown table, JSONL, `where` filter.

import type { DecisionLogEntry } from './types.ts'

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
