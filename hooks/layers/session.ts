// Core lifecycle (MOD-ADAPTER "Core"): session.start, classic.SessionStart (watchPaths, /clear, compact),
// session.end {clear}, session.compact, classic.FileChanged for gate.json.


import { json } from '../state.ts'
import { type Io, type Runtime, debug, join } from '../ctx.ts'
import { GATE_JSON, ensureSession, loadGateConfig } from './config.ts'
import { ensureRules } from './cursor-rules.ts'
import { flushJournal, journal } from './journal.ts'
import { keepText } from './budgets.ts'
import { recompute } from './skill-gate.ts'
import { buildStale, loadPrompts, promptDir, registerScriptTools, registerSkillTools } from './dsl.ts'
import { trustState } from './trust.ts'
import { refreshStatus } from './ui.ts'
import { resetGateStats } from './gates.ts'
import { registerCommands } from './commands.ts'

/** Per-conversation state; manual, gate, trust and the log survive. */
export async function resetConversation(io: Io, rt: Runtime, trigger: string): Promise<void> {
  await io.update('seen', () => [])
  await io.update('budgetsFired', () => [])
  await io.update('gateState', () => ({ turn: 0 }))
  await io.update('recentPaths', () => [])
  await io.update('agentTiers', () => ({}))
  await io.update('brief', () => null)
  await io.update('health', () => null)
  rt.readFiles.clear()
  rt.changedPaths.clear()
  rt.verifyFailed = 0
  rt.stallTurns = 0
  rt.escalated.clear()
  rt.staticCache.clear()
  rt.lastRender = undefined
  rt.stepUsage = undefined
  resetGateStats(rt) // H011 counts per conversation
  rt.compactions = 0
  await journal(io, rt, { kind: 'debug', trigger })
}

function recheckOn(rt: Runtime, what: string): boolean {
  return (rt.config?.classify?.recheckOn ?? []).some((x) => x === what || x.endsWith(what))
}

async function watchList(io: Io, rt: Runtime): Promise<string[]> {
  const out = [join(rt.root, GATE_JSON), join(rt.root, '.cursor/rules')]
  for (const r of await ensureRules(io, rt)) if (!r.source?.startsWith('provider:')) out.push(join(rt.root, r.path))
  const set = await loadPrompts(io, rt)
  out.push(...set.watch, join(rt.root, `${promptDir(rt)}/scripts`))
  return [...new Set(out)]
}

/** session.start, before `next`: commands, config, rules, prompt-skill tools; trusted → script tools + build. */
export async function sessionStart(io: Io, rt: Runtime, e: { isInteractive: boolean; surface: string | null }): Promise<void> {
  rt.interactive = e.isInteractive
  rt.surface = e.surface
  rt.ready = false
  rt.boot = undefined
  await registerCommands(io)
  await ensureSession(io, rt)
  try {
    await ensureRules(io, rt, { force: true })
    await registerSkillTools(io, rt)
    if ((await trustState(io, rt)) === 'trusted') {
      await registerScriptTools(io, rt)
      void buildStale(io, rt).catch((err: unknown) => debug(io, `build: ${String(err)}`))
    }
    await refreshStatus(io, rt)
  } catch (err) {
    debug(io, `session.start: ${String((err as Error)?.message ?? err)}`)
  }
}

/** A conversation other than the one this runtime has followed: `/clear`, `/resume` (the process goes on under another
 *  session id) and a fork. Reads, dedup, turn and budget state of the old one must not carry over (M17). */
const NEW_CONVERSATION = new Set(['clear', 'resume', 'fork'])

/** classic.SessionStart, after `next`: /clear, /resume and fork reset, compaction recheck, and the FileChanged watch list. */
export async function classicSessionStart(io: Io, rt: Runtime, source: string): Promise<string[]> {
  try {
    await ensureSession(io, rt)
    if (NEW_CONVERSATION.has(source)) await resetConversation(io, rt, source)
    if (source === 'compact' && recheckOn(rt, 'compact')) {
      await io.update('manual', (m) => json({ ...m, recheck: true }))
      rt.recheckReason = 'compact'
    }
    return await watchList(io, rt)
  } catch (err) {
    debug(io, `classic.SessionStart: ${String((err as Error)?.message ?? err)}`)
    return []
  }
}

export async function sessionEnd(io: Io, rt: Runtime, reason: string): Promise<void> {
  if (reason === 'clear' || reason === 'resume') await resetConversation(io, rt, reason)
  await flushJournal(io, rt)
}

/** session.compact, before `next`: instructions that keep the profile and delivered rules. */
export async function compactInstructions(io: Io, rt: Runtime, instructions: string | undefined): Promise<string> {
  await ensureSession(io, rt)
  return [instructions, await keepText(io)].filter(Boolean).join('\n\n')
}

/** session.compact of a subagent's transcript, after `next`: the main loop was not compacted (no recheck, the static
 *  cache stays, M26); only that agent's delivered rules are forgotten, so they reach it again. */
export async function compactAgentAfter(io: Io, rt: Runtime, agentId: string): Promise<void> {
  await io.update('seen', (s) => s.filter((k) => !k.startsWith(`${agentId}:`)))
  await journal(io, rt, { kind: 'debug', trigger: 'compact', data: { agentId } })
}

/** session.compact, after `next` (a real compaction of the main conversation): reclassify on the next prompt when
 *  recheckOn has `compact`. */
export async function compactAfter(io: Io, rt: Runtime): Promise<void> {
  if (recheckOn(rt, 'compact')) {
    await io.update('manual', (m) => json({ ...m, recheck: true }))
    rt.recheckReason = 'compact'
  }
  rt.staticCache.clear()
  rt.compactions++
  await journal(io, rt, { kind: 'debug', trigger: 'compact' })
}

export async function configFileChanged(io: Io, rt: Runtime, path: string): Promise<void> {
  if (!rt.root || path !== join(rt.root, GATE_JSON)) return
  await loadGateConfig(io, rt)
  await recompute(io, rt, 'config').catch(() => null)
}

/** turn.step, after `next`: the main loop's token usage (prompt-cache hits for health H002/H012, G-43). */
export function recordStepUsage(rt: Runtime, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens?: number; model?: string } | null | undefined, agentId: string | undefined): void {
  if (!usage || agentId !== undefined) return
  const last = { input: usage.input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheCreation: usage.cache_creation_input_tokens ?? 0, output: usage.output_tokens ?? 0, model: usage.model ?? '' }
  const u = rt.stepUsage ?? { steps: 0, input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }
  rt.stepUsage = { steps: u.steps + 1, input: u.input + last.input, cacheRead: u.cacheRead + last.cacheRead, cacheCreation: u.cacheCreation + last.cacheCreation, output: u.output + last.output, last }
}
