// Session state helpers (the 'context-gate' contract in types/index.d.ts). Never write from a ui.render hook.

import type { PluginState } from 'claude-code'

import type { ContextGateDecision, ContextGateLogEntry, ContextGateManual } from '../types'

/** The plugin's session state, key by key (types/index.d.ts). The atoms themselves live in register.ts:
 * the mods validator reads state references only as consts of the hooks file. */
export type State = PluginState['context-gate']
export type StateKey = keyof State

export const INITIAL: State = {
  gate: null,
  gateState: { turn: 0 },
  log: [],
  seen: [],
  manual: { add: [], remove: [] },
  health: null,
  budgetsFired: [],
  trust: { decision: 'unknown', key: null, commandsHash: null },
  recentPaths: [],
  model: null,
  tier: null,
  agentTiers: {},
  ctxPercent: null,
  brief: null,
  config: { ok: true, disabled: {}, diagnostics: 0 },
}

/** `$.state.set` takes JSON only: drop `undefined` fields. */
export function json<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

/** Manual signals present → the gate applies whatever the classifier mode. */
export function hasManual(m: ContextGateManual | undefined): boolean {
  return !!m && (m.profile !== undefined || m.off === true || m.add.length > 0 || m.remove.length > 0)
}

/** The gate filters only when it is applied (not shadow) and not off. */
export function isApplied(g: ContextGateDecision | null | undefined): g is ContextGateDecision {
  return !!g && !g.shadow && !g.off
}

export function pushRing<T>(buf: readonly T[], entry: T, max: number): T[] {
  const out = [...buf, entry]
  return out.length > max ? out.slice(out.length - max) : out
}

export type LogEntry = ContextGateLogEntry
