// context-gate hooks module: the `claude-code-mod` harness adapter (docs/MOD-ADAPTER.md).
// No Node here: everything outside the module goes through `$`; the pure core is imported relatively.
//
// The mods validator follows `$` only inside the file that holds the hook, and takes one hook per event and
// matcher, so every `on(...)` lives here, every engine call is spelled `$.noun.event(...)` in `port`, and the
// layers (hooks/layers/*) are plain functions over that port (`io`) and the module runtime (`rt`):
//   session/config/commands (core), cursor-rules (layer 1), skill-gate + budgets + gates (layer 2),
//   dsl + host (layer 3), trust (Р2), journal, ui.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { type FileCall, type Io, OWN_TOOL_PREFIX, newRuntime, readOptions } from './ctx.ts'
import { INITIAL, type State, type StateKey } from './state.ts'
import { ensureSession } from './layers/config.ts'
import { classicSessionStart, compactAfter, compactAgentAfter, compactInstructions, configFileChanged, recordStepUsage, sessionEnd, sessionStart } from './layers/session.ts'
import { editSection, gateCommand, rerenderHealth, rerenderSection } from './layers/commands.ts'
import { bashAfter, bashBefore, gatesAfterFile, gatesAfterWrite, gatesBeforeFile, gatesMentioned, guardsBash, guardsFileCall, promptGates, turnAfter } from './layers/gates.ts'
import { checkRoot, relPath, ruleCommand, rulesAfterFile, rulesBeforeFile, rulesContextAfter, rulesContextBefore, rulesFileChanged } from './layers/cursor-rules.ts'
import { describeMcp, gatePromptSubmit, listingAfter, mcpGate, observeStep, offerAgent, recompute, skillCall } from './layers/skill-gate.ts'
import { checkBudgets } from './layers/budgets.ts'
import { captureSkillArgs, composeAfter, dslContextBefore, dslFileChanged, serveOwnTool, skillPrompt, trustOnPrompt } from './layers/dsl.ts'
import { HEALTH_PANE, SECTION_PANE, WHY_PANE, applyProposed, bandProps, buildErrorOf, healthPane, resetAuto, sectionPane, whyPane } from './layers/ui.ts'
import { indexWatched, writeIndex } from './layers/index.ts'
import { invalidateSurface } from './layers/trust.ts'

export { bandLine, gateLine } from './layers/ui.ts'

// Session state: one atom per key with literal refs (the validator lists what the module reads and writes).
const gateAtom = atom({ plugin: 'context-gate', key: 'gate' } as const, INITIAL.gate)
const gateStateAtom = atom({ plugin: 'context-gate', key: 'gateState' } as const, INITIAL.gateState)
const logAtom = atom({ plugin: 'context-gate', key: 'log' } as const, INITIAL.log)
const seenAtom = atom({ plugin: 'context-gate', key: 'seen' } as const, INITIAL.seen)
const manualAtom = atom({ plugin: 'context-gate', key: 'manual' } as const, INITIAL.manual)
const healthAtom = atom({ plugin: 'context-gate', key: 'health' } as const, INITIAL.health)
const budgetsFiredAtom = atom({ plugin: 'context-gate', key: 'budgetsFired' } as const, INITIAL.budgetsFired)
const trustAtom = atom({ plugin: 'context-gate', key: 'trust' } as const, INITIAL.trust)
const recentPathsAtom = atom({ plugin: 'context-gate', key: 'recentPaths' } as const, INITIAL.recentPaths)
const modelAtom = atom({ plugin: 'context-gate', key: 'model' } as const, INITIAL.model)
const tierAtom = atom({ plugin: 'context-gate', key: 'tier' } as const, INITIAL.tier)
const agentTiersAtom = atom({ plugin: 'context-gate', key: 'agentTiers' } as const, INITIAL.agentTiers)
const ctxPercentAtom = atom({ plugin: 'context-gate', key: 'ctxPercent' } as const, INITIAL.ctxPercent)
const briefAtom = atom({ plugin: 'context-gate', key: 'brief' } as const, INITIAL.brief)
const configAtom = atom({ plugin: 'context-gate', key: 'config' } as const, INITIAL.config)
const sectionViewAtom = atom({ plugin: 'context-gate', key: 'sectionView' } as const, INITIAL.sectionView)

