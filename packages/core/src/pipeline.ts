// Pure pipeline stages over JSONL-friendly Item arrays (SPEC "Pipeline"): collect → normalize → decide → tokens / where.
// The CLI and `/gate … | …` run the same executors (`runPipeStage` over a `PipeHost`); each stage takes JSON and returns JSON.

import type { DecisionLogEntry, Gate, GateConfig, GateState, Item, ItemDecision, ItemKind, MdcRule, Signals } from './types.ts'
import type { PipeStage } from './gatecmd.ts'
import { parseDuration } from './duration.ts'
import { ruleToItem } from './mdc.ts'
import { groupsOf, normalizeItems, parseSkillListing, skillListingItems } from './items.ts'
import { decideGate } from './decide.ts'
import type { DecideOptions } from './decide.ts'
import { filterWhere, formatWhy, getPath } from './journal.ts'

export type DecidedItem = Item & { decision: ItemDecision }

export function collectFromRules(rules: readonly MdcRule[]): Item[] {
  return rules.map(ruleToItem)
}

export function collectFromSkillListing(text: string): Item[] {
  return skillListingItems(parseSkillListing(text))
}

export function normalize(items: readonly Item[]): Item[] {
  return normalizeItems(items)
}

/** Attach a decision to each item (fresh state, no hysteresis — a pipe run is one decision). */
export function decideStage(items: readonly Item[], cfg: GateConfig, signals: Signals, opts: DecideOptions & { state?: GateState } = {}): DecidedItem[] {
  const { gate } = decideGate(cfg, signals, opts.state ?? { turn: 0 }, items, opts)
  return items.map((it) => ({ ...it, decision: gate.items[it.id] ?? 'on' }))
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

export interface TokenSummary {
  count: number
  chars: number
  tokens: number
  /** Only items that reach the context (decision ≠ off; nameOnly counts the name). */
  included: { count: number; chars: number; tokens: number }
  byKind: Partial<Record<ItemKind, { count: number; chars: number; tokens: number }>>
  byDecision: Partial<Record<ItemDecision, { count: number; chars: number; tokens: number }>>
}

export function tokens(items: readonly (Item & { decision?: ItemDecision })[]): TokenSummary {
  const sum: TokenSummary = { count: 0, chars: 0, tokens: 0, included: { count: 0, chars: 0, tokens: 0 }, byKind: {}, byDecision: {} }
  const bump = (b: { count: number; chars: number; tokens: number }, chars: number) => { b.count++; b.chars += chars; b.tokens = estimateTokens(b.chars) }
  for (const it of items) {
    const chars = it.cost?.chars ?? 0
    bump(sum, chars)
    bump((sum.byKind[it.kind] ??= { count: 0, chars: 0, tokens: 0 }), chars)
    const d = it.decision ?? 'on'
    bump((sum.byDecision[d] ??= { count: 0, chars: 0, tokens: 0 }), chars)
    if (d !== 'off') bump(sum.included, d === 'nameOnly' ? it.name.length : chars)
  }
  sum.tokens = estimateTokens(sum.chars)
  return sum
}

/** `where` over items. Extra keys: `group` (needs cfg), `globs` (attach.globs), `when` (attach.when), `source` (provenance.source). */
export function whereFilter<T extends Item>(items: readonly T[], expr: string, cfg?: Pick<GateConfig, 'groups'>): { items: T[] } | { error: string } {
  return filterWhere(items, expr, (obj, key) => {
    const it = obj as T
    if (key === 'group') return cfg ? groupsOf(cfg, it) : []
    if (key === 'when') return it.attach?.when
    if (key === 'globs') return it.attach?.globs
    if (key === 'source') return it.provenance?.source
    if (key === 'chars') return it.cost?.chars
    return getPath(it, key)
  })
}

export function itemsToJsonl(items: readonly unknown[]): string {
  return items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '')
}

// ───────────────────────── Stage executors (CLI `pipe` and `/gate a | b`) ─────────────────────────
// One implementation of every pipe stage over JSON records. The host supplies what differs between the CLI
// (files on disk, `buildContext`) and the mod (the session's items, live gate and journal): `collect`,
// `decide`, `signals`, `render` and the journal. Everything else is pure.

