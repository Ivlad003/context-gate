// context-gate's contract: the session state the mod keeps in `$.state`.
// Self-contained (no import, no reference), as the mods API requires of a
// plugin's `types` file. Shapes mirror packages/core/src/types.ts in JSON form.
// Optional fields (never `undefined` values: $.state drops them like JSON) keep
// core values assignable as they are: Gate, GateState, DecisionLogEntry,
// Signals.manual. Reading back, the adapter narrows `items` to ItemDecision.

/** Which signal decided (core DecisionTrigger, widened to string for JSON). */
export type ContextGateTrigger = string

/** The applied gate decision (core `Gate`). */
export type ContextGateDecision = {
  profile?: string
  proposed?: { profile: string; confidence: number }
  tier: string
  trigger: ContextGateTrigger
  off: boolean
  skills: { on: string[]; nameOnly: string[]; off: string[]; preload: string[] }
  mcp: { on: string[]; off: string[] }
  agents: { on: string[]; off: string[] }
  rules: { on: string[]; off: string[] }
  /** Per-item decision keyed by Item.id: 'on' | 'nameOnly' | 'off' | 'preload'. */
  items: Record<string, string>
  groups: string[]
  reason: string[]
  /** Shadow mode: computed and journaled, not applied (nothing is filtered); `proposed` holds the profile. */
  shadow?: boolean
}

/** Hysteresis and turn counter (core `GateState`). */
export type ContextGateGateState = {
  profile?: string
  profileSource?: ContextGateTrigger
  pending?: { profile: string; count: number }
  turn: number
}

/** One decision-log row (core `DecisionLogEntry`); the ring keeps 200. */
export type ContextGateLogEntry = {
  ts: number
  turn: number
  trigger: string
  profile?: string
  tier: string
  enabled: string[]
  disabled: string[]
  reason: string[]
  kind?: string
  data?: Record<string, unknown>
}

/** Manual overrides from /gate for this session (core `Signals.manual`). */
export type ContextGateManual = {
  profile?: string
  add: string[]
  remove: string[]
  off?: boolean
  /** /gate shadow | /gate apply override of classify.mode; absent = config/userConfig. */
  mode?: 'shadow' | 'auto'
  /** /gate new: reclassify on the next prompt. */
  recheck?: boolean
}

/** Last render health of one prompt section (prompt.compose / render.ts). */
export type ContextGateSectionHealth = {
  hash: string
  chars: number
  tokens: number
  scope: string
  status: string
  truncated: boolean
}

export type ContextGateRenderHealth = {
  at: number
  ms: number
  /** Share of prompt chars unchanged since the previous render, 0..100 (H002). */
  stablePct: number
  unverified: number
  sections: Record<string, ContextGateSectionHealth>
}

/** Trust-on-first-use for repository-defined execution (SPEC Р2). */
export type ContextGateTrust = {
  decision: 'unknown' | 'trusted' | 'denied'
  /** `<repo root>|<remote>` the decision is for (mirrored in $.store). */
  key: string | null
  /** Hash of gate.json command set the decision covered. */
  commandsHash: string | null
}

export type ContextGateBrief = {
  key: string
  text: string
  at: number
}

/** Config load status shown by /gate why when a layer is off. */
export type ContextGateConfigStatus = {
  ok: boolean
  /** Layers switched off and why (config error G3xx, .claude/rules/cursor present, ...). */
  disabled: Record<string, string>
  diagnostics: number
}

/** The section the `gate-section` pane shows (`/gate render prompt://<id>`), rendered in a command or a button. */
export type ContextGateSectionView = {
  id: string
  tier: string
  scope: string
  text: string
  chars: number
  tokens: number
  included: boolean
  reason?: string
  status: string
  /** `G*`/`H*` lines of the render. */
  diagnostics: string[]
  at: number
  /** Browser editor URL once `/gate edit` (or the pane button) started it. */
  editorUrl?: string
  /** Last editor start error. */
  editorError?: string
}

declare module 'claude-code' {
  interface PluginState {
    'context-gate': {
      gate: ContextGateDecision | null
      gateState: ContextGateGateState
      log: ContextGateLogEntry[]
      /** Rule dedup keys `<agentId|main>:<ruleId>`. */
      seen: string[]
      manual: ContextGateManual
      health: ContextGateRenderHealth | null
      /** Budget thresholds already acted on, e.g. `softContextPct`, `hardContextPct`. */
      budgetsFired: string[]
      trust: ContextGateTrust
      /** Repo-relative POSIX paths from @-mentions and file tools, newest last (cap 50). */
      recentPaths: string[]
      /** Main loop's model and tier. */
      model: string | null
      tier: string | null
      /** Tier per subagent loop, keyed by agentId. */
      agentTiers: Record<string, string>
      /** Context fill, 0..100, from session.measure / turn.complete. */
      ctxPercent: number | null
      brief: ContextGateBrief | null
      config: ContextGateConfigStatus
      /** The `gate-section` pane's section (null until `/gate render`). */
      sectionView: ContextGateSectionView | null
    }
  }
}