function readState($: EngineInterface, key: StateKey): Promise<unknown> {
  switch (key) {
    case 'gate': return read($, gateAtom)
    case 'gateState': return read($, gateStateAtom)
    case 'log': return read($, logAtom)
    case 'seen': return read($, seenAtom)
    case 'manual': return read($, manualAtom)
    case 'health': return read($, healthAtom)
    case 'budgetsFired': return read($, budgetsFiredAtom)
    case 'trust': return read($, trustAtom)
    case 'recentPaths': return read($, recentPathsAtom)
    case 'model': return read($, modelAtom)
    case 'tier': return read($, tierAtom)
    case 'agentTiers': return read($, agentTiersAtom)
    case 'ctxPercent': return read($, ctxPercentAtom)
    case 'brief': return read($, briefAtom)
    case 'config': return read($, configAtom)
    case 'sectionView': return read($, sectionViewAtom)
  }
}

function updateState($: EngineInterface, key: StateKey, fn: (v: never) => unknown): Promise<unknown> {
  switch (key) {
    case 'gate': return update($, gateAtom, fn as (v: State['gate']) => State['gate'])
    case 'gateState': return update($, gateStateAtom, fn as (v: State['gateState']) => State['gateState'])
    case 'log': return update($, logAtom, fn as (v: State['log']) => State['log'])
    case 'seen': return update($, seenAtom, fn as (v: State['seen']) => State['seen'])
    case 'manual': return update($, manualAtom, fn as (v: State['manual']) => State['manual'])
    case 'health': return update($, healthAtom, fn as (v: State['health']) => State['health'])
    case 'budgetsFired': return update($, budgetsFiredAtom, fn as (v: State['budgetsFired']) => State['budgetsFired'])
    case 'trust': return update($, trustAtom, fn as (v: State['trust']) => State['trust'])
    case 'recentPaths': return update($, recentPathsAtom, fn as (v: State['recentPaths']) => State['recentPaths'])
    case 'model': return update($, modelAtom, fn as (v: State['model']) => State['model'])
    case 'tier': return update($, tierAtom, fn as (v: State['tier']) => State['tier'])
    case 'agentTiers': return update($, agentTiersAtom, fn as (v: State['agentTiers']) => State['agentTiers'])
    case 'ctxPercent': return update($, ctxPercentAtom, fn as (v: State['ctxPercent']) => State['ctxPercent'])
    case 'brief': return update($, briefAtom, fn as (v: State['brief']) => State['brief'])
    case 'config': return update($, configAtom, fn as (v: State['config']) => State['config'])
    case 'sectionView': return update($, sectionViewAtom, fn as (v: State['sectionView']) => State['sectionView'])
  }
}

