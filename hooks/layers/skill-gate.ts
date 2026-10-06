// Layer 2: skill-gate (SPEC "Шар 2", MOD-ADAPTER "Layer 2"). Signals → decideGate (pure, core) → application.
// Shadow mode (default): the gate is computed and journaled but NOT applied: nothing is filtered and the
// band shows `gate (frontend?) …`. `/gate apply` (mode auto) applies it; manual `/gate <p>` / `+g` / `-g`
// / `off` apply regardless of the mode. Application points: skill listing rewrite, skill.prompt off text
// (dsl.ts), tool.describe + tool.call deny for MCP, agent.offer, preload section (dsl.ts).


import type { Gate, GateConfig, GateState, Item, ItemDecision, Signals } from '../../packages/core/src/types.ts'
import { decideGate, denyText, skillOffText } from '../../packages/core/src/decide.ts'
import { tierForModel } from '../../packages/core/src/config.ts'
import { extractMentions, extractPromptFlag } from '../../packages/core/src/gatecmd.ts'
import { makeItem, normalizeItems, parseSkillListing, renderSkillListing, skillListingItems } from '../../packages/core/src/items.ts'
import { ruleToItem } from '../../packages/core/src/mdc.ts'
import { evalSource, newBudget, truthy } from '../../packages/core/src/expr.ts'
import type { ContextGateDecision, ContextGateManual } from '../../types'
import { hasManual, isApplied, json } from '../state.ts'
import { type Io, OWN_TOOL_PREFIX, type Runtime, debug, hash, join, now } from '../ctx.ts'
import { ensureSession } from './config.ts'
import { ensureRules, relPath, rulesForPrompt } from './cursor-rules.ts'
import { journal, pushEntry } from './journal.ts'
import { refreshStatus } from './ui.ts'

// ───────────────────────── items ─────────────────────────

