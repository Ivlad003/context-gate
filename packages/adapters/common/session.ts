// Harness-neutral gate session for the `pi` and `opencode` adapters (SPEC "Єдина модель", harness-адаптери).
// Pure: no Node, no I/O. Same decideGate as the mod, the hooks adapter and shiftwork, over the same gate.json.
// The session object is in-memory state owned by the adapter (one per harness session); the functions below
// update it in place and return what to deliver plus the journal entries to append.

import type { DecisionLogEntry, Gate, GateConfig, GateState, Item, MdcRule, Signals } from '../../core/src/types.ts'
import { decideGate, denyText, profileParts, skillOffText, statusLine } from '../../core/src/decide.ts'
import { autoRulesFor, isPartialRead, packInjections, ruleToItem } from '../../core/src/mdc.ts'
import { normalizePath } from '../../core/src/glob.ts'
import { makeItem, ownEntry } from '../../core/src/items.ts'
import { extractMentions, extractPromptFlag, promptFlagAction } from '../../core/src/gatecmd.ts'
import { normalizeModelId, tierForModel } from '../../core/src/config.ts'

/** Log file the mod, the hooks adapter, shiftwork and these adapters share (repo-relative). */
export const GATE_LOG = '.claude/gate.log.jsonl'
/** Recent paths kept as `when.paths` signals. */
export const RECENT_PATHS = 20
/** Default cap for one rules injection (`cursorRules.maxCharsPerInjection`). */
export const DEFAULT_MAX_INJECTION = 30_000

export type AdapterName = 'pi' | 'opencode'

export interface GateEnv {
  /** Fixed profile (as `/gate <profile>`); also set by shiftwork's plan `env`. */
  CONTEXT_GATE_PROFILE?: string
  /** `auto` applies without a manual profile; `shadow` only logs. Overrides `classify.mode`. */
  CONTEXT_GATE_MODE?: string
  /** `1` → like `/gate off`. */
  CONTEXT_GATE_OFF?: string
  /** Ticket `**Type:**` from shiftwork (`profiles[*].when.ticketType`). */
  CONTEXT_GATE_TICKET_TYPE?: string
  /** Model id when the harness gives none. */
  CONTEXT_GATE_MODEL?: string
  /** Shiftwork plan: the ticket's `Skills: +a -b` as groups (or profiles) added / removed, space or comma separated. */
  CONTEXT_GATE_ADD?: string
  CONTEXT_GATE_REMOVE?: string
  /** `system`: the runner already put the tier preload into the system prompt; the adapter does not repeat it. */
  CONTEXT_GATE_PRELOAD?: string
}

/** Env keys these adapters read (load.ts `gateEnv` copies exactly these). */
export const GATE_ENV_KEYS = ['CONTEXT_GATE_PROFILE', 'CONTEXT_GATE_MODE', 'CONTEXT_GATE_OFF', 'CONTEXT_GATE_TICKET_TYPE', 'CONTEXT_GATE_MODEL', 'CONTEXT_GATE_ADD', 'CONTEXT_GATE_REMOVE', 'CONTEXT_GATE_PRELOAD'] as const

export interface GateData {
  /** Absolute repo root. */
  root: string
  config: GateConfig
  rules: readonly MdcRule[]
  /** Skills (with `provenance.path`, and `body` when known), agents and tools known up front. */
  items: readonly Item[]
  env: GateEnv
  branch?: string
  windows?: boolean
}

export interface GateSession {
  /** Dedup keys of delivered rules (`<ruleId>`), reset on compaction and on a new session. */
  seen: string[]
  /** Always rules already journaled as delivered (the text itself is re-sent with every system prompt). */
  journaledAlways: string[]
  /** Recent repo-relative paths for `when.paths`. */
  paths: string[]
  gate: GateState
  /** Prompt-level overrides: `[gate:x]`, `[gate:off]`, `[gate:auto]`. */
  manual?: { profile?: string; off?: boolean }
  model?: string
  /** Last committed decision (the turn's gate). */
  current?: Gate
  /** Last logged decision, to log only changes. */
  last?: { profile?: string; tier: string; off: boolean }
  /** `[gate:new]` / `[gate:auto]` seen; the next turn decision re-evaluates without hysteresis. */
  pendingRecheck?: boolean
}