export type StageOut = { records: unknown[] } | { text: string } | { error: string; code?: number }

export interface DecideFlags { profile?: string; model?: string; tier?: string; branch?: string; paths: string[] }

export interface RenderedRecord { text: string; tokens: number; included: boolean; reason?: string; status?: string }

export interface PipeHost {
  /** Config for `where group=…` and `budget`. */
  config: GateConfig
  now: number
  /** Items of every source (kind/id filters are applied by the stage). */
  collect(): Item[] | Promise<Item[]>
  decide(items: readonly Item[], flags: DecideFlags): Record<string, ItemDecision> | Promise<Record<string, ItemDecision>>
  signals(args: Record<string, string>): Record<string, unknown> | Promise<Record<string, unknown>>
  /** Render the named sections; absent → sections render as not found. */
  render?(ids: ReadonlySet<string>, args: Record<string, string>): Promise<{ tier: string; sections: Map<string, RenderedRecord> }>
  /** Journal entries (oldest first). */
  log(): readonly DecisionLogEntry[] | Promise<readonly DecisionLogEntry[]>
  /** `deliver` needs `--dry-run` (the CLI: delivery is the mod's or `sync`'s job). */
  deliverNeedsDryRun?: boolean
}

type AnyItem = Item & { decision?: ItemDecision } & Record<string, unknown>
const asItems = (records: readonly unknown[]): AnyItem[] => records.filter((r): r is AnyItem => !!r && typeof r === 'object' && typeof (r as Item).kind === 'string')

export function sinceMs(since: string | undefined, now: number): number | undefined {
  if (!since) return undefined
  const d = parseDuration(since)
  if (d !== undefined) return now - d
  const t = Date.parse(since)
  return Number.isFinite(t) ? t : undefined
}

export interface ObservedCounts { delivered: number; enabled: number; denied: number; lastAt?: number }

/** Per-item counters from the journal: delivered (rule-delivered / skill-render / decision enabled), denied. */
export function observeCounts(entries: readonly DecisionLogEntry[], from?: number): Map<string, ObservedCounts> {
  const out = new Map<string, ObservedCounts>()
  const bump = (id: string, k: 'delivered' | 'enabled' | 'denied', ts: number): void => {
    const c = out.get(id) ?? { delivered: 0, enabled: 0, denied: 0 }
    c[k]++
    c.lastAt = Math.max(c.lastAt ?? 0, ts)
    out.set(id, c)
  }
  for (const e of entries) {
    if (from !== undefined && (e.ts ?? 0) < from) continue
    const d = (e.data ?? {}) as Record<string, unknown>
    const kind = e.kind ?? 'decision'
    if (kind === 'rule-delivered') {
      const ids = [d.id, d.rule, ...(Array.isArray(d.rules) ? d.rules : [])].filter((x): x is string => typeof x === 'string')
      for (const id of ids) bump(id.includes(':') ? id : `rule:${id}`, 'delivered', e.ts)
    } else if (kind === 'skill-render' && typeof d.skill === 'string') bump(`skill:${d.skill}`, 'delivered', e.ts)
    else if (kind === 'deny') {
      const t = (d.tool ?? d.id ?? d.name) as string | undefined
      if (t) bump(t.includes(':') ? t : `tool:${t}`, 'denied', e.ts)
    } else if (kind === 'decision') for (const id of e.enabled ?? []) bump(id, 'enabled', e.ts)
  }
  return out
}

function num(v: string | undefined, dflt: number): number {
  const n = Number(v)
  return v !== undefined && Number.isFinite(n) ? n : dflt
}

