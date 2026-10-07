// Layer 2: skill-gate (SPEC "Шар 2", MOD-ADAPTER "Layer 2"). Signals → decideGate (pure, core) → application.
// Shadow mode (default): the gate is computed and journaled but NOT applied: nothing is filtered and the
// band shows `gate (frontend?) …`. `/gate apply` (mode auto) applies it; manual `/gate <p>` and `off` apply
// regardless of the mode, while `+g` / `-g` in shadow only edit the proposal. Application points: skill listing
// rewrite, skill.prompt off text (dsl.ts), tool.describe + tool.call deny for MCP, agent.offer, preload section
// (dsl.ts). Only a user prompt is a turn: other recomputes (`/gate`, model change, gate.json) move neither the
// turn counter nor the hysteresis. MCP servers no group in gate.json mentions are never denied (O1).

import type { Gate, GateConfig, GateState, Item, ItemDecision, Signals } from '../../packages/core/src/types.ts'
import { briefRequest, classifyRequest, decideGate, denyText, parseBrief, parseClassify, profileParts, skillOffText } from '../../packages/core/src/decide.ts'
import { modelForTier, normalizeConfig } from '../../packages/core/src/config.ts'
import { parseDuration } from '../../packages/core/src/duration.ts'
import { extractMentions, extractPromptFlag } from '../../packages/core/src/gatecmd.ts'
import { groupsOf, isMcpTool, makeItem, mcpServerOf, mentionedInGroups, normalizeItems, parseSkillListing, renderSkillListing, skillListingItems } from '../../packages/core/src/items.ts'
import { ruleToItem } from '../../packages/core/src/mdc.ts'
import { evalSource, newBudget, regexTest, truthy } from '../../packages/core/src/expr.ts'
import type { ContextGateDecision, ContextGateManual } from '../../types'
import { hasManual, isApplied, json } from '../state.ts'
import { type Io, OWN_TOOL_PREFIX, type Runtime, debug, hash, join, now } from '../ctx.ts'
import { ensureSession, modelTier } from './config.ts'
import { allowedBinary, configuredPromptDir, makeRenderHost, providerConfigs, providerData, runArgv } from './host.ts'
import { repoKey, trustState } from './trust.ts'
import { ensureRules, relPath, rulesForPrompt } from './cursor-rules.ts'
import { journal, pushEntry } from './journal.ts'
import { refreshStatus } from './ui.ts'

// ───────────────────────── items ─────────────────────────

/** Script tools (`# gate-tool:` in `<prompt>/scripts`) registered by dsl.ts, as items (G-35). */
function scriptTools(rt: Runtime): { name: string; path: string; description: string; tiers?: string[] }[] {
  const out: { name: string; path: string; description: string; tiers?: string[] }[] = []
  for (const t of rt.tools.values()) if (t.kind === 'script') out.push(t.tool)
  return out
}

/** `claude-tools` sources with `match` (a regex on the tool name) narrow which MCP tools become items. */
function toolFilter(rt: Runtime): (name: string) => boolean {
  const pats = (rt.config?.itemSources ?? []).filter((s) => s.kind === 'claude-tools' && s.match).map((s) => s.match!)
  if (!pats.length) return () => true
  // Repo patterns run on the core's linear-time engine (M51); an invalid or unsupported pattern is ignored.
  const valid = pats.filter((p) => regexTest(p, '') !== null)
  if (!valid.length) return () => false
  const test = (p: string, name: string): boolean => { try { return regexTest(p, name, newBudget()) === true } catch { return false } }
  return (name) => valid.some((p) => test(p, name))
}

const itemKeys = new WeakMap<Runtime, string>()

export async function ensureItems(io: Io, rt: Runtime): Promise<Item[]> {
  await ensureSession(io, rt)
  const rules = await ensureRules(io, rt)
  const scripts = scriptTools(rt)
  const scriptKey = scripts.map((t) => t.name).sort().join(',')
  if (rt.items && !rt.itemsDirty && itemKeys.get(rt) === scriptKey) return rt.items
  const items: Item[] = []
  if (rt.listingText) items.push(...skillListingItems(parseSkillListing(rt.listingText)))
  if (rt.mcpTools === undefined) {
    const list = await io.tool.list().catch(() => [])
    rt.mcpTools = list.filter((t) => t.mcp && !t.name.startsWith(OWN_TOOL_PREFIX)).map((t) => t.name)
  }
  const keep = toolFilter(rt)
  for (const name of rt.mcpTools) if (keep(name)) items.push(makeItem('tool', name, { provenance: { source: 'claude-tools' } }))
  for (const t of scripts) items.push(makeItem('tool', t.name, { description: t.description, provenance: { source: 'gate-tool', path: t.path }, ...(t.tiers ? { tags: t.tiers.map((x) => `tier:${x}`) } : {}) }))
  for (const name of rt.agentNames) items.push(makeItem('agent', name, { provenance: { source: 'claude-agents' } }))
  for (const r of rules) items.push(ruleToItem(r))
  rt.items = normalizeItems(items)
  rt.itemsDirty = false
  itemKeys.set(rt, scriptKey)
  return rt.items
}

// ───────────────────────── per-agent gates (G-08) ─────────────────────────

const agentGates = new WeakMap<Runtime, Map<string, { key: string; gate: ContextGateDecision }>>()

/** The gate a subagent sees: the main decision's profile and manual groups on the agent's own tier
 * (`agentTiers`, recorded on `turn.step`). Main loop, an unknown agent, a same-tier agent, shadow or off → the main gate. */
export async function gateFor(io: Io, rt: Runtime, agentId: string | undefined): Promise<ContextGateDecision | null> {
  // An invalid gate.json switches layer 2 off: a gate stored before that must not keep filtering (M18).
  if (!rt.config) return null
  const gate = await io.read('gate')
  if (agentId === undefined || !isApplied(gate)) return gate
  const tier = (await io.read('agentTiers'))[agentId]
  if (!tier || tier === gate.tier) return gate
  const items = await ensureItems(io, rt)
  const manual = await io.read('manual')
  const key = `${tier}|${gate.profile ?? ''}|${manual.add.join(',')}|${manual.remove.join(',')}|${effectiveItems(gate)}|${items.length}`
  let cache = agentGates.get(rt)
  if (!cache) { cache = new Map(); agentGates.set(rt, cache) }
  const hit = cache.get(agentId)
  if (hit && hit.key === key) return hit.gate
  const signals: Signals = { paths: [], agentId }
  if (gate.profile || manual.add.length || manual.remove.length) signals.manual = { add: manual.add, remove: manual.remove, ...(gate.profile ? { profile: gate.profile } : {}) }
  const res = decideGate(autoConfig(rt.config), signals, { turn: 0 }, items, { tier })
  const refined = refineGate(rt.config, items, res.gate).gate
  const g: ContextGateDecision = json({ ...refined, trigger: gate.trigger, reason: [`субагент ${agentId}: tier ${tier} (основний цикл: ${gate.tier})`, ...refined.reason] })
  cache.set(agentId, { key, gate: g })
  return g
}