export function newSession(): GateSession {
  return { seen: [], journaledAlways: [], paths: [], gate: { turn: 0 } }
}

/** Compaction / `/clear`-like reset: the context no longer holds delivered rules. `full` also drops paths and overrides. */
export function resetSession(s: GateSession, full = false): void {
  s.seen = []
  s.journaledAlways = []
  if (full) {
    s.paths = []
    s.manual = undefined
    s.gate = { turn: 0 }
    s.current = undefined
    s.last = undefined
  }
}

/** `anthropic/claude-sonnet-4-6` → `claude-sonnet-4-6` (the `models` globs in gate.json use bare ids). */
export function modelIdOf(ref: string | undefined): string | undefined {
  if (!ref?.trim()) return undefined
  const m = normalizeModelId(ref)
  const slash = m.lastIndexOf('/')
  return slash >= 0 ? m.slice(slash + 1) : m
}

/** Whether decisions are enforced (filter, deny, rule gating) or only logged (shadow). Same rule as the hooks adapter. */
export function isApplied(cfg: GateConfig, s: GateSession, env: GateEnv): boolean {
  if (env.CONTEXT_GATE_OFF === '1' || s.manual?.off) return false
  if (env.CONTEXT_GATE_PROFILE?.trim()) return true
  if (s.manual?.profile) return true
  // A runner plan's `Skills: +a -b` is a manual signal, like `/gate +a` in the mod.
  if (envList(env.CONTEXT_GATE_ADD).length || envList(env.CONTEXT_GATE_REMOVE).length) return true
  const mode = env.CONTEXT_GATE_MODE?.trim() || cfg.classify?.mode || 'shadow'
  return mode === 'auto'
}

/** `CONTEXT_GATE_ADD="pg, +ops"` → `['pg', 'ops']`. */
export function envList(v: string | undefined): string[] {
  return (v ?? '').split(/[\s,]+/).map((x) => x.replace(/^[+-]/, '')).filter(Boolean)
}

function manualSignal(s: GateSession, env: GateEnv): Signals['manual'] {
  if (env.CONTEXT_GATE_OFF === '1' || s.manual?.off) return { add: [], remove: [], off: true }
  const p = s.manual?.profile || env.CONTEXT_GATE_PROFILE?.trim()
  const add = envList(env.CONTEXT_GATE_ADD)
  const remove = envList(env.CONTEXT_GATE_REMOVE)
  if (!p && !add.length && !remove.length) return undefined
  return p ? { profile: p, add, remove } : { add, remove }
}

/** Is every part of `word` (`a+b` unions too) a profile gate.json declares? The mod ignores others (G502). */
export function declaredProfile(cfg: GateConfig, word: string): boolean {
  const parts = profileParts(word, cfg)
  return parts.length > 0 && parts.every((p) => ownEntry(cfg.profiles, p) !== undefined)
}

/**
 * The `[gate:x]` word that enables `group`: `[gate:x]` sets a profile, not a group, so it is the group itself only
 * when that is a declared profile, else a declared profile that contains the group (M73).
 */
export function flagForGroup(cfg: GateConfig, group: string): string | undefined {
  if (ownEntry(cfg.profiles, group)) return group
  for (const [name, p] of Object.entries(cfg.profiles ?? {})) if (p?.groups?.includes(group)) return name
  return undefined
}

function allItems(data: GateData, extra: readonly Item[]): Item[] {
  const seen = new Set<string>()
  const out: Item[] = []
  for (const it of [...extra, ...data.items, ...data.rules.map(ruleToItem)]) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    out.push(it)
  }
  return out
}

function relPath(data: GateData, p: string): string {
  return normalizePath(p, data.root, data.windows === undefined ? {} : { windows: data.windows })
}