/** How the `deliver` stage would hand one item to a harness adapter (dry run). */
export function deliveryOf(it: Item, d: ItemDecision, adapter: string): { event: string; action: string } {
  if (adapter === 'static') {
    const event = it.kind === 'rule' ? (it.ruleType === 'always' || it.ruleType === 'auto' ? '.claude/rules/cursor' : '.claude/skills/cursor-*') : it.kind === 'skill' ? 'settings.local.json skillOverrides' : it.kind === 'section' ? '.claude/prompt.generated.md' : '—'
    const action = d === 'off' ? (it.kind === 'skill' ? 'skillOverrides: off' : 'не генерується') : d === 'nameOnly' ? 'skillOverrides: name-only' : 'генерується'
    return { event, action }
  }
  if (it.kind === 'skill') return { event: d === 'preload' ? 'skill.prompt + prompt.compose' : 'prompt.attachment skill_listing', action: d === 'off' ? 'прибрано з листингу; skill.prompt → відмова' : d === 'nameOnly' ? 'лише назва в листингу' : d === 'preload' ? 'тіло вбудовано' : 'у листингу' }
  if (it.kind === 'tool') return { event: 'tool.describe + tool.call', action: d === 'off' ? 'isDeferred + { deny }' : 'доступний' }
  if (it.kind === 'agent') return { event: 'agent.offer', action: d === 'off' ? 'isOffered: false' : 'запропоновано' }
  if (it.kind === 'rule') return { event: it.ruleType === 'always' ? 'prompt.context' : it.ruleType === 'auto' ? 'tool.call (context після Read/Edit)' : it.ruleType === 'agent' ? 'skill (cursor-*)' : '/rule, @mention', action: d === 'off' ? 'не доставляється' : 'доставляється' }
  if (it.kind === 'section') return { event: 'prompt.compose', action: d === 'off' ? 'пропущено' : `секція context-gate:${it.name} (scope session)` }
  return { event: 'scope рендера', action: 'дані провайдера' }
}

/**
 * One stage over records. `last`: the stage ends the pipe (`why` prints its table there, records elsewhere).
 * `args` are `--key value` / `key=value` pairs (core gatecmd grammar).
 */