// ───────────────────────── mod refinements of the core decision ─────────────────────────

/** `mcp__ide__*` (the editor bridge) is the session's own plumbing, never a repo's profile choice. */
const IDE_TOOL = /^mcp__ide__/

export function groupedConfig(cfg: GateConfig): GateConfig {
  const legacy = !!(cfg.skillGroups || cfg.mcpGroups || Object.values(cfg.profiles ?? {}).some((p) => p.skills || p.mcp || p.agents) || Object.values(cfg.tiers ?? {}).some((t) => t.skills))
  return legacy ? normalizeConfig(cfg).config : cfg
}

/**
 * Two corrections over core `decideGate` for what the session really holds (O1, M10):
 * - an MCP tool that no group of gate.json mentions (a personal server, a claude.ai connector, `mcp__ide__*`) is
 *   not the repo's to deny: it passes through, and the reason names the servers (an explicit group still governs);
 * - a plugin skill `ns:name` that no group names in full follows the groups that name its bare `name`.
 */
export function refineGate(config: GateConfig, items: readonly Item[], gate: Gate): { gate: Gate; passthrough: string[] } {
  if (gate.off) return { gate, passthrough: [] }
  const cfg = groupedConfig(config)
  if (!Object.keys(cfg.groups ?? {}).length) return { gate, passthrough: [] }
  const active = new Set(gate.groups)
  const decisions: Record<string, ItemDecision> = { ...gate.items }
  const servers = new Set<string>()
  let changed = false
  for (const it of items) {
    const d = decisions[it.id]
    if (d === undefined) continue
    if (isMcpTool(it) && (IDE_TOOL.test(it.name) || !mentionedInGroups(cfg, it))) {
      // Core decideGate already passes these (O1); the mod still names them in the notice.
      servers.add(mcpServerOf(it.name) ?? it.name)
      if (d === 'off') { decisions[it.id] = 'on'; changed = true }
    } else if (it.kind === 'skill' && it.name.includes(':') && (d === 'nameOnly' || d === 'off') && !mentionedInGroups(cfg, it)) {
      const bare = { kind: 'skill' as const, name: it.name.replace(/^[^:]+:/, '') }
      if (!mentionedInGroups(cfg, bare)) continue
      const next: ItemDecision = groupsOf(cfg, bare).some((g) => active.has(g)) ? 'on' : 'off'
      if (next !== d) { decisions[it.id] = next; changed = true }
    }
  }
  if (!changed) return { gate, passthrough: [...servers].sort() }
  const skills: Gate['skills'] = { on: [], nameOnly: [], off: [], preload: [] }
  const mcp: Gate['mcp'] = { on: [], off: [] }
  for (const it of items) {
    const d = decisions[it.id]
    if (d === undefined) continue
    if (it.kind === 'skill') skills[d === 'preload' ? 'preload' : d === 'nameOnly' ? 'nameOnly' : d === 'off' ? 'off' : 'on'].push(it.name)
    else if (isMcpTool(it)) mcp[d === 'off' ? 'off' : 'on'].push(it.name)
  }
  const passthrough = [...servers].sort()
  const offServers = [...new Set(mcp.off.map((n) => mcpServerOf(n) ?? n))]
  const reason = gate.reason.filter((r) => !r.startsWith('MCP поза профілем вимкнено:'))
  if (offServers.length) reason.push(`MCP поза профілем вимкнено: ${offServers.join(', ')}`)
  if (passthrough.length) reason.push(`MCP без групи в gate.json не фільтрується: ${passthrough.join(', ')}`)
  return { gate: { ...gate, items: decisions, skills, mcp, reason }, passthrough }
}

const passthroughNoticed = new WeakMap<Runtime, string>()

/** One toast per session and server set: the applied gate leaves these MCP servers alone (O1). */
async function noticePassthrough(io: Io, rt: Runtime, servers: readonly string[]): Promise<void> {
  const key = servers.join(',')
  if (!key || passthroughNoticed.get(rt) === key) return
  passthroughNoticed.set(rt, key)
  await journal(io, rt, { kind: 'debug', trigger: 'mcp-passthrough', data: { servers: [...servers] } })
  try { io.ui.toast(`context-gate: MCP без групи в gate.json не фільтруються: ${servers.join(', ')}. Щоб керувати ними профілем, додай їх у groups.`, { timeoutMs: 8000 }) } catch { /* no surface */ }
}

// ───────────────────────── signals ─────────────────────────

/** Branch from `.git/HEAD` (a worktree's `.git` file → its gitdir), host git as the fallback. */
export async function readBranch(io: Io, rt: Runtime): Promise<string | undefined> {
  const repo = await io.session.repo().catch(() => null)
  const root = repo?.root ?? rt.root
  const head = async (gitDir: string): Promise<string | undefined> => {
    const t = await io.fs.read(`${gitDir}/HEAD`).catch(() => undefined)
    if (typeof t !== 'string') return undefined
    const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(t)
    return m ? m[1].trim() : undefined
  }
  let b = await head(join(root, '.git'))
  if (b === undefined) {
    const dotgit = await io.fs.read(join(root, '.git')).catch(() => undefined)
    const m = typeof dotgit === 'string' ? /^gitdir:\s*(.+)$/m.exec(dotgit) : null
    if (m) b = await head(join(root, m[1].trim()))
  }
  return b
}

export function effectiveMode(rt: Runtime, manual: ContextGateManual): 'shadow' | 'auto' {
  if (manual.mode) return manual.mode
  if (rt.options.mode === 'auto') return 'auto'
  return rt.config?.classify?.mode === 'auto' ? 'auto' : 'shadow'
}