function pushRecent(list: string[], item: string, max: number): string[] {
  const out = list.filter((x) => x !== item)
  out.push(item)
  return out.length > max ? out.slice(out.length - max) : out
}

function withAdapter(e: DecisionLogEntry, adapter: AdapterName, extra: Record<string, unknown> = {}): DecisionLogEntry {
  return { ...e, data: { ...e.data, adapter, ...extra } }
}

export interface PromptParse {
  /** Prompt text with a leading `[gate:x]` removed. */
  text: string
  recheck: boolean
  /** Repo-relative paths of `@file` mentions. */
  files: string[]
}

/**
 * A leading `[gate:x]` / `[gate:off]` / `[gate:auto]` / `[gate:new]` of a user prompt: updates the overrides. With
 * `cfg`, a profile gate.json does not declare is ignored as the mod does (G502): `ignored` carries the notice.
 */
export function applyFlag(s: GateSession, prompt: string, cfg?: GateConfig): { text: string; recheck: boolean; flag?: string; ignored?: string } {
  const flag = extractPromptFlag(prompt)
  const action = promptFlagAction(flag.profile)
  let recheck = false
  let ignored: string | undefined
  if (action === 'off') s.manual = { off: true }
  else if (action === 'auto') { s.manual = undefined; recheck = true }
  else if (action === 'new') recheck = true
  else if (flag.profile && cfg && !declaredProfile(cfg, flag.profile)) {
    ignored = `context-gate: G502 [gate:${flag.profile}]: профіль не оголошено в gate.json, прапорець проігноровано. Відомі: ${Object.keys(cfg.profiles ?? {}).join(', ') || '—'}`
  } else if (flag.profile) s.manual = { profile: flag.profile }
  if (recheck) s.pendingRecheck = true
  const out: { text: string; recheck: boolean; flag?: string; ignored?: string } = { text: flag.text, recheck }
  if (flag.profile) out.flag = flag.profile
  if (ignored) out.ignored = ignored
  return out
}

/** Repo-relative paths of `@file` mentions; they become `when.paths` signals. */
export function mentionedFiles(data: GateData, s: GateSession, prompt: string): string[] {
  const files = extractMentions(prompt).files.map((f) => relPath(data, f))
  for (const f of files) s.paths = pushRecent(s.paths, f, RECENT_PATHS)
  return files
}

/** Both of the above for one prompt. */
export function applyPrompt(data: GateData, s: GateSession, prompt: string): PromptParse {
  const f = applyFlag(s, prompt, data.config)
  return { text: f.text, recheck: f.recheck, files: mentionedFiles(data, s, f.text) }
}

export interface TurnInput {
  /** Harness model ref or id (`anthropic/claude-haiku-4-5`). */
  model?: string
  /** Items the harness reports for this turn (its skill list, its tools). */
  items?: readonly Item[]
  recheck?: 'new' | 'compact'
  now: number
}

export interface TurnDecision {
  gate: Gate
  applied: boolean
  log: DecisionLogEntry[]
}

/** A turn-advancing decision (one per user prompt, or on a model change). Logs a `decision` only on a change. */
export function decideTurn(data: GateData, s: GateSession, adapter: AdapterName, input: TurnInput): TurnDecision {
  const model = modelIdOf(input.model) ?? s.model ?? modelIdOf(data.env.CONTEXT_GATE_MODEL)
  const signals: Signals = { paths: [...s.paths], model }
  if (data.branch) signals.branch = data.branch
  if (data.env.CONTEXT_GATE_TICKET_TYPE?.trim()) signals.ticketType = data.env.CONTEXT_GATE_TICKET_TYPE.trim()
  const manual = manualSignal(s, data.env)
  if (manual) signals.manual = manual
  const recheck = input.recheck ?? (s.pendingRecheck ? 'new' : undefined)
  s.pendingRecheck = undefined
  const opts = { now: input.now, ...(s.model ? { prevModel: s.model } : {}), ...(recheck ? { recheck: true, recheckReason: recheck } : {}) }
  const r = decideGate(data.config, signals, s.gate, allItems(data, input.items ?? []), opts)
  const applied = isApplied(data.config, s, data.env)
  const gate: Gate = applied ? r.gate : { ...r.gate, shadow: true }
  s.gate = r.state
  s.current = gate
  if (model) s.model = model
  const cur: { profile?: string; tier: string; off: boolean } = { tier: gate.tier, off: gate.off }
  if (gate.profile !== undefined) cur.profile = gate.profile
  const changed = !s.last || s.last.profile !== cur.profile || s.last.tier !== cur.tier || s.last.off !== cur.off
  s.last = cur
  return { gate, applied, log: changed ? [withAdapter(r.log, adapter, applied ? {} : { shadow: true })] : [] }
}

