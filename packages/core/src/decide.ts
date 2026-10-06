// skill-gate decision (SPEC "Шар 2 — skill-gate"): a pure function of config, signals, state and items.
// Priority: manual (/gate) → profiles[*].when → classifier (auto, ≥ minConfidence) → tiers[models[model]] → standard.
// Hysteresis: the profile changes only on a manual signal, on a different `when` profile two turns in a row,
// or on recheck (`/gate new`, compaction).

import type { DecisionLogEntry, DecisionTrigger, Gate, GateConfig, GateState, Item, ItemDecision, ProfileWhen, Signals, Tier } from './types.ts'
import { normalizeConfig, tierForModel } from './config.ts'
import { expandGroups, groupsOf, isMcpTool, mcpServerOf } from './items.ts'
import { compileGlob, matchAny } from './glob.ts'

export interface DecideOptions {
  /** `/gate new`, compaction or `/gate auto`: re-evaluate the profile without hysteresis. */
  recheck?: boolean
  recheckReason?: 'new' | 'compact' | 'auto'
  /** Model of the previous turn; a change yields trigger `model-change`. */
  prevModel?: string
  /** Evaluator for `when.expr` (core/expr.ts), injected to keep this module independent. */
  evalExpr?: (expr: string, data: Record<string, unknown>) => boolean
  /** Number of consecutive turns needed for a `when` profile switch (default 2). */
  hysteresisTurns?: number
  /** Forced tier (CLI `--tier`, tests): overrides the tier derived from `signals.model`. */
  tier?: Tier
  now?: number
}

export interface DecideResult {
  gate: Gate
  state: GateState
  log: DecisionLogEntry
}

/** Separator for the union of several matched profiles. */
export const PROFILE_UNION = '+'

export function profileParts(profile: string | undefined): string[] {
  return profile ? profile.split(PROFILE_UNION).filter(Boolean) : []
}

interface WhenHit { trigger: DecisionTrigger; detail: string }

function whenMatches(when: ProfileWhen | undefined, signals: Signals, opts: DecideOptions, reasons: string[], name: string): WhenHit | undefined {
  if (!when) return undefined
  if (when.paths?.length) {
    for (const p of signals.paths) {
      if (matchAny(p, when.paths, [], { matchBase: true })) return { trigger: 'when:paths', detail: `${p} ~ ${when.paths.join(', ')}` }
    }
  }
  if (when.branch && signals.branch) {
    try {
      if (new RegExp(when.branch).test(signals.branch)) return { trigger: 'when:branch', detail: `гілка ${signals.branch} ~ /${when.branch}/` }
    } catch {
      reasons.push(`профіль ${name}: невірний regex гілки /${when.branch}/`)
    }
  }
  if (when.ticketType?.length && signals.ticketType && when.ticketType.includes(signals.ticketType)) {
    return { trigger: 'when:ticketType', detail: `тип тікета ${signals.ticketType}` }
  }
  if (when.expr && opts.evalExpr) {
    try {
      if (opts.evalExpr(when.expr, signals.data ?? {})) return { trigger: 'when:expr', detail: `вираз ${when.expr}` }
    } catch (e) {
      reasons.push(`профіль ${name}: помилка виразу ${when.expr}: ${(e as Error).message}`)
    }
  }
  return undefined
}

function hasLegacy(cfg: GateConfig): boolean {
  return !!(cfg.skillGroups || cfg.mcpGroups || Object.values(cfg.profiles ?? {}).some((p) => p.skills || p.mcp || p.agents) || Object.values(cfg.tiers ?? {}).some((t) => t.skills))
}

/** Resolve `+x` / `-x`: a group name, or a profile name (its groups). */
function resolveGroupRef(cfg: GateConfig, name: string): string[] {
  if (cfg.groups?.[name]) return [name]
  const p = cfg.profiles?.[name]
  if (p) return p.groups ?? []
  return [name]
}

/**
 * The decision only: which items a profile/tier turns on, off or name-only. Applying it is the adapter's
 * call. In shadow mode (`classify.mode: "shadow"` or `/gate shadow`, no manual signal) the adapters (mod,
 * hooks adapter) log the decision and filter nothing (SPEC scenario 1: `skills 30/30`); they mark that with
 * `gate.shadow = true`, which `statusLine` renders as `gate (profile?)`. decideGate never sets `shadow`.
 */
