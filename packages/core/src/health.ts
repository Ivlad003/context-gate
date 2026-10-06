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
  /** Per-gate counters (`hooks/layers/gates.ts gateStats`, or the journal): attempts, blocks, total ms, manual overrides. */
  gates?: Record<string, GateStat>
  /** Real usage of the last request (`turn.step` `usage`, PROBE): H002 from cache hits, H012 the prompt share. */
  usage?: UsageStat
  /** Compactions in this session. */
  compactions?: number
  /** Gate decision of the session: profile, classifier confidence, manual overrides. */
  decision?: { profile?: string | null; confidence?: number; manualOverrides?: number }
  /** USD per 1k input tokens of the session model (`models` attributes); with `usage.sessionInputTokens` → a cost estimate. */
  costPer1k?: number
  /** Session cost as the engine reports it (`$.session.usage().cost`), preferred over the estimate. */
  costUsd?: number
  /** Skills in the listing without a description (nameOnly or dropped by the native 1 % budget). */
  skillsNoDescription?: number
}

export interface GateStat { attempts: number; blocks: number; ms?: number; overrides?: number }

export interface UsageStat {
  /** `input_tokens` of the last request (uncached part). */
  inputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  outputTokens?: number
  /** Input tokens summed over the session (cost estimate). */
  sessionInputTokens?: number
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
  H011: 30, // % of attempts a gate blocks
  H012: 40, // % of input tokens that is the system prompt
  H013: 0, // stale compiled prompts
  D001: 0, // failed @assert
}

