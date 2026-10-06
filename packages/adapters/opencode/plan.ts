// OpenCode V2 adapter, pure part: maps plugin hooks onto the shared gate session (common/session.ts).
// Delivery points (assumed shapes, see types.ts):
//   session.prompt       → `[gate:x]` stripped; turn decision; tier preload via `prompt.skills` (`prompt({ skills })`);
//                          `@file` Auto rules appended to the prompt text
//   session.context      → Always rules + status pushed onto `system`; MCP tools outside the profile deleted from `tools`
//   permission.evaluate  → `skill` (resource = skill id) and MCP tool actions gated off → `effect: "deny"`
//   tool.execute.after   → Auto Attached rules for `read` / `edit` / `write` paths appended to the result content
//   session.compaction   → dedup reset
// `skillPermissionRules` gives the same skill decision as `permissions` rules (`{ action: "skill", … }`) for
// `session.create({ permissions })` or `ctx.permission.rules` — what shiftwork's OpenCode backend would pass.

import type { DecisionLogEntry, Gate } from '../../core/src/types.ts'
import type { GateData, GateSession } from '../common/session.ts'
import { applyFlag, decideTurn, hiddenTools, mentionedFiles, modelIdOf, newSession, resetSession, rulesForFile, rulesForFiles, skillDeny, systemParts, systemText, toolDeny, toolPath } from '../common/session.ts'
import type { OcContextEvent, OcPermissionEvent, OcPermissionRule, OcPromptEvent, OcToolAfterEvent } from './types.ts'

export const OC_FILE_TOOLS = ['read', 'edit', 'write'] as const

export interface OcSession {
  gate: GateSession
  /** Preloaded skills already attached to a prompt in this context. */
  preloaded: string[]
}

export function newOcSession(): OcSession {
  return { gate: newSession(), preloaded: [] }
}

/**
 * OpenCode tool name → the gate's canonical `mcp__<server>__<tool>`. Names already in that form pass; otherwise a
 * `<server>_<tool>` or `<server>.<tool>` prefix of a configured MCP server (opencode.json `mcp` keys) maps.
 * ASSUMED naming: OpenCode V2's MCP tool names were not verified locally.
 */
export function canonicalToolName(name: string, servers: readonly string[]): string {
  if (name.startsWith('mcp__')) return name
  for (const s of [...servers].sort((a, b) => b.length - a.length)) {
    for (const sep of ['_', '.']) if (name.startsWith(s + sep) && name.length > s.length + 1) return `mcp__${s}__${name.slice(s.length + 1)}`
  }
  return name
}

export interface Step { log: DecisionLogEntry[] }

/** `session` hook `prompt`: one turn decision per user prompt. Mutates `event.prompt`. */
export function onPrompt(data: GateData, s: OcSession, event: OcPromptEvent, now: number): Step {
  const f = applyFlag(s.gate, event.prompt.text ?? '')
  if (f.flag) event.prompt.text = f.text
  const files = mentionedFiles(data, s.gate, f.text)
  const d = decideTurn(data, s.gate, 'opencode', { now })
  const log = [...d.log]
  // Tier preload through prompt({ skills }): attached once per context, not on every prompt.
  const want = d.gate.skills.preload.filter((n) => !s.preloaded.includes(n))
  if (want.length) {
    const skills = event.prompt.skills ?? []
    for (const id of want) if (!skills.some((x) => x.id === id)) skills.push({ id })
    event.prompt.skills = skills
    s.preloaded.push(...want)
  }
  const mention = rulesForFiles(data, s.gate, files, 'prompt', 'opencode', now)
  log.push(...mention.log)
  if (mention.text) event.prompt.text = `${event.prompt.text}\n\n${mention.text}`
  return { log }
}

