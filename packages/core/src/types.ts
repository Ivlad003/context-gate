// Shared contracts of context-gate core. Pure data types: no Node, no Claude Code.
// Every module of packages/core, packages/cli, packages/jsx and hooks/ imports from here.
// Changing a shape here is a contract change (SPEC.md "Єдина модель").

// ───────────────────────── Diagnostics ─────────────────────────

/** Diagnostic code: G0xx structure, G1xx expressions, G2xx run/lazy/providers,
 * G3xx config, G4xx tier variants, G5xx pipe, H0xx health, D0xx debug. */
export type Code = `${'G' | 'H' | 'D'}${number}`

export interface Diagnostic {
  code: Code
  severity: 'error' | 'warning' | 'info'
  message: string
  /** File path (repo-relative POSIX) and 1-based line, when known. */
  path?: string
  line?: number
  hint?: string
}

// ───────────────────────── Items (unified model) ─────────────────────────

export type ItemKind = 'skill' | 'tool' | 'agent' | 'rule' | 'section' | 'datum'
export type ItemStatus = 'ok' | 'fail' | 'unverified'

/** Cursor rule type, kept on rule items for /gate rules. */
export type RuleType = 'always' | 'auto' | 'agent' | 'manual'

export interface Item {
  kind: ItemKind
  /** `<kind>:<name>`, e.g. `skill:react-components`, `tool:mcp__github__list_prs`, `rule:react`. */
  id: string
  name: string
  description?: string
  body?: string
  tags?: string[]
  attach: { when: 'always' | 'paths' | 'manual' | 'on-demand'; globs?: string[] }
  cost: { chars: number }
  provenance: { source: string; path?: string }
  status?: ItemStatus
  /** Rule items only. */
  ruleType?: RuleType
}

// ───────────────────────── Cursor rules ─────────────────────────

export interface MdcRule {
  /** File name without `.mdc`, prefixed with dir for nested (`packages/api/x`). */
  id: string
  path: string
  type: RuleType
  description?: string
  /** Positive globs (already prefixed for nested rule dirs). */
  globs: string[]
  /** Negated globs (without the leading `!`). */
  negGlobs: string[]
  alwaysApply: boolean
  body: string
  /** Paths from `@file` references in the body (expanded to one line each). */
  fileRefs: string[]
  /** Item source that produced the rule (`cursor-mdc` when absent; `markdown-dir`, `provider:<name>`). */
  source?: string
}

// ───────────────────────── Config: .claude/gate.json ─────────────────────────

export type Tier = string // 'premium' | 'standard' | 'quick' by convention, any key of config.tiers

export interface ProfileWhen {
  paths?: string[]
  branch?: string // regex
  expr?: string // DSL expression over providers
  ticketType?: string[]
}

export interface ProfileConfig {
  /** New format: group names from `groups`. */
  groups?: string[]
  /** Legacy format (G310): names from skillGroups / mcpGroups; agents are names. */
  skills?: string[]
  mcp?: string[]
  agents?: string[]
  when?: ProfileWhen
}

export interface TierConfig {
  groups?: string[]
  skills?: string[] // legacy
  preload?: string[]
  /** Model attributes for tier inference when `models` has no tier for the model (G-01). */
  thresholds?: TierThresholds
}

export interface BudgetPct { softContextPct?: number; hardContextPct?: number }

export type OnExceedAction =
  | { do: 'section'; section: string }
  | { do: 'notice'; text: string }
  | { do: 'compact'; instructions?: string }

export interface ProviderConfig {
  kind: 'cli' | 'file' | 'mcp' | 'module'
  builtin?: boolean
  command?: string[]
  functions?: string[] | Record<string, string[]>
  path?: string
  pick?: string[]
  tool?: string
  args?: Record<string, unknown>
  cache?: string // duration like '5m'
  onError?: 'unverified' | 'skip' | 'fail'
  /** `cli`: exit codes that count as success (default `[0]`); see core `providerResultOk`. */
  okExitCodes?: number[]
  /** `cli`: any other exit code with JSON on stdout still yields data (`eslint -f json` exits 1 on lint errors). */
  parseOnError?: boolean
  schema?: unknown
  exposes?: string[]
}

