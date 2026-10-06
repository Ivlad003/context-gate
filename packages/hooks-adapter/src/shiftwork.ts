// Shiftwork integration contract (SPEC "Режими запуску" → "Інтеграція зі shiftwork", plan step 7).
// Pure, no Node: the runner (or `hooks-adapter plan`) turns a ticket's `**Type:**`, `**Model:**` and
// `**Skills:**` lines plus the shared `.claude/gate.json` into the arguments of one `claude -p` shift,
// and writes `decision` / `escalation-suggested` / `gate-failed` events in the `.claude/gate.log.jsonl` format.

import type { DecisionLogEntry, Gate, GateConfig, Item, Signals, Tier } from '../../core/src/types.ts'
import { decideGate, skillOverridesFor } from '../../core/src/decide.ts'
import { tierForModel } from '../../core/src/config.ts'
import { toJsonl } from '../../core/src/journal.ts'

/** Log file the mod, the hooks adapter and the runner share (repo-relative). */
export const GATE_LOG = '.claude/gate.log.jsonl'

/** Shiftwork backend prefixes of a model ref (`claude:claude-sonnet-4-6`, see shiftwork planner `parseModelRef`). */
const BACKEND_PREFIX = /^(?:claude|codex|cursor|grok|opencode|pi|ollama):/

/** `claude:claude-sonnet-4-6` → `claude-sonnet-4-6`; `anthropic/claude-haiku-4-5` → `claude-haiku-4-5`. */
export function shiftworkModelId(ref: string | undefined): string | undefined {
  if (!ref) return undefined
  const m = ref.trim().replace(BACKEND_PREFIX, '')
  const slash = m.lastIndexOf('/')
  return slash >= 0 ? m.slice(slash + 1) : m
}

/** Ticket `**Skills:**` line (space separated, `+group` / `-group` / `group`) → gate manual adjustments. */
export function skillAdjustments(skills: readonly string[] | string | undefined): { add: string[]; remove: string[] } {
  const list = typeof skills === 'string' ? skills.split(/[\s,]+/) : [...(skills ?? [])]
  const add: string[] = []
  const remove: string[] = []
  for (const raw of list) {
    const s = raw.trim().replace(/^`|`$/g, '')
    if (!s) continue
    if (s.startsWith('-')) remove.push(s.slice(1))
    else add.push(s.replace(/^\+/, ''))
  }
  return { add, remove }
}

/** Profile for a ticket type: `profiles[x].when.ticketType` (all matches, union), else a profile with the type's name. */
export function profileForTicketType(config: GateConfig, ticketType: string | undefined): { profile?: string; via?: 'when:ticketType' | 'name' } {
  if (!ticketType) return {}
  const t = ticketType.trim()
  const hits = Object.entries(config.profiles ?? {}).filter(([, p]) => p.when?.ticketType?.includes(t)).map(([n]) => n)
  if (hits.length) return { profile: hits.join('+'), via: 'when:ticketType' }
  if (config.profiles?.[t]) return { profile: t, via: 'name' }
  return {}
}

export interface TicketPlanInput {
  /** Ticket `**Type:**` (shiftwork `ticket.type`, or the routed `route.type`). */
  ticketType?: string
  /** Shiftwork model ref or plain model id. */
  model?: string
  /** Ticket `**Skills:**` adjustments. */
  skills?: readonly string[] | string
  /** Skills (body and `provenance.path` = repo-relative or absolute SKILL.md path), agents, MCP tools. */
  items?: readonly Item[]
  branch?: string
  paths?: string[]
}

export interface TicketPlan {
  profile: string | undefined
  tier: Tier
  /** Skill names the shift may use (`on` + `preload`). */
  skills: string[]
  /** Skill names whose body goes into the system prompt. */
  preload: string[]
  /** Text for `--append-system-prompt` (preloaded bodies, shiftwork's `<!-- Preloaded skill: … -->` framing). */
  appendSystemPrompt: string
  /** Skill directories to symlink into the shift's `--plugin-dir <tmp>/skills/` (skills outside the repo). */
  pluginDirSymlinks: string[]
  /** For `claude -p --settings '<json>'`: listing overrides for repo/user skills the shift must not see. */
  settings: { skillOverrides: Record<string, 'name-only' | 'user-invocable-only' | 'off'> }
  /** Env for the shift so the hooks adapter / mod make the same decision. */
  env: Record<string, string>
  /** MCP tools gated off (the hooks adapter denies them when installed). */
  mcpOff: string[]
  gate: Gate
  log: DecisionLogEntry
}