/** The engine calls the layers may make, each spelled out on `$`. */
function port($: EngineInterface): Io {
  return {
    read: ((key: StateKey) => readState($, key)) as Io['read'],
    update: ((key: StateKey, fn: (v: never) => unknown) => updateState($, key, fn)) as Io['update'],
    fs: {
      read: (path) => $.fs.read(path),
      list: (path) => $.fs.list(path),
      exists: (path) => $.fs.exists(path),
      write: (path, text) => $.fs.write(path, text),
      stat: (path, options) => $.fs.stat(path, options),
    },
    session: {
      id: () => $.session.id(),
      root: () => $.session.root(),
      model: () => $.session.model(),
      repo: () => $.session.repo(),
      usage: () => $.session.usage(),
      append: (args) => $.session.append(args),
      compact: (input) => $.session.compact(input),
    },
    env: {
      os: () => $.env.get('OS'),
      home: () => $.env.get('HOME'),
      cacheHome: () => $.env.get('XDG_CACHE_HOME'),
      planProfile: () => $.env.get('CONTEXT_GATE_PROFILE'),
      ticketType: () => $.env.get('CONTEXT_GATE_TICKET_TYPE'),
      ticket: () => $.env.get('CONTEXT_GATE_TICKET'),
    },
    store: {
      get: (key) => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: (key) => $.store.delete(key),
      keys: () => $.store.keys(),
    },
    process: { run: (argv, init) => $.process.run(argv, init), spawn: (request) => $.process.spawn(request) },
    settings: { read: () => $.settings.read() as Promise<Record<string, unknown>> },
    mcp: { call: (server, tool, args) => $.mcp.call(server, tool, args) },
    model: {
      complete: (request, options) => $.model.complete(request, options),
      classify: (text, labels, options) => $.model.classify(text, labels, options),
    },
    tool: { register: (spec) => $.tool.register(spec), list: () => $.tool.list() },
    command: { register: (spec) => $.command.register(spec) },
    ui: {
      ask: (question, options) => $.ui.ask(question, options),
      toast: (text, options) => $.ui.toast(text, options),
      status: (text) => $.ui.status(text),
      log: (text, options) => $.ui.log(text, options),
      invalidate: (event) => $.ui.invalidate(event),
      open: (pane) => $.ui.open(pane),
      close: (pane) => $.ui.close(pane),
    },
    clock: { after: (ms, fn) => $.clock.after(ms, fn) },
    plugin: { root: $.plugin.root, name: $.plugin.name },
  }
}

/** `.catch` for every hook: a failed layer degrades to the engine's own behaviour. */
function pass<E, R>(_$: unknown, e: E, next: (e: E) => R): R {
  return next(e)
}

/** What an enforcement hook answers when it fails before `next` and the repo enforces something on the call (R7):
 *  a refusal, not the engine's fail-open. */
const GUARD_DENY = 'context-gate: перевірка гейтів не вдалася — дію не виконано. Повтори її; якщо збій повторюється, перевір .claude/gate.json або /gate health.'

/** userConfig fields that widen what repo code may run: only the person in /config may turn them on (S14). Keyed
 *  `<plugin>.<field>`; the plugin part may carry a suffix (`context-gate@inline`). */
const WIDENING: Record<string, (v: unknown) => boolean> = {
  trustBuild: (v) => v === 'always',
  allowScripts: (v) => v === true,
}
const widening = (key: string): ((v: unknown) => boolean) | undefined => {
  const m = /^context-gate(?:@[^.]*)?\.(\w+)$/.exec(key)
  return m ? WIDENING[m[1]] : undefined
}

