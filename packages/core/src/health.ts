// Prompt health (SPEC "Prompt health: метрики промпту"): metrics over a RenderResult and the previous one.
// Pure: every number comes from data the caller already has; no model calls.

import type { Code, Diagnostic, HealthMetric, HealthReport, RenderResult, Scope } from './types.ts'
import type { RenderedSectionExt } from './render.ts'

export interface HealthExtras {
  /** Items whose delivery is unconfirmed (overrides the count of unverified sections). */
  unverified?: number
  contextPct?: number
  /** Size of the skills listing in characters. */
  skillListingChars?: number
  /** Context window in tokens (listing budget = 1 % of it). */
  contextWindow?: number
  /** Deny count per tool for this session. */
  denies?: Record<string, number>
  /** Prompt ids whose .compiled is older than its sources. */
  compiledStale?: string[]
}

export type HealthThresholds = Partial<Record<Code, number>>

export const DEFAULT_THRESHOLDS: Record<string, number> = {
  H001: 12_000, // total tokens
  H002: 70, // % stable since previous turn (minimum)
  H003: 500, // drift tokens outside volatile
  H004: 1000, // ms without scripts
  H005: 2000, // ms total
  H007: 0, // unverified items
  H009: 1, // listing % of context
  H010: 3, // denies of one tool
  H013: 0, // stale compiled prompts
}

const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function computeHealth(current: RenderResult, previous?: RenderResult, extras: HealthExtras = {}, thresholds: HealthThresholds = {}): HealthReport {
  const th = (c: string): number => (thresholds as Record<string, number | undefined>)[c] ?? DEFAULT_THRESHOLDS[c]
  const metrics: HealthMetric[] = []
  const diagnostics: Diagnostic[] = []
  const add = (m: HealthMetric): void => {
    metrics.push(m)
    if (!m.ok && m.code) diagnostics.push({ code: m.code, severity: 'warning', message: `${m.name}: ${m.value}${m.threshold !== undefined ? ` (поріг ${m.threshold})` : ''}`, ...(m.advice ? { hint: m.advice } : {}) })
  }

  const inc = current.sections.filter(s => s.included)
  const tokens = inc.reduce((a, s) => a + s.tokens, 0)
  const chars = inc.reduce((a, s) => a + s.chars, 0)
  const byScope = (sc: Scope): number => inc.filter(s => s.scope === sc).reduce((a, s) => a + s.tokens, 0)
  const staticPct = tokens ? Math.round((byScope('static') / tokens) * 100) : 0
  const biggest = [...inc].sort((a, b) => b.tokens - a.tokens)[0]

  // Informational size metrics (status line reads these by name).
  metrics.push({ name: 'tokens', value: tokens, ok: true })
  metrics.push({ name: 'chars', value: chars, ok: true })
  metrics.push({ name: 'static-pct', value: staticPct, ok: true })
  for (const sc of ['static', 'profile', 'volatile'] as Scope[]) metrics.push({ name: `tokens:${sc}`, value: byScope(sc), ok: true })

  add({
    code: 'H001', name: 'Розмір промпту (токени)', value: tokens, threshold: th('H001'), ok: tokens <= th('H001'),
    advice: biggest ? `\`${biggest.id}\` ${fmtK(biggest.tokens)} → додати \`budget\` або перевести частину в \`ref\`/\`lazy\`` : undefined,
  })

  if (previous) {
    const prev = new Map(previous.sections.filter(s => s.included).map(s => [s.id, s]))
    const stableChars = inc.filter(s => prev.get(s.id)?.hash === s.hash).reduce((a, s) => a + s.chars, 0)
    const stablePct = chars ? Math.round((stableChars / chars) * 100) : 100
    const changed = inc.filter(s => prev.get(s.id)?.hash !== s.hash)
    add({
      code: 'H002', name: 'Стабільна частка (prompt cache), %', value: stablePct, threshold: th('H002'), ok: stablePct >= th('H002'),
      advice: changed.length ? `змінились: ${changed.map(s => s.id).join(', ')} → винести змінне у volatile` : undefined,
    })
    let drift = 0
    const drifted: string[] = []
    const ids = new Set([...inc.map(s => s.id), ...prev.keys()])
    for (const id of ids) {
      const c = inc.find(s => s.id === id)
      const p = prev.get(id)
      if ((c?.scope ?? p?.scope) === 'volatile' || c?.hash === p?.hash) continue
      drift += Math.abs((c?.tokens ?? 0) - (p?.tokens ?? 0)) || Math.max(c?.tokens ?? 0, p?.tokens ?? 0)
      drifted.push(id)
    }
    add({
      code: 'H003', name: 'Дрейф поза volatile (токени)', value: drift, threshold: th('H003'), ok: drift <= th('H003'),
      advice: drifted.length ? `${drifted.join(', ')} → стабілізувати або перевести у volatile` : undefined,
    })
  } else {
    metrics.push({ code: 'H002', name: 'Стабільна частка (prompt cache), %', value: '—', ok: true })
  }

  const runMs = current.trace.filter(t => (t.kind === 'run' || t.kind === 'call' || t.kind === 'mcp') && t.source === 'run').reduce((a, t) => a + (t.ms ?? 0), 0)
  const noScripts = Math.max(0, current.ms - runMs)
  const slowest = current.trace.filter(t => t.ms !== undefined).sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))[0]
  add({ code: 'H004', name: 'Час рендера без скриптів, мс', value: noScripts, threshold: th('H004'), ok: noScripts <= th('H004'), advice: 'спростити вирази або перенести логіку в провайдер' })
  add({
    code: 'H005', name: 'Час рендера разом, мс', value: current.ms, threshold: th('H005'), ok: current.ms <= th('H005'),
    advice: slowest ? `найдовше: ${slowest.section} ${slowest.kind} ${slowest.ms} мс → додати \`cache=\`` : 'додати `cache=` до @run',
  })

  // H006: sections rendered from data past its cache window (`stale` is set by render.ts).
  const staleSecs = (current.sections as RenderedSectionExt[]).filter(s => s.included && s.stale && s.stale.length)
  add({
    code: 'H006', name: 'Секції зі застарілих даних', value: staleSecs.length, threshold: 0, ok: staleSecs.length === 0,
    advice: staleSecs.length ? `${staleSecs.map(s => `${s.id} (${s.stale!.join(', ')})`).join('; ')} → оновити дані (context-gate data set, cron/CI) або збільшити cache` : undefined,
  })

  const unverified = extras.unverified ?? current.sections.filter(s => s.status === 'unverified').length
  add({ code: 'H007', name: 'Unverified', value: unverified, threshold: th('H007'), ok: unverified <= th('H007'), advice: 'перевірити довіру до репозиторію (/gate trust) і onError провайдерів' })

  const truncated = current.sections.filter(s => s.truncated)
  const truncStatic = truncated.filter(s => s.scope === 'static')
  add({
    code: 'H008', name: 'Урізання static-секцій', value: truncStatic.length, threshold: 0, ok: truncStatic.length === 0,
    advice: truncStatic.length ? `${truncStatic.map(s => s.id).join(', ')} → збільшити \`budget\` або скоротити текст` : truncated.length ? `урізано (не static): ${truncated.map(s => s.id).join(', ')}` : undefined,
  })

  if (extras.skillListingChars !== undefined && extras.contextWindow) {
    const pct = Math.round(((extras.skillListingChars / 4) / extras.contextWindow) * 1000) / 10
    add({ code: 'H009', name: 'Листинг skills, % контексту', value: pct, threshold: th('H009'), ok: pct <= th('H009'), advice: 'вимкнути групи skills у профілі або скоротити описи' })
  }

  if (extras.denies) {
    const worst = Object.entries(extras.denies).sort((a, b) => b[1] - a[1])[0]
    const n = worst?.[1] ?? 0
    add({ code: 'H010', name: 'Deny одного інструмента', value: n, threshold: th('H010'), ok: n <= th('H010'), advice: worst ? `\`${worst[0]}\` → увімкнути його групу в профілі або пояснити в промпті` : undefined })
  }

  if (extras.compiledStale) {
    const n = extras.compiledStale.length
    add({ code: 'H013', name: 'Застарілий .compiled', value: n, threshold: th('H013'), ok: n <= th('H013'), advice: n ? `${extras.compiledStale.join(', ')} → context-gate build` : undefined })
  }

  if (extras.contextPct !== undefined) metrics.push({ name: 'ctx-pct', value: extras.contextPct, ok: true })

  return {
    metrics,
    sections: current.sections.map(s => ({ id: s.id, scope: s.scope, chars: s.chars, tokens: s.tokens, ...(s.truncated ? { truncated: true } : {}) })),
    diagnostics,
  }
}

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ')

