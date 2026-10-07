// Journal aggregates for `context-gate report` and `/gate why` (SPEC "Ескалація", сценарії 8 і 11,
// "Промпти як skills"). Pure, over `.claude/gate.log.jsonl` entries; no Node.

import type { DecisionLogEntry, GateConfig, Item } from './types.ts'
import { enablingGroup } from './decide.ts'

// ───────────────────────── attempts and tokens per tier per task (G-09) ─────────────────────────

export interface TierCost { tier: string; attempts: number; failed: number; passed: number; turns: number; tokens: number }
export interface TaskCost { task: string; tiers: TierCost[] }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Tokens an entry carries: `data.tokens`, or `data.usage` (`input_tokens` + cache tokens + `output_tokens`). */
export function entryTokens(e: DecisionLogEntry): number {
  const d = e.data ?? {}
  if (typeof d.tokens === 'number') return num(d.tokens)
  const u = d.usage as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return 0
  return num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens)
}

/** A verification attempt: a Verify run (runner), a command gate, or a failed test/lint Bash call (mod).
 * A command gate is counted from its `gate-attempt` entries (`pass` and `block`); its `gate-failed` twin is
 * then skipped (`attemptGates`: gates that have `gate-attempt` entries), so a block counts once. */
function attemptOf(e: DecisionLogEntry, attemptGates: ReadonlySet<string>): 'passed' | 'failed' | undefined {
  if ((e.kind as string) === 'gate-attempt') {
    const o = e.data?.outcome
    return o === 'pass' ? 'passed' : o === 'block' ? 'failed' : undefined
  }
  if (e.kind === 'gate-failed') return attemptGates.has(gateName(e)) ? undefined : 'failed'
  if (e.trigger === 'verify' && e.data?.gate === 'verify') return e.data?.passed === true ? 'passed' : 'failed'
  if (e.kind === 'debug' && e.trigger === 'verify-failed') return 'failed'
  return undefined
}

/**
 * How many attempts and tokens each tier cost on each task. The task is `data.ticket` (shiftwork) or
 * `data.ticketId`, else `сесія`; the tier is the entry's own. Tokens come only from entries that carry them.
 */
export function tierCosts(entries: readonly DecisionLogEntry[]): TaskCost[] {
  const tasks = new Map<string, Map<string, TierCost & { turnSet: Set<number> }>>()
  const attemptGates = new Set(entries.filter((e) => (e.kind as string) === 'gate-attempt').map(gateName))
  for (const e of entries) {
    const tier = e.tier || '?'
    const task = String(e.data?.ticket ?? e.data?.ticketId ?? 'сесія')
    const att = attemptOf(e, attemptGates)
    const tokens = entryTokens(e)
    if (!att && !tokens && e.kind !== 'decision') continue
    const byTier = tasks.get(task) ?? new Map()
    tasks.set(task, byTier)
    const c = byTier.get(tier) ?? { tier, attempts: 0, failed: 0, passed: 0, turns: 0, tokens: 0, turnSet: new Set<number>() }
    byTier.set(tier, c)
    if (att) { c.attempts++; c[att]++ }
    c.tokens += tokens
    if (typeof e.turn === 'number') c.turnSet.add(e.turn)
  }
  const out: TaskCost[] = []
  for (const [task, byTier] of tasks) {
    const tiers = [...byTier.values()].filter((c) => c.attempts || c.tokens).map(({ turnSet, ...c }) => ({ ...c, turns: turnSet.size }))
    if (tiers.length) out.push({ task, tiers })
  }
  return out
}

/** The gate an entry belongs to: `data.gate`, else the trigger (`read-before-write`). */
function gateName(e: DecisionLogEntry): string {
  return typeof e.data?.gate === 'string' ? e.data.gate : String(e.trigger)
}

/** `| задача | tier | спроб | невдалих | токенів |` for `/gate why` and `report`. */
export function formatTierCosts(costs: readonly TaskCost[]): string {
  if (!costs.length) return 'Спроб перевірки за tier ще не було.'
  const rows = ['| задача | tier | спроб | невдалих | пройдено | токенів |', '| --- | --- | --- | --- | --- | --- |']
  for (const t of costs) for (const c of t.tiers) rows.push(`| ${t.task} | ${c.tier} | ${c.attempts} | ${c.failed} | ${c.passed} | ${c.tokens || '—'} |`)
  return rows.join('\n')
}

// ───────────────────────── deny suggestions (сценарій 8, G-55) ─────────────────────────

export interface DenySuggestion { profile: string; kind: Item['kind']; name: string; count: number; group?: string; text: string }

/** `mcp__postgres__query` / `tool:mcp__postgres__query` / `skill:x` (the mod's `data.skill`) → kind + name.
 * Shared by `report` and the pipeline's `observe` counts. */
export function deniedItem(e: DecisionLogEntry): { kind: Item['kind']; name: string } | undefined {
  const d = e.data ?? {}
  const raw = typeof d.tool === 'string' ? d.tool : typeof d.skill === 'string' ? `skill:${d.skill}` : typeof d.id === 'string' ? d.id : typeof d.name === 'string' ? d.name : undefined
  if (!raw) return undefined
  const m = /^(skill|tool|agent|rule):(.+)$/.exec(raw)
  if (m) return { kind: m[1] as Item['kind'], name: m[2]! }
  return { kind: typeof d.skill === 'string' ? 'skill' : 'tool', name: raw }
}