/** `models` value: a tier name, or attributes. With `tier` the entry maps directly; without it the tier is
 * inferred from `tiers[*].thresholds` (SPEC "Єдина модель": «tier виводиться з порогів»). `match` (a glob)
 * replaces the key as the pattern, so the key can be a label. */
export interface ModelSpec {
  tier?: Tier
  match?: string
  /** Context window in tokens. */
  contextWindow?: number
  /** Input price in USD per 1k tokens. */
  costPer1k?: number
}

/** Model attributes a tier requires (all declared bounds must hold). */
export interface TierThresholds {
  minContextWindow?: number
  maxContextWindow?: number
  minCostPer1k?: number
  maxCostPer1k?: number
}

/** External classify / brief provider (SPEC "Провайдери — Сигнали профілю"): `builtin` (the model API),
 * `jev` (the engine's label classifier, `$.model.classify`), or a CLI that reads JSON on stdin.
 * classify: stdin `{ text, profiles: [{ name, groups }], paths, model }` → stdout `{ "profile", "confidence" }`.
 * brief: stdin `{ text, tier, maxChars, paths, model }` → stdout the brief (plain text, or JSON `{ "text" }`). */
export type ModelProviderRef = 'builtin' | 'jev' | { kind: 'cli'; command: string[]; timeout?: string }

export interface ExecutorConfig {
  command: string[] // with `{code}` placeholder
  stdin?: string // `{code}` to pass code via stdin
  timeout?: string
  env?: Record<string, string>
  callTemplate?: string[]
}

export interface GateCheckConfig {
  name: string
  /** `push` / `publish`: a Bash command that runs `git push` / publishes a package (npm, pnpm, yarn, bun, cargo, twine, poetry). */
  on: 'write' | 'commit' | 'push' | 'publish' | 'turn' | 'prompt'
  builtin?: boolean
  tiers?: Tier[]
  /** A `prompt` gate gets the prompt text on stdin; others get nothing. Without `run` and `provider`, only `pass` decides. */
  run?: string[]
  pass?: string // expression over { exitCode, stdout, stderr, result, prompt (prompt gates), command (Bash gates) }
  message?: string
  provider?: string
  onlyNew?: boolean
  baseline?: string
  /** A gate that cannot run (untrusted, not whitelisted, provider unavailable) blocks instead of passing (S6). */
  failClosed?: boolean
  /** `prompt` gates: a failure stops the prompt (the message is shown to the user) instead of reaching the model as context. */
  drop?: boolean
}

export interface ItemSourceConfig {
  kind: 'claude-skills' | 'claude-tools' | 'claude-agents' | 'cursor-mdc' | 'markdown-dir' | 'prompt-dir' | 'provider'
  dir?: string
  match?: string
  as?: ItemKind | 'always'
  name?: string
  pick?: string
  field?: string
  template?: string
  nested?: boolean
  frontmatter?: Record<string, string>
}

