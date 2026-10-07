// `claude-code-hooks` harness adapter (SPEC "Єдина модель", harness-адаптери): the fallback without mods.
// Pure: one settings-hook event (stdin JSON) + loaded repo data + session state → hook JSON output,
// new state and journal entries. All I/O lives in node.ts / main.ts.

import type { DecisionLogEntry, Gate, GateConfig, GateState, Item, MdcRule, Signals } from '../../core/src/types.ts'
import { decideGate, denyText, profileParts, statusLine } from '../../core/src/decide.ts'
import { autoRulesFor as coreAutoRulesFor, isPartialRead, packInjections, ruleToItem } from '../../core/src/mdc.ts'
import { normalizePath } from '../../core/src/glob.ts'
import { makeItem, ownEntry } from '../../core/src/items.ts'
import { extractMentions, extractPromptFlag, promptFlagAction } from '../../core/src/gatecmd.ts'
import { tierForModel } from '../../core/src/config.ts'
import { gateAttemptEntry } from '../../core/src/journal.ts'

/** Claude Code saves a hook's additionalContext above this size to a file and shows a preview only. */
export const ADDITIONAL_CONTEXT_LIMIT = 10_000
/** Recent paths kept as `when.paths` signals. */
export const RECENT_PATHS = 20
/** Paths remembered for read-before-write. */
export const READ_PATHS = 500
/** Our own MCP tools (mod adapter) are never gated. */
export const OWN_MCP_PREFIX = 'mcp__context-gate__'

export const FILE_TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit'] as const
export const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

/** The settings-hook stdin JSON (fields this adapter reads; see ClassicHookInputs in the d.ts). */
export interface HookInput {
  hook_event_name: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  agent_id?: string
  /** SessionStart (`startup|resume|clear|compact|fork`), UserPromptSubmit (`user|sdk|system|…`) */
  source?: string
  model?: string
  /** UserPromptSubmit */
  prompt?: string
  /** PostModelSwitch */
  from_model?: string
  to_model?: string
  /** PreToolUse / PostToolUse */
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
}

export interface HookOutput {
  /** Shown to the user, not to the model (common hook output field). */
  systemMessage?: string
  hookSpecificOutput: {
    hookEventName: string
    additionalContext?: string
    permissionDecision?: 'allow' | 'deny' | 'ask'
    permissionDecisionReason?: string
  }
}

export interface SessionState {
  v: 1
  /** Dedup keys `<agent_id|main>:<ruleId>`. */
  seen: string[]
  /** Repo-relative paths read (or written) in this session: read-before-write. */
  read: string[]
  /** Recent paths for `when.paths`. */
  paths: string[]
  gate: GateState
  /** Prompt-level overrides: `[gate:x]`, `[gate:off]`, `[gate:auto]`. */
  manual?: { profile?: string; off?: boolean }
  model?: string
  /** Last logged decision, to log only changes. */
  last?: { profile?: string; tier: string; off: boolean }
  /** Tier-preloaded skills already in this context (reset on /clear and compaction). */
  preloaded?: string[]
}

export interface HookEnv {
  /** Fixed profile (as `/gate <profile>`), like the plugin's userConfig `profile`. */
  CONTEXT_GATE_PROFILE?: string
  /** `auto` applies the gate (deny) without a manual profile; `shadow` only logs. Overrides `classify.mode`. */
  CONTEXT_GATE_MODE?: string
  /** `1` → like `/gate off`. */
  CONTEXT_GATE_OFF?: string
  /** Ticket `**Type:**` from shiftwork (profiles[*].when.ticketType). */
  CONTEXT_GATE_TICKET_TYPE?: string
  /** Ticket id from shiftwork: recorded in decision entries (L64). */
  CONTEXT_GATE_TICKET?: string
  /** Model id when SessionStart has none (`claude -p --model …` runners). */
  CONTEXT_GATE_MODEL?: string
  ANTHROPIC_MODEL?: string
  /** Ticket `**Skills:** +a -b` from shiftwork's plan: groups (or profiles) added / removed, space or comma separated. */
  CONTEXT_GATE_ADD?: string
  CONTEXT_GATE_REMOVE?: string
  /** `system`: the runner already put the tier preload into the system prompt; SessionStart skips it. */
  CONTEXT_GATE_PRELOAD?: string
}