function autoConfig(cfg: GateConfig): GateConfig {
  return { ...cfg, classify: { minConfidence: 0.7, ...cfg.classify, mode: 'auto' } }
}

function evalWhen(expr: string, data: Record<string, unknown>): boolean {
  return truthy(evalSource(expr, data as never, newBudget()))
}

function manualSignal(m: ContextGateManual): Signals['manual'] | undefined {
  if (!hasManual(m)) return undefined
  const out: NonNullable<Signals['manual']> = { add: m.add, remove: m.remove }
  if (m.profile !== undefined) out.profile = m.profile
  if (m.off) out.off = true
  return out
}

function effectiveItems(g: ContextGateDecision | null): string {
  if (!isApplied(g)) return ''
  return Object.keys(g.items).sort().map((k) => `${k}=${g.items[k]}`).join(',')
}

/** Session env the shiftwork runner sets (`CONTEXT_GATE_PROFILE`, `CONTEXT_GATE_TICKET_TYPE`, `CONTEXT_GATE_TICKET`).
 * `$.env.get` takes literal names only, so the port reads them; a port without them yields nothing. */
type PlanEnv = { planProfile?(): Promise<string | undefined>; ticketType?(): Promise<string | undefined>; ticket?(): Promise<string | undefined> }

const planEnvs = new WeakMap<Runtime, { profile?: string; ticketType?: string; ticket?: string }>()