export interface GateConfig {
  $schema?: string
  /** gate.json format version (core CONFIG_VERSION); a newer one is reported (G317). */
  version?: number
  /** New unified format: name → kind-prefixed globs (`skill:react-*`, `tool:mcp__figma__*`). */
  groups?: Record<string, string[]>
  /** Legacy (G310). */
  skillGroups?: Record<string, string[]>
  mcpGroups?: Record<string, string[]>
  tiers: Record<Tier, TierConfig>
  /** glob on model id → tier, or attributes (`{ contextWindow, costPer1k, tier?, match? }`, see ModelSpec). */
  models: Record<string, Tier | ModelSpec>
  profiles: Record<string, ProfileConfig>
  classify?: { mode: 'shadow' | 'auto'; model?: string; minConfidence?: number; recheckOn?: string[]; provider?: ModelProviderRef }
  budgets?: { default?: BudgetPct; tiers?: Record<Tier, BudgetPct> }
  onExceed?: { softContextPct?: OnExceedAction; hardContextPct?: OnExceedAction }
  escalation?: { order: Tier[]; after: { verifyFailed?: number; stallTurns?: number } }
  brief?: { enabled: boolean; model?: string; maxChars?: number; tiers?: Tier[]; provider?: ModelProviderRef }
  providers?: Record<string, ProviderConfig>
  executors?: Record<string, ExecutorConfig>
  ruleSources?: ItemSourceConfig[] // legacy
  itemSources?: ItemSourceConfig[]
  gates?: GateCheckConfig[]
  cursorRules?: { enabled?: boolean; nested?: boolean; maxCharsPerInjection?: number; strictWrite?: boolean }
  prompt?: {
    dir?: string; runCacheDefault?: string; build?: 'auto' | 'never'; commitCompiled?: boolean; persist?: boolean
    /** Prompt library packages whose exported skills `context-gate build` builds (G-19). */
    packages?: string[]
    /** `level2`: native TS expressions in runtime props of TSX prompts (Р1, G-24). */
    transform?: 'level1' | 'level2'
    /** SKILL.md body: `live` render line (default), pre-rendered `static` body, or `both` (Р6, G-26). */
    skillBody?: 'live' | 'static' | 'both'
    /** Where `scope: volatile` sections go: the end of the system prompt (default) or the prompt's context (P1). */
    volatile?: 'system' | 'context'
  }
  health?: Partial<Record<Code, number>>
  debug?: boolean
  /** `.claude/gate.debug.log` writer (only with `debug: true` or CLI `--debug`); see core `debugLogPath`. */
  debugLog?: { path?: string; maxBytes?: number }
  /** A false `@assert`: skip the section (default) or fail the render. */
  assertFail?: 'skip' | 'fail'
  log?: { file?: boolean }
  env?: string[] // whitelist of env vars visible to the DSL (masked in debug)
  /** Binaries repo executors/providers may start: narrows the user whitelist, never widens it (Р2). */
  allowBinaries?: string[]
}

// ───────────────────────── Signals → Decision (skill-gate) ─────────────────────────

export interface Signals {
  /** Manual overrides from /gate for this session. */
  manual?: { profile?: string; add: string[]; remove: string[]; off?: boolean }
  /** Paths from @-mentions and recent tool calls (repo-relative POSIX). */
  paths: string[]
  branch?: string
  model?: string
  agentId?: string
  ticketType?: string
  /** Ticket id (shiftwork `CONTEXT_GATE_TICKET`): journaled so `report` can match runner and adapter decisions. */
  ticketId?: string
  /** Classifier proposal. */
  classified?: { profile: string; confidence: number }
  /** Provider data for `when.expr`. */
  data?: Record<string, unknown>
}

export interface GateState {
  /** Currently committed profile(s) and how they were chosen. */
  profile?: string
  profileSource?: DecisionTrigger
  /** Hysteresis: a different `when` profile seen on consecutive turns. */
  pending?: { profile: string; count: number }
  turn: number
}

export type DecisionTrigger = 'manual' | 'when:paths' | 'when:branch' | 'when:expr' | 'when:ticketType' | 'classify' | 'tier' | 'default' | 'model-change' | 'compact' | 'off'

export type ItemDecision = 'on' | 'nameOnly' | 'off' | 'preload'