/** Markdown table for `/gate health` with a «що зробити» column. */
export function formatHealth(report: HealthReport): string {
  const lines = ['| Код | Метрика | Значення | Поріг | Стан | Що зробити |', '| --- | --- | --- | --- | --- | --- |']
  for (const m of report.metrics) {
    if (!m.code) continue
    lines.push(`| ${m.code} | ${esc(m.name)} | ${m.value} | ${m.threshold ?? ''} | ${m.ok ? 'ok' : '⚠'} | ${m.ok ? '' : esc(m.advice ?? '')} |`)
  }
  if (report.sections.length) {
    lines.push('', '| Секція | scope | символи | токени |', '| --- | --- | --- | --- |')
    for (const s of [...report.sections].sort((a, b) => b.tokens - a.tokens)) lines.push(`| ${esc(s.id)}${s.truncated ? ' (обрізано)' : ''} | ${s.scope} | ${s.chars} | ${s.tokens} |`)
  }
  return lines.join('\n')
}

/** `ctx 38% · prompt 8.1k (static 76%) · ◌ 0` */
export function statusLine(report: HealthReport, ctxPct?: number): string {
  const get = (name: string): number => {
    const v = report.metrics.find(m => m.name === name)?.value
    return typeof v === 'number' ? v : 0
  }
  const unverified = report.metrics.find(m => m.code === 'H007')?.value ?? 0
  const pct = ctxPct ?? (report.metrics.some(m => m.name === 'ctx-pct') ? get('ctx-pct') : undefined)
  const parts: string[] = []
  if (pct !== undefined) parts.push(`ctx ${Math.round(pct)}%`)
  parts.push(`prompt ${fmtK(get('tokens'))} (static ${get('static-pct')}%)`)
  parts.push(`◌ ${unverified}`)
  return parts.join(' · ')
}