/** Env keys the hooks adapter reads (main.ts copies exactly these). */
export const HOOK_ENV_KEYS = ['CONTEXT_GATE_PROFILE', 'CONTEXT_GATE_MODE', 'CONTEXT_GATE_OFF', 'CONTEXT_GATE_TICKET_TYPE', 'CONTEXT_GATE_TICKET', 'CONTEXT_GATE_MODEL', 'ANTHROPIC_MODEL', 'CONTEXT_GATE_ADD', 'CONTEXT_GATE_REMOVE', 'CONTEXT_GATE_PRELOAD'] as const

export interface HookContext {
  /** Absolute repo root (CLAUDE_PROJECT_DIR or cwd). */
  root: string
  config: GateConfig
  rules: readonly MdcRule[]
  /** Skills (with body when known) and agents; rules and the called tool are added here. */
  items: readonly Item[]
  env: HookEnv
  now: number
  branch?: string
  windows?: boolean
  /** Does a repo-relative (or absolute) path exist? */
  exists(path: string): boolean
}

export interface HookResult {
  output?: HookOutput
  state: SessionState
  log: DecisionLogEntry[]
}

export function newState(): SessionState {
  return { v: 1, seen: [], read: [], paths: [], gate: { turn: 0 } }
}

/** Coerce whatever was on disk into a valid state (corrupt → fresh). */
export function reviveState(raw: unknown): SessionState {
  if (!raw || typeof raw !== 'object') return newState()
  const s = raw as Partial<SessionState>
  if (s.v !== 1) return newState()
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const out: SessionState = { v: 1, seen: arr(s.seen), read: arr(s.read), paths: arr(s.paths), gate: s.gate && typeof s.gate === 'object' ? s.gate : { turn: 0 } }
  if (s.manual) out.manual = s.manual
  if (typeof s.model === 'string') out.model = s.model
  if (s.last) out.last = s.last
  if (Array.isArray(s.preloaded)) out.preloaded = arr(s.preloaded)
  return out
}

