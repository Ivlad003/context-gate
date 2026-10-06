// pi adapter, pure part: maps pi extension events onto the shared gate session (common/session.ts).
// Delivery points (pi 0.99.1, see types.ts):
//   input              → strip a leading `[gate:x]` (InputEventResult `transform`)
//   before_agent_start → skills: filter `systemPromptOptions.skills`; Always rules + status + tier preload:
//                        `systemPromptOptions.sections['context-gate']`; `@file` Auto rules: a hidden custom message
//   tool_call          → MCP tools (`mcp__<server>__<tool>`, pi's own MCP naming) outside the profile: `{ block, reason }`
//   tool_result        → Auto Attached rules for `read` / `edit` / `write` paths appended to the result content
//   session_start / session_compact → dedup reset

import type { DecisionLogEntry, Item } from '../../core/src/types.ts'
import { makeItem } from '../../core/src/items.ts'
import type { GateData, GateSession } from '../common/session.ts'
import { applyFlag, decideTurn, filterSkills, mentionedFiles, resetSession, rulesForFiles, rulesForFile, systemParts, systemText, toolDeny, toolPath } from '../common/session.ts'
import type { PiBeforeAgentStartEvent, PiBeforeAgentStartResult, PiContext, PiSessionStartEvent, PiSkill, PiToolCallEvent, PiToolCallResult, PiToolResultEvent, PiToolResultResult } from './types.ts'

/** Tag of the system prompt section this adapter owns (`<context-gate>…</context-gate>`). */
export const PI_SECTION = 'context-gate'
/** `customType` of the hidden message that carries `@file` rules. */
export const PI_MESSAGE_TYPE = 'context-gate'
/** pi built-in file tools whose `path` argument attaches Auto rules. */
export const PI_FILE_TOOLS = ['read', 'edit', 'write'] as const

export interface Step<R> {
  result?: R
  log: DecisionLogEntry[]
}

/** pi's skill list as gate items (name, description, SKILL.md path for preload). */
export function skillItems(skills: readonly PiSkill[]): Item[] {
  return skills.map((sk) => {
    const extra: Partial<Item> = { provenance: { source: 'pi-skills', path: sk.filePath } }
    if (sk.description) extra.description = sk.description
    return makeItem('skill', sk.name, extra)
  })
}

/** `ctx.model` → model ref (`anthropic/claude-sonnet-4-6`); the session strips the provider. */
export function piModelRef(ctx: Pick<PiContext, 'model'>): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined
}

/** `input`: apply and strip a leading `[gate:x]`. Returns the transformed text, or undefined to continue unchanged. */
export function onInput(s: GateSession, text: string): string | undefined {
  const f = applyFlag(s, text)
  return f.flag ? f.text : undefined
}

/**
 * `before_agent_start`: one turn decision. Mutates `event.systemPromptOptions` in place (pi documents the
 * options as mutable; later handlers see the change) and returns the hidden `@file` rules message, if any.
 */
export function onBeforeAgentStart(data: GateData, s: GateSession, event: PiBeforeAgentStartEvent, ctx: Pick<PiContext, 'model'>, now: number, readBody?: (path: string) => string | undefined): Step<PiBeforeAgentStartResult> {
  const opts = event.systemPromptOptions
  const skills = opts.skills ?? []
  const pre = applyFlag(s, event.prompt ?? '')
  const files = mentionedFiles(data, s, pre.text)
  const pathItems = skillItems(skills)
  const sessionData: GateData = { ...data, items: mergeItems(pathItems, data.items) }
  const d = decideTurn(sessionData, s, 'pi', { model: piModelRef(ctx), items: pathItems, now })
  const log = [...d.log]

  const f = filterSkills(skills, (sk) => sk.name, d.gate, d.applied)
  opts.skills = f.keep

  const parts = systemParts(sessionData, s, d.gate, d.applied, 'pi', now, readBody)
  log.push(...parts.log)
  const text = systemText(parts)
  if (!opts.sections) opts.sections = {}
  if (text) opts.sections[PI_SECTION] = text
  else delete opts.sections[PI_SECTION]

  const mention = rulesForFiles(sessionData, s, files, 'prompt', 'pi', now)
  log.push(...mention.log)
  const result: PiBeforeAgentStartResult | undefined = mention.text ? { message: { customType: PI_MESSAGE_TYPE, content: mention.text, display: false } } : undefined
  return result ? { result, log } : { log }
}

/** Data items first; the harness list fills in what disk loading didn't see (pi's own skill dirs). */
function mergeItems(harness: readonly Item[], disk: readonly Item[]): Item[] {
  const byId = new Map<string, Item>()
  for (const it of harness) byId.set(it.id, it)
  for (const it of disk) byId.set(it.id, { ...byId.get(it.id), ...it })
  return [...byId.values()]
}

/** `tool_call`: block MCP tools gated off by the profile. */
export function onToolCall(data: GateData, s: GateSession, event: PiToolCallEvent, now: number): Step<PiToolCallResult> {
  const r = toolDeny(data, s, event.toolName, 'pi', now)
  return r.deny ? { result: { block: true, reason: r.deny }, log: r.log } : { log: r.log }
}

/** `tool_result`: append Auto Attached rules for the file a built-in file tool touched. */
export function onToolResult(data: GateData, s: GateSession, event: PiToolResultEvent, now: number): Step<PiToolResultResult> {
  if (event.isError || !(PI_FILE_TOOLS as readonly string[]).includes(event.toolName)) return { log: [] }
  const p = toolPath(event.input)
  if (!p) return { log: [] }
  const r = rulesForFile(data, s, p, `tool:${event.toolName}`, 'pi', now, event.input)
  if (!r.text) return { log: r.log }
  return { result: { content: [...event.content, { type: 'text', text: r.text }] }, log: r.log }
}

/** `session_start`: a new session starts clean; a resumed or forked one re-delivers rules. */
export function onSessionStart(s: GateSession, event: Pick<PiSessionStartEvent, 'reason'>): void {
  if (event.reason === 'new') resetSession(s, true)
  else if (event.reason === 'resume' || event.reason === 'fork') resetSession(s)
}

/** `session_compact`: delivered rules are gone from the context. */
export function onCompact(s: GateSession): void {
  resetSession(s)
}