export async function runPipeStage(stage: PipeStage, input: readonly unknown[], host: PipeHost, opts: { last?: boolean } = {}): Promise<StageOut> {
  const a = stage.args
  const last = opts.last ?? true
  switch (stage.stage) {
    case 'collect': {
      let items = await host.collect()
      const kinds = (a.kind ?? stage.positional[0])?.split(',')
      if (kinds) items = items.filter((i) => kinds.includes(i.kind))
      if (a.id) { const ids = a.id.split(','); items = items.filter((i) => ids.includes(i.name) || ids.includes(i.id)) }
      return { records: [...asItems(input), ...items] }
    }
    case 'normalize': return { records: normalize(asItems(input)) }
    case 'signals': return { records: [await host.signals(a)] }
    case 'decide': {
      const items = asItems(input)
      const flags: DecideFlags = { paths: a.paths?.split(',').filter(Boolean) ?? [], ...(a.profile ? { profile: a.profile } : {}), ...(a.model ? { model: a.model } : {}), ...(a.tier ? { tier: a.tier } : {}), ...(a.branch ? { branch: a.branch } : {}) }
      const decisions = await host.decide(items, flags)
      return { records: items.map((it) => ({ ...it, decision: decisions[it.id] ?? 'on' })) }
    }
    case 'budget': {
      const maxItem = num(a['max-chars'] ?? a.max, host.config.cursorRules?.maxCharsPerInjection ?? 30_000)
      let total = a.total !== undefined ? num(a.total, Infinity) * 4 : Infinity
      return {
        records: asItems(input).map((it) => {
          const d = it.decision ?? 'on'
          if (d === 'off' || d === 'nameOnly') return it
          const chars = it.cost?.chars ?? 0
          if (chars > maxItem) return { ...it, decision: 'nameOnly' as ItemDecision, budget: `${chars} > ${maxItem} символів → on-demand`, attach: { ...it.attach, when: 'on-demand' } }
          if (chars > total) return { ...it, decision: 'nameOnly' as ItemDecision, budget: 'загальний бюджет вичерпано → on-demand', attach: { ...it.attach, when: 'on-demand' } }
          total -= chars
          return it
        }),
      }
    }
    case 'render': {
      const items = asItems(input)
      const ids = new Set(items.filter((i) => i.kind === 'section').map((i) => i.name))
      const r = ids.size && host.render ? await host.render(ids, a) : undefined
      return {
        records: items.map((it) => {
          if (it.kind === 'section') {
            const s = r?.sections.get(it.name)
            return { ...it, rendered: s ?? { text: '', tokens: 0, included: false, reason: 'не знайдено' }, ...(r ? { tier: r.tier } : {}) }
          }
          const d = it.decision
          const text = d === 'off' ? '' : d === 'nameOnly' ? it.name : it.kind === 'rule' || d === 'preload' ? it.body ?? '' : `${it.name}${it.description ? `: ${it.description}` : ''}`
          return { ...it, rendered: { text, tokens: Math.ceil(text.length / 4), included: d !== 'off' } }
        }),
      }
    }
    case 'tokens': return { records: [tokens(asItems(input))] }
    case 'preview': return { text: previewText(input) }
    case 'deliver': {
      if (host.deliverNeedsDryRun && a['dry-run'] === undefined && !stage.positional.includes('dry-run')) return { error: 'deliver у CLI лише з --dry-run: доставку робить mod (claude-code-mod) або context-gate sync (static)', code: 2 }
      const adapter = a.adapter ?? 'claude-code-mod'
      return { records: asItems(input).map((it) => { const d = it.decision ?? 'on'; return { id: it.id, decision: d, adapter, ...deliveryOf(it, d, adapter) } }) }
    }
    case 'observe': {
      const counts = observeCounts(await host.log(), sinceMs(a.since, host.now))
      const status = a.status
      const out = asItems(input).map((it) => ({ ...it, observed: counts.get(it.id) ?? { delivered: 0, enabled: 0, denied: 0 } }))
      const filtered = !status ? out : out.filter((it) => {
        const c = it.observed
        if (status === 'never') return c.delivered === 0 && c.enabled === 0
        if (status === 'delivered') return c.delivered > 0
        if (status === 'denied') return c.denied > 0
        if (status === 'enabled') return c.enabled > 0
        return (it as Item).status === status
      })
      return { records: filtered }
    }
    case 'where': {
      const r = whereFilter(input as Item[], stage.expr ?? stage.positional.join(' '), host.config)
      return 'error' in r ? { error: `G508 ${r.error}`, code: 2 } : { records: r.items }
    }
    case 'take': return { records: input.slice(0, num(stage.positional[0] ?? a.n, 10)) }
    case 'sort': {
      const key = stage.positional[0] ?? a.key ?? 'id'
      const desc = key.startsWith('-')
      const k = desc ? key.slice(1) : key
      const get = (x: unknown): unknown => k === 'chars' ? (x as Item).cost?.chars : getPath(x, k)
      return { records: [...input].sort((x, y) => { const p = get(x); const q = get(y); const c = typeof p === 'number' && typeof q === 'number' ? p - q : String(p ?? '').localeCompare(String(q ?? '')); return desc ? -c : c }) }
    }
    case 'on': return { records: asItems(input).filter((i) => (i.decision ?? 'on') !== 'off') }
    case 'off': return { records: asItems(input).filter((i) => i.decision === 'off') }
    case 'why': {
      const entries = [...(await host.log())]
      if (a.json || a.format === 'jsonl' || !last) return { records: [...input, ...entries] }
      return { text: formatWhy(entries, num(a.n, 50)) + '\n' }
    }
  }
  return { error: `G501 Невідома стадія «${String((stage as PipeStage).stage)}»`, code: 2 }
}

/** Runs `a | b | c` over the host. A text stage (`preview`, `why`) must be the last one. */
export async function runPipeline(stages: readonly PipeStage[], input: readonly unknown[], host: PipeHost): Promise<StageOut> {
  let records: unknown[] = [...input]
  for (let i = 0; i < stages.length; i++) {
    const out = await runPipeStage(stages[i], records, host, { last: i === stages.length - 1 })
    if ('error' in out) return out
    if ('text' in out) {
      if (i < stages.length - 1) return { error: `G504 Стадія ${stages[i].stage} виводить текст, далі в pipe її не передати`, code: 2 }
      return out
    }
    records = out.records
  }
  return { records }
}

/** `preview`: rendered records as text blocks, plain items as one line each. */
export function previewText(records: readonly unknown[]): string {
  const out: string[] = []
  for (const it of asItems(records)) {
    const r = it.rendered as { text?: string; included?: boolean; reason?: string } | undefined
    const d = it.decision
    if (r) { out.push(`<!-- ${it.id}${d ? ` ${d}` : ''}${r.included === false ? ` — пропущено${r.reason ? `: ${r.reason}` : ''}` : ''} -->`); if (r.text) out.push(r.text); out.push('') }
    else out.push(`- ${it.id}${d ? ` [${d}]` : ''}${it.description ? ` — ${it.description}` : ''} (${it.cost?.chars ?? 0} симв.)`)
  }
  return out.join('\n').replace(/\n+$/, '') + '\n'
}