/** The committed gate re-evaluated with extra items (a tool the turn decision didn't know), without advancing. */
export function gateWith(data: GateData, s: GateSession, extra: readonly Item[], now: number): Gate {
  const signals: Signals = { paths: [], model: s.model ?? modelIdOf(data.env.CONTEXT_GATE_MODEL) }
  const manual = manualSignal(s, data.env)
  // The committed profile holds; runner adjustments (CONTEXT_GATE_ADD/REMOVE) apply on top of it.
  if (manual && (manual.profile || manual.off || !s.gate.profile)) signals.manual = manual
  else if (s.gate.profile) signals.manual = { profile: s.gate.profile, add: manual?.add ?? [], remove: manual?.remove ?? [] }
  return decideGate(data.config, signals, s.gate, allItems(data, extra), { now }).gate
}

// ───────────────────────── system prompt ─────────────────────────

function maxInjection(cfg: GateConfig): number {
  return cfg.cursorRules?.maxCharsPerInjection ?? DEFAULT_MAX_INJECTION
}

function ruleAllowed(rule: MdcRule, gate: Gate | undefined, applied: boolean): boolean {
  if (!applied || !gate) return true
  return gate.items[`rule:${rule.id}`] !== 'off'
}

function deliveredLog(now: number, turn: number, tier: string, ids: string[], via: string, adapter: AdapterName, path?: string): DecisionLogEntry {
  return { ts: now, turn, trigger: via, tier, enabled: ids.map((i) => `rule:${i}`), disabled: [], reason: [`${via}: ${ids.join(', ')}`], kind: 'rule-delivered', data: { rules: ids, adapter, ...(path ? { path } : {}) } }
}

export interface SystemParts {
  /** `context-gate: gate frontend · tier standard · …` when applied and something is gated. */
  status?: string
  /** Always rules, framed `Contents of <path> (Cursor rule <id>):`. */
  rules?: string
  /** Preloaded skill bodies, shiftwork's `<!-- Preloaded skill: <path> -->` framing. */
  preload?: string
  /** Rule ids delivered, skill names preloaded. */
  included: string[]
  preloaded: string[]
  log: DecisionLogEntry[]
}

/**
 * What goes into the system prompt for this turn: status, Always rules, tier preload. The system prompt is
 * rebuilt every turn by both harnesses, so the text is returned every time; only the first delivery is journaled.
 * `readBody` loads a skill body by path when the item has none.
 */
export function systemParts(data: GateData, s: GateSession, gate: Gate, applied: boolean, adapter: AdapterName, now: number, readBody?: (path: string) => string | undefined): SystemParts {
  const out: SystemParts = { included: [], preloaded: [], log: [] }
  if (applied && (gate.profile || gate.mcp.off.length || gate.skills.off.length)) out.status = `context-gate: ${statusLine(gate)}`
  const always = data.rules.filter((r) => r.type === 'always' && ruleAllowed(r, gate, applied))
  if (always.length) {
    const packed = packInjections(always, maxInjection(data.config))
    if (packed.text) out.rules = packed.text
    out.included = packed.included
    const fresh = packed.included.filter((id) => !s.journaledAlways.includes(id))
    if (fresh.length) {
      s.journaledAlways.push(...fresh)
      out.log.push(deliveredLog(now, s.gate.turn, gate.tier, fresh, 'system-prompt', adapter))
    }
  }
  const bodies: string[] = []
  // Preload (Р5) only for the applied gate, as the mod's preload section (M03); not when the runner already did it.
  const preload = applied && !gate.off && data.env.CONTEXT_GATE_PRELOAD !== 'system' ? gate.skills.preload : []
  for (const name of preload) {
    const it = data.items.find((i) => i.kind === 'skill' && i.name === name)
    const path = it?.provenance.path
    const body = it?.body ?? (path && readBody ? readBody(path) : undefined)
    if (!body) continue
    bodies.push(`<!-- Preloaded skill: ${path ?? name} -->\n${body}`)
    out.preloaded.push(name)
  }
  if (bodies.length) out.preload = bodies.join('\n\n')
  return out
}