export function decideGate(config: GateConfig, signals: Signals, state: GateState, items: readonly Item[], opts: DecideOptions = {}): DecideResult {
  const cfg = hasLegacy(config) ? normalizeConfig(config).config : config
  const reason: string[] = []
  const turn = (state.turn ?? 0) + 1
  const ts = opts.now ?? 0
  const needTurns = opts.hysteresisTurns ?? 2

  // ── tier ──
  const t = opts.tier ? { tier: opts.tier, reason: `tier ${opts.tier} задано явно`, fallback: false } : tierForModel(cfg, signals.model)
  const tier: Tier = t.tier
  reason.push((signals.agentId ? `субагент ${signals.agentId}: ` : '') + t.reason)
  if ((signals.model || opts.tier) && !cfg.tiers?.[tier]) reason.push(`tier ${tier} не оголошено в tiers`)

  // ── manual off ──
  if (signals.manual?.off) {
    const gate = allOn(items, tier, state.profile, ['/gate off: фільтрацію вимкнено, усе увімкнено', ...reason])
    const newState: GateState = { ...state, turn }
    return { gate, state: newState, log: logOf(gate, turn, ts) }
  }

  // ── profile ──
  let profile = state.profile
  let source: DecisionTrigger | undefined = state.profileSource
  let pending = state.pending
  let trigger: DecisionTrigger | undefined
  let proposed: Gate['proposed']
  const recheck = !!opts.recheck || (state.profileSource === 'manual' && !signals.manual?.profile)

  // Classifier proposal (evaluated always for logging).
  const mode = cfg.classify?.mode ?? 'shadow'
  const minConf = cfg.classify?.minConfidence ?? 0.7
  let classifyCandidate: string | undefined
  if (signals.classified) {
    const { profile: cp, confidence } = signals.classified
    const known = !!cfg.profiles?.[cp]
    if (!known) reason.push(`класифікатор: профіль ${cp} не оголошено`)
    else if (mode === 'shadow') {
      proposed = { profile: cp, confidence }
      reason.push(`класифікатор (shadow): ${cp} ${confidence.toFixed(2)} — лише в журнал`)
    } else if (confidence >= minConf) {
      classifyCandidate = cp
    } else {
      reason.push(`класифікатор: ${cp} ${confidence.toFixed(2)} < ${minConf} → не застосовано`)
    }
  }

  if (signals.manual?.profile) {
    const mp = signals.manual.profile
    if (!profileParts(mp).every((p) => cfg.profiles?.[p])) reason.push(`ручний профіль ${mp} не оголошено в profiles`)
    if (profile !== mp || source !== 'manual') reason.push(`/gate ${mp}: профіль зафіксовано вручну`)
    else reason.push(`профіль ${mp} зафіксовано вручну`)
    profile = mp
    source = 'manual'
    trigger = 'manual'
    pending = undefined
  } else {
    if (recheck) {
      reason.push(opts.recheckReason === 'compact' ? 'compaction: профіль перераховано' : opts.recheckReason === 'auto' || state.profileSource === 'manual' ? '/gate auto: повернуто автоматику' : '/gate new: перекласифікація')
    }
    // `when` matches; several → union.
    const hits: { name: string; hit: WhenHit }[] = []
    for (const [name, p] of Object.entries(cfg.profiles ?? {})) {
      const hit = whenMatches(p.when, signals, opts, reason, name)
      if (hit) hits.push({ name, hit })
    }
    let candidate: string | undefined
    let candTrigger: DecisionTrigger | undefined
    if (hits.length) {
      candidate = hits.map((h) => h.name).join(PROFILE_UNION)
      candTrigger = hits[0].hit.trigger
      for (const h of hits) reason.push(`${h.hit.trigger}: ${h.hit.detail} → ${h.name}`)
      if (hits.length > 1) reason.push(`збіг кількох профілів → об'єднання ${candidate}`)
    } else if (classifyCandidate) {
      candidate = classifyCandidate
      candTrigger = 'classify'
    }

    const isFirst = profile === undefined || recheck
    if (candidate === undefined) {
      if (recheck) { profile = undefined; source = undefined }
      pending = undefined
    } else if (candidate === profile && !recheck) {
      pending = undefined
    } else if (isFirst) {
      profile = candidate
      source = candTrigger
      trigger = candTrigger
      pending = undefined
      if (candTrigger === 'classify') reason.push(`класифікатор: ${candidate} ${signals.classified!.confidence.toFixed(2)} ≥ ${minConf} → застосовано`)
    } else if (candTrigger === 'classify') {
      // Classifier only decides on the first prompt of a task and on recheck.
      reason.push(`класифікатор пропонує ${candidate}, але профіль ${profile} стабільний до /gate new`)
      pending = undefined
    } else {
      const count = pending?.profile === candidate ? pending.count + 1 : 1
      if (count >= needTurns) {
        reason.push(`гістерезис: ${candidate} ${count} ходи поспіль → зміна профілю з ${profile}`)
        profile = candidate
        source = candTrigger
        trigger = candTrigger
        pending = undefined
      } else {
        reason.push(`гістерезис: ${candidate} (${count}/${needTurns}), профіль ${profile} лишається`)
        pending = { profile: candidate, count }
      }
    }
  }

  if (!trigger) {
    if (profile) trigger = opts.recheckReason === 'compact' ? 'compact' : (source ?? 'tier')
    else trigger = t.fallback ? 'default' : 'tier'
    if (opts.prevModel && signals.model && opts.prevModel !== signals.model) trigger = 'model-change'
    if (opts.recheckReason === 'compact') trigger = 'compact'
  }
  if (!profile) {
    reason.push(t.fallback ? `профіль не визначено; ${t.reason} (попередження: використано tier за замовчуванням)` : `профіль не визначено → набір tier ${tier}`)
  }

  // ── groups ──
  const tierCfg = cfg.tiers?.[tier]
  const active = new Set<string>(tierCfg?.groups ?? [])
  for (const p of profileParts(profile)) for (const g of cfg.profiles?.[p]?.groups ?? []) active.add(g)
  for (const a of signals.manual?.add ?? []) for (const g of resolveGroupRef(cfg, a)) { active.add(g); reason.push(`/gate +${a}: група ${g}`) }
  for (const r of signals.manual?.remove ?? []) for (const g of resolveGroupRef(cfg, r)) { active.delete(g); reason.push(`/gate -${r}: група ${g}`) }
  const groups = [...active]

  const noGroups = !Object.keys(cfg.groups ?? {}).length
  if (noGroups) reason.push('у gate.json немає груп → усе увімкнено')

  // ── per-item decisions ──
  const enabled = expandGroups(cfg, groups, items)
  const preloadPats = (tierCfg?.preload ?? []).map((p) => p.replace(/^skill:/, ''))
  const preloadMatch = preloadPats.map((p) => compileGlob(p))
  const decisions: Record<string, ItemDecision> = {}
  const gate: Gate = {
    profile, tier, trigger, off: false,
    skills: { on: [], nameOnly: [], off: [], preload: [] },
    mcp: { on: [], off: [] }, agents: { on: [], off: [] }, rules: { on: [], off: [] },
    items: decisions, groups, reason,
  }
  if (proposed) gate.proposed = proposed

  for (const it of items) {
    let d: ItemDecision
    const grouped = noGroups ? false : groupsOf(cfg, it).length > 0
    if (it.kind === 'skill' && preloadMatch.some((m) => m(it.name))) d = 'preload'
    else if (noGroups || enabled.has(it.id)) d = 'on'
    else if (it.kind === 'section' || it.kind === 'datum') d = 'on'
    else if (it.kind === 'tool' && !isMcpTool(it)) d = 'on'
    else if (grouped) d = 'off'
    else if (it.kind === 'skill') d = 'nameOnly'
    else if (it.kind === 'tool') d = 'off' // MCP tools outside the profile are off
    else d = 'on' // ungrouped agents and rules stay available
    decisions[it.id] = d
    switch (it.kind) {
      case 'skill':
        if (d === 'preload') gate.skills.preload.push(it.name)
        else gate.skills[d === 'nameOnly' ? 'nameOnly' : d === 'off' ? 'off' : 'on'].push(it.name)
        break
      case 'tool':
        if (isMcpTool(it)) gate.mcp[d === 'off' ? 'off' : 'on'].push(it.name)
        break
      case 'agent':
        gate.agents[d === 'off' ? 'off' : 'on'].push(it.name)
        break
      case 'rule':
        gate.rules[d === 'off' ? 'off' : 'on'].push(it.name)
        break
    }
  }
  if (gate.skills.preload.length) reason.push(`preload для tier ${tier}: ${gate.skills.preload.join(', ')}`)
  if (gate.mcp.off.length) {
    const servers = [...new Set(gate.mcp.off.map((n) => mcpServerOf(n) ?? n))]
    reason.push(`MCP поза профілем вимкнено: ${servers.join(', ')}`)
  }

  const newState: GateState = { turn, profile, profileSource: source }
  if (pending) newState.pending = pending
  return { gate, state: newState, log: logOf(gate, turn, ts) }
}