/**
 * Repeated denies of one item under one profile → «додай групу в профіль». The profile is the entry's own,
 * else that of the latest `decision` before it. `min` is the H010 threshold (more than 3 by default).
 */
export function denySuggestions(entries: readonly DecisionLogEntry[], config: GateConfig | undefined, min = 3): DenySuggestion[] {
  const counts = new Map<string, { profile: string; kind: Item['kind']; name: string; count: number }>()
  let profile: string | undefined
  for (const e of entries) {
    // Every decision resets the running profile: after one with no profile (tier only, `/gate auto`), later
    // denies belong to no profile and are not attributed to a stale one.
    if (!e.kind || e.kind === 'decision') { if (e.trigger !== 'verify') profile = e.profile; continue }
    if (e.kind !== 'deny' || e.trigger === 'strictWrite' || e.data?.shadow === true) continue
    const it = deniedItem(e)
    const p = e.profile ?? profile
    if (!it || !p) continue
    const key = `${p}\0${it.kind}\0${it.name}`
    const c = counts.get(key) ?? { profile: p, ...it, count: 0 }
    c.count++
    counts.set(key, c)
  }
  const out: DenySuggestion[] = []
  for (const c of counts.values()) {
    if (c.count <= min) continue
    const group = config ? enablingGroup(c.kind, c.name, config) : undefined
    const label = c.kind === 'tool' && c.name.startsWith('mcp__') ? c.name.split('__')[1] ?? c.name : c.name
    const text = group
      ? `${label}: ${c.count} deny у профілі ${c.profile} → додай групу \`${group}\` у \`profiles.${c.profile}.groups\` (на сесію: /gate +${group})`
      : `${label}: ${c.count} deny у профілі ${c.profile} → додай його в групу профілю ${c.profile}`
    out.push({ ...c, ...(group ? { group } : {}), text })
  }
  return out.sort((a, b) => b.count - a.count)
}

// ───────────────────────── runner vs mod by ticketId (сценарій 11, G-55) ─────────────────────────

export interface TicketComparison { ticket: string; ticketType?: string; runner?: string; mod?: string; agree: boolean }

const ticketOf = (e: DecisionLogEntry): string | undefined => {
  const t = e.data?.ticket ?? e.data?.ticketId
  return typeof t === 'string' && t ? t : undefined
}

/**
 * The runner's (`data.adapter: shiftwork`) and the mod's/hooks adapter's latest profile per ticket. A mod
 * decision belongs to a ticket by `data.ticket`/`data.ticketId`, else by the same `data.ticketType`.
 */
export function compareRunnerMod(entries: readonly DecisionLogEntry[]): TicketComparison[] {
  const runner = new Map<string, { profile?: string; ticketType?: string }>()
  const modByTicket = new Map<string, string | undefined>()
  const modByType = new Map<string, string | undefined>()
  for (const e of entries) {
    if (e.kind && e.kind !== 'decision') continue
    if (e.trigger === 'verify') continue
    const t = ticketOf(e)
    const type = typeof e.data?.ticketType === 'string' ? e.data.ticketType : undefined
    if (e.data?.adapter === 'shiftwork') {
      if (t) runner.set(t, { profile: e.profile, ...(type ? { ticketType: type } : {}) })
    } else {
      if (t) modByTicket.set(t, e.profile)
      if (type) modByType.set(type, e.profile)
    }
  }
  const out: TicketComparison[] = []
  for (const [ticket, r] of runner) {
    const has = modByTicket.has(ticket) || (r.ticketType !== undefined && modByType.has(r.ticketType))
    if (!has) continue
    const mod = modByTicket.has(ticket) ? modByTicket.get(ticket) : modByType.get(r.ticketType!)
    out.push({ ticket, ...(r.ticketType ? { ticketType: r.ticketType } : {}), ...(r.profile ? { runner: r.profile } : {}), ...(mod ? { mod } : {}), agree: (r.profile ?? '') === (mod ?? '') })
  }
  return out
}

// ───────────────────────── shadow agreement (MVP exit criterion, M2) ─────────────────────────

export interface ShadowAgreement {
  /** Decisions that carry a proposal (`data.proposed`, the shadow classifier/`when` result). */
  proposed: number
  /** Proposals with a reference: a `label` entry or a later manual choice (`/gate <p>`, `[gate:p]`) in that turn
   * window, or the profile a `classify` or `manual` decision itself committed. */
  labeled: number
  matched: number
  differed: number
  /** Proposals nobody confirmed or corrected: not counted in the agreement. */
  unlabeled: number
  /** matched / labeled, 0…1; undefined while nothing is labeled. */
  rate?: number
}

const partsOf = (p: unknown): string[] => (typeof p === 'string' && p ? p.split('+') : [])