/** The parts joined as one block (for harnesses that take a flat system list). */
export function systemText(p: SystemParts): string {
  return [p.status, p.rules, p.preload].filter(Boolean).join('\n\n')
}

// ───────────────────────── skills ─────────────────────────

export interface SkillFilter<T> {
  /** Skills to advertise (on + preload; with `keepNameOnly`, the name-only ones too). */
  keep: T[]
  /** Kept but should be shown by name only (harnesses without a name-only mode keep them listed). */
  nameOnly: T[]
  /** Names removed from the listing. */
  removed: string[]
}

/** Filter a harness skill list by the gate. In shadow mode nothing is removed. */
export function filterSkills<T>(skills: readonly T[], nameOf: (s: T) => string, gate: Gate, applied: boolean): SkillFilter<T> {
  const out: SkillFilter<T> = { keep: [], nameOnly: [], removed: [] }
  for (const sk of skills) {
    const d = gate.items[`skill:${nameOf(sk)}`]
    if (!applied || d === undefined || d === 'on' || d === 'preload') out.keep.push(sk)
    else if (d === 'nameOnly') { out.keep.push(sk); out.nameOnly.push(sk) }
    else out.removed.push(nameOf(sk))
  }
  return out
}

/** Deny text for loading a gated-off skill, or undefined when allowed (shadow: logged, not denied). */
export function skillDeny(data: GateData, s: GateSession, name: string, adapter: AdapterName, now: number): { deny?: string; log: DecisionLogEntry[] } {
  const gate = s.current ?? gateWith(data, s, [], now)
  if (gate.items[`skill:${name}`] !== 'off') return { log: [] }
  const reason = skillOffText(name, gate, data.config)
  const applied = isApplied(data.config, s, data.env)
  const entry = denyLog(now, s, gate, `skill:${name}`, applied ? reason : `shadow: ${reason}`, !applied, adapter)
  return applied ? { deny: promptHint(reason, data), log: [entry] } : { log: [entry] }
}

// ───────────────────────── tools ─────────────────────────

function denyLog(now: number, s: GateSession, gate: Gate, id: string, reason: string, shadow: boolean, adapter: AdapterName): DecisionLogEntry {
  const e: DecisionLogEntry = { ts: now, turn: s.gate.turn, trigger: 'deny', tier: gate.tier, enabled: [], disabled: [id], reason: [reason], kind: 'deny', data: { adapter, shadow, ...(id.startsWith('tool:') ? { tool: id } : { id }) } }
  if (gate.profile !== undefined) e.profile = gate.profile
  return e
}

/** `/gate +x` is a mod command; in these harnesses the user switches with `[gate:x]` in the prompt. */
function promptHint(reason: string, data: Pick<GateData, 'config' | 'env'>): string {
  const text = reason.replace(/(Користувач може увімкнути|Увімкни): \/gate (\S+)/, (_m, lead: string, g: string) => {
    const flag = g === 'off' ? 'off' : flagForGroup(data.config, g.replace(/^\+/, '')) ?? 'off'
    return `${lead}: [gate:${flag}] на початку промпту`
  })
  return data.env.CONTEXT_GATE_PROFILE ? `${text} (профіль задано CONTEXT_GATE_PROFILE)` : `${text}. Або [gate:off].`
}