/** `/gate … | …` answer: items as a list, other records as JSON lines; at most `max` rows. */
export function formatPipeText(out: StageOut, max = 100): string {
  if ('error' in out) return out.error
  if ('text' in out) return out.text.replace(/\n+$/, '')
  const rows = out.records
  if (!rows.length) return 'Порожньо: жоден запис не пройшов pipe.'
  const lines = rows.slice(0, max).map((r) => {
    const it = r as AnyItem
    if (r && typeof r === 'object' && typeof it.kind === 'string' && typeof it.id === 'string') {
      const obs = it.observed as ObservedCounts | undefined
      return `- ${it.id}${it.decision ? ` [${it.decision}]` : ''}${it.description ? ` — ${it.description}` : ''} (${it.cost?.chars ?? 0} симв.)${obs ? ` · доставлено ${obs.delivered}, увімкнено ${obs.enabled}, відмов ${obs.denied}` : ''}`
    }
    return '`' + JSON.stringify(r) + '`'
  })
  if (rows.length > max) lines.push(`…(+${rows.length - max})`)
  return [`${rows.length} ${rows.length === 1 ? 'запис' : 'записів'}:`, ...lines].join('\n')
}

// ───────────────────────── Provenance (`/gate`: where each item comes from) ─────────────────────────

export interface ProvenanceInput {
  config: Pick<GateConfig, 'groups' | 'tiers' | 'profiles'>
  gate: Pick<Gate, 'tier' | 'groups' | 'items' | 'off' | 'profile'> & { skills?: { preload: string[] }; shadow?: boolean }
  /** How the profile was chosen (GateState.profileSource): `manual`, `when:paths`, `classify 0.84`, … */
  profileSource?: string
  manual?: { profile?: string; add: string[]; remove: string[] }
}

/**
 * Why each enabled item is on (SPEC scenario 4: `manual`, `when:paths`, `tier`), computed from the gate's
 * groups: `+group` from `/gate` → `manual`, a tier group → `tier`, a profile group → how the profile was
 * chosen. Items in no group are on by default; `preload` comes from the tier. Off items are left out.
 */
export function itemProvenance(items: readonly Pick<Item, 'id' | 'kind' | 'name'>[], p: ProvenanceInput): Map<string, string> {
  const out = new Map<string, string>()
  if (p.gate.off) { for (const it of items) out.set(it.id, 'off (усе увімкнено)'); return out }
  const tierGroups = new Set(p.config.tiers?.[p.gate.tier]?.groups ?? [])
  const manualAdd = new Set<string>()
  for (const a of p.manual?.add ?? []) {
    if (p.config.groups?.[a]) manualAdd.add(a)
    else for (const g of p.config.profiles?.[a]?.groups ?? [a]) manualAdd.add(g)
  }
  const active = new Set(p.gate.groups)
  const profileTrigger = p.manual?.profile ? 'manual' : p.profileSource ?? 'profile'
  const noGroups = !Object.keys(p.config.groups ?? {}).length
  for (const it of items) {
    const d = p.gate.items[it.id] ?? 'on'
    if (d === 'off') continue
    if (d === 'preload') { out.set(it.id, `tier ${p.gate.tier} (preload)`); continue }
    if (d === 'nameOnly') { out.set(it.id, 'поза групами (лише назва)'); continue }
    if (noGroups) { out.set(it.id, 'без груп у gate.json'); continue }
    const gs = groupsOf(p.config, it).filter((g) => active.has(g))
    if (!gs.length) { out.set(it.id, 'не в групах'); continue }
    const labels = gs.map((g) => (manualAdd.has(g) ? `manual +${g}` : tierGroups.has(g) ? `tier ${p.gate.tier}: ${g}` : `${profileTrigger}${p.gate.profile ? ` ${p.gate.profile}` : ''}: ${g}`))
    out.set(it.id, [...new Set(labels)].join(', '))
  }
  return out
}