/**
 * Agreement of shadow proposals with the profile the user actually wanted (SPEC: MVP exit ≥ 80 %). Shadow
 * decisions carry no `profile`, so the reference is, in order: a `label` entry after the proposal and before
 * the next proposal (`data.profile` the correct profile, or `data.correct: true|false`), a `manual` decision
 * in that window (the user overrode or confirmed it), else the decision's own `profile` when the classifier set it or
 * the user did (trigger `classify` / `manual`; a `when`/sticky profile is not a verdict on the proposal). A
 * proposal with no reference is `unlabeled`, never a mismatch.
 */
export function shadowAgreement(entries: readonly DecisionLogEntry[]): ShadowAgreement {
  const r: ShadowAgreement = { proposed: 0, labeled: 0, matched: 0, differed: 0, unlabeled: 0 }
  const isDecision = (e: DecisionLogEntry) => (!e.kind || e.kind === 'decision') && e.trigger !== 'verify'
  const proposalOf = (e: DecisionLogEntry): string | undefined => {
    const p = (e.data?.proposed as { profile?: unknown } | undefined)?.profile
    return isDecision(e) && typeof p === 'string' && p ? p : undefined
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const proposal = proposalOf(e)
    if (!proposal) continue
    r.proposed++
    let verdict: boolean | undefined
    for (let j = i + 1; j < entries.length && verdict === undefined; j++) {
      const x = entries[j]!
      if (proposalOf(x)) break
      if ((x.kind as string) === 'label') {
        const d = x.data ?? {}
        if (typeof d.correct === 'boolean') verdict = d.correct
        else if (typeof d.profile === 'string') verdict = partsOf(d.profile).includes(proposal)
      } else if (isDecision(x) && x.trigger === 'manual' && x.profile) verdict = partsOf(x.profile).includes(proposal)
    }
    // The decision's own profile is a reference when the classifier applied it or the user chose it (`manual`); a
    // `when` or sticky profile next to a shadow proposal was not influenced by it and says nothing about it (M2).
    if (verdict === undefined && (e.trigger === 'classify' || e.trigger === 'manual') && e.profile && e.data?.shadow !== true) verdict = partsOf(e.profile).includes(proposal)
    if (verdict === undefined) { r.unlabeled++; continue }
    r.labeled++
    if (verdict) r.matched++
    else r.differed++
  }
  if (r.labeled) r.rate = r.matched / r.labeled
  return r
}

// ───────────────────────── skill-prompt renders (G-28) ─────────────────────────

export interface SkillRenderStat { skill: string; renders: number; avgMs: number; avgChars: number; failed: number; args: string[] }

/** `skill-render` entries per skill: count, mean ms and chars, non-ok renders, up to 3 distinct arg samples. */
export function skillRenderStats(entries: readonly DecisionLogEntry[], samples = 3): SkillRenderStat[] {
  const by = new Map<string, { renders: number; ms: number; chars: number; failed: number; args: Set<string> }>()
  for (const e of entries) {
    if (e.kind !== 'skill-render' || typeof e.data?.skill !== 'string') continue
    const s = by.get(e.data.skill) ?? { renders: 0, ms: 0, chars: 0, failed: 0, args: new Set<string>() }
    by.set(e.data.skill, s)
    s.renders++
    s.ms += num(e.data.ms)
    s.chars += num(e.data.chars)
    if (e.data.status !== undefined && e.data.status !== 'ok') s.failed++
    if (e.data.args !== undefined && s.args.size < samples) s.args.add(JSON.stringify(e.data.args).slice(0, 120))
  }
  return [...by].map(([skill, s]) => ({ skill, renders: s.renders, avgMs: Math.round(s.ms / s.renders), avgChars: Math.round(s.chars / s.renders), failed: s.failed, args: [...s.args] }))
}

// ───────────────────────── gate counters from the journal (H011 in the CLI) ─────────────────────────

/** Blocks per gate from `gate-failed`; overrides from `gate-attempt {outcome: override}` (the current contract,
 * core journal.ts). Legacy `debug {trigger: gate-override}` entries count only for gates with no `gate-attempt`
 * override, so a journal holding both forms never counts one «все одно» twice. */
export function gateFailures(entries: readonly DecisionLogEntry[]): Record<string, { blocks: number; overrides: number }> {
  const out: Record<string, { blocks: number; overrides: number }> = {}
  const legacy: Record<string, number> = {}
  const modern = new Set<string>()
  for (const e of entries) {
    const g = typeof e.data?.gate === 'string' ? e.data.gate : undefined
    if (!g) continue
    if (e.kind === 'gate-failed') (out[g] ??= { blocks: 0, overrides: 0 }).blocks++
    else if ((e.kind as string) === 'gate-attempt' && e.data?.outcome === 'override') { modern.add(g); (out[g] ??= { blocks: 0, overrides: 0 }).overrides++ }
    else if (e.kind === 'debug' && e.trigger === 'gate-override') legacy[g] = (legacy[g] ?? 0) + 1
  }
  for (const [g, n] of Object.entries(legacy)) if (!modern.has(g)) (out[g] ??= { blocks: 0, overrides: 0 }).overrides += n
  return out
}