/** Elements of `xs` not in `ys`. */
function minus(xs: readonly string[], ys: readonly string[]): string[] {
  const set = new Set(ys)
  return xs.filter((x) => !set.has(x))
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Three-way merge for concurrent hook processes (R4): `base` is what this process read, `next` what it computed,
 * `disk` what another process wrote meanwhile. List fields get both sides' additions and removals; a scalar
 * field this process did not change takes the disk value. With `disk` equal to `base` the result is `next`.
 */
export function mergeStates(base: SessionState, next: SessionState, disk: SessionState): SessionState {
  const list = (k: 'seen' | 'read' | 'paths', max: number): string[] => {
    const removedByOther = minus(base[k], disk[k])
    const addedByOther = minus(disk[k], base[k])
    const out = minus(next[k], removedByOther)
    for (const x of addedByOther) if (!out.includes(x)) out.push(x)
    return out.length > max ? out.slice(out.length - max) : out
  }
  const out: SessionState = { ...next, seen: list('seen', Number.MAX_SAFE_INTEGER), read: list('read', READ_PATHS), paths: list('paths', RECENT_PATHS) }
  for (const k of ['gate', 'manual', 'model', 'last', 'preloaded'] as const) {
    if (!same(base[k], next[k])) continue
    if (disk[k] === undefined) delete out[k]
    else (out as unknown as Record<string, unknown>)[k] = disk[k]
  }
  return out
}

/** Did this event change the state (skip the write when not)? */
export function stateChanged(before: SessionState, after: SessionState): boolean {
  return !same(before, after)
}

// ───────────────────────── output builders ─────────────────────────

export function contextOutput(event: string, text: string): HookOutput | undefined {
  if (!text.trim()) return undefined
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
}

export function denyOutput(reason: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}

/** Pack framed rules into `limit` (pointer lines included). Rules that don't fit become `також діє: <path>`. */
export function packWithin(rules: readonly Pick<MdcRule, 'id' | 'path' | 'body'>[], limit: number, perInjection = limit): { text: string; included: string[]; deferred: string[] } {
  let budget = Math.min(limit, perInjection)
  for (let i = 0; i < 50; i++) {
    const r = packInjections(rules, Math.max(0, budget))
    if (r.text.length <= limit || budget <= 0) {
      return r.text.length <= limit ? r : { ...r, text: r.text.slice(0, limit) }
    }
    budget -= r.text.length - limit
  }
  const r = packInjections(rules, 0)
  return { ...r, text: r.text.slice(0, limit) }
}

/** Join context parts, never above the limit. */
function joinLimited(parts: string[], limit = ADDITIONAL_CONTEXT_LIMIT): string {
  const out: string[] = []
  let used = 0
  for (const p of parts) {
    if (!p) continue
    const add = p.length + (out.length ? 2 : 0)
    if (used + add > limit) break
    out.push(p)
    used += add
  }
  return out.join('\n\n')
}

// ───────────────────────── gate ─────────────────────────

function modelOf(input: HookInput, state: SessionState, env: HookEnv): string | undefined {
  return input.model || state.model || env.CONTEXT_GATE_MODEL || env.ANTHROPIC_MODEL || undefined
}

/** Whether decisions are enforced (deny / rule gating) or only logged (shadow). */
export function isApplied(cfg: GateConfig, state: SessionState, env: HookEnv): boolean {
  if (env.CONTEXT_GATE_PROFILE?.trim()) return true
  if (state.manual?.profile) return true
  // A runner plan's `Skills: +a -b` is a manual signal, like `/gate +a` in the mod.
  if (envList(env.CONTEXT_GATE_ADD).length || envList(env.CONTEXT_GATE_REMOVE).length) return true
  const mode = env.CONTEXT_GATE_MODE?.trim() || cfg.classify?.mode || 'shadow'
  return mode === 'auto'
}

/** `CONTEXT_GATE_ADD="pg, +ops"` → `['pg', 'ops']`. */
export function envList(v: string | undefined): string[] {
  return (v ?? '').split(/[\s,]+/).map((x) => x.replace(/^[+-]/, '')).filter(Boolean)
}

function manualSignal(state: SessionState, env: HookEnv): Signals['manual'] {
  if (env.CONTEXT_GATE_OFF === '1' || state.manual?.off) return { add: [], remove: [], off: true }
  const p = state.manual?.profile || env.CONTEXT_GATE_PROFILE?.trim()
  const add = envList(env.CONTEXT_GATE_ADD)
  const remove = envList(env.CONTEXT_GATE_REMOVE)
  if (!p && !add.length && !remove.length) return undefined
  return p ? { profile: p, add, remove } : { add, remove }
}

/** Is every part of `word` (`a+b` unions too) a profile gate.json declares? The mod ignores others (G502). */
export function declaredProfile(cfg: GateConfig, word: string): boolean {
  const parts = profileParts(word, cfg)
  return parts.length > 0 && parts.every((p) => ownEntry(cfg.profiles, p) !== undefined)
}

/**
 * The `[gate:x]` word that enables `group` in these harnesses: `[gate:x]` sets a profile, not a group, so it is
 * the group itself only when that is a declared profile, else a declared profile that contains the group.
 */
export function flagForGroup(cfg: GateConfig, group: string): string | undefined {
  if (ownEntry(cfg.profiles, group)) return group
  for (const [name, p] of Object.entries(cfg.profiles ?? {})) if (p?.groups?.includes(group)) return name
  return undefined
}

function gateItems(ctx: HookContext, extra: Item[] = []): Item[] {
  return [...ctx.items, ...ctx.rules.map(ruleToItem), ...extra]
}

interface Decision { gate: Gate; gateState: GateState; log: DecisionLogEntry }

/** A turn-advancing decision (SessionStart, UserPromptSubmit). */
function decideTurn(ctx: HookContext, state: SessionState, input: HookInput, paths: string[], opts: { recheck?: boolean; recheckReason?: 'compact' | 'new'; advance?: boolean } = {}): Decision {
  const signals: Signals = { paths, model: modelOf(input, state, ctx.env) }
  if (ctx.branch) signals.branch = ctx.branch
  if (ctx.env.CONTEXT_GATE_TICKET_TYPE) signals.ticketType = ctx.env.CONTEXT_GATE_TICKET_TYPE
  if (ctx.env.CONTEXT_GATE_TICKET) signals.ticketId = ctx.env.CONTEXT_GATE_TICKET
  if (input.agent_id) signals.agentId = input.agent_id
  const manual = manualSignal(state, ctx.env)
  if (manual) signals.manual = manual
  const r = decideGate(ctx.config, signals, state.gate, gateItems(ctx), { ...opts, now: ctx.now, prevModel: state.model, ...(ctx.windows ? { nocase: true } : {}) })
  return { gate: r.gate, gateState: r.state, log: r.log }
}

/** A non-advancing look at the committed gate (PreToolUse / PostToolUse): no `when` signals, so no hysteresis step. */
export function currentGate(ctx: HookContext, state: SessionState, input: HookInput, extra: Item[] = []): Gate {
  const signals: Signals = { paths: [], model: modelOf(input, state, ctx.env) }
  const manual = manualSignal(state, ctx.env)
  // The committed profile holds; runner adjustments (CONTEXT_GATE_ADD/REMOVE) apply on top of it.
  if (manual && (manual.profile || manual.off || !state.gate.profile)) signals.manual = manual
  else if (state.gate.profile) signals.manual = { profile: state.gate.profile, add: manual?.add ?? [], remove: manual?.remove ?? [] }
  return decideGate(ctx.config, signals, state.gate, gateItems(ctx, extra), { now: ctx.now }).gate
}

function maybeLog(state: SessionState, d: Decision, force: boolean): DecisionLogEntry[] {
  const cur = { profile: d.gate.profile, tier: d.gate.tier, off: d.gate.off }
  const changed = !state.last || state.last.profile !== cur.profile || state.last.tier !== cur.tier || state.last.off !== cur.off
  if (cur.profile === undefined) delete cur.profile
  state.last = cur
  return force || changed ? [{ ...d.log, data: { ...d.log.data, adapter: 'claude-code-hooks' } }] : []
}

// ───────────────────────── rules ─────────────────────────

function dedupKey(input: HookInput, ruleId: string): string {
  return `${input.agent_id ?? 'main'}:${ruleId}`
}

function ruleAllowed(rule: MdcRule, gate: Gate | undefined, applied: boolean): boolean {
  if (!applied || !gate) return true
  return gate.items[`rule:${rule.id}`] !== 'off'
}

/** Cursor semantics: a glob without `/` (`*.ts`) matches the basename at any depth. */
function autoRulesFor(ctx: HookContext, rel: string): MdcRule[] {
  return coreAutoRulesFor(ctx.rules, rel, { nocase: !!ctx.windows })
}

function perInjection(cfg: GateConfig): number {
  return cfg.cursorRules?.maxCharsPerInjection ?? 30_000
}

function relPath(ctx: HookContext, p: string): string {
  return normalizePath(p, ctx.root, ctx.windows === undefined ? {} : { windows: ctx.windows })
}

function pushRecent(list: string[], item: string, max: number): string[] {
  const out = list.filter((x) => x !== item)
  out.push(item)
  return out.length > max ? out.slice(out.length - max) : out
}

function toolPath(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined
  const t = toolInput as Record<string, unknown>
  const p = t.file_path ?? t.notebook_path
  return typeof p === 'string' && p ? p : undefined
}

function deliveredLog(ctx: HookContext, turn: number, tier: string, ids: string[], via: string, path?: string): DecisionLogEntry {
  return { ts: ctx.now, turn, trigger: via, tier, enabled: ids.map((i) => `rule:${i}`), disabled: [], reason: [`${via}: ${ids.join(', ')}`], kind: 'rule-delivered', data: { rules: ids, adapter: 'claude-code-hooks', ...(path ? { path } : {}) } }
}

// ───────────────────────── events ─────────────────────────

export function handleHook(input: HookInput, ctx: HookContext, prev: SessionState): HookResult {
  const state: SessionState = { ...prev, seen: [...prev.seen], read: [...prev.read], paths: [...prev.paths], gate: { ...prev.gate } }
  switch (input.hook_event_name) {
    case 'SessionStart': return onSessionStart(input, ctx, state)
    case 'UserPromptSubmit': return onPrompt(input, ctx, state)
    case 'PostToolUse': return onPostTool(input, ctx, state)
    case 'PreToolUse': return onPreTool(input, ctx, state)
    case 'SubagentStart': return onSubagentStart(input, ctx, state)
    case 'PostModelSwitch': return onModelSwitch(input, ctx, state)
    default: return { state, log: [] }
  }
}

/** `classify.recheckOn` has `what` (`compact`, `/gate new`), as the mod's session layer reads it. */
function recheckOn(cfg: GateConfig, what: string): boolean {
  return (cfg.classify?.recheckOn ?? []).some((x) => x === what || x.endsWith(what))
}

/** Always rules the gate allows and this agent's context lacks, packed within `limit`. */
function packAlways(ctx: HookContext, state: SessionState, input: HookInput, gate: Gate | undefined, applied: boolean, limit: number): { text: string; included: string[] } {
  const always = ctx.rules.filter((r) => r.type === 'always' && !state.seen.includes(dedupKey(input, r.id)) && ruleAllowed(r, gate, applied))
  if (!always.length) return { text: '', included: [] }
  const packed = packWithin(always, limit, perInjection(ctx.config))
  for (const id of packed.included) state.seen.push(dedupKey(input, id))
  return { text: packed.text, included: packed.included }
}

/** Tier preload blocks (skill bodies inline, like --append-system-prompt) for skills not yet in this context. */
function preloadParts(ctx: HookContext, state: SessionState, names: readonly string[], budget: number): { parts: string[]; used: number } {
  const parts: string[] = []
  let used = 0
  const done = state.preloaded ?? []
  for (const name of names) {
    if (done.includes(name)) continue
    const it = ctx.items.find((i) => i.kind === 'skill' && i.name === name)
    if (!it?.body) continue
    const block = `Preloaded skill ${name}${it.provenance.path ? ` (${it.provenance.path})` : ''}:\n${it.body}`
    if (used + block.length + 2 > budget) { parts.push(`також діє skill ${name}: прочитай ${it.provenance.path ?? name} за потреби`); continue }
    parts.push(block)
    used += block.length + 2
    state.preloaded = [...(state.preloaded ?? []), name]
  }
  return { parts, used }
}

function onSessionStart(input: HookInput, ctx: HookContext, state: SessionState): HookResult {
  const source = input.source ?? 'startup'
  // The context is re-read after /clear and compaction: delivered rules and preloaded bodies are gone from it.
  if (source === 'clear' || source === 'compact') { state.seen = []; state.preloaded = undefined }
  if (source === 'clear') { state.read = []; state.paths = []; state.manual = undefined }
  const model = modelOf(input, state, ctx.env)
  const recheck = source === 'clear' ? { recheck: true, recheckReason: 'new' as const }
    : source === 'compact' && recheckOn(ctx.config, 'compact') ? { recheck: true, recheckReason: 'compact' as const } : {}
  const d = decideTurn(ctx, state, input, state.paths, recheck)
  state.gate = d.gateState
  if (model) state.model = model
  const log = maybeLog(state, d, true)
  const applied = isApplied(ctx.config, state, ctx.env)

  const parts: string[] = []
  let used = 0
  const packed = packAlways(ctx, state, input, d.gate, applied, ADDITIONAL_CONTEXT_LIMIT - 200)
  if (packed.text) parts.push(packed.text)
  used += packed.text.length
  if (packed.included.length) log.push(deliveredLog(ctx, d.gateState.turn, d.gate.tier, packed.included, 'session-start'))
  // Preload for weak tiers (tiers[*].preload, Р5): only for the applied gate, as the mod's preload section (M03).
  // A resumed or forked transcript already holds it; a runner that preloaded into the system prompt says so.
  if (applied && !d.gate.off && source !== 'resume' && source !== 'fork' && ctx.env.CONTEXT_GATE_PRELOAD !== 'system') {
    parts.push(...preloadParts(ctx, state, d.gate.skills.preload, ADDITIONAL_CONTEXT_LIMIT - 200 - used).parts)
  }
  if (applied && (d.gate.profile || d.gate.mcp.off.length)) parts.unshift(`context-gate: ${statusLine(d.gate)}`)
  const out = contextOutput('SessionStart', joinLimited(parts))
  return out ? { output: out, state, log } : { state, log }
}

/** SubagentStart: a subagent does not inherit the main thread's SessionStart context, so it gets the Always rules. */
function onSubagentStart(input: HookInput, ctx: HookContext, state: SessionState): HookResult {
  if (!input.agent_id) return { state, log: [] }
  const applied = isApplied(ctx.config, state, ctx.env)
  const gate = currentGate(ctx, state, input)
  const packed = packAlways(ctx, state, input, gate, applied, ADDITIONAL_CONTEXT_LIMIT - 200)
  const log = packed.included.length ? [deliveredLog(ctx, state.gate.turn, gate.tier, packed.included, 'subagent-start')] : []
  const out = contextOutput('SubagentStart', packed.text)
  return out ? { output: out, state, log } : { state, log }
}

/** PostModelSwitch (`/model`): the tier follows the new model (read-before-write, preload); not a new turn. */
function onModelSwitch(input: HookInput, ctx: HookContext, state: SessionState): HookResult {
  const to = input.to_model?.trim()
  if (!to || to === state.model) return { state, log: [] }
  const d = decideTurn(ctx, state, { ...input, model: to }, [], { advance: false })
  state.gate = d.gateState
  state.model = to
  const log = maybeLog(state, d, false)
  const applied = isApplied(ctx.config, state, ctx.env)
  const parts: string[] = []
  if (applied && !d.gate.off && ctx.env.CONTEXT_GATE_PRELOAD !== 'system') parts.push(...preloadParts(ctx, state, d.gate.skills.preload, ADDITIONAL_CONTEXT_LIMIT - 200).parts)
  if (parts.length && applied) parts.unshift(`context-gate: ${statusLine(d.gate)}`)
  const out = contextOutput('PostModelSwitch', joinLimited(parts))
  return out ? { output: out, state, log } : { state, log }
}

const RULE_CMD = /^[ \t]*\/rule[ \t]+([^\n]+)/m

/** UserPromptSubmit sources that are not the user's own turn (d.ts): task notifications, wakeups, peer messages. */
const MACHINE_SOURCES = ['system', 'loop_wakeup', 'schedule_wakeup', 'poll_event']

function onPrompt(input: HookInput, ctx: HookContext, state: SessionState): HookResult {
  // A machine-injected prompt is no turn (hysteresis) and no place for `[gate:x]` / `/rule` from other agents.
  if (input.source && MACHINE_SOURCES.includes(input.source)) return { state, log: [] }
  const raw = input.prompt ?? ''
  const flag = extractPromptFlag(raw)
  const action = promptFlagAction(flag.profile)
  let recheck = false
  let notice: string | undefined
  if (action === 'off') state.manual = { off: true }
  else if (action === 'auto') { state.manual = undefined; recheck = true }
  else if (action === 'new') { recheck = true }
  else if (flag.profile && declaredProfile(ctx.config, flag.profile)) state.manual = { profile: flag.profile }
  else if (flag.profile) {
    const known = Object.keys(ctx.config.profiles ?? {}).join(', ') || '—'
    notice = `context-gate: G502 [gate:${flag.profile}]: профіль не оголошено в gate.json, прапорець проігноровано. Відомі: ${known}`
  }
  const text = flag.text
  const mentions = extractMentions(text)
  const ruleIds = new Set(mentions.rules)
  const explicit = new Set<string>()
  const cmd = RULE_CMD.exec(text)
  if (cmd) for (const id of cmd[1].trim().split(/[\s,]+/).filter(Boolean)) { ruleIds.add(id); explicit.add(id) }

  const files = mentions.files.map((f) => relPath(ctx, f))
  for (const f of files) {
    state.paths = pushRecent(state.paths, f, RECENT_PATHS)
    // `@file` mentions arrive with their content: they count as read (Claude Code and the mod agree).
    state.read = pushRecent(state.read, f, READ_PATHS)
  }
  const prevLast = state.last
  const d = decideTurn(ctx, state, input, state.paths, recheck ? { recheck: true, recheckReason: 'new' } : {})
  const prevProfile = prevLast?.profile
  state.gate = d.gateState
  const log = maybeLog(state, d, false)
  const applied = isApplied(ctx.config, state, ctx.env)

  // Manual `@id` and `/rule id`: any rule by id (Manual first of all); `/rule` re-sends even if seen.
  const picked: MdcRule[] = []
  const pickedIds = new Set<string>()
  const unknown: string[] = []
  for (const id of ruleIds) {
    const rule = ctx.rules.find((r) => r.id === id || r.id.endsWith(`/${id}`))
    if (!rule) { if (explicit.has(id)) unknown.push(id); continue }
    if (!explicit.has(id) && state.seen.includes(dedupKey(input, rule.id))) continue
    if (!explicit.has(id) && !ruleAllowed(rule, d.gate, applied)) continue
    if (!pickedIds.has(rule.id)) { picked.push(rule); pickedIds.add(rule.id) }
  }
  // `@file` mentions don't go through a tool call (issue #98796): Auto Attached rules here.
  for (const f of files) {
    for (const rule of autoRulesFor(ctx, f)) {
      if (pickedIds.has(rule.id) || state.seen.includes(dedupKey(input, rule.id)) || !ruleAllowed(rule, d.gate, applied)) continue
      picked.push(rule)
      pickedIds.add(rule.id)
    }
  }
  const parts: string[] = []
  if (applied && d.gate.profile !== prevProfile && d.gate.profile) parts.push(`context-gate: ${statusLine(d.gate)}`)
  if (unknown.length) parts.push(`context-gate: правило ${unknown.join(', ')} не знайдено в .cursor/rules`)
  // A profile change can turn on Always rules SessionStart held back (M71); the mod rebuilds them every prompt.
  const gateChanged = !prevLast || prevLast.profile !== d.gate.profile || prevLast.off !== d.gate.off
  if (applied && gateChanged) {
    const always = packAlways(ctx, state, input, d.gate, applied, ADDITIONAL_CONTEXT_LIMIT - 300)
    if (always.text) parts.push(always.text)
    if (always.included.length) log.push(deliveredLog(ctx, d.gateState.turn, d.gate.tier, always.included, 'prompt'))
  }
  if (picked.length) {
    const used = parts.reduce((n, p) => n + p.length + 2, 0)
    const packed = packWithin(picked, Math.max(0, ADDITIONAL_CONTEXT_LIMIT - 300 - used), perInjection(ctx.config))
    for (const id of packed.included) if (!state.seen.includes(dedupKey(input, id))) state.seen.push(dedupKey(input, id))
    parts.push(packed.text)
    if (packed.included.length) log.push(deliveredLog(ctx, d.gateState.turn, d.gate.tier, packed.included, 'prompt'))
  }
  const out = contextOutput('UserPromptSubmit', joinLimited(parts))
  const result: HookResult = out ? { output: out, state, log } : { state, log }
  if (notice) result.output = { ...(result.output ?? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } }), systemMessage: notice }
  return result
}