async function planEnv(io: Io, rt: Runtime): Promise<{ profile?: string; ticketType?: string; ticket?: string }> {
  const hit = planEnvs.get(rt)
  if (hit) return hit
  const env = io.env as Io['env'] & PlanEnv
  const get = async (f: (() => Promise<string | undefined>) | undefined): Promise<string | undefined> => {
    const v = f ? await f.call(env).catch(() => undefined) : undefined
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  const out: { profile?: string; ticketType?: string; ticket?: string } = {}
  const profile = await get(env.planProfile)
  const ticketType = await get(env.ticketType)
  const ticket = await get(env.ticket)
  if (profile) out.profile = profile
  if (ticketType) out.ticketType = ticketType
  if (ticket) out.ticket = ticket
  planEnvs.set(rt, out)
  return out
}

/** The runner's planned profile, when gate.json declares it: a manual signal for this session (not persisted). */
async function planProfile(io: Io, rt: Runtime, cfg: GateConfig): Promise<string | undefined> {
  const p = (await planEnv(io, rt)).profile
  return p && profileParts(p, cfg).every((x) => Object.prototype.hasOwnProperty.call(cfg.profiles ?? {}, x)) ? p : undefined
}

/** Data a `when.expr` reads (SPEC «Сигнали профілю»): `git.branch`, `session`, `tier` and the providers, as the
 * render scope has them. Only computed when some profile has an `expr`. */
/** Provider data of one prompt: the dry `when` decision and the recompute right after it read the same snapshot,
 * so the providers run once per prompt, not twice. */
const WHEN_DATA_TTL_MS = 3000
const whenDataMemo = new WeakMap<Runtime, { key: string; at: number; data: Record<string, unknown> }>()

async function whenData(io: Io, rt: Runtime, cfg: GateConfig, branch: string | undefined, model: string | undefined, tier: string | null): Promise<Record<string, unknown> | undefined> {
  if (!Object.values(cfg.profiles ?? {}).some((p) => p.when?.expr)) return undefined
  const key = JSON.stringify([rt.root, branch ?? '', model ?? '', tier ?? ''])
  const memo = whenDataMemo.get(rt)
  if (memo && memo.key === key && now() - memo.at < WHEN_DATA_TTL_MS) return memo.data
  const data: Record<string, unknown> = { git: { branch: branch ?? '' }, session: { model: model ?? '', root: rt.root, interactive: rt.interactive }, tier: tier ?? 'standard' }
  try {
    const trusted = (await trustState(io, rt).catch(() => 'unknown')) === 'trusted'
    // The same providers as the render scope: gate.json's plus the `<prompt dir>/lib` modules (M11, M19).
    const dir = configuredPromptDir(rt.cfg)
    const providers = await providerConfigs(io, rt, dir)
    const host = makeRenderHost(io, rt, { trusted, repoKey: await repoKey(io, rt), itemBody: async () => undefined, rules: async () => rt.rules?.list ?? [], promptDir: dir, providers })
    for (const [k, v] of Object.entries(await providerData(io, rt, host))) if (!(k in data)) data[k] = v
  } catch (err) {
    debug(io, `when.expr data: ${String((err as Error)?.message ?? err)}`)
  }
  whenDataMemo.set(rt, { key, at: now(), data })
  return data
}

/** Applied: mode auto, or a profile / off the user (or the runner's plan) fixed. `+g`/`-g` alone keep shadow (M20). */
function appliedBy(rt: Runtime, manual: ContextGateManual, plan: string | undefined): boolean {
  return effectiveMode(rt, manual) === 'auto' || manual.profile !== undefined || manual.off === true || plan !== undefined
}

export interface RecomputeOptions {
  classified?: { profile: string; confidence: number }
  recheck?: boolean
  recheckReason?: 'new' | 'compact' | 'auto'
  prevModel?: string
  /** A user turn (default: trigger `prompt`): moves `turn` and the hysteresis. Others re-derive in place (M21). */
  advance?: boolean
  /** Decide as a turn (the classifier may commit on the first prompt) but keep the stored turn: the late answer
   * of a classifier that ran past the prompt (shadow, P5). */
  keepTurn?: boolean
}

/** Recomputes run one at a time: a background classifier answer must not interleave with a prompt's. */
const recomputing = new WeakMap<Runtime, Promise<unknown>>()

/** The one place that calls decideGate. Returns the stored gate (null when layer 2 is off). */
export function recompute(io: Io, rt: Runtime, trigger: string, opts: RecomputeOptions = {}): Promise<ContextGateDecision | null> {
  const prev = recomputing.get(rt) ?? Promise.resolve()
  const run = prev.then(() => recomputeNow(io, rt, trigger, opts), () => recomputeNow(io, rt, trigger, opts))
  recomputing.set(rt, run.catch(() => undefined))
  return run
}

async function recomputeNow(io: Io, rt: Runtime, trigger: string, opts: RecomputeOptions): Promise<ContextGateDecision | null> {
  await ensureSession(io, rt)
  const cfg = rt.config
  if (!cfg) {
    // gate.json turned invalid: drop the stored decision, so nothing keeps filtering on it (M18).
    const stale = await io.read('gate')
    if (stale) {
      await io.update('gate', () => null)
      if (isApplied(stale)) {
        io.ui.invalidate('prompt.attachment')
        io.ui.invalidate('tool.describe')
      }
    }
    await refreshStatus(io, rt)
    return null
  }
  const items = await ensureItems(io, rt)
  const manual = await io.read('manual')
  const model = (await io.read('model')) ?? undefined
  const signals: Signals = { paths: await io.read('recentPaths'), model }
  const plan = await planProfile(io, rt, cfg)
  const ms = manualSignal(manual)
  if (ms) signals.manual = ms
  else if (plan) signals.manual = { profile: plan, add: [], remove: [] }
  const env = await planEnv(io, rt)
  if (env.ticketType) signals.ticketType = env.ticketType
  if (env.ticket) signals.ticketId = env.ticket
  const branch = await readBranch(io, rt)
  if (branch) signals.branch = branch
  if (opts.classified) signals.classified = opts.classified
  const data = await whenData(io, rt, cfg, branch, model, await io.read('tier'))
  if (data) signals.data = data
  const state = (await io.read('gateState')) as GateState
  const advance = opts.advance ?? trigger === 'prompt'
  // G-01: the harness's context window infers the tier of a model no `models` entry names (M22).
  const cw = model ? await io.session.usage().then((u) => u.context.window, () => undefined) : undefined
  const res = decideGate(autoConfig(cfg), signals, state, items, {
    recheck: opts.recheck, recheckReason: opts.recheckReason, prevModel: opts.prevModel, evalExpr: evalWhen, now: now(),
    advance, nocase: rt.windows, ...(cw ? { modelAttrs: { contextWindow: cw } } : {}),
  })
  const refined = refineGate(cfg, items, res.gate)
  const applied = appliedBy(rt, manual, plan)
  let gate: ContextGateDecision = refined.gate
  const log = { ...res.log, kind: 'decision', data: { ...(res.log.data ?? {}), source: trigger } as Record<string, unknown> }
  if (opts.keepTurn) log.turn = state.turn
  if (refined.passthrough.length) log.data = { ...log.data, passthrough: refined.passthrough }
  if (!applied) {
    const proposedProfile = res.gate.profile ?? opts.classified?.profile
    const confidence = res.gate.trigger === 'classify' || !res.gate.profile ? (opts.classified?.confidence ?? 0) : 1
    const { profile: _drop, ...rest } = refined.gate
    gate = { ...rest, shadow: true, reason: [...refined.gate.reason, 'shadow: рішення лише в журнал, нічого не фільтрується (/gate apply)'] }
    if (proposedProfile) gate.proposed = { profile: proposedProfile, confidence }
    delete log.profile
    log.data = { ...log.data, shadow: true, ...(gate.proposed ? { proposed: gate.proposed } : {}) }
  }
  log.reason = gate.reason
  const prev = await io.read('gate')
  const nextState: GateState = opts.keepTurn ? { ...res.state, turn: state.turn } : res.state
  await io.update('gate', () => json(gate))
  await io.update('gateState', () => json(nextState))
  await io.update('tier', () => res.gate.tier)
  await pushEntry(io, rt, json(log))
  if (effectiveItems(prev) !== effectiveItems(gate)) {
    io.ui.invalidate('prompt.attachment')
    io.ui.invalidate('tool.describe')
  }
  // Always rules ride prompt.context, computed once per conversation: re-read it only when the gate turns one of
  // them on or off, which costs the cached first message (M12).
  if (alwaysOff(rt, prev) !== alwaysOff(rt, gate)) io.ui.invalidate('prompt.context')
  if (applied) await noticePassthrough(io, rt, refined.passthrough)
  await refreshStatus(io, rt)
  return gate
}

/** Always rules the gate switches off, as a comparable key. */
function alwaysOff(rt: Runtime, g: ContextGateDecision | null): string {
  if (!isApplied(g)) return ''
  return (rt.rules?.list ?? []).filter((r) => r.type === 'always' && g.items[`rule:${r.id}`] === 'off').map((r) => r.id).sort().join(',')
}

/** Re-derive per-item decisions for the current profile after the item set grew (no hysteresis step, no log). */
async function materialize(io: Io, rt: Runtime): Promise<void> {
  const gate = await io.read('gate')
  if (!gate || !rt.config || gate.off) return
  const items = await ensureItems(io, rt)
  const manual = await io.read('manual')
  const profile = gate.profile ?? (gate.shadow ? gate.proposed?.profile : undefined)
  const signals: Signals = { paths: [], model: (await io.read('model')) ?? undefined }
  if (profile || manual.add.length || manual.remove.length) signals.manual = { add: manual.add, remove: manual.remove, ...(profile ? { profile } : {}) }
  // The stored tier stands (it may come from the context window, G-01), not the model id's fallback.
  const res = decideGate(autoConfig(rt.config), signals, { turn: 0 }, items, { tier: gate.tier, nocase: rt.windows })
  const d = refineGate(rt.config, items, res.gate).gate
  const next: ContextGateDecision = { ...gate, items: d.items, skills: d.skills, mcp: d.mcp, agents: d.agents, rules: d.rules }
  await io.update('gate', () => json(next))
}

// ───────────────────────── classifier, brief ─────────────────────────

export { parseClassify }

/** A `{ kind: 'cli' }` classify/brief provider: trusted repo + whitelisted binary, JSON on stdin (G-02). */
async function runProvider(io: Io, rt: Runtime, what: string, p: { command: string[]; timeout?: string }, stdin: string, defaultMs: number): Promise<string | undefined> {
  if (!p.command.length) return undefined
  if ((await trustState(io, rt).catch(() => 'unknown')) !== 'trusted') {
    debug(io, `${what} provider ${p.command[0]}: репозиторій не довірений — пропущено`)
    return undefined
  }
  if (!(await allowedBinary(io, rt, p.command))) {
    debug(io, `${what} provider ${p.command[0]}: бінарник поза білим списком (G201)`)
    return undefined
  }
  const r = await runArgv(io, rt, p.command, { stdin, timeoutMs: parseDuration(p.timeout) ?? defaultMs })
  if (r.exitCode !== 0) {
    debug(io, `${what} provider ${p.command[0]}: exit ${r.exitCode} (G203) ${r.stderr.slice(0, 200)}`)
    await journal(io, rt, { kind: 'debug', trigger: `${what}-provider`, data: { code: 'G203', exitCode: r.exitCode, command: p.command[0] } })
    return undefined
  }
  return r.stdout
}

function classifySystem(cfg: GateConfig): string {
  const lines = Object.entries(cfg.profiles).map(([name, p]) => `- ${name}${p.groups?.length ? ` (групи: ${p.groups.join(', ')})` : ''}`)
  return [
    'Ти класифікатор задач для розробника. Обери один профіль задачі з переліку:',
    ...lines,
    'Відповідай лише одним рядком JSON без пояснень: {"profile": "<назва з переліку>", "confidence": <число від 0 до 1>}.',
  ].join('\n')
}

const CLASSIFY_MS = 8000
/** How long a shadow-mode prompt waits for the classifier or the brief before it goes on without them (P5). */
export const SHADOW_GRACE_MS = 1500

/** A promise and whether it settled, for a wait that may give up before it does. */
interface Tracked<T> { done: boolean; value?: T; promise: Promise<T | undefined> }

function track<T>(p: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { done: false, promise: Promise.resolve(undefined) }
  t.promise = p.then((v) => { t.done = true; t.value = v; return v }, () => { t.done = true; return undefined })
  return t
}

/** `p`, or undefined once `ms` passed on the session clock. A clock that fires early (a test kit) or no clock at
 * all leaves `p` to decide. */
function within<T>(io: Io, p: Promise<T>, ms: number): Promise<T | undefined> {
  const started = now()
  return new Promise((resolve) => {
    let done = false
    const finish = (v: T | undefined): void => { if (!done) { done = true; resolve(v) } }
    p.then(finish, () => finish(undefined))
    try { io.clock.after(ms, () => { if (now() - started >= ms - 50) finish(undefined) }) } catch { /* no clock: wait for p */ }
  })
}

/** What a classifier or brief call cost (P5): `report` and `/gate why` count `data.usage` per tier. */
async function journalModelCall(io: Io, rt: Runtime, what: 'classify' | 'brief', model: string, r: unknown, ms: number): Promise<void> {
  const v = r && typeof r === 'object' ? (r as { isAnswered?: unknown; usage?: unknown }) : undefined
  await journal(io, rt, { kind: 'model-call', trigger: what, tier: (await io.read('tier')) ?? '', data: { model, ms, answered: v?.isAnswered === true, ...(v?.usage && typeof v.usage === 'object' ? { usage: v.usage as Record<string, unknown> } : {}) } })
}

/** Classifier (G-02 `classify.provider`): `builtin` (default) asks `io.model.complete` for JSON, falling back
 * to `io.model.classify` (label only → below minConfidence, never auto-applies); `jev` is the engine's label
 * classifier on its own (the user chose it, so its label counts as minConfidence); `{ kind: 'cli' }` runs the
 * command with `classifyRequest` JSON on stdin and reads `{ profile, confidence }` (trusted repos only).
 * Every engine call is bounded by 8 s and journaled with its usage. */
export async function classify(io: Io, rt: Runtime, text: string, paths: string[]): Promise<{ profile: string; confidence: number } | undefined> {
  const cfg = rt.config
  if (!cfg) return undefined
  const profiles = Object.keys(cfg.profiles)
  if (!profiles.length) return undefined
  const prompt = `${text.slice(0, 4000)}${paths.length ? `\n\nФайли: ${paths.slice(-20).join(', ')}` : ''}`
  const model = cfg.classify?.model ?? 'haiku'
  const provider = cfg.classify?.provider ?? 'builtin'
  const minConf = cfg.classify?.minConfidence ?? 0.7
  if (typeof provider === 'object') {
    const out = await runProvider(io, rt, 'classify', provider, classifyRequest(cfg, text, paths, (await io.read('model')) ?? undefined), CLASSIFY_MS)
    return out === undefined ? undefined : parseClassify(out, profiles)
  }
  const label = async (): Promise<string | undefined> => {
    const t0 = now()
    const l = await within(io, io.model.classify(prompt, profiles, { model }), CLASSIFY_MS)
    await journalModelCall(io, rt, 'classify', model, undefined, now() - t0)
    return l ?? undefined
  }
  if (provider === 'jev') {
    try {
      const l = await label()
      return l && profiles.includes(l) ? { profile: l, confidence: minConf } : undefined
    } catch (err) {
      debug(io, `jev classifier failed: ${String((err as Error)?.message ?? err)}`)
      return undefined
    }
  }
  try {
    const t0 = now()
    const r = await io.model.complete({ model, system: classifySystem(cfg), prompt, maxTokens: 64, timeoutMs: CLASSIFY_MS })
    await journalModelCall(io, rt, 'classify', model, r, now() - t0)
    if (r.isAnswered) {
      const parsed = parseClassify(r.text, profiles)
      if (parsed) return parsed
    }
  } catch (err) {
    debug(io, `classifier complete failed: ${String((err as Error)?.message ?? err)}`)
  }
  try {
    const l = await label()
    if (l && profiles.includes(l)) return { profile: l, confidence: Math.max(0, minConf - 0.01) }
  } catch (err) {
    debug(io, `classifier fallback failed: ${String((err as Error)?.message ?? err)}`)
  }
  return undefined
}

const BRIEF_SYSTEM = [
  'Ти досвідчений інженер. Напиши бриф задачі для слабшої моделі, яка її виконуватиме.',
  'Розділи Markdown: Мета; Обмеження; Релевантні файли; Кроки; Критерії прийняття; Відомі пастки.',
  'Стисло й конкретно, без вступу.',
].join('\n')

/** Task brief on a strong model for non-premium tiers, cached in state by text hash. `brief.provider`
 * `{ kind: 'cli' }` (G-02) writes it with an external command instead (`briefRequest` JSON on stdin). */
async function brief(io: Io, rt: Runtime, text: string, tier: string): Promise<string | undefined> {
  const b = rt.config?.brief
  const enabled = b?.enabled === true || rt.options.brief
  if (!enabled || tier === 'premium') return undefined
  const tiers = b?.tiers ?? ['quick', 'standard']
  if (!tiers.includes(tier)) return undefined
  const key = hash(text)
  const cached = await io.read('brief')
  if (cached?.key === key) return cached.text
  const maxChars = b?.maxChars ?? 2000
  if (b?.provider && typeof b.provider === 'object') {
    const stdout = await runProvider(io, rt, 'brief', b.provider, briefRequest(text, tier, maxChars, await io.read('recentPaths'), (await io.read('model')) ?? undefined), 60_000)
    const out = stdout === undefined ? undefined : parseBrief(stdout, maxChars)
    if (!out) return undefined
    await io.update('brief', () => ({ key, text: out, at: now() }))
    await journal(io, rt, { kind: 'debug', trigger: 'brief', tier, data: { chars: out.length, provider: 'cli' } })
    return out
  }
  try {
    const model = b?.model ?? 'opus'
    const t0 = now()
    const r = await io.model.complete({ model, system: BRIEF_SYSTEM, prompt: text.slice(0, 8000), maxTokens: Math.ceil(maxChars / 2), timeoutMs: 30000 })
    await journalModelCall(io, rt, 'brief', model, r, now() - t0)
    if (!r.isAnswered) return undefined
    const out = r.text.trim().slice(0, maxChars)
    await io.update('brief', () => ({ key, text: out, at: now() }))
    await journal(io, rt, { kind: 'debug', trigger: 'brief', tier, data: { chars: out.length } })
    return out
  } catch (err) {
    debug(io, `brief failed: ${String((err as Error)?.message ?? err)}`)
    return undefined
  }
}

function briefBlock(rt: Runtime, text: string): string {
  return `Бриф задачі (context-gate, ${rt.config?.brief?.model ?? 'opus'}):\n${text}`
}

// ───────────────────────── escalation ─────────────────────────

function modelHint(cfg: GateConfig, tier: string): string {
  const glob = modelForTier(cfg, tier)
  return glob ? glob.replace(/\*/g, '').replace(/^-+|-+$/g, '').replace(/^claude-/, '') : tier
}

/** escalation-suggested once per tier and task when verifyFailed / stallTurns cross `escalation.after`. */
export async function checkEscalation(io: Io, rt: Runtime): Promise<void> {
  const esc = rt.config?.escalation
  if (!esc) return
  const tier = (await io.read('tier')) ?? 'standard'
  const i = esc.order.indexOf(tier)
  if (i < 0 || i >= esc.order.length - 1 || rt.escalated.has(tier)) return
  const vf = esc.after.verifyFailed
  const st = esc.after.stallTurns
  let why: string | undefined
  if (vf !== undefined && rt.verifyFailed >= vf) why = `${rt.verifyFailed} невдалі перевірки на ${tier}`
  else if (st !== undefined && rt.stallTurns >= st) why = `${rt.stallTurns} ходів без змін на ${tier}`
  if (!why) return
  rt.escalated.add(tier)
  const next = esc.order[i + 1]
  const text = `${why} — перейди на ${next}: /model ${modelHint(rt.config!, next)}`
  await journal(io, rt, { kind: 'escalation-suggested', trigger: 'escalation', tier, data: { to: next, verifyFailed: rt.verifyFailed, stallTurns: rt.stallTurns } })
  try { io.ui.toast(`context-gate: ${text}`, { timeoutMs: 10000 }) } catch { /* no surface */ }
}

function resetTask(rt: Runtime): void {
  rt.verifyFailed = 0
  rt.stallTurns = 0
  rt.escalated.clear()
}

// ───────────────────────── hooks ─────────────────────────

function asGate(g: ContextGateDecision): Gate {
  return g as unknown as Gate
}

export function skillOff(gate: ContextGateDecision | null, name: string): boolean {
  if (!isApplied(gate)) return false
  const d = gate.items[`skill:${name}`] ?? gate.items[`skill:${name.replace(/^[^:]+:/, '')}`]
  return d === 'off'
}

export async function skillOffMessage(io: Io, rt: Runtime, name: string, agentId?: string): Promise<string | undefined> {
  const gate = await gateFor(io, rt, agentId)
  if (!rt.config || !skillOff(gate, name)) return undefined
  return skillOffText(name, asGate(gate!), rt.config)
}

/** Layer 3's per-prompt block (`prompt.volatile: "context"`, P1). Set by dsl.ts, which imports this module (a
 * direct import back would make the two modules a cycle). */
let promptContextSource: ((io: Io, rt: Runtime) => Promise<string | undefined>) | undefined

export function setPromptContextSource(fn: (io: Io, rt: Runtime) => Promise<string | undefined>): void {
  promptContextSource = fn
}

async function layer3Context(io: Io, rt: Runtime): Promise<string[]> {
  const t = await promptContextSource?.(io, rt).catch(() => undefined)
  return t ? [t] : []
}

/** A brief that ran past a shadow-mode prompt: injected into the next prompt once it is ready (P5). */
const lateBriefs = new WeakMap<Runtime, Tracked<string | undefined>>()

/**
 * `[gate:off]`, `[gate:auto]`, `[gate:new]` are the `/gate` commands, as in the other adapters (M23); any other
 * word is a profile, applied only when gate.json declares it (an unknown one is G502, ignored). Returns a notice.
 */
async function applyPromptFlag(io: Io, rt: Runtime, word: string): Promise<string | undefined> {
  if (word === 'off') {
    await io.update('manual', (m) => json({ ...m, off: true }))
    return undefined
  }
  if (word === 'auto') {
    await io.update('manual', (m) => json({ add: [], remove: [], ...(m.mode ? { mode: m.mode } : {}), recheck: true }))
    rt.recheckReason = 'auto'
    return undefined
  }
  if (word === 'new') {
    await io.update('manual', (m) => json({ ...m, recheck: true }))
    rt.recheckReason = 'new'
    return undefined
  }
  const cfg = rt.config
  if (!cfg) return undefined
  const declared = (x: string): boolean => Object.prototype.hasOwnProperty.call(cfg.profiles ?? {}, x)
  if (!profileParts(word, cfg).every(declared)) {
    const known = Object.keys(cfg.profiles ?? {}).join(', ') || '—'
    await journal(io, rt, { kind: 'debug', trigger: 'prompt-flag', data: { code: 'G502', profile: word } })
    return `G502 [gate:${word}]: профіль не оголошено в gate.json, прапорець проігноровано. Відомі: ${known}`
  }
  await io.update('manual', (m) => json({ ...m, profile: word, off: undefined }))
  return undefined
}

/** prompt.submit for layers 1 and 2: `[gate:x]` flag, `@` mentions, signals, classifier, brief.
 * Context is attached on the way down by the caller. A new task (the first prompt, `/gate new`, `[gate:new]`)
 * resets the escalation counters and gets the brief; a compaction only re-derives the profile (M24). In shadow
 * mode the classifier and the brief wait at most SHADOW_GRACE_MS: a late classifier answer lands as its own
 * decision, a late brief rides the next prompt (P5). */
export async function gatePromptSubmit(io: Io, rt: Runtime, input: { text: string }): Promise<{ text: string; context: string[]; mentioned: string[] }> {
  await ensureSession(io, rt)
  let text = input.text
  const flag = extractPromptFlag(text)
  if (flag.profile) {
    text = flag.text
    const notice = await applyPromptFlag(io, rt, flag.profile)
    if (notice) try { io.ui.toast(`context-gate: ${notice}`, { timeoutMs: 8000 }) } catch { /* no surface */ }
  }
  const context: string[] = []
  const mentioned: string[] = []
  if (text.trimStart().startsWith('/')) return { text, context, mentioned }
  const mentions = extractMentions(text)
  mentioned.push(...mentions.files.map((f) => relPath(rt, f)))
  context.push(...(await rulesForPrompt(io, rt, mentions.files, mentions.rules)))
  if (!rt.config) return { text, context: [...context, ...(await layer3Context(io, rt))], mentioned }
  const gs = await io.read('gateState')
  const manual = await io.read('manual')
  const why = manual.recheck === true ? (rt.recheckReason ?? 'new') : undefined
  const newTask = gs.turn === 0 || (why !== undefined && why !== 'compact')
  const reclassify = gs.turn === 0 || why !== undefined
  const late = lateBriefs.get(rt)
  if (late && (late.done || newTask)) {
    lateBriefs.delete(rt)
    if (!newTask && late.value) context.push(briefBlock(rt, late.value))
  }
  const plan = await planProfile(io, rt, rt.config)
  const shadow = !appliedBy(rt, manual, plan)
  let classified: RecomputeOptions['classified']
  let lateClassify: Tracked<RecomputeOptions['classified']> | undefined
  if (newTask) resetTask(rt)
  if (reclassify && !manual.profile && !manual.off && !plan && Object.keys(rt.config.profiles).length) {
    // A deterministic `when` match decides without the classifier.
    const items = await ensureItems(io, rt)
    const model = (await io.read('model')) ?? undefined
    const branch = await readBranch(io, rt)
    const signals: Signals = { paths: await io.read('recentPaths'), model, branch }
    const env = await planEnv(io, rt)
    if (env.ticketType) signals.ticketType = env.ticketType
    const data = await whenData(io, rt, rt.config, branch, model, await io.read('tier'))
    if (data) signals.data = data
    const dry = decideGate(autoConfig(rt.config), signals, gs as GateState, items, { evalExpr: evalWhen, recheck: manual.recheck, nocase: rt.windows })
    if (!dry.gate.trigger.startsWith('when:')) {
      const call = classify(io, rt, text, await io.read('recentPaths'))
      if (!shadow) classified = await call
      else {
        const t = track(call)
        await within(io, t.promise, SHADOW_GRACE_MS)
        if (t.done) classified = t.value
        else lateClassify = t
      }
    }
  }
  const recheck = manual.recheck === true && gs.turn > 0
  const gate = await recompute(io, rt, 'prompt', { classified, recheck, recheckReason: recheck ? why : undefined })
  if (manual.recheck) {
    await io.update('manual', (m) => json({ ...m, recheck: undefined }))
    rt.recheckReason = undefined
  }
  if (lateClassify) {
    // The answer lands as its own decision of this turn (the proposal, or the profile of a fresh task). Decided as
    // that turn (advance) only while it is still the current one: after a later prompt it would count one more
    // hysteresis turn for a pending `when` candidate (M21), and that prompt already decided without it.
    const turnAt = ((await io.read('gateState')) as GateState).turn
    void lateClassify.promise.then(async (c) => {
      if (!c) return null
      if (((await io.read('gateState')) as GateState).turn !== turnAt) {
        debug(io, 'late classifier: відповідь прийшла після наступного промпту — відкинуто')
        return null
      }
      return recompute(io, rt, 'classify', { classified: c, advance: true, keepTurn: true })
    })
      .catch((err: unknown) => debug(io, `late classifier: ${String((err as Error)?.message ?? err)}`))
  }
  if (newTask && gate) {
    const call = brief(io, rt, text, gate.tier)
    let b: string | undefined
    if (!gate.shadow) b = await call
    else {
      const t = track(call)
      await within(io, t.promise, SHADOW_GRACE_MS)
      if (t.done) b = t.value
      else lateBriefs.set(rt, t)
    }
    if (b) context.push(briefBlock(rt, b))
  }
  context.push(...(await layer3Context(io, rt)))
  return { text, context, mentioned }
}

/** MCP tool outside the applied profile → the deny text (counted for H010). */
export async function mcpGate(io: Io, rt: Runtime, tool: string, agentId?: string): Promise<string | undefined> {
  await ensureSession(io, rt)
  const gate = await gateFor(io, rt, agentId)
  if (!rt.config || !isApplied(gate) || gate.items[`tool:${tool}`] !== 'off') return undefined
  rt.denies[tool] = (rt.denies[tool] ?? 0) + 1
  await journal(io, rt, { kind: 'deny', trigger: 'mcp', tier: gate.tier, data: { tool, count: rt.denies[tool], ...(agentId !== undefined ? { agent: agentId } : {}) } })
  return denyText('tool', tool, asGate(gate), rt.config)
}

/** prompt.attachment {skill_listing}, after `next`: capture the listing (item source), rewrite it for the applied gate. */
export async function listingAfter(io: Io, rt: Runtime, agentId: string | undefined, text: string | null): Promise<string | null> {
  await ensureSession(io, rt)
  if (text === null) return null
  const listing = parseSkillListing(text)
  const names = listing.lines.filter((l) => l.type === 'skill').map((l) => (l as { name: string }).name)
  if (agentId === undefined) {
    rt.listingText = text
    const key = names.slice().sort().join(',')
    if (key !== rt.listingNames) {
      rt.listingNames = key
      rt.itemsDirty = true
      await materialize(io, rt)
    }
  }
  const gate = await gateFor(io, rt, agentId)
  if (!isApplied(gate)) return text
  if (!names.length) {
    if (!rt.unknownListingLogged) {
      rt.unknownListingLogged = true
      await journal(io, rt, { kind: 'health', trigger: 'H009', data: { note: 'формат skill_listing не розпізнано' } })
    }
    return text
  }
  return renderSkillListing(listing, gate.items as Record<string, ItemDecision>)
}

/** tool.describe for an MCP tool: one line «вимкнено профілем …» and deferred when gated off. */
export async function describeMcp(io: Io, rt: Runtime, tool: string): Promise<{ description: string; isDeferred: true } | undefined> {
  if (tool.startsWith(OWN_TOOL_PREFIX)) return undefined
  await ensureSession(io, rt)
  if (rt.mcpTools && !rt.mcpTools.includes(tool)) {
    rt.mcpTools.push(tool)
    rt.itemsDirty = true
  }
  const gate = await io.read('gate')
  if (rt.config && isApplied(gate) && gate.items[`tool:${tool}`] === 'off') return { description: denyText('tool', tool, asGate(gate), rt.config), isDeferred: true }
  return undefined
}

// ───────────────────────── skill invocations (tool.call Skill / typed `/name` → skill.prompt) ─────────────────────────

/** One expansion the engine is about to ask `skill.prompt` for: the model's Skill call the gate let through (and
 * for which agent), or a `/name` the user typed. `skill.prompt` carries neither the agent nor the call, so the
 * entries queue per skill and the oldest (or the one whose args the text names) is taken (M06, M07, M13). */
export interface SkillInvocation { args: string; agentId?: string; user: boolean; at: number }

const SKILL_QUEUE_MAX = 8
const SKILL_QUEUE_TTL_MS = 10 * 60_000
const USER_INVOCATION_TTL_MS = 60_000
const skillQueues = new WeakMap<Runtime, Map<string, SkillInvocation[]>>()

const bareSkill = (name: string): string => name.replace(/^[^:]+:/, '')

function skillQueue(rt: Runtime, skill: string): SkillInvocation[] {
  let m = skillQueues.get(rt)
  if (!m) { m = new Map(); skillQueues.set(rt, m) }
  const key = bareSkill(skill)
  const t = now()
  // A call the engine refused after us never reaches skill.prompt: old entries age out. A typed `/name` expands
  // right away, so its entry lives a minute: a stale one must not exempt a later unannounced expansion (M13).
  const q = (m.get(key) ?? []).filter((x) => t - x.at < (x.user ? USER_INVOCATION_TTL_MS : SKILL_QUEUE_TTL_MS))
  m.set(key, q)
  return q
}

export function noteSkillInvocation(rt: Runtime, skill: string, inv: { args: string; agentId?: string; user: boolean }): void {
  const q = skillQueue(rt, skill)
  q.push({ ...inv, at: now() })
  if (q.length > SKILL_QUEUE_MAX) q.splice(0, q.length - SKILL_QUEUE_MAX)
}

/** The invocation a `skill.prompt` expands: the one whose args equal the text's `--args`, else the oldest. */
export function takeSkillInvocation(rt: Runtime, skill: string, textArgs?: string): SkillInvocation | undefined {
  const q = skillQueue(rt, skill)
  if (!q.length) return undefined
  const i = textArgs !== undefined ? q.findIndex((x) => x.args === textArgs) : -1
  return q.splice(i < 0 ? 0 : i, 1)[0]
}

/** tool.call Skill: a gated-off skill is denied before it loads (for the calling agent's gate, G-08); an allowed
 * call is remembered with its args and agent for skill.prompt. */
export async function skillCall(io: Io, rt: Runtime, skill: string, args: string | undefined, agentId?: string): Promise<string | undefined> {
  await ensureSession(io, rt)
  const off = await skillOffMessage(io, rt, skill, agentId)
  if (off) {
    await journal(io, rt, { kind: 'deny', trigger: 'skill', data: { skill, ...(agentId !== undefined ? { agent: agentId } : {}) } })
    return off
  }
  noteSkillInvocation(rt, skill, { args: args ?? '', user: false, ...(agentId !== undefined ? { agentId } : {}) })
  return undefined
}

/** agent.offer: false for agent types outside the applied profile. */
export async function offerAgent(io: Io, rt: Runtime, agent: string): Promise<boolean> {
  await ensureSession(io, rt)
  if (!rt.config) return true
  if (!rt.agentNames.has(agent)) {
    rt.agentNames.add(agent)
    rt.itemsDirty = true
    await materialize(io, rt)
  }
  const gate = await io.read('gate')
  return !(isApplied(gate) && (gate.agents.off.includes(agent) || gate.items[`agent:${agent}`] === 'off'))
}

const AGENT_TIERS_MAX = 64

/** turn.step observer: main-loop model change → tier + recompute; subagent → its own tier. */
export async function observeStep(io: Io, rt: Runtime, model: string, agentId: string | undefined): Promise<void> {
  try {
    await ensureSession(io, rt)
    if (!rt.config || !model) return
    if (agentId === undefined) {
      const prev = await io.read('model')
      if (model !== prev) {
        await io.update('model', () => model)
        const cw = await io.session.usage().then((u) => u.context.window, () => undefined)
        await io.update('tier', () => modelTier(rt, model, cw))
        if (prev) await recompute(io, rt, 'model-change', { prevModel: prev })
      }
    } else {
      const tiers = await io.read('agentTiers')
      if (!(agentId in tiers)) {
        const t = modelTier(rt, model)
        // Subagent ids are ephemeral: keep the most recent ones only (L04).
        await io.update('agentTiers', (m) => json(Object.fromEntries([...Object.entries(m), [agentId, t]].slice(-AGENT_TIERS_MAX))))
      }
    }
  } catch (err) {
    debug(io, `turn.step: ${String((err as Error)?.message ?? err)}`)
  }
}
