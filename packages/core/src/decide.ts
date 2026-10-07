// skill-gate decision (SPEC "Шар 2 — skill-gate"): a pure function of config, signals, state and items.
// Priority: manual (/gate) → profiles[*].when → classifier (auto, ≥ minConfidence) → tiers[models[model]] → standard.
// Hysteresis: the profile changes only on a manual signal, on a different `when` profile two turns in a row,
// or on recheck (`/gate new`, compaction). Only user prompts are turns: a recompute after `/gate +x`, a model
// change or a gate.json reload passes `advance: false` and moves neither `turn` nor the hysteresis counter.

import type { DecisionLogEntry, DecisionTrigger, Gate, GateConfig, GateState, Item, ItemDecision, ProfileWhen, Signals, Tier } from './types.ts'
import type { ModelAttrs } from './config.ts'
import { normalizeConfig, tierForModel } from './config.ts'
import { expandGroups, groupsOf, isMcpTool, mcpServerOf, mentionedInGroups, ownEntry } from './items.ts'
import { compileGlob, isRepoRelative, matchAny, splitNegation } from './glob.ts'
import { regexTest } from './expr.ts'

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
  /** Model attributes from the harness (context window, cost): the tier for a model id no `models` entry
   * matches comes from `tiers[*].thresholds` (G-01) instead of falling back to `standard`. */
  modelAttrs?: ModelAttrs
  /** `false`: a recompute within the same user turn (`/gate +x`, model change, gate.json reload). `turn` and the
   * hysteresis counter stay as they are and `when`/classifier signals do not switch the profile; manual
   * signals and `recheck` still apply. Default true: one call per user prompt. */
  advance?: boolean
  /** Case-insensitive `when.paths` (Windows repos), as the adapters pass to `ruleMatches`. */
  nocase?: boolean
  now?: number
}

export interface DecideResult {
  gate: Gate
  state: GateState
  log: DecisionLogEntry
}

/** Separator for the union of several matched profiles. */
export const PROFILE_UNION = '+'

/** The profiles of a (possibly united) profile string. With `cfg`, a declared profile whose own name contains
 * `+` (`c++`) is one profile, not a union (config validation warns about such names, G316). */
export function profileParts(profile: string | undefined, cfg?: Pick<GateConfig, 'profiles'>): string[] {
  if (!profile) return []
  if (cfg && ownEntry(cfg.profiles, profile)) return [profile]
  return profile.split(PROFILE_UNION).filter(Boolean)
}

interface WhenHit { trigger: DecisionTrigger; detail: string }