export async function ensureItems(io: Io, rt: Runtime): Promise<Item[]> {
  await ensureSession(io, rt)
  const rules = await ensureRules(io, rt)
  if (rt.items && !rt.itemsDirty) return rt.items
  const items: Item[] = []
  if (rt.listingText) items.push(...skillListingItems(parseSkillListing(rt.listingText)))
  if (rt.mcpTools === undefined) {
    const list = await io.tool.list().catch(() => [])
    rt.mcpTools = list.filter((t) => t.mcp && !t.name.startsWith(OWN_TOOL_PREFIX)).map((t) => t.name)
  }
  for (const name of rt.mcpTools) items.push(makeItem('tool', name, { provenance: { source: 'claude-tools' } }))
  for (const name of rt.agentNames) items.push(makeItem('agent', name, { provenance: { source: 'claude-agents' } }))
  for (const r of rules) items.push(ruleToItem(r))
  rt.items = normalizeItems(items)
  rt.itemsDirty = false
  return rt.items
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

export interface RecomputeOptions {
  classified?: { profile: string; confidence: number }
  recheck?: boolean
  recheckReason?: 'new' | 'compact' | 'auto'
  prevModel?: string
}

/** The one place that calls decideGate. Returns the stored gate (null when layer 2 is off). */
export async function recompute(io: Io, rt: Runtime, trigger: string, opts: RecomputeOptions = {}): Promise<ContextGateDecision | null> {
  await ensureSession(io, rt)
  const cfg = rt.config
  if (!cfg) return null
  const items = await ensureItems(io, rt)
  const manual = await io.read('manual')
  const model = (await io.read('model')) ?? undefined
  const signals: Signals = { paths: await io.read('recentPaths'), model }
  const ms = manualSignal(manual)
  if (ms) signals.manual = ms
  const branch = await readBranch(io, rt)
  if (branch) signals.branch = branch
  if (opts.classified) signals.classified = opts.classified
  const state = (await io.read('gateState')) as GateState
  const res = decideGate(autoConfig(cfg), signals, state, items, {
    recheck: opts.recheck, recheckReason: opts.recheckReason, prevModel: opts.prevModel, evalExpr: evalWhen, now: now(),
  })
  const applied = hasManual(manual) || effectiveMode(rt, manual) === 'auto'
  let gate: ContextGateDecision = res.gate
  const log = { ...res.log, kind: 'decision', data: { ...(res.log.data ?? {}), source: trigger } as Record<string, unknown> }
  if (!applied) {
    const proposedProfile = res.gate.profile ?? opts.classified?.profile
    const confidence = res.gate.trigger === 'classify' || !res.gate.profile ? (opts.classified?.confidence ?? 0) : 1
    const { profile: _drop, ...rest } = res.gate
    gate = { ...rest, shadow: true, reason: [...res.gate.reason, 'shadow: рішення лише в журнал, нічого не фільтрується (/gate apply)'] }
    if (proposedProfile) gate.proposed = { profile: proposedProfile, confidence }
    delete log.profile
    log.reason = gate.reason
    log.data = { ...log.data, shadow: true, ...(gate.proposed ? { proposed: gate.proposed } : {}) }
  }
  const prev = await io.read('gate')
  await io.update('gate', () => json(gate))
  await io.update('gateState', () => json(res.state))
  await io.update('tier', () => res.gate.tier)
  await pushEntry(io, rt, json(log))
  if (effectiveItems(prev) !== effectiveItems(gate)) {
    io.ui.invalidate('prompt.attachment')
    io.ui.invalidate('tool.describe')
  }
  await refreshStatus(io, rt)
  return gate
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
  const res = decideGate(autoConfig(rt.config), signals, { turn: 0 }, items, {})
  const next: ContextGateDecision = { ...gate, items: res.gate.items, skills: res.gate.skills, mcp: res.gate.mcp, agents: res.gate.agents, rules: res.gate.rules }
  await io.update('gate', () => json(next))
}

// ───────────────────────── classifier, brief ─────────────────────────

export function parseClassify(text: string, profiles: readonly string[]): { profile: string; confidence: number } | undefined {
  const m = /\{[\s\S]*?\}/.exec(text)
  if (!m) return undefined
  try {
    const v = JSON.parse(m[0]) as { profile?: unknown; confidence?: unknown }
    if (typeof v.profile !== 'string' || !profiles.includes(v.profile)) return undefined
    const c = typeof v.confidence === 'number' ? v.confidence : Number(v.confidence)
    return { profile: v.profile, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0 }
  } catch {
    return undefined
  }
}

function classifySystem(cfg: GateConfig): string {
  const lines = Object.entries(cfg.profiles).map(([name, p]) => `- ${name}${p.groups?.length ? ` (групи: ${p.groups.join(', ')})` : ''}`)
  return [
    'Ти класифікатор задач для розробника. Обери один профіль задачі з переліку:',
    ...lines,
    'Відповідай лише одним рядком JSON без пояснень: {"profile": "<назва з переліку>", "confidence": <число від 0 до 1>}.',
  ].join('\n')
}

/** Classifier: `io.model.complete` asking JSON; fallback `io.model.classify` (label only → below minConfidence, never auto-applies). */
export async function classify(io: Io, rt: Runtime, text: string, paths: string[]): Promise<{ profile: string; confidence: number } | undefined> {
  const cfg = rt.config
  if (!cfg) return undefined
  const profiles = Object.keys(cfg.profiles)
  if (!profiles.length) return undefined
  const prompt = `${text.slice(0, 4000)}${paths.length ? `\n\nФайли: ${paths.slice(-20).join(', ')}` : ''}`
  const model = cfg.classify?.model ?? 'haiku'
  try {
    const r = await io.model.complete({ model, system: classifySystem(cfg), prompt, maxTokens: 64, timeoutMs: 8000 })
    if (r.isAnswered) {
      const parsed = parseClassify(r.text, profiles)
      if (parsed) return parsed
    }
  } catch (err) {
    debug(io, `classifier complete failed: ${String((err as Error)?.message ?? err)}`)
  }
  try {
    const label = await io.model.classify(prompt, profiles, { model })
    if (label && profiles.includes(label)) return { profile: label, confidence: Math.max(0, (cfg.classify?.minConfidence ?? 0.7) - 0.01) }
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

/** Task brief on a strong model for non-premium tiers, cached in state by text hash. */
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
  try {
    const r = await io.model.complete({ model: b?.model ?? 'opus', system: BRIEF_SYSTEM, prompt: text.slice(0, 8000), maxTokens: Math.ceil(maxChars / 2), timeoutMs: 30000 })
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

// ───────────────────────── escalation ─────────────────────────

function modelHint(cfg: GateConfig, tier: string): string {
  const glob = Object.entries(cfg.models).find(([, t]) => t === tier)?.[0]
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

export async function skillOffMessage(io: Io, rt: Runtime, name: string): Promise<string | undefined> {
  const gate = await io.read('gate')
  if (!rt.config || !skillOff(gate, name)) return undefined
  return skillOffText(name, asGate(gate!), rt.config)
}

/** prompt.submit for layers 1 and 2: `[gate:x]` flag, `@` mentions, signals, classifier, brief.
 * Context is attached on the way down by the caller. */
export async function gatePromptSubmit(io: Io, rt: Runtime, input: { text: string }): Promise<{ text: string; context: string[]; mentioned: string[] }> {
  await ensureSession(io, rt)
  let text = input.text
  const flag = extractPromptFlag(text)
  if (flag.profile) {
    text = flag.text
    await io.update('manual', (m) => json({ ...m, profile: flag.profile, off: undefined }))
  }
  const context: string[] = []
  const mentioned: string[] = []
  if (text.trimStart().startsWith('/')) return { text, context, mentioned }
  const mentions = extractMentions(text)
  mentioned.push(...mentions.files.map((f) => relPath(rt, f)))
  context.push(...(await rulesForPrompt(io, rt, mentions.files, mentions.rules)))
  if (!rt.config) return { text, context, mentioned }
  const gs = await io.read('gateState')
  const manual = await io.read('manual')
  const first = gs.turn === 0 || manual.recheck === true
  let classified: RecomputeOptions['classified']
  if (first) {
    resetTask(rt)
    if (!manual.profile && !manual.off && Object.keys(rt.config.profiles).length) {
      // A deterministic `when` match decides without the classifier.
      const items = await ensureItems(io, rt)
      const dry = decideGate(autoConfig(rt.config), { paths: await io.read('recentPaths'), model: (await io.read('model')) ?? undefined, branch: await readBranch(io, rt) }, gs as GateState, items, { evalExpr: evalWhen, recheck: manual.recheck })
      if (!dry.gate.trigger.startsWith('when:')) classified = await classify(io, rt, text, await io.read('recentPaths'))
    }
  }
  const recheck = manual.recheck === true && gs.turn > 0
  const gate = await recompute(io, rt, 'prompt', { classified, recheck, recheckReason: recheck ? (rt.recheckReason ?? 'new') : undefined })
  if (manual.recheck) {
    await io.update('manual', (m) => json({ ...m, recheck: undefined }))
    rt.recheckReason = undefined
  }
  if (first && gate) {
    const b = await brief(io, rt, text, gate.tier)
    if (b) context.push(`Бриф задачі (context-gate, ${rt.config.brief?.model ?? 'opus'}):\n${b}`)
  }
  return { text, context, mentioned }
}

/** MCP tool outside the applied profile → the deny text (counted for H010). */
export async function mcpGate(io: Io, rt: Runtime, tool: string): Promise<string | undefined> {
  await ensureSession(io, rt)
  const gate = await io.read('gate')
  if (!rt.config || !isApplied(gate) || gate.items[`tool:${tool}`] !== 'off') return undefined
  rt.denies[tool] = (rt.denies[tool] ?? 0) + 1
  await journal(io, rt, { kind: 'deny', trigger: 'mcp', tier: gate.tier, data: { tool, count: rt.denies[tool] } })
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
  const gate = await io.read('gate')
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

/** tool.call Skill: remember args for skill.prompt; a gated-off skill is denied before it loads. */
export async function skillCall(io: Io, rt: Runtime, skill: string, args: string | undefined): Promise<string | undefined> {
  await ensureSession(io, rt)
  rt.skillArgs.set(skill, args ?? '')
  const off = await skillOffMessage(io, rt, skill)
  if (off) await journal(io, rt, { kind: 'deny', trigger: 'skill', data: { skill } })
  return off
}

/** agent.offer: false for agent types outside the applied profile. */
export async function offerAgent(io: Io, rt: Runtime, agent: string): Promise<boolean> {
  await ensureSession(io, rt)
  if (!rt.agentNames.has(agent)) {
    rt.agentNames.add(agent)
    rt.itemsDirty = true
    await materialize(io, rt)
  }
  const gate = await io.read('gate')
  return !(isApplied(gate) && (gate.agents.off.includes(agent) || gate.items[`agent:${agent}`] === 'off'))
}

/** turn.step observer: main-loop model change → tier + recompute; subagent → its own tier. */
export async function observeStep(io: Io, rt: Runtime, model: string, agentId: string | undefined): Promise<void> {
  try {
    await ensureSession(io, rt)
    if (!rt.config || !model) return
    if (agentId === undefined) {
      const prev = await io.read('model')
      if (model !== prev) {
        await io.update('model', () => model)
        await io.update('tier', () => tierForModel(rt.config!, model).tier)
        if (prev) await recompute(io, rt, 'model-change', { prevModel: prev })
      }
    } else {
      const tiers = await io.read('agentTiers')
      if (!(agentId in tiers)) {
        const t = tierForModel(rt.config, model).tier
        await io.update('agentTiers', (m) => json({ ...m, [agentId]: t }))
      }
    }
  } catch (err) {
    debug(io, `turn.step: ${String((err as Error)?.message ?? err)}`)
  }
}