function dirOf(path: string): string {
  const p = path.replace(/\\/g, '/')
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : p
}

/** Plan one shift: same decideGate as the mod and the hooks adapter, ticket Type mapped to a profile without a classifier. */
export function planForTicket(config: GateConfig, input: TicketPlanInput, now = 0): TicketPlan {
  const model = shiftworkModelId(input.model)
  const { profile } = profileForTicketType(config, input.ticketType)
  const adj = skillAdjustments(input.skills)
  const signals: Signals = { paths: input.paths ?? [], model }
  if (input.branch) signals.branch = input.branch
  if (input.ticketType) signals.ticketType = input.ticketType.trim()
  if (profile || adj.add.length || adj.remove.length) {
    signals.manual = { add: adj.add, remove: adj.remove }
    if (profile) signals.manual.profile = profile
  }
  const items = input.items ?? []
  const r = decideGate(config, signals, { turn: 0 }, items, { now })
  const gate = r.gate
  // A ticket-type profile is the runner's decision, not a manual one: log it as such.
  if (profile) {
    gate.trigger = 'when:ticketType'
    r.log.trigger = 'when:ticketType'
    const why = `тип тікета ${input.ticketType!.trim()} → профіль ${profile}`
    gate.reason = [why, ...gate.reason.filter((x) => !x.includes('зафіксовано вручну'))]
    r.log.reason = gate.reason
  }
  r.log.data = { ...r.log.data, adapter: 'shiftwork', ...(input.ticketType ? { ticketType: input.ticketType } : {}) }

  const skillItems = new Map(items.filter((i) => i.kind === 'skill').map((i) => [i.name, i]))
  const skills = [...gate.skills.on, ...gate.skills.preload]
  const preload = [...gate.skills.preload]
  const bodies: string[] = []
  for (const name of preload) {
    const it = skillItems.get(name)
    if (it?.body) bodies.push(`<!-- Preloaded skill: ${it.provenance.path ?? name} -->\n${it.body}`)
  }
  const pluginDirSymlinks: string[] = []
  for (const name of skills) {
    const p = skillItems.get(name)?.provenance.path
    if (p) pluginDirSymlinks.push(/SKILL\.md$/i.test(p) ? dirOf(p) : p)
  }
  const skillOverrides = skillOverridesFor(gate, { hard: true }) as TicketPlan['settings']['skillOverrides']

  const env: Record<string, string> = {}
  if (gate.profile) env.CONTEXT_GATE_PROFILE = gate.profile
  if (input.ticketType) env.CONTEXT_GATE_TICKET_TYPE = input.ticketType.trim()
  if (model) env.CONTEXT_GATE_MODEL = model

  return {
    profile: gate.profile,
    tier: gate.tier,
    skills,
    preload,
    appendSystemPrompt: bodies.join('\n\n'),
    pluginDirSymlinks: [...new Set(pluginDirSymlinks)],
    settings: { skillOverrides },
    env,
    mcpOff: gate.mcp.off,
    gate,
    log: r.log,
  }
}

// ───────────────────────── journal events ─────────────────────────

export interface ShiftEventBase {
  ts: number
  /** Shift number on the ticket (1-based), written as `turn`. */
  turn: number
  tier: Tier
  profile?: string
  /** `<feature>/<number>` */
  ticket?: string
}

/** Next tier in `escalation.order` above `tier`, if any. */
export function nextTier(config: GateConfig, tier: Tier): Tier | undefined {
  const order = config.escalation?.order ?? []
  const i = order.indexOf(tier)
  return i >= 0 && i + 1 < order.length ? order[i + 1] : undefined
}