export interface Gate {
  profile: string | undefined
  /** Shadow classifier proposal (shown as `(frontend?)`). */
  proposed?: { profile: string; confidence: number }
  /** Set by the adapter, never by decideGate: the decision is logged but not applied (shadow mode). */
  shadow?: boolean
  tier: Tier
  trigger: DecisionTrigger
  off: boolean
  skills: { on: string[]; nameOnly: string[]; off: string[]; preload: string[] }
  mcp: { on: string[]; off: string[] }
  agents: { on: string[]; off: string[] }
  rules: { on: string[]; off: string[] }
  /** Per-item decision keyed by Item.id. */
  items: Record<string, ItemDecision>
  /** Groups active after manual +/-. */
  groups: string[]
  reason: string[]
}

export interface DecisionLogEntry {
  ts: number
  turn: number
  trigger: DecisionTrigger | string
  profile?: string
  tier: Tier
  enabled: string[]
  disabled: string[]
  reason: string[]
  kind?: 'decision' | 'escalation-suggested' | 'gate-failed' | 'gate-attempt' | 'skill-render' | 'snapshot' | 'debug' | 'rule-delivered' | 'deny' | 'health' | 'label'
  data?: Record<string, unknown>
}

// ───────────────────────── Prompt AST (total DSL) ─────────────────────────
// Produced by @context-gate/jsx at build time (and by the Markdown @-directive parser),
// serialized into .claude/prompt/.compiled/<id>.json, executed by core/render.ts.
// Expressions are ALWAYS strings parsed by core/expr.ts (SPEC Р1, level 1).

export type Scope = 'static' | 'profile' | 'volatile'
export type IncludeMode = 'inline' | 'ref' | 'lazy'

export type Node =
  | { t: 'text'; value: string }
  /** `{{ expr }}` interpolation. */
  | { t: 'expr'; expr: string }
  | { t: 'el'; tag: string; attrs?: Record<string, string>; children: Node[] } // ol/li/pre/code/b/i/p/h1-h6/ul/br
  | { t: 'if'; test: string; then: Node[]; else?: Node[] }
  | { t: 'each'; of: string; as: string; index?: string; children: Node[] }
  | { t: 'let'; name: string; value: string }
  | { t: 'set'; name: string; value: string }
  | { t: 'repeat'; n: string; children: Node[] } // counter `i`
  | { t: 'break' }
  | { t: 'continue' }
  /** Persist variable `name` to `data.<key ?? name>`; after a `run`/`call` it carries that value's fetchedAt/cache. */
  | { t: 'store'; name: string; key?: string }
  | { t: 'run'; lang: string; code: string; as?: string; cache?: string; store?: string; needs?: string[] }
  | { t: 'use'; name: string; path: string }
  | { t: 'call'; fn: string; args: string[]; kwargs?: Record<string, string>; as: string; cache?: string; store?: string }
  | { t: 'include'; source: 'file' | 'text' | 'section' | 'skill' | 'rule' | 'mcp'; ref: string; mode: IncludeMode; budget?: number; description?: string; args?: Record<string, string>; as?: string; text?: string }
  | { t: 'tier'; is: Tier[] | 'non-premium'; children: Node[] }
  | { t: 'fence'; lang?: string; title?: string; children: Node[] }
  | { t: 'list'; ordered?: boolean; children: Node[] }
  | { t: 'table'; columns: string[]; rows: string; cells: string[] } // rows = expr of list, cells = exprs over `row`
  | { t: 'debug'; exprs: string[]; message?: string }
  | { t: 'assert'; test: string; message?: string }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { t: 'trace'; on: boolean }

export interface SectionNode {
  id: string
  scope: Scope
  when?: string
  budget?: number
  after?: string
  tier?: Tier[]
  children: Node[]
  /** Source file and line for diagnostics/trace. */
  source?: { path: string; line?: number }
}

export type ArgType = 'string' | 'number' | 'enum' | 'flag' | 'path' | 'list' | 'json' | 'rest'
export interface ArgSpec {
  type: ArgType
  positional?: number
  required?: boolean
  default?: unknown
  hint?: string
  values?: string[] // enum
  description?: string
}

