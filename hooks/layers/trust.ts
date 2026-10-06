// Trust-on-first-use per repository (SPEC Р2). Covers every io.process.run / io.mcp.call that repo
// config initiates: prompt build, @run/@call executors, cli providers, command gates, script tools.
// Until trusted only plugin code and file reads run. Key: repo root + remote, kept in io.store.


import type { GateConfig } from '../../packages/core/src/types.ts'
import { json } from '../state.ts'
import { type Io, type Runtime, debug, hash, now, stableJson } from '../ctx.ts'

export type TrustDecision = 'unknown' | 'trusted' | 'denied'

export const TRUST_QUESTION = 'context-gate: дозволити цьому репозиторію збирати промпти й запускати команди з .claude/gate.json (гейти, скрипти, провайдери)?'
export const TRUST_YES = 'Так, довіряю'
export const TRUST_NO = 'Ні'

interface Stored { decision: 'trusted' | 'denied'; commandsHash: string; at: number }

/** Everything repo config can execute: a change asks again. */
export function commandsHash(cfg: GateConfig | undefined): string {
  if (!cfg) return hash('')
  const providers = Object.fromEntries(Object.entries(cfg.providers ?? {}).filter(([, p]) => p.kind === 'cli' || p.kind === 'mcp'))
  return hash(stableJson({ executors: cfg.executors ?? {}, providers, gates: (cfg.gates ?? []).filter((g) => g.run).map((g) => ({ name: g.name, run: g.run })), build: cfg.prompt?.build ?? 'auto' }))
}

export async function repoKey(io: Io, rt: Runtime): Promise<string> {
  const repo = await io.session.repo().catch(() => null)
  return `${repo?.root ?? rt.root}|${repo?.remote ?? ''}`
}

/** Current decision without asking. */
export async function trustState(io: Io, rt: Runtime): Promise<TrustDecision> {
  if (rt.options.trustBuild === 'always') return 'trusted'
  if (rt.options.trustBuild === 'never') return 'denied'
  const key = await repoKey(io, rt)
  const h = commandsHash(rt.config)
  const cached = rt.trustCache
  if (cached && cached.key === key && cached.hash === h) return cached.decision
  const stored = (await io.store.get(`trust:${key}`).catch(() => undefined)) as Stored | undefined
  const decision: TrustDecision = stored && stored.commandsHash === h ? stored.decision : 'unknown'
  rt.trustCache = { key, hash: h, decision }
  await io.update('trust', () => json({ decision, key, commandsHash: h }))
  return decision
}

/** Decision, asking once per session when interactive. A dismissed question stays unknown (not stored). */
export async function ensureTrust(io: Io, rt: Runtime, opts: { ask: boolean }): Promise<TrustDecision> {
  const current = await trustState(io, rt)
  if (current !== 'unknown' || !opts.ask || !rt.interactive || rt.trustAsked) return current
  rt.trustAsked = true
  let answer: string | undefined
  try {
    answer = await io.ui.ask(TRUST_QUESTION, { header: 'context-gate', options: [TRUST_YES, TRUST_NO] })
  } catch {
    return 'unknown'
  }
  if (answer !== TRUST_YES && answer !== TRUST_NO) return 'unknown'
  const decision: 'trusted' | 'denied' = answer === TRUST_YES ? 'trusted' : 'denied'
  const key = await repoKey(io, rt)
  const h = commandsHash(rt.config)
  await io.store.set(`trust:${key}`, { decision, commandsHash: h, at: now() } satisfies Stored).catch((err: unknown) => debug(io, `trust store failed: ${String(err)}`))
  rt.trustCache = { key, hash: h, decision }
  await io.update('trust', () => json({ decision, key, commandsHash: h }))
  return decision
}

export async function revokeTrust(io: Io, rt: Runtime): Promise<string> {
  const key = await repoKey(io, rt)
  await io.store.delete(`trust:${key}`).catch(() => undefined)
  rt.trustCache = undefined
  rt.trustAsked = false
  await io.update('trust', () => json({ decision: 'unknown', key, commandsHash: null }))
  return key
}

/** Repo config holds something only trust unlocks. */
export function needsTrust(cfg: GateConfig | undefined, hasPrompts: boolean, hasScripts: boolean): boolean {
  if (!cfg) return hasPrompts
  return hasPrompts || hasScripts || (cfg.gates ?? []).some((g) => g.run) || Object.keys(cfg.executors ?? {}).length > 0 || Object.values(cfg.providers ?? {}).some((p) => p.kind === 'cli' || p.kind === 'mcp')
}
