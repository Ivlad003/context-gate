// Module caches and per-session runtime (docs/MOD-ADAPTER.md "Ground rules").
// Everything here is disposable: a hot reload drops it and `ensureSession` rebuilds it lazily.
// Durable values live in $.state (state.ts) and $.store (trust, cache).

import type { EngineInterface, PluginOptions } from 'claude-code'

import type { CompiledPrompt, Diagnostic, GateConfig, Item, MdcRule, RenderResult, HealthReport } from '../packages/core/src/types.ts'
import { detectWindows } from '../packages/core/src/glob.ts'
import type { State, StateKey } from './state.ts'

type E = EngineInterface

/** The engine calls the layers use, bound in register.ts (the mods validator follows `$` only inside
 * the file that holds the hook, so layers never see `$` itself). */
export interface Io {
  read<K extends StateKey>(key: K): Promise<State[K]>
  update<K extends StateKey>(key: K, fn: (v: State[K]) => State[K]): Promise<State[K]>
  fs: {
    read(path: string): Promise<string | { base64: string }>
    list(path: string): ReturnType<E['fs']['list']>
    exists(path: string): Promise<boolean>
    write(path: string, text: string): Promise<void>
    /** `$.fs.stat` (optional: layers fall back to the parent's `list`). */
    stat?(path: string): Promise<{ kind: string; size: number; mtimeMs: number }>
  }
  session: {
    id(): Promise<string>
    root(): Promise<string>
    model(): Promise<string>
    repo(): ReturnType<E['session']['repo']>
    usage(): ReturnType<E['session']['usage']>
    append: E['session']['append']
    compact(input?: { instructions?: string }): Promise<unknown>
  }
  env: {
    os(): Promise<string | undefined>
    home(): Promise<string | undefined>
    /** `XDG_CACHE_HOME` (optional; the cache dir falls back to `<home>/.cache`). */
    cacheHome?(): Promise<string | undefined>
  }
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> }
  process: {
    run: E['process']['run']
    /** `$.process.spawn` (WP2: `/gate edit` starts the browser editor; optional for fake ports). */
    spawn?: E['process']['spawn']
  }
  /** `$.settings.read()`: merged settings, `env` block included (G-03 env whitelist; optional for fake ports). */
  settings?: { read(): Promise<Record<string, unknown>> }
  mcp: { call: E['mcp']['call'] }
  model: { complete: E['model']['complete']; classify: E['model']['classify'] }
  tool: { register: E['tool']['register']; list: E['tool']['list'] }
  command: { register: E['command']['register'] }
  ui: {
    ask: E['ui']['ask']
    toast: E['ui']['toast']
    status: E['ui']['status']
    log: E['ui']['log']
    invalidate: E['ui']['invalidate']
    open: E['ui']['open']
    close: E['ui']['close']
  }
  clock: { after(ms: number, fn: () => void): unknown }
  plugin: { root: string; name: string }
}

/** Layers name the port `$` in types only; values are always `io`. */
export type $ = Io

export interface Options {
  profile: string
  mode: 'shadow' | 'auto'
  trustBuild: 'ask' | 'always' | 'never'
  allowScripts: boolean
  brief: boolean
}

export function readOptions(o: PluginOptions | undefined): Options {
  const s = (k: string): string => (typeof o?.[k] === 'string' ? (o[k] as string) : '')
  const mode = s('mode') === 'auto' ? 'auto' : 'shadow'
  const tb = s('trustBuild')
  return {
    profile: s('profile').trim(),
    mode,
    trustBuild: tb === 'always' || tb === 'never' ? tb : 'ask',
    allowScripts: o?.allowScripts === true,
    brief: o?.brief === true,
  }
}

export interface PromptSet {
  key: string
  /** Compiled TSX prompts (`.compiled/*.json`), skill prompts included. */
  compiled: CompiledPrompt[]
  /** Markdown prompt files (`<dir>/*.md`, tier variants `<id>.<tier>.md` included), for core `assemblePrompts`. */
  markdown: { path: string; text: string }[]
  /** Prompt sources whose `.compiled` is missing or older (repo-relative). */
  stale: string[]
  diagnostics: Diagnostic[]
  /** Absolute paths worth watching. */
  watch: string[]
  /** Every source (entry and imports) of the compiled prompts, repo-relative: their mtimes feed staleness. */
  sources?: string[]
  /** Where the compiled prompts came from: the repo `.compiled`, the CLI's per-repo cache (Р3), or nowhere. */
  compiledFrom?: 'repo' | 'cache' | 'none'
}

export interface ScriptTool {
  name: string
  description: string
  path: string
  /** JSON Schema from the `# input:` header (core `parseToolHeader`). */
  inputSchema: Record<string, unknown>
  tiers?: string[]
  /** Function-level tool (`# gate-tool: <fn>` in a module): call this export through the shim. */
  fn?: string
}