/** `session` hook `context`: system prompt parts and tool hiding. A model change re-decides (trigger `model-change`). */
export function onContext(data: GateData, s: OcSession, event: OcContextEvent, servers: readonly string[], now: number, readBody?: (path: string) => string | undefined): Step {
  const log: DecisionLogEntry[] = []
  const model = event.model?.id
  let gate = s.gate.current
  let applied = !!gate && !gate.shadow
  if (!gate || (model && modelIdOf(model) !== s.gate.model)) {
    const d = decideTurn(data, s.gate, 'opencode', { now, ...(model ? { model } : {}) })
    gate = d.gate
    applied = d.applied
    log.push(...d.log)
  }
  // Preload goes through prompt({ skills }); a preload skill not attached yet (the first prompt ran before the
  // model, hence the tier, was known) is inlined here until the next prompt attaches it.
  const pending = data.items.filter((i) => i.kind !== 'skill' || !s.preloaded.includes(i.name))
  const parts = systemParts({ ...data, items: pending }, s.gate, gate, applied, 'opencode', now, readBody)
  log.push(...parts.log)
  const text = systemText(parts)
  if (text) event.system.push(text)
  const names = Object.keys(event.tools ?? {})
  const canon = new Map(names.map((n) => [canonicalToolName(n, servers), n]))
  for (const c of hiddenTools(data, s.gate, [...canon.keys()], now)) delete event.tools[canon.get(c)!]
  return { log }
}

/** `permission` hook `evaluate`: deny skills and MCP tools the gate turned off. */
export function onPermission(data: GateData, s: OcSession, event: OcPermissionEvent, servers: readonly string[], now: number): Step {
  if (event.effect === 'deny') return { log: [] }
  if (event.action === 'skill') {
    const log: DecisionLogEntry[] = []
    for (const id of event.resources) {
      const r = skillDeny(data, s.gate, id, 'opencode', now)
      log.push(...r.log)
      if (r.deny) { event.effect = 'deny'; event.message = r.deny; break }
    }
    return { log }
  }
  const tool = canonicalToolName(event.action, servers)
  const r = toolDeny(data, s.gate, tool, 'opencode', now)
  if (r.deny) { event.effect = 'deny'; event.message = r.deny }
  return { log: r.log }
}

/** `tool` hook `execute.after`: Auto Attached rules for the file a built-in file tool touched. */
export function onToolAfter(data: GateData, s: OcSession, event: OcToolAfterEvent, now: number): Step {
  if (event.status !== 'completed' || !event.result || !(OC_FILE_TOOLS as readonly string[]).includes(event.tool)) return { log: [] }
  const p = toolPath(event.input)
  if (!p) return { log: [] }
  const r = rulesForFile(data, s.gate, p, `tool:${event.tool}`, 'opencode', now, event.input)
  if (r.text) event.result.content = appendContent(event.result.content, r.text)
  return { log: r.log }
}

function appendContent(content: unknown, text: string): unknown {
  if (typeof content === 'string') return content ? `${content}\n\n${text}` : text
  if (Array.isArray(content)) return [...content, { type: 'text', text }]
  if (content === undefined || content === null) return text
  return [content, { type: 'text', text }]
}

/** `session` hook `compaction`: delivered rules and preloaded skills are gone from the context. */
export function onCompaction(s: OcSession): void {
  resetSession(s.gate)
  s.preloaded = []
}

/** The gate's skill decision as OpenCode permission rules (`deny` hides the skill and rejects loading it). */
export function skillPermissionRules(gate: Pick<Gate, 'skills' | 'shadow' | 'off'>): OcPermissionRule[] {
  if (gate.shadow || gate.off) return []
  return gate.skills.off.map((name) => ({ action: 'skill', resource: name, effect: 'deny' as const }))
}

/** MCP server names from an `opencode.json` text (`mcp` keys), tolerant of `//` comments (jsonc). */
export function mcpServersFromConfig(text: string | undefined): string[] {
  if (!text) return []
  try {
    const json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as { mcp?: Record<string, unknown> }
    return json.mcp && typeof json.mcp === 'object' ? Object.keys(json.mcp) : []
  } catch {
    return []
  }
}
