// Minimal local types for the OpenCode V2 plugin API this adapter uses. Neither `@opencode/plugin` nor its
// types are installed anywhere locally, so these are ASSUMED shapes, assembled from:
//   - the installed `opencode` 2.0.20 binary (its bundled server JS): the hook trigger sites
//     `trigger("session","prompt",{sessionID,messageID,prompt:{text,files,agents,skills},metadata,delivery})`,
//     `trigger("permission","evaluate",{sessionID,agent,action,resources,metadata,source,effect})`,
//     `trigger("tool","execute.after",{tool,sessionID,agent,messageID,id,input,status,result|error})`,
//     the `context` hook (`{...,agent,tools}` with `system.push(...)`, `delete tools[name]`, `model.id`),
//     the skill tool's `assert({action:"skill",resources:[skill.id]})`, and the built-in read/write
//     tools' `{ path }` input;
//   - shiftwork's research notes (`research/opencode-plugins-report.md`, v2 docs): `Plugin.define({ id, setup })`,
//     `ctx.<domain>.hook(name, cb)`, `ctx.location.directory`, `ctx.permission.rules({ sessionID, permissions })`.
// The built-in plugins mutate the event object in place; this adapter does the same. Verify against
// `@opencode/plugin` types before relying on it.

export type OcEffect = 'allow' | 'ask' | 'deny'

/** A permission rule (`agents.<id>.permissions`, `session.create({ permissions })`): last match wins. */
export interface OcPermissionRule { action: string; resource: string; effect: OcEffect }

/** `session` hook `prompt` (admission): `prompt` is a clone the plugin may edit. */
export interface OcPromptEvent {
  sessionID: string
  messageID?: string
  prompt: { text: string; files?: unknown[]; agents?: unknown[]; skills?: { id: string; mention?: unknown }[] }
  metadata?: unknown
  delivery?: string
}

/** `session` hooks `context` / `compaction` / `generate`: before every agent-loop call. */
export interface OcContextEvent {
  sessionID?: string
  agent?: string
  model?: { id: string; providerID?: string }
  /** System prompt parts; built-in plugins push strings (`rc.make(text)`). */
  system: unknown[]
  messages?: unknown[]
  /** Tools offered to the model, keyed by name; deleting a key hides the tool. */
  tools: Record<string, unknown>
}

/** `permission` hook `evaluate`: set `effect` (and `message`) to override the decision. */
export interface OcPermissionEvent {
  sessionID: string
  agent?: string
  action: string
  resources: string[]
  metadata?: unknown
  source?: unknown
  effect: OcEffect
  message?: string
}

/** `tool` hook `execute.after`. `result.content` is a string or a content-part array. */
export interface OcToolAfterEvent {
  tool: string
  sessionID: string
  agent?: string
  messageID?: string
  id?: string
  input: unknown
  status: 'completed' | 'error'
  result?: { output?: unknown; content: unknown; metadata?: unknown }
  error?: unknown
}

type Hook<E> = (event: E) => void | Promise<void>

/** The parts of the V2 plugin `ctx` used here. */
export interface OcPluginContext {
  location?: { directory?: string }
  options?: Record<string, unknown>
  session: {
    hook(name: 'prompt', cb: Hook<OcPromptEvent>): unknown
    hook(name: 'context' | 'compaction' | 'generate', cb: Hook<OcContextEvent>): unknown
  }
  tool: { hook(name: 'execute.after', cb: Hook<OcToolAfterEvent>): unknown }
  permission: {
    hook(name: 'evaluate', cb: Hook<OcPermissionEvent>): unknown
    /** Per-session rules (from the research notes, unverified). */
    rules?(input: { sessionID: string; permissions: OcPermissionRule[] }): unknown
  }
}

/** What `Plugin.define` takes (assumed identity-like). */
export interface OcPluginDefinition {
  id: string
  setup(ctx: OcPluginContext): Promise<(() => void) | void> | (() => void) | void
}