function allOn(items: readonly Item[], tier: Tier, profile: string | undefined, reason: string[]): Gate {
  const gate: Gate = {
    profile, tier, trigger: 'off', off: true,
    skills: { on: [], nameOnly: [], off: [], preload: [] },
    mcp: { on: [], off: [] }, agents: { on: [], off: [] }, rules: { on: [], off: [] },
    items: {}, groups: [], reason,
  }
  for (const it of items) {
    gate.items[it.id] = 'on'
    if (it.kind === 'skill') gate.skills.on.push(it.name)
    else if (it.kind === 'tool' && isMcpTool(it)) gate.mcp.on.push(it.name)
    else if (it.kind === 'agent') gate.agents.on.push(it.name)
    else if (it.kind === 'rule') gate.rules.on.push(it.name)
  }
  return gate
}

function logOf(gate: Gate, turn: number, ts: number): DecisionLogEntry {
  const enabled: string[] = []
  const disabled: string[] = []
  for (const [id, d] of Object.entries(gate.items)) (d === 'off' ? disabled : enabled).push(id)
  const entry: DecisionLogEntry = { ts, turn, trigger: gate.trigger, tier: gate.tier, enabled, disabled, reason: gate.reason, kind: 'decision' }
  if (gate.profile) entry.profile = gate.profile
  if (gate.proposed) entry.data = { proposed: gate.proposed }
  return entry
}