/** MCP tool (canonical `mcp__<server>__<tool>`) call: deny text when gated off and applied; a `deny` entry either way. */
export function toolDeny(data: GateData, s: GateSession, tool: string, adapter: AdapterName, now: number): { deny?: string; log: DecisionLogEntry[] } {
  if (!tool.startsWith('mcp__') || tool.startsWith('mcp__context-gate__')) return { log: [] }
  const item = makeItem('tool', tool, { provenance: { source: 'claude-tools' } })
  const gate = gateWith(data, s, [item], now)
  if (gate.items[item.id] !== 'off') return { log: [] }
  const reason = denyText('tool', tool, gate, data.config)
  const applied = isApplied(data.config, s, data.env)
  const entry = denyLog(now, s, gate, item.id, applied ? reason : `shadow: ${reason}`, !applied, adapter)
  return applied ? { deny: promptHint(reason, data), log: [entry] } : { log: [entry] }
}

/** Names (canonical) of MCP tools to hide from the model this turn. Empty in shadow mode. */
export function hiddenTools(data: GateData, s: GateSession, tools: readonly string[], now: number): string[] {
  if (!isApplied(data.config, s, data.env)) return []
  const mcp = tools.filter((t) => t.startsWith('mcp__') && !t.startsWith('mcp__context-gate__'))
  if (!mcp.length) return []
  const gate = gateWith(data, s, mcp.map((t) => makeItem('tool', t, { provenance: { source: 'claude-tools' } })), now)
  return mcp.filter((t) => gate.items[`tool:${t}`] === 'off')
}

// ───────────────────────── Auto Attached rules ─────────────────────────

/**
 * Auto Attached rules for a file a tool touched (or a prompt mentioned), not yet delivered in this context.
 * A full read (or a mention) of a `.mdc` counts as delivering that rule; a partial read (offset/limit) and an
 * edit/write (only the diff reached the model) don't — as the mod and the hooks adapter.
 */
export function rulesForFile(data: GateData, s: GateSession, path: string, via: string, adapter: AdapterName, now: number, toolInput?: unknown): { text?: string; rel: string; log: DecisionLogEntry[] } {
  const rel = relPath(data, path)
  s.paths = pushRecent(s.paths, rel, RECENT_PATHS)
  if (rel.endsWith('.mdc') && (via === 'tool:read' || via === 'prompt') && !isPartialRead(toolInput)) {
    const r = data.rules.find((x) => x.path === rel)
    if (r && !s.seen.includes(r.id)) s.seen.push(r.id)
  }
  const applied = isApplied(data.config, s, data.env)
  const gate = applied ? (s.current ?? gateWith(data, s, [], now)) : undefined
  const rules = autoRulesFor(data.rules, rel, { nocase: !!data.windows }).filter((r) => !s.seen.includes(r.id) && ruleAllowed(r, gate, applied))
  if (!rules.length) return { rel, log: [] }
  const packed = packInjections(rules, maxInjection(data.config))
  for (const id of packed.included) s.seen.push(id)
  const tier = gate?.tier ?? tierForModel(data.config, s.model).tier
  const log = packed.included.length ? [deliveredLog(now, s.gate.turn, tier, packed.included, via, adapter, rel)] : []
  return { text: packed.text || undefined, rel, log }
}

/** Auto Attached rules for several mentioned files, packed as one block. */
export function rulesForFiles(data: GateData, s: GateSession, files: readonly string[], via: string, adapter: AdapterName, now: number): { text?: string; log: DecisionLogEntry[] } {
  const texts: string[] = []
  const log: DecisionLogEntry[] = []
  for (const f of files) {
    const r = rulesForFile(data, s, f, via, adapter, now)
    if (r.text) texts.push(r.text)
    log.push(...r.log)
  }
  return { text: texts.length ? texts.join('\n\n') : undefined, log }
}

/** Path argument of a file tool (`path`, `file_path`, `filePath`). */
export function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const t = input as Record<string, unknown>
  const p = t.path ?? t.file_path ?? t.filePath
  return typeof p === 'string' && p ? p : undefined
}