function onPostTool(input: HookInput, ctx: HookContext, state: SessionState): HookResult {
  const tool = input.tool_name ?? ''
  if (!(FILE_TOOLS as readonly string[]).includes(tool)) return { state, log: [] }
  const p = toolPath(input.tool_input)
  if (!p) return { state, log: [] }
  const rel = relPath(ctx, p)
  state.read = pushRecent(state.read, rel, READ_PATHS)
  state.paths = pushRecent(state.paths, rel, RECENT_PATHS)

  // Reading a .mdc in full is a delivery of that rule (a partial read is not: PR #96364).
  if (tool === 'Read' && rel.endsWith('.mdc') && !isPartialRead(input.tool_input)) {
    const r = ctx.rules.find((x) => x.path === rel)
    if (r && !state.seen.includes(dedupKey(input, r.id))) state.seen.push(dedupKey(input, r.id))
  }

  const applied = isApplied(ctx.config, state, ctx.env)
  const gate = applied ? currentGate(ctx, state, input) : undefined
  const rules = autoRulesFor(ctx, rel).filter((r) => !state.seen.includes(dedupKey(input, r.id)) && ruleAllowed(r, gate, applied))
  if (!rules.length) return { state, log: [] }
  const packed = packWithin(rules.map((r) => ({ ...r, path: r.path })), ADDITIONAL_CONTEXT_LIMIT, perInjection(ctx.config))
  for (const id of packed.included) state.seen.push(dedupKey(input, id))
  const tier = gate?.tier ?? tierForModel(ctx.config, modelOf(input, state, ctx.env)).tier
  const log = packed.included.length ? [deliveredLog(ctx, state.gate.turn, tier, packed.included, `tool:${tool}`, rel)] : []
  const out = contextOutput('PostToolUse', packed.text)
  return out ? { output: out, state, log } : { state, log }
}