export interface Runtime {
  options: Options
  ready: boolean
  root: string
  windows: boolean
  interactive: boolean
  surface: string | null
  /** Valid config, or undefined when gate.json failed validation (layer 2 off). */
  config?: GateConfig
  /** Config used by layer 1 and budgets: the valid one or defaults. */
  cfg: GateConfig
  configDiagnostics: Diagnostic[]
  disabled: Record<string, string>
  rules?: { key: string; list: MdcRule[]; diagnostics: Diagnostic[]; checkedAt: number }
  rulesDirty: boolean
  /** Last skill listing text (main loop) and the names it held. */
  listingText?: string
  listingNames: string
  mcpTools?: string[]
  agentNames: Set<string>
  itemsDirty: boolean
  items?: Item[]
  prompts?: PromptSet
  promptsDirty: boolean
  lastRender?: RenderResult
  lastHealth?: HealthReport
  /** Static section cache: id → node hash + rendered text. */
  staticCache: Map<string, { hash: string; text: string; chars: number; tokens: number }>
  /** Last sections added in prompt.compose (reused for an `analysis` render). */
  lastSections?: { id: string; text: string; scope: 'session' }[]
  skillArgs: Map<string, string>
  /** Our registered tools: full tool name → what serves it. */
  tools: Map<string, { kind: 'skill'; prompt: CompiledPrompt } | { kind: 'lazy'; ref: string; description: string } | { kind: 'script'; tool: ScriptTool }>
  /** Files read (any part) per agent, for read-before-write. */
  readFiles: Map<string, Set<string>>
  /** Files written this session (repo-relative). */
  changedPaths: Set<string>
  denies: Record<string, number>
  verifyFailed: number
  stallTurns: number
  editedThisTurn: boolean
  escalated: Set<string>
  journalBuffer: string[]
  journalText?: string
  /** Hash of the last written journal snapshot (dedup). */
  lastSnapshot?: string
  trustAsked: boolean
  recheckReason?: 'new' | 'compact' | 'auto'
  trustCache?: { key: string; hash: string; decision: 'unknown' | 'trusted' | 'denied' }
  building: boolean
  buildAttempted: Set<string>
  whitelist?: string[]
  unknownListingLogged: boolean
  /** `turn.step` usage of the main loop (G-43, health H002/H012): totals and the last step. */
  stepUsage?: { steps: number; input: number; cacheRead: number; cacheCreation: number; output: number; last?: { input: number; cacheRead: number; cacheCreation: number; output: number; model: string } }
  /** Last failed prompt build (H013 / G*), for the `prompt ⚠ build` status marker; cleared by a good build. */
  buildError?: { code: string; message: string; at: number }
  /** Model calls of each lazy include (`get_<name>`), by ref. */
  lazyCalls: Map<string, number>
  /** Module exports asked once per session (G158): module path → names (null when the shim can't tell). */
  moduleExports: Map<string, string[] | null>
  /** `.trace/last.json` throttle: last write time and content hash. */
  traceWrite?: { at: number; hash: string }
  /** Hash of the last journaled debug/assert/log batch (dedup across renders). */
  lastDebug?: string
  /** `.claude/gate.debug.log` text kept in memory (no append API). */
  debugLogText?: string
}

export function newRuntime(options: Options): Runtime {
  return {
    options,
    ready: false,
    root: '',
    windows: false,
    interactive: true,
    surface: 'terminal',
    cfg: undefined as unknown as GateConfig,
    configDiagnostics: [],
    disabled: {},
    rulesDirty: true,
    listingNames: '',
    agentNames: new Set(),
    itemsDirty: true,
    promptsDirty: true,
    staticCache: new Map(),
    skillArgs: new Map(),
    tools: new Map(),
    readFiles: new Map(),
    changedPaths: new Set(),
    denies: {},
    verifyFailed: 0,
    stallTurns: 0,
    editedThisTurn: false,
    escalated: new Set(),
    journalBuffer: [],
    trustAsked: false,
    building: false,
    buildAttempted: new Set(),
    unknownListingLogged: false,
    lazyCalls: new Map(),
    moduleExports: new Map(),
  }
}

/** One Read/Edit/Write/NotebookEdit call, as the layers see it. */
export interface FileCall {
  tool: 'Read' | 'Edit' | 'Write' | 'NotebookEdit'
  /** Path as given (absolute). */
  file: string
  /** Repo-relative POSIX. */
  rel: string
  /** `agentId` or `main`. */
  agent: string
  agentId?: string
  input: Record<string, unknown>
}

export type ToolResultLike = { deny?: unknown; isError?: unknown; context?: readonly string[] }

export const OWN_TOOL_PREFIX = 'mcp__context-gate__'

/** Join a repo-relative POSIX path onto the root (absolute paths pass through). */
export function join(root: string, rel: string): string {
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(rel)) return rel
  const r = root.replace(/[\\/]+$/, '')
  const p = rel.replace(/^\.\//, '')
  return r ? `${r}/${p}` : p
}

/** Repo-relative path stays inside the root (no `..`, not absolute). */
export function insideRoot(rel: string): boolean {
  if (/^([A-Za-z]:|[\\/])/.test(rel)) return false
  return !rel.split(/[\\/]/).includes('..')
}

export async function initRoot(io: Io, rt: Runtime): Promise<void> {
  rt.root = await io.session.root()
  let os: string | undefined
  try { os = await io.env.os() } catch { os = undefined }
  rt.windows = detectWindows(rt.root, os)
}

export function debug(io: Io, text: string): void {
  try { io.ui.log(`context-gate: ${text}`, { to: 'debug' }) } catch { /* logging is best effort */ }
}

/** Stable JSON (sorted keys) for hashing. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson((v as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(v ?? null)
}

/** FNV-1a, hex (same as render.ts hashString; kept local so this file needs no render.ts). */
export function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function now(): number {
  return Date.now()
}