/** `escalation-suggested` when `verifyFailed` / `stallTurns` reach `escalation.after`. */
export function escalationEvent(config: GateConfig, base: ShiftEventBase, counts: { verifyFailed?: number; stallTurns?: number }): DecisionLogEntry | undefined {
  const after = config.escalation?.after
  if (!after) return undefined
  const reasons: string[] = []
  if (after.verifyFailed !== undefined && (counts.verifyFailed ?? 0) >= after.verifyFailed) reasons.push(`${counts.verifyFailed} невдалі перевірки на ${base.tier}`)
  if (after.stallTurns !== undefined && (counts.stallTurns ?? 0) >= after.stallTurns) reasons.push(`${counts.stallTurns} ходів без прогресу на ${base.tier}`)
  if (!reasons.length) return undefined
  const to = nextTier(config, base.tier)
  const reason = to ? `${reasons.join('; ')} — перейди на ${to}` : `${reasons.join('; ')} — вищого tier немає`
  return entry('escalation-suggested', 'escalation', base, [reason], { from: base.tier, ...(to ? { to } : {}), ...counts })
}

/** One Verify run of a shift: `gate-failed` (gate `verify`) on failure, `decision` with trigger `verify` on success. */
export function verifyEvent(base: ShiftEventBase, result: { passed: boolean; attempt: number; command?: string; exitCode?: number }): DecisionLogEntry {
  const reason = result.passed ? `Verify пройдено (спроба ${result.attempt})` : `Verify не пройдено (спроба ${result.attempt}${result.exitCode !== undefined ? `, exit ${result.exitCode}` : ''})`
  return entry(result.passed ? 'decision' : 'gate-failed', 'verify', base, [reason], { gate: 'verify', passed: result.passed, attempt: result.attempt, ...(result.command ? { command: result.command } : {}), ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) })
}

/** The plan as a `decision` entry stamped with the shift's time and number. */
export function decisionEvent(plan: TicketPlan, base: Omit<ShiftEventBase, 'tier' | 'profile'>): DecisionLogEntry {
  const e: DecisionLogEntry = { ...plan.log, ts: base.ts, turn: base.turn, data: { ...plan.log.data, ...(base.ticket ? { ticket: base.ticket } : {}) } }
  return e
}

function entry(kind: NonNullable<DecisionLogEntry['kind']>, trigger: string, base: ShiftEventBase, reason: string[], data: Record<string, unknown>): DecisionLogEntry {
  const e: DecisionLogEntry = { ts: base.ts, turn: base.turn, trigger, tier: base.tier, enabled: [], disabled: [], reason, kind, data: { adapter: 'shiftwork', ...(base.ticket ? { ticket: base.ticket } : {}), ...data } }
  if (base.profile) e.profile = base.profile
  return e
}

/** JSONL text to append to `.claude/gate.log.jsonl`. */
export function formatEvents(entries: readonly DecisionLogEntry[]): string {
  return entries.map((e) => toJsonl(e)).join('')
}

/** Read side for the runner: `escalation-suggested` entries newer than `since` (optionally for one ticket). */
export function escalationsSince(entries: readonly DecisionLogEntry[], since: number, ticket?: string): DecisionLogEntry[] {
  return entries.filter((e) => e.kind === 'escalation-suggested' && e.ts > since && (!ticket || e.data?.ticket === undefined || e.data.ticket === ticket))
}

/** Verify-first-try rate from the journal: tickets whose first verify event passed / tickets with a verify event. */
export function verifyFirstTry(entries: readonly DecisionLogEntry[]): { tickets: number; firstTry: number; rate: number | undefined } {
  const first = new Map<string, boolean>()
  for (const e of entries) {
    if (e.trigger !== 'verify' || e.data?.gate !== 'verify') continue
    const t = String(e.data?.ticket ?? '')
    if (!first.has(t)) first.set(t, e.data?.passed === true && e.data?.attempt === 1)
  }
  const firstTry = [...first.values()].filter(Boolean).length
  return { tickets: first.size, firstTry, rate: first.size ? firstTry / first.size : undefined }
}

/** Tier the plan would use for a model, with the reason (for `plan --explain`). */
export function tierOf(config: GateConfig, modelRef: string | undefined): { tier: Tier; reason: string } {
  const t = tierForModel(config, shiftworkModelId(modelRef))
  return { tier: t.tier, reason: t.reason }
}
