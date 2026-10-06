// `claude-code-hooks` harness adapter (SPEC "Єдина модель", harness-адаптери): the fallback without mods.
// Pure: one settings-hook event (stdin JSON) + loaded repo data + session state → hook JSON output,
// new state and journal entries. All I/O lives in node.ts / main.ts.

import type { DecisionLogEntry, Gate, GateConfig, GateState, Item, MdcRule, Signals } from '../../core/src/types.ts'
import { decideGate, denyText, statusLine } from '../../core/src/decide.ts'
import { autoRulesFor as coreAutoRulesFor, isPartialRead, packInjections, ruleToItem } from '../../core/src/mdc.ts'
import { normalizePath } from '../../core/src/glob.ts'
import { makeItem } from '../../core/src/items.ts'
import { extractMentions, extractPromptFlag } from '../../core/src/gatecmd.ts'
import { tierForModel } from '../../core/src/config.ts'

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
  /** SessionStart */
  source?: string
  model?: string
  /** UserPromptSubmit */
  prompt?: string
  /** PreToolUse / PostToolUse */
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
}

export interface HookOutput {
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
  /** Model id when SessionStart has none (`claude -p --model …` runners). */
  CONTEXT_GATE_MODEL?: string
  ANTHROPIC_MODEL?: string
}

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
  return out
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
  const mode = env.CONTEXT_GATE_MODE?.trim() || cfg.classify?.mode || 'shadow'
  return mode === 'auto'
}

function manualSignal(state: SessionState, env: HookEnv): Signals['manual'] {
  if (env.CONTEXT_GATE_OFF === '1' || state.manual?.off) return { add: [], remove: [], off: true }
  const p = state.manual?.profile || env.CONTEXT_GATE_PROFILE?.trim()
  return p ? { profile: p, add: [], remove: [] } : undefined
}

function gateItems(ctx: HookContext, extra: Item[] = []): Item[] {
  return [...ctx.items, ...ctx.rules.map(ruleToItem), ...extra]
}

interface Decision { gate: Gate; gateState: GateState; log: DecisionLogEntry }

/** A turn-advancing decision (SessionStart, UserPromptSubmit). */
function decideTurn(ctx: HookContext, state: SessionState, input: HookInput, paths: string[], opts: { recheck?: boolean; recheckReason?: 'compact' | 'new' } = {}): Decision {
  const signals: Signals = { paths, model: modelOf(input, state, ctx.env) }
  if (ctx.branch) signals.branch = ctx.branch
  if (ctx.env.CONTEXT_GATE_TICKET_TYPE) signals.ticketType = ctx.env.CONTEXT_GATE_TICKET_TYPE
  if (input.agent_id) signals.agentId = input.agent_id
  const manual = manualSignal(state, ctx.env)
  if (manual) signals.manual = manual
  const r = decideGate(ctx.config, signals, state.gate, gateItems(ctx), { ...opts, now: ctx.now, prevModel: state.model })
  return { gate: r.gate, gateState: r.state, log: r.log }
}

/** A non-advancing look at the committed gate (PreToolUse / PostToolUse): no `when` signals, so no hysteresis step. */
export function currentGate(ctx: HookContext, state: SessionState, input: HookInput, extra: Item[] = []): Gate {
  const signals: Signals = { paths: [], model: modelOf(input, state, ctx.env) }
  const manual = manualSignal(state, ctx.env)
  if (manual) signals.manual = manual
  else if (state.gate.profile) signals.manual = { profile: state.gate.profile, add: [], remove: [] }
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
    default: return { state, log: [] }
  }
}

function onSessionStart(input: HookInput, ctx: HookContext, state: SessionState): HookResult {
  const source = input.source ?? 'startup'
  // The context is re-read after /clear and compaction: delivered rules are gone from it.
  if (source === 'clear' || source === 'compact') state.seen = []
  if (source === 'clear') { state.read = []; state.paths = []; state.manual = undefined }
  const model = modelOf(input, state, ctx.env)
  const d = decideTurn(ctx, state, input, state.paths, source === 'compact' ? { recheck: true, recheckReason: 'compact' } : source === 'clear' ? { recheck: true, recheckReason: 'new' } : {})
  state.gate = d.gateState
  if (model) state.model = model
  const log = maybeLog(state, d, true)
  const applied = isApplied(ctx.config, state, ctx.env)

  const parts: string[] = []
  const always = ctx.rules.filter((r) => r.type === 'always' && !state.seen.includes(dedupKey(input, r.id)) && ruleAllowed(r, d.gate, applied))
  let used = 0
  if (always.length) {
    const packed = packWithin(always, ADDITIONAL_CONTEXT_LIMIT - 200, perInjection(ctx.config))
    for (const id of packed.included) state.seen.push(dedupKey(input, id))
    if (packed.text) parts.push(packed.text)
    used += packed.text.length
    if (packed.included.length) log.push(deliveredLog(ctx, d.gateState.turn, d.gate.tier, packed.included, 'session-start'))
  }
  // Preload for weak tiers (tiers[*].preload): skill bodies inline, like --append-system-prompt.
  {
    for (const name of d.gate.skills.preload) {
      const it = ctx.items.find((i) => i.kind === 'skill' && i.name === name)
      if (!it?.body) continue
      const block = `Preloaded skill ${name}${it.provenance.path ? ` (${it.provenance.path})` : ''}:\n${it.body}`
      if (used + block.length + 2 > ADDITIONAL_CONTEXT_LIMIT - 200) { parts.push(`також діє skill ${name}: прочитай ${it.provenance.path ?? name} за потреби`); continue }
      parts.push(block)
      used += block.length + 2
    }
  }
  if (applied && (d.gate.profile || d.gate.mcp.off.length)) parts.unshift(`context-gate: ${statusLine(d.gate)}`)
  const out = contextOutput('SessionStart', joinLimited(parts))
  return out ? { output: out, state, log } : { state, log }
}