// ───────────────────────── Deny texts ─────────────────────────

function profileLabel(gate: Gate): string {
  if (gate.off) return 'off'
  return gate.profile ? `профілем ${gate.profile}` : `tier ${gate.tier}`
}

/** Which group (prefer one that is also a profile name) would enable the item. */
export function enablingGroup(kind: Item['kind'], name: string, config: GateConfig): string | undefined {
  const cfg = hasLegacy(config) ? normalizeConfig(config).config : config
  const gs = groupsOf(cfg, { kind, name })
  if (!gs.length) return undefined
  return gs.find((g) => cfg.profiles?.[g]) ?? gs[0]
}

/** Text for `{ deny }` / short tool description: `postgres вимкнено профілем frontend. Користувач може увімкнути: /gate +backend`. */
export function denyText(kind: Item['kind'], name: string, gate: Gate, config: GateConfig): string {
  const display = kind === 'tool' && name.startsWith('mcp__') ? (mcpServerOf(name) ?? name) : name
  const g = enablingGroup(kind, name, config)
  const how = g ? `/gate +${g}` : '/gate off'
  return `${display} вимкнено ${profileLabel(gate)}. Користувач може увімкнути: ${how}`
}

/** Replacement body for a disabled skill (`skill.prompt`). */
export function skillOffText(name: string, gate: Gate, config: GateConfig): string {
  const g = enablingGroup('skill', name, config)
  return `Skill ${name} вимкнено ${profileLabel(gate)}. Увімкни: ${g ? `/gate +${g}` : '/gate off'}`
}

/** One-line status: `gate frontend · tier standard · skills 5/23 · mcp 2/6 · rules 3`.
 * Shadow (`gate.shadow`, set by the adapter): nothing is filtered, so the counts are all/all
 * (`gate (frontend?) · tier standard · skills 30/30 · …`) and the proposal is shown with `?`. */
export function statusLine(gate: Gate, extra: { ctxPct?: number } = {}): string {
  const s = gate.skills
  const skillsTotal = s.on.length + s.nameOnly.length + s.off.length + s.preload.length
  const mcpTotal = gate.mcp.on.length + gate.mcp.off.length
  const rulesTotal = gate.rules.on.length + gate.rules.off.length
  const proposal = gate.proposed?.profile ?? (gate.shadow ? gate.profile : undefined)
  const prof = gate.off ? 'off' : gate.shadow ? (proposal ? `(${proposal}?)` : '—') : gate.profile ?? (gate.proposed ? `(${gate.proposed.profile}?)` : '—')
  const skillsOn = gate.shadow || gate.off ? skillsTotal : s.on.length + s.preload.length
  const mcpOn = gate.shadow || gate.off ? mcpTotal : gate.mcp.on.length
  const rulesOn = gate.shadow || gate.off ? rulesTotal : gate.rules.on.length
  const parts = [`gate ${prof}`, `tier ${gate.tier}`, `skills ${skillsOn}/${skillsTotal}`, `mcp ${mcpOn}/${mcpTotal}`, `rules ${rulesOn}`]
  if (extra.ctxPct !== undefined) parts.push(`ctx ${Math.round(extra.ctxPct)}%`)
  return parts.join(' · ')
}

// ───────────────────────── static adapters ─────────────────────────

/** Claude Code `settings.skillOverrides` values (checked against the settings schema). */
export type SkillOverride = 'on' | 'name-only' | 'user-invocable-only' | 'off'

/**
 * Gate → `settings.skillOverrides` for the static adapters (hooks adapter `install`, CLI `sync`, shiftwork):
 * `nameOnly` → `name-only`; `off` → `user-invocable-only` (the user keeps `/name`), or `off` with `hard`.
 * Skills that are on or preloaded get no key (absent = on).
 */
export function skillOverridesFor(gate: Pick<Gate, 'skills'>, opts: { hard?: boolean } = {}): Record<string, SkillOverride> {
  const out: Record<string, SkillOverride> = {}
  const name = (n: string) => n.replace(/^skill:/, '')
  for (const n of gate.skills.nameOnly) out[name(n)] = 'name-only'
  for (const n of gate.skills.off) out[name(n)] = opts.hard ? 'off' : 'user-invocable-only'
  return out
}