function onPreTool(input: HookInput, ctx: HookContext, state: SessionState): HookResult {
  const tool = input.tool_name ?? ''
  if (tool.startsWith('mcp__')) return mcpGate(input, ctx, state, tool)
  if ((WRITE_TOOLS as readonly string[]).includes(tool)) return writeGate(input, ctx, state, tool)
  return { state, log: [] }
}

function denyLog(ctx: HookContext, state: SessionState, gate: Gate, id: string, reason: string, shadow: boolean): DecisionLogEntry {
  return { ts: ctx.now, turn: state.gate.turn, trigger: 'deny', profile: gate.profile, tier: gate.tier, enabled: [], disabled: [id], reason: [reason], kind: 'deny', data: { adapter: 'claude-code-hooks', shadow, ...(id.startsWith('tool:') ? { tool: id } : { id }) } }
}

function mcpGate(input: HookInput, ctx: HookContext, state: SessionState, tool: string): HookResult {
  if (tool.startsWith(OWN_MCP_PREFIX)) return { state, log: [] }
  const toolItem = makeItem('tool', tool, { provenance: { source: 'claude-tools' } })
  const gate = currentGate(ctx, state, input, [toolItem])
  if (gate.items[toolItem.id] !== 'off') return { state, log: [] }
  const reason = denyText('tool', tool, gate, ctx.config)
  if (!isApplied(ctx.config, state, ctx.env)) {
    const entry = denyLog(ctx, state, gate, toolItem.id, `shadow: ${reason}`, true)
    if (gate.profile === undefined) delete entry.profile
    return { state, log: [entry] }
  }
  const hint = ctx.env.CONTEXT_GATE_PROFILE ? ' (профіль задано CONTEXT_GATE_PROFILE)' : ' Або напиши [gate:off] у промпті.'
  const text = reason.replace(/Користувач може увімкнути: \/gate (\S+)/, (_m, g: string) => {
    const flag = g === 'off' ? 'off' : flagForGroup(ctx.config, g.replace(/^\+/, '')) ?? 'off'
    return `Користувач може увімкнути: [gate:${flag}] у промпті або /gate ${g} з mod.`
  }) + hint
  const entry = denyLog(ctx, state, gate, toolItem.id, reason, false)
  if (gate.profile === undefined) delete entry.profile
  return { output: denyOutput(text), state, log: [entry] }
}