const RULE_CMD = /^[ \t]*\/rule[ \t]+([^\n]+)/m

function onPrompt(input: HookInput, ctx: HookContext, state: SessionState): HookResult {
  const raw = input.prompt ?? ''
  const flag = extractPromptFlag(raw)
  let recheck = false
  if (flag.profile === 'off') state.manual = { off: true }
  else if (flag.profile === 'auto') { state.manual = undefined; recheck = true }
  else if (flag.profile === 'new') { recheck = true }
  else if (flag.profile) state.manual = { profile: flag.profile }
  const text = flag.text
  const mentions = extractMentions(text)
  const ruleIds = new Set(mentions.rules)
  const explicit = new Set<string>()
  const cmd = RULE_CMD.exec(text)
  if (cmd) for (const id of cmd[1].trim().split(/[\s,]+/).filter(Boolean)) { ruleIds.add(id); explicit.add(id) }

  const files = mentions.files.map((f) => relPath(ctx, f))
  for (const f of files) state.paths = pushRecent(state.paths, f, RECENT_PATHS)
  const d = decideTurn(ctx, state, input, state.paths, recheck ? { recheck: true, recheckReason: 'new' } : {})
  const prevProfile = state.last?.profile
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
  if (picked.length) {
    const packed = packWithin(picked, ADDITIONAL_CONTEXT_LIMIT - 300, perInjection(ctx.config))
    for (const id of packed.included) if (!state.seen.includes(dedupKey(input, id))) state.seen.push(dedupKey(input, id))
    parts.push(packed.text)
    if (packed.included.length) log.push(deliveredLog(ctx, d.gateState.turn, d.gate.tier, packed.included, 'prompt'))
  }
  const out = contextOutput('UserPromptSubmit', joinLimited(parts))
  return out ? { output: out, state, log } : { state, log }
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
  const text = reason.replace(/Користувач може увімкнути: \/gate (\S+)/, (_m, g: string) => `Користувач може увімкнути: [gate:${g.replace(/^\+/, '')}] у промпті або /gate ${g} з mod.`) + hint
  const entry = denyLog(ctx, state, gate, toolItem.id, reason, false)
  if (gate.profile === undefined) delete entry.profile
  return { output: denyOutput(text), state, log: [entry] }
}

function readBeforeWriteActive(cfg: GateConfig, tier: string): boolean {
  const g = (cfg.gates ?? []).find((x) => x.name === 'read-before-write' && x.builtin !== false && x.on === 'write')
  if (!g) return false
  return !g.tiers?.length || g.tiers.includes(tier)
}

function writeGate(input: HookInput, ctx: HookContext, state: SessionState, tool: string): HookResult {
  const p = toolPath(input.tool_input)
  if (!p) return { state, log: [] }
  const rel = relPath(ctx, p)
  const tier = tierForModel(ctx.config, modelOf(input, state, ctx.env)).tier
  const exists = rel !== '' && ctx.exists(rel)
  const gateStub = { profile: state.gate.profile, tier } as Gate

  if (exists && readBeforeWriteActive(ctx.config, tier) && !state.read.includes(rel)) {
    const reason = tool === 'Write'
      ? `read-before-write: ${rel} уже існує; прочитай його інструментом Read перед перезаписом (tier ${tier}).`
      : `read-before-write: спершу прочитай ${rel} інструментом Read, потім редагуй (tier ${tier}).`
    const entry: DecisionLogEntry = { ...denyLog(ctx, state, gateStub, `file:${rel}`, reason, false), kind: 'gate-failed', trigger: 'read-before-write' }
    if (entry.profile === undefined) delete entry.profile
    return { output: denyOutput(reason), state, log: [entry] }
  }
  // strictWrite (edge case 2): a Write of a new file whose Auto Attached rule hasn't been delivered.
  if (!exists && tool === 'Write' && ctx.config.cursorRules?.strictWrite) {
    const applied = isApplied(ctx.config, state, ctx.env)
    const gate = applied ? currentGate(ctx, state, input) : undefined
    const rules = autoRulesFor(ctx, rel).filter((r) => !state.seen.includes(dedupKey(input, r.id)) && ruleAllowed(r, gate, applied))
    if (rules.length) {
      const packed = packWithin(rules, ADDITIONAL_CONTEXT_LIMIT - 300, perInjection(ctx.config))
      for (const id of packed.included) state.seen.push(dedupKey(input, id))
      const reason = `${packed.text}\n\nДля ${rel} діють правила вище. Повтори запис з їх урахуванням.`
      return { output: denyOutput(reason), state, log: [deliveredLog(ctx, state.gate.turn, tier, packed.included, 'strict-write', rel)] }
    }
  }
  return { state, log: [] }
}
