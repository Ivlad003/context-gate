// Minimal local types for the pi extension API this adapter uses. pi is not a dependency of this repo, so
// these mirror `@earendil-works/pi-coding-agent` 0.99.1 (`dist/core/extensions/types.d.ts`,
// `dist/core/system-prompt.d.ts`, `dist/core/skills.d.ts`), checked against the copy installed in the
// shiftwork repo (`shiftwork/node_modules/@earendil-works/pi-coding-agent`). Only the fields read or written
// here are declared; everything else is left open. Re-check on a pi upgrade.

/** `Skill` (skills.d.ts). */
export interface PiSkill {
  name: string
  description: string
  filePath: string
  baseDir?: string
  disableModelInvocation?: boolean
  [k: string]: unknown
}

/** `NormalizedBuildSystemPromptOptions` (system-prompt.d.ts): mutable prompt sections. */
export interface PiSystemPromptOptions {
  cwd: string
  appendSystemPrompt: string
  /** Additional XML-wrapped prompt sections keyed by tag name. */
  sections: Record<string, string>
  skills: PiSkill[]
  [k: string]: unknown
}

/** `BeforeAgentStartEvent`. */
export interface PiBeforeAgentStartEvent {
  type: 'before_agent_start'
  prompt: string
  readonly systemPrompt?: string
  systemPromptOptions: PiSystemPromptOptions
}

/** `BeforeAgentStartEventResult`: `message` is a custom message added to the conversation. */
export interface PiBeforeAgentStartResult {
  message?: { customType: string; content: string; display: boolean; details?: unknown }
  systemPrompt?: string
}

export interface PiTextContent { type: 'text'; text: string }
export type PiContent = PiTextContent | { type: 'image'; [k: string]: unknown }

/** `ToolCallEvent` (any tool; built-ins `read`/`edit`/`write` take `{ path }`). */
export interface PiToolCallEvent {
  type: 'tool_call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  parentToolCallId?: string
}

/** `ToolCallEventResult`. */
export interface PiToolCallResult { block?: boolean; reason?: string }

/** `ToolResultEvent`. */
export interface PiToolResultEvent {
  type: 'tool_result'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  content: PiContent[]
  isError: boolean
}

/** `ToolResultEventResult`. */
export interface PiToolResultResult { content?: PiContent[] }

/** `InputEvent` / `InputEventResult`: fired on user input before agent processing. */
export interface PiInputEvent { type: 'input'; text: string; source?: 'interactive' | 'rpc' | 'extension' }
export type PiInputResult = { action: 'continue' } | { action: 'transform'; text: string } | { action: 'handled' }

export interface PiSessionStartEvent { type: 'session_start'; reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork' }
export interface PiSessionCompactEvent { type: 'session_compact' }

/** The parts of `ExtensionContext` used here. */
export interface PiContext {
  cwd: string
  hasUI: boolean
  model: { id: string; provider: string } | undefined
  ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void }
}

type Handler<E, R = undefined> = (event: E, ctx: PiContext) => Promise<R | void> | R | void

/** The parts of `ExtensionAPI` used here. */
export interface PiExtensionAPI {
  on(event: 'session_start', handler: Handler<PiSessionStartEvent>): unknown
  on(event: 'session_compact', handler: Handler<PiSessionCompactEvent>): unknown
  on(event: 'input', handler: Handler<PiInputEvent, PiInputResult>): unknown
  on(event: 'before_agent_start', handler: Handler<PiBeforeAgentStartEvent, PiBeforeAgentStartResult>): unknown
  on(event: 'tool_call', handler: Handler<PiToolCallEvent, PiToolCallResult>): unknown
  on(event: 'tool_result', handler: Handler<PiToolResultEvent, PiToolResultResult>): unknown
}