/** As the mod (`gatesFor`): a `builtin` gate; no `tiers` means every declared tier except premium (SPEC). */
export function readBeforeWriteActive(cfg: GateConfig, tier: string): boolean {
  const g = (cfg.gates ?? []).find((x) => x.name === 'read-before-write' && x.builtin === true && x.on === 'write')
  if (!g) return false
  return (g.tiers ?? Object.keys(cfg.tiers ?? {}).filter((t) => t !== 'premium')).includes(tier)
}

function writeGate(input: HookInput, ctx: HookContext, state: SessionState, tool: string): HookResult {
  const p = toolPath(input.tool_input)
  if (!p) return { state, log: [] }
  const rel = relPath(ctx, p)
  const tier = tierForModel(ctx.config, modelOf(input, state, ctx.env)).tier
  const exists = rel !== '' && ctx.exists(rel)
  const gateStub = { profile: state.gate.profile, tier } as Gate

  const rbw = exists && readBeforeWriteActive(ctx.config, tier)
  // H011: every evaluation of the gate is a `gate-attempt` (core journal contract), a block also `gate-failed`.
  const attempt = (outcome: 'pass' | 'block'): DecisionLogEntry => gateAttemptEntry({ gate: 'read-before-write', on: 'write', outcome, adapter: 'claude-code-hooks', ...(input.session_id ? { sessionId: input.session_id } : {}) }, { ts: ctx.now, turn: state.gate.turn, tier, ...(state.gate.profile ? { profile: state.gate.profile } : {}) })
  if (rbw && !state.read.includes(rel)) {
    const reason = tool === 'Write'
      ? `read-before-write: ${rel} уже існує; прочитай його інструментом Read перед перезаписом (tier ${tier}).`
      : `read-before-write: спершу прочитай ${rel} інструментом Read, потім редагуй (tier ${tier}).`
    const base = denyLog(ctx, state, gateStub, `file:${rel}`, reason, false)
    // `data.gate` / `data.on` as the mod's gate-failed entry: core report and `context-gate report` key on them.
    const entry: DecisionLogEntry = { ...base, kind: 'gate-failed', trigger: 'read-before-write', data: { ...base.data, gate: 'read-before-write', on: 'write' } }
    if (entry.profile === undefined) delete entry.profile
    return { output: denyOutput(reason), state, log: [entry, attempt('block')] }
  }
  const passed = rbw ? [attempt('pass')] : []
  // strictWrite (edge case 2): a Write of a new file whose Auto Attached rule hasn't been delivered.
  if (!exists && tool === 'Write' && ctx.config.cursorRules?.strictWrite) {
    const applied = isApplied(ctx.config, state, ctx.env)
    const gate = applied ? currentGate(ctx, state, input) : undefined
    const rules = autoRulesFor(ctx, rel).filter((r) => !state.seen.includes(dedupKey(input, r.id)) && ruleAllowed(r, gate, applied))
    if (rules.length) {
      const packed = packWithin(rules, ADDITIONAL_CONTEXT_LIMIT - 300, perInjection(ctx.config))
      for (const id of packed.included) state.seen.push(dedupKey(input, id))
      const reason = `${packed.text}\n\nДля ${rel} діють правила вище. Повтори запис з їх урахуванням.`
      return { output: denyOutput(reason), state, log: [deliveredLog(ctx, state.gate.turn, tier, packed.included, 'strict-write', rel), ...passed] }
    }
  }
  return { state, log: passed }
}