function whenMatches(when: ProfileWhen | undefined, signals: Signals, opts: DecideOptions, reasons: string[], name: string): WhenHit | undefined {
  if (!when) return undefined
  if (when.paths?.length) {
    for (const p of signals.paths) {
      // A path outside the repo root (`/home/u/.claude/settings.json`) is no signal for a repo profile.
      if (!isRepoRelative(p)) continue
      if (matchAny(p, when.paths, [], { matchBase: true, nocase: !!opts.nocase })) return { trigger: 'when:paths', detail: `${p} ~ ${when.paths.join(', ')}` }
    }
  }
  if (when.branch && signals.branch) {
    // The repo's pattern runs on the linear-time engine (M51): no catastrophic backtracking from gate.json.
    let hit: boolean | null = null
    try { hit = regexTest(when.branch, signals.branch) } catch { /* over the step budget: no match */ }
    if (hit) return { trigger: 'when:branch', detail: `гілка ${signals.branch} ~ /${when.branch}/` }
    if (hit === null) reasons.push(`профіль ${name}: невірний або непідтримуваний regex гілки /${when.branch}/`)
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
  if (ownEntry(cfg.groups, name)) return [name]
  const p = ownEntry(cfg.profiles, name)
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
  const advance = opts.advance !== false
  const turn = (state.turn ?? 0) + (advance ? 1 : 0)
  const ts = opts.now ?? 0
  const needTurns = opts.hysteresisTurns ?? 2

  // ── tier ──
  const t = opts.tier ? { tier: opts.tier, reason: `tier ${opts.tier} задано явно`, fallback: false } : tierForModel(cfg, signals.model, opts.modelAttrs)
  const tier: Tier = t.tier
  reason.push((signals.agentId ? `субагент ${signals.agentId}: ` : '') + t.reason)
  if ((signals.model || opts.tier) && !cfg.tiers?.[tier]) reason.push(`tier ${tier} не оголошено в tiers`)

  // ── manual off ──
  if (signals.manual?.off) {
    const gate = allOn(items, tier, state.profile, ['/gate off: фільтрацію вимкнено, усе увімкнено', ...reason])
    const newState: GateState = { ...state, turn }
    return { gate, state: newState, log: logOf(gate, turn, ts, signals) }
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
    const known = !!ownEntry(cfg.profiles, cp)
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
    if (!profileParts(mp, cfg).every((p) => ownEntry(cfg.profiles, p))) reason.push(`ручний профіль ${mp} не оголошено в profiles`)
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
    if (!advance && !recheck) {
      // Same user turn: keep the committed profile and the hysteresis counter as they are.
      if (candidate !== undefined && candidate !== profile) reason.push(`перерахунок у межах ходу: ${candidate} не змінює профіль ${profile ?? '—'}`)
    } else if (candidate === undefined) {
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
  for (const p of profileParts(profile, cfg)) for (const g of ownEntry(cfg.profiles, p)?.groups ?? []) active.add(g)
  for (const a of signals.manual?.add ?? []) for (const g of resolveGroupRef(cfg, a)) { active.add(g); reason.push(`/gate +${a}: група ${g}`) }
  const removedGroups: string[] = []
  for (const r of signals.manual?.remove ?? []) for (const g of resolveGroupRef(cfg, r)) { active.delete(g); removedGroups.push(g); reason.push(`/gate -${r}: група ${g}`) }
  const groups = [...active]

  const noGroups = !Object.keys(cfg.groups ?? {}).length
  if (noGroups) reason.push('у gate.json немає груп → усе увімкнено')

  // ── per-item decisions ──
  const enabled = expandGroups(cfg, groups, items)
  // The user's `/gate -group` beats the tier's preload (the strongest signal wins).
  const removed = removedGroups.length ? expandGroups(cfg, removedGroups, items) : new Set<string>()
  // Preload names skills only: a negated entry (`!skill:a`) would otherwise match every skill (config warns, G315).
  const preloadMatch = (tierCfg?.preload ?? [])
    .filter((p) => !splitNegation(p.trim()).negated)
    .map((p) => p.trim().replace(/^skill:/, ''))
    .filter((p) => p && !p.startsWith('!'))
    .map((p) => compileGlob(p))
  const decisions: Record<string, ItemDecision> = {}
  const gate: Gate = {
    profile, tier, trigger, off: false,
    skills: { on: [], nameOnly: [], off: [], preload: [] },
    mcp: { on: [], off: [] }, agents: { on: [], off: [] }, rules: { on: [], off: [] },
    items: decisions, groups, reason,
  }
  if (proposed) gate.proposed = proposed

  const passthrough = new Set<string>()
  for (const it of items) {
    let d: ItemDecision
    // An item a group excludes (`!agent:x`) is still grouped: the exclusion turns it off, it must not fall
    // back to the more permissive default of ungrouped items.
    const grouped = noGroups ? false : mentionedInGroups(cfg, it)
    // A plugin skill `ns:name` that no group names in full follows the groups that name its bare `name` (M10).
    const bare = !grouped && !noGroups && it.kind === 'skill' && it.name.includes(':') ? { kind: 'skill' as const, name: it.name.replace(/^[^:]+:/, '') } : undefined
    if (it.kind === 'skill' && !removed.has(it.id) && preloadMatch.some((m) => m(it.name))) d = 'preload'
    else if (noGroups || enabled.has(it.id)) d = 'on'
    else if (bare && mentionedInGroups(cfg, bare)) d = groupsOf(cfg, bare).some((g) => active.has(g)) ? 'on' : 'off'
    else if (it.kind === 'section' || it.kind === 'datum') d = 'on'
    else if (grouped) d = 'off' // script tools (`# gate-tool:`) obey groups like MCP tools (G-35)
    else if (it.kind === 'tool' && !isMcpTool(it)) d = 'on'
    else if (it.kind === 'skill') d = 'nameOnly'
    else if (it.kind === 'tool') { d = 'on'; passthrough.add(mcpServerOf(it.name) ?? it.name) } // O1: an MCP tool no group mentions (a personal server, a connector, mcp__ide__*) is not the repo's to deny
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
  if (passthrough.size) reason.push(`MCP без групи в gate.json не фільтрується: ${[...passthrough].sort().join(', ')}`)

  const newState: GateState = { turn, profile, profileSource: source }
  if (pending) newState.pending = pending
  return { gate, state: newState, log: logOf(gate, turn, ts, signals) }
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

function logOf(gate: Gate, turn: number, ts: number, signals?: Signals): DecisionLogEntry {
  const enabled: string[] = []
  const disabled: string[] = []
  for (const [id, d] of Object.entries(gate.items)) (d === 'off' ? disabled : enabled).push(id)
  const entry: DecisionLogEntry = { ts, turn, trigger: gate.trigger, tier: gate.tier, enabled, disabled, reason: gate.reason, kind: 'decision' }
  if (gate.profile) entry.profile = gate.profile
  const data: Record<string, unknown> = {}
  if (gate.proposed) data.proposed = gate.proposed
  // `report` matches runner and adapter decisions per ticket (сценарій 11).
  if (signals?.ticketId) data.ticketId = signals.ticketId
  if (signals?.ticketType) data.ticketType = signals.ticketType
  if (Object.keys(data).length) entry.data = data
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
  return gs.find((g) => ownEntry(cfg.profiles, g)) ?? gs[0]
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

// ───────────────────────── classify / brief providers (G-02) ─────────────────────────

/** The CLI classify provider's stdin: `{ text, profiles: [{ name, groups }], paths, model }`. */
export function classifyRequest(config: Pick<GateConfig, 'profiles'>, text: string, paths: readonly string[], model?: string): string {
  const profiles = Object.entries(config.profiles ?? {}).map(([name, p]) => ({ name, groups: p.groups ?? [] }))
  return JSON.stringify({ text: text.slice(0, 4000), profiles, paths: paths.slice(-20), ...(model ? { model } : {}) })
}

/** `{ "profile", "confidence" }` anywhere in the text (a model answer or a CLI's stdout); confidence clamped to 0…1.
 * Each balanced top-level `{…}` is tried in turn (nested objects and stray braces before the JSON are fine). */
export function parseClassify(text: string, profiles: readonly string[]): { profile: string; confidence: number } | undefined {
  for (const cand of braceCandidates(text)) {
    let v: { profile?: unknown; confidence?: unknown }
    try { v = JSON.parse(cand) as typeof v } catch { continue }
    if (!v || typeof v !== 'object' || typeof v.profile !== 'string' || !profiles.includes(v.profile)) continue
    const c = typeof v.confidence === 'number' ? v.confidence : Number(v.confidence)
    return { profile: v.profile, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0 }
  }
  return undefined
}

const MAX_BRACE_STARTS = 64
const MAX_BRACE_SCAN = 1 << 20

/** Balanced `{…}` spans starting at each `{` (strings respected), at most 20. */
function braceCandidates(text: string): string[] {
  const out: string[] = []
  // The answer is untrusted text: an unbalanced `{{{…` would rescan to the end from every start (O(n²)), so both
  // the start positions and the characters scanned overall are bounded.
  let starts = 0
  let scanned = 0
  for (let start = text.indexOf('{'); start >= 0 && out.length < 20 && starts++ < MAX_BRACE_STARTS && scanned < MAX_BRACE_SCAN; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let q = false
    for (let i = start; i < text.length && scanned++ < MAX_BRACE_SCAN; i++) {
      const c = text[i]
      if (q) { if (c === '\\') i++; else if (c === '"') q = false; continue }
      if (c === '"') q = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) { out.push(text.slice(start, i + 1)); break }
    }
  }
  return out
}

/** The CLI brief provider's stdin: `{ text, tier, maxChars, paths, model }`. */
export function briefRequest(text: string, tier: string, maxChars: number, paths: readonly string[], model?: string): string {
  return JSON.stringify({ text: text.slice(0, 8000), tier, maxChars, paths: paths.slice(-20), ...(model ? { model } : {}) })
}

/** A brief provider's stdout: JSON `{ "text" }` or plain text, trimmed and cut at `maxChars`. */
export function parseBrief(stdout: string, maxChars: number): string | undefined {
  let t = stdout.trim()
  if (t.startsWith('{')) {
    try {
      const v = JSON.parse(t) as { text?: unknown }
      if (typeof v.text === 'string') t = v.text.trim()
    } catch { /* plain text */ }
  }
  return t ? t.slice(0, maxChars) : undefined
}