export const register: Register = (on, options) => {
  const rt = newRuntime(readOptions(options))

  // ───────── core: lifecycle, commands ─────────

  on('session.start', async ($, e, next) => {
    const io = port($)
    await sessionStart(io, rt, e)
    await writeIndex(io, rt, 'session.start')
    return next(e)
  }).catch(pass)

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    const watch = await classicSessionStart(port($), rt, e.source)
    return watch.length ? { ...r, watchPaths: [...(r.watchPaths ?? []), ...watch] } : r
  }).catch(pass)

  on('session.end', async ($, e, next) => {
    await sessionEnd(port($), rt, e.reason)
    return next(e)
  }).catch(pass)

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute') return next(e)
    const io = port($)
    if (e.agentId !== undefined) {
      // A subagent's own transcript: the main loop keeps its profile, recheck and static cache (M26).
      const r = await next(e)
      if (!('skip' in r && r.skip)) await compactAgentAfter(io, rt, e.agentId)
      return r
    }
    const instructions = await compactInstructions(io, rt, e.instructions)
    const r = await next({ ...e, instructions })
    if (!('skip' in r && r.skip)) await compactAfter(io, rt) // a vetoed compaction changed nothing (L10)
    return r
  }).catch(pass)

  on('classic.FileChanged', async ($, e, next) => {
    const io = port($)
    invalidateSurface(rt)
    rulesFileChanged(rt, e.file_path)
    await dslFileChanged(io, rt, e.file_path)
    await configFileChanged(io, rt, e.file_path)
    if (indexWatched(rt, e.file_path)) await writeIndex(io, rt, 'file-changed')
    return next(e)
  }).catch(pass)

  on('command.run', { command: 'gate' }, async ($, e) => {
    const io = port($)
    const r = await gateCommand(io, rt, e.args)
    await writeIndex(io, rt, 'gate')
    return r
  })

  on('command.run', { command: 'rule' }, async ($, e) => {
    const io = port($)
    await ensureSession(io, rt)
    return ruleCommand(io, rt, e.args)
  })

  on('command.run', async ($, e, next) => {
    captureSkillArgs(rt, e.command, e.args, e.origin)
    return next(e)
  }).catch(pass)

  // S14: another plugin's `$.config.set` (or a bridge) may not widen trust; the person's own /config change may.
  on('config.set', async ($, e, next) => {
    const widens = widening(e.key)
    if (widens && widens(e.value) && e.origin.kind !== 'composer') return { deny: 'context-gate: розширити довіру може лише користувач у /config' }
    return next(e)
  }).catch(($, e, next) => (next.called || !widening(e.key) ? next(e) : { deny: 'context-gate: зміну не перевірено' }))

  // ───────── layer 1 + 2: prompt ─────────

  on('prompt.context', async ($, e, next) => {
    const io = port($)
    await rulesContextBefore(io, rt)
    await dslContextBefore(io, rt)
    return rulesContextAfter(io, rt, e, await next(e))
  }).catch(pass)

  // trust (first prompt) → `[gate:x]`, @mentions, rules, signals, classifier, brief → prompt gates.
  on('prompt.submit', async ($, e, next) => {
    const io = port($)
    await ensureSession(io, rt)
    await checkRoot(io, rt)
    await trustOnPrompt(io, rt, e.text)
    const g = await gatePromptSubmit(io, rt, { text: e.text })
    gatesMentioned(rt, g.mentioned)
    const context = [...(e.context ?? []), ...g.context]
    if (!g.text.trimStart().startsWith('/')) {
      const failed = await promptGates(io, rt, e.text)
      if (failed?.drop) return { drop: failed.message }
      if (failed) context.push(failed.message)
    }
    if (g.text === e.text && context.length === (e.context?.length ?? 0)) return next(e)
    return next({ ...e, text: g.text, context })
  }).catch(pass)

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const io = port($)
    const r = await next(e)
    const before = rt.listingText
    const text = await listingAfter(io, rt, e.agentId, r.text)
    if (rt.listingText !== before) void writeIndex(io, rt, 'listing')
    return text === r.text ? r : { text }
  }).catch(pass)

  // ───────── tools ─────────

  // Gates (read-before-write, write gates) and strictWrite deny before; Auto Attached rules after the result.
  on('tool.call', { tool: ['Read', 'Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const io = port($)
    await ensureSession(io, rt)
    await checkRoot(io, rt) // a moved root before the path is made repo-relative
    const file = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    if (typeof file !== 'string' || !file) return next(e)
    const c: FileCall = { tool: e.tool, file, rel: relPath(rt, file), agent: e.agentId ?? 'main', input: e as unknown as Record<string, unknown>, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) }
    const denied = (await gatesBeforeFile(io, rt, c)) ?? (await rulesBeforeFile(io, rt, c))
    if (denied) return denied
    const r = await next(e)
    gatesAfterFile(rt, c, r)
    return rulesAfterFile(io, rt, c, await gatesAfterWrite(io, rt, c, r))
  }).catch(($, e, next) => (next.called || !guardsFileCall(rt, e.tool) ? next(e) : { deny: GUARD_DENY }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const io = port($)
    const cmd = typeof e.command === 'string' ? e.command : ''
    const deny = await bashBefore(io, rt, cmd, e.agentId)
    if (deny) return { deny }
    const r = await next(e)
    await bashAfter(io, rt, cmd, r)
    return r
  }).catch(($, e, next) => (next.called || !guardsBash(rt, typeof e.command === 'string' ? e.command : '') ? next(e) : { deny: GUARD_DENY }))

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    // Without the engine's tool table laid beside the d.ts, Skill's arguments are `unknown`: narrow them.
    if (typeof e.skill !== 'string' || !e.skill) return next(e)
    const deny = await skillCall(port($), rt, e.skill, typeof e.args === 'string' ? e.args : undefined, e.agentId)
    return deny ? { deny } : next(e)
  }).catch(pass)

  // MCP: our own tools are served here; others outside the applied profile are denied.
  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    const io = port($)
    if (e.tool.startsWith(OWN_TOOL_PREFIX)) return (await serveOwnTool(io, rt, e as unknown as { tool: string } & Record<string, unknown>)) ?? next(e)
    const deny = await mcpGate(io, rt, e.tool, e.agentId)
    return deny ? { deny } : next(e)
  }).catch(pass)

  on('tool.describe', { tool: /^mcp__/ }, async ($, e, next) => (await describeMcp(port($), rt, e.tool)) ?? next(e)).catch(pass)

  on('agent.offer', async ($, e, next) => ((await offerAgent(port($), rt, e.agent)) ? next(e) : { isOffered: false })).catch(pass)

  on('skill.prompt', async ($, e, next) => {
    const text = await skillPrompt(port($), rt, e.skill, e.text)
    return text === undefined ? next(e) : { text }
  }).catch(pass)

  // ───────── turns, budgets ─────────

  on('turn.step', async function* ($, e, next) {
    await observeStep(port($), rt, e.model, e.agentId)
    const res = yield* next(e)
    recordStepUsage(rt, res.usage, e.agentId)
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await turnAfter(port($), rt, e)
    return r
  }).catch(pass)

  on('session.measure', async ($, e, next) => {
    const io = port($)
    await ensureSession(io, rt)
    await checkBudgets(io, rt, e.context.percent)
    return next(e)
  }).catch(pass)

  // ───────── layer 3: the system prompt ─────────

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const sections = await composeAfter(port($), rt, e, r.sections)
    return sections ? { sections } : r
  }).catch(pass)

  // ───────── UI ─────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const gate = await read($, gateAtom)
    const tier = await read($, tierAtom)
    const ctx = await read($, ctxPercentAtom)
    const { Text } = $.ui.resolve(e)
    const band = bandProps(rt, gate, tier, ctx)
    return band.hot ? Text({ color: 'warning', wrap: 'truncate', children: band.text }) : Text({ dimColor: true, wrap: 'truncate', children: band.text })
  }).catch(pass)

  on('ui.render', { component: 'Pane', requestId: WHY_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const status = await read($, configAtom)
    const tree = whyPane(els as never, {
      log: await read($, logAtom),
      gate: await read($, gateAtom),
      health: await read($, healthAtom),
      disabled: status.disabled,
      rows: Math.max(3, (e.viewport?.rows ?? 30) - 12),
      onApply: () => { const io = port($); void applyProposed(io, rt, (t) => recompute(io, rt, t)) },
      onAuto: () => { const io = port($); void resetAuto(io, (t) => recompute(io, rt, t)) },
    })
    return tree as ReturnType<typeof els.Box>
  })

  on('ui.render', { component: 'Pane', requestId: HEALTH_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    await read($, healthAtom) // subscribes: a new render redraws the pane
    const tree = healthPane(els as never, {
      report: rt.lastHealth,
      buildError: buildErrorOf(rt),
      onRerender: () => { void rerenderHealth(port($), rt) },
    })
    return tree as ReturnType<typeof els.Box>
  })

  on('ui.render', { component: 'Pane', requestId: SECTION_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const view = await read($, sectionViewAtom)
    const tree = sectionPane(els as never, {
      view,
      onEdit: () => { if (view) void editSection(port($), rt, view.id) },
      onRerender: () => { void rerenderSection(port($), rt) },
    })
    return tree as ReturnType<typeof els.Box>
  })
}