export interface CompiledPrompt {
  version: 1
  compiler: string // e.g. 'context-gate@0.1.0'
  id: string
  sourceHash: string
  sources: { path: string; hash: string }[]
  /** Normal system-prompt sections. */
  sections: SectionNode[]
  /** Present when `<Prompt as="skill">`. */
  skill?: {
    name: string
    description: string
    args: Record<string, ArgSpec>
    invoke: { user: boolean; model: 'tool' | 'skill' | false }
    tiers?: Tier[]
    body: Node[]
  }
  /** Top-level `use` bindings (namespace → path). */
  uses?: Record<string, string>
  diagnostics: Diagnostic[]
}

// ───────────────────────── Rendering ─────────────────────────

/** Values visible to expressions: gate, git, fs, cursor, ctx, session, args, data, providers. JSON-only. */
export type Value = null | boolean | number | string | Value[] | { [k: string]: Value }
export type Scope_ = Record<string, Value>

/** Everything the renderer needs from the outside world; injected by mod adapter or CLI. */
export interface RenderHost {
  /** Read a repo file (repo-relative). undefined when missing. */
  readFile(path: string): Promise<string | undefined>
  /** Run code with an executor. Must respect trust + whitelist; returns stdout. */
  run?(req: { lang: string; code: string; stdin: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string; ms: number }>
  /** Call a function of a module through the language shim (batched). */
  call?(req: { path: string; calls: { fn: string; args: Value[]; kwargs?: Record<string, Value> }[]; timeoutMs?: number }): Promise<Value[]>
  mcp?(req: { server: string; tool: string; args: Record<string, Value>; timeoutMs?: number }): Promise<Value>
  /** Cache and data store (data.*). */
  cacheGet?(key: string): Promise<{ value: Value; at: number } | undefined>
  cacheSet?(key: string, value: Value): Promise<void>
  /** Register a lazy tool `get_<name>`; adapter-specific, optional. */
  registerLazy?(name: string, description: string, ref: string): void
  /** Resolve skill/rule bodies for include source skill/rule. */
  itemBody?(kind: 'skill' | 'rule', name: string): Promise<{ description?: string; body?: string; path?: string } | undefined>
  now(): number
  /** Trusted: may run executors / mcp. Untrusted → run/call/mcp render as unverified stubs. */
  trusted: boolean
  /** When true, run/call use cache only (dry-scripts). */
  dryScripts?: boolean
}

export interface TraceEntry {
  section: string
  kind: 'section' | 'if' | 'let' | 'set' | 'run' | 'call' | 'mcp' | 'include' | 'debug' | 'assert' | 'log' | 'budget' | 'tier' | 'when'
  line?: number
  detail: string
  ms?: number
  source?: 'cache' | 'run' | 'build-time' | 'stub'
}

export interface RenderedSection {
  id: string
  scope: Scope
  text: string
  chars: number
  tokens: number // estimate chars/4
  included: boolean
  /** Why excluded/truncated. */
  reason?: string
  truncated?: boolean
  after?: string
  hash: string
  status: ItemStatus
}

export interface RenderResult {
  sections: RenderedSection[]
  /** Final ordered prompt text (static → profile → volatile) with section markers when requested. */
  text: string
  trace: TraceEntry[]
  diagnostics: Diagnostic[]
  ms: number
  /** Values to persist (`store`). */
  stored: Record<string, Value>
}

export interface RenderOptions {
  tier: Tier
  only?: string
  markers?: boolean
  /** Step limit per section (default 10_000). */
  stepLimit?: number
  /** Total @run budget per render in ms (default 2000). */
  runBudgetMs?: number
  debug?: boolean
}

// ───────────────────────── Health ─────────────────────────

export interface HealthMetric {
  code?: Code
  name: string
  value: number | string
  threshold?: number | string
  ok: boolean
  advice?: string
}

export interface HealthReport {
  metrics: HealthMetric[]
  sections: { id: string; scope: Scope; chars: number; tokens: number; truncated?: boolean }[]
  diagnostics: Diagnostic[]
}