/** Names of informational metrics the status line reads; the rest of the uncoded ones show under «Сесія». */
const INTERNAL = new Set(['tokens', 'chars', 'static-pct', 'tokens:static', 'tokens:profile', 'tokens:volatile', 'ctx-pct'])
const SCRIPT_KINDS = new Set(['run', 'call', 'mcp'])

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

  const u = extras.usage
  const usageIn = u ? (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0) : 0
  const realStable = u && usageIn > 0 && u.cacheReadTokens !== undefined ? Math.round(((u.cacheReadTokens ?? 0) / usageIn) * 100) : undefined
  if (realStable !== undefined) {
    add({
      code: 'H002', name: 'Стабільна частка (prompt cache), %', value: realStable, threshold: th('H002'), ok: realStable >= th('H002'),
      advice: `з usage: cache_read ${fmtK(u!.cacheReadTokens ?? 0)} з ${fmtK(usageIn)} вхідних → винести змінне у volatile в кінці`,
    })
  }

  if (previous) {
    const prev = new Map(previous.sections.filter(s => s.included).map(s => [s.id, s]))
    const stableChars = inc.filter(s => prev.get(s.id)?.hash === s.hash).reduce((a, s) => a + s.chars, 0)
    const stablePct = chars ? Math.round((stableChars / chars) * 100) : 100
    const changed = inc.filter(s => prev.get(s.id)?.hash !== s.hash)
    if (realStable === undefined) add({
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
  } else if (realStable === undefined) {
    metrics.push({ code: 'H002', name: 'Стабільна частка (prompt cache), %', value: '—', ok: true })
  }

  const runMs = current.trace.filter(t => (t.kind === 'run' || t.kind === 'call' || t.kind === 'mcp') && t.source === 'run').reduce((a, t) => a + (t.ms ?? 0), 0)
  const noScripts = Math.max(0, current.ms - runMs)
  const slow = current.trace.filter(t => t.ms !== undefined && SCRIPT_KINDS.has(t.kind)).sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
  const slowest = slow[0] ?? current.trace.filter(t => t.ms !== undefined).sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))[0]
  const top = slow.slice(0, 3).map(t => `${t.section} ${t.kind} ${t.ms} мс`).join(', ')
  const scripted = current.trace.filter(t => SCRIPT_KINDS.has(t.kind) && (t.source === 'cache' || t.source === 'run'))
  const hits = scripted.filter(t => t.source === 'cache').length
  const hitPct = scripted.length ? Math.round((hits / scripted.length) * 100) : undefined
  if (hitPct !== undefined) metrics.push({ name: 'Cache hit rate @run/@call/@mcp, %', value: hitPct, ok: true, advice: `${hits} з ${scripted.length}` })
  if (top) metrics.push({ name: 'Найдовші @run і провайдери', value: top, ok: true })
  add({ code: 'H004', name: 'Час рендера без скриптів, мс', value: noScripts, threshold: th('H004'), ok: noScripts <= th('H004'), advice: 'спростити вирази або перенести логіку в провайдер' })
  add({
    code: 'H005', name: 'Час рендера разом, мс', value: current.ms, threshold: th('H005'), ok: current.ms <= th('H005'),
    advice: top ? `найдовші: ${top}${hitPct !== undefined ? `; cache hit ${hitPct} %` : ''} → додати \`cache=\`` : slowest ? `найдовше: ${slowest.section} ${slowest.kind} ${slowest.ms} мс → додати \`cache=\`` : 'додати `cache=` до @run',
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
    const noDesc = extras.skillsNoDescription
    add({ code: 'H009', name: 'Листинг skills, % контексту', value: pct, threshold: th('H009'), ok: pct <= th('H009') && !noDesc, advice: `${noDesc ? `${noDesc} skills без опису; ` : ''}вимкнути групи skills у профілі або скоротити описи` })
  }
  if (extras.skillsNoDescription !== undefined) metrics.push({ name: 'Skills без опису в листингу', value: extras.skillsNoDescription, ok: true })

  if (extras.denies) {
    const worst = Object.entries(extras.denies).sort((a, b) => b[1] - a[1])[0]
    const n = worst?.[1] ?? 0
    add({ code: 'H010', name: 'Deny одного інструмента', value: n, threshold: th('H010'), ok: n <= th('H010'), advice: worst ? `\`${worst[0]}\` → увімкнути його групу в профілі або пояснити в промпті` : undefined })
  }

  if (extras.gates && Object.keys(extras.gates).length) {
    let worst: [string, number] | undefined
    for (const [name, g] of Object.entries(extras.gates)) {
      if (!g.attempts) continue
      const pct = Math.round((g.blocks / g.attempts) * 100)
      const avg = g.ms !== undefined ? Math.round(g.ms / g.attempts) : undefined
      metrics.push({ name: `Гейт ${name}`, value: `${g.blocks}/${g.attempts} заблоковано (${pct} %)${avg !== undefined ? `, ${avg} мс у середньому` : ''}${g.overrides ? `, «все одно» ${g.overrides}` : ''}`, ok: true })
      if (!worst || pct > worst[1]) worst = [name, pct]
    }
    if (worst) {
      const g = extras.gates[worst[0]]
      add({
        code: 'H011', name: 'Гейт блокує спроб, %', value: worst[1], threshold: th('H011'), ok: worst[1] <= th('H011'),
        advice: `\`${worst[0]}\` ${g.blocks}/${g.attempts}${g.overrides ? `, ручних «все одно» ${g.overrides} (false positives?)` : ''} → звузити \`tiers\`, \`onlyNew\` + \`baseline\` або послабити \`pass\``,
      })
    }
  }

  if (u && usageIn > 0) {
    const pct = Math.round((tokens / usageIn) * 100)
    add({
      code: 'H012', name: 'Системний промпт, % вхідних токенів', value: pct, threshold: th('H012'), ok: pct <= th('H012'),
      advice: biggest ? `промпт ${fmtK(tokens)} з ${fmtK(usageIn)} → \`${biggest.id}\` ${fmtK(biggest.tokens)} у \`ref\`/\`lazy\` або \`budget\`` : undefined,
    })
    if (u.cacheReadTokens !== undefined) metrics.push({ name: 'Токени кешу (cache_read / cache_creation)', value: `${fmtK(u.cacheReadTokens)} / ${fmtK(u.cacheCreationTokens ?? 0)}`, ok: true })
  }
  const cost = extras.costUsd ?? (extras.costPer1k !== undefined && u?.sessionInputTokens !== undefined ? (u.sessionInputTokens / 1000) * extras.costPer1k : undefined)
  if (cost !== undefined) {
    const share = u && usageIn > 0 ? ` (промпт ≈ ${Math.round((tokens / usageIn) * 100)} %)` : ''
    metrics.push({ name: `Вартість сесії, $${extras.costUsd === undefined ? ' (оцінка)' : ''}`, value: `${cost.toFixed(2)}${share}`, ok: true })
  }
  if (extras.compactions !== undefined) metrics.push({ name: 'Компакції за сесію', value: extras.compactions, ok: true })
  if (extras.decision) {
    const d = extras.decision
    metrics.push({ name: 'Рішення gate', value: `профіль ${d.profile ?? '—'}${d.confidence !== undefined ? `, confidence ${d.confidence.toFixed(2)}` : ''}${d.manualOverrides ? `, ручних перевизначень ${d.manualOverrides}` : ''}`, ok: true })
  }

  const asserts = current.diagnostics.filter(d => d.code === 'D001')
  add({
    code: 'D001', name: 'Assert не пройшов', value: asserts.length, threshold: th('D001'), ok: asserts.length <= th('D001'),
    advice: asserts.length ? `${asserts.slice(0, 3).map(d => d.message).join('; ')} → перевірити дані або умову \`@assert\`` : undefined,
  })

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
  const info = report.metrics.filter(m => !m.code && !INTERNAL.has(m.name))
  if (info.length) {
    lines.push('', '| Сесія | Значення |', '| --- | --- |')
    for (const m of info) lines.push(`| ${esc(m.name)} | ${esc(String(m.value))}${m.advice ? ` (${esc(m.advice)})` : ''} |`)
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
