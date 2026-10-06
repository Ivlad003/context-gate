// pi extension entry (experimental): `pi -e <context-gate>/packages/adapters/pi/index.ts`, or list it under
// `pi.extensions` of a pi package. Harness glue only; the logic is in plan.ts and ../common/session.ts.
// Reads `<cwd>/.claude/gate.json` and `.cursor/rules`, journals to `<cwd>/.claude/gate.log.jsonl`.

import type { GateData, GateSession } from '../common/session.ts'
import { newSession } from '../common/session.ts'
import { appendJournal, loadGateData, loadSkillDirs, readSkillBody } from '../common/load.ts'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import type { DecisionLogEntry } from '../../core/src/types.ts'
import { onBeforeAgentStart, onCompact, onInput, onSessionStart, onToolCall, onToolResult } from './plan.ts'
import type { PiContext, PiExtensionAPI, PiInputResult } from './types.ts'

export interface PiAdapterOptions {
  /** Clock (tests). */
  now?: () => number
  env?: Record<string, string | undefined>
  /** Journal writer (tests); default appends to `<root>/.claude/gate.log.jsonl`. */
  journal?: (root: string, entries: readonly DecisionLogEntry[]) => void
  /** Skill body reader for preload (tests). */
  readBody?: (path: string) => string | undefined
  home?: string
}

/** Build the extension; `export default` below is the instance pi loads. */
export function createPiAdapter(opts: PiAdapterOptions = {}) {
  const now = opts.now ?? Date.now
  const env = opts.env ?? process.env
  const journal = opts.journal ?? appendJournal
  const readBody = opts.readBody ?? readSkillBody
  const home = opts.home ?? env.HOME ?? homedir()

  return function contextGate(pi: PiExtensionAPI): void {
    const session: GateSession = newSession()
    let data: GateData | undefined
    let root = ''

    // Reloaded at every turn so gate.json / .mdc edits apply on the next prompt.
    const load = (ctx: PiContext): GateData => {
      root = ctx.cwd
      const skills = loadSkillDirs(root, [join(root, '.claude', 'skills'), join(home, '.claude', 'skills')])
      data = loadGateData(root, skills, env)
      return data
    }
    const current = (ctx: PiContext): GateData => data && root === ctx.cwd ? data : load(ctx)
    const write = (entries: readonly DecisionLogEntry[]) => { if (entries.length) journal(root, entries) }
    // A failing gate must never break the harness: errors leave the event untouched.
    const guard = <T>(fn: () => T): T | undefined => { try { return fn() } catch { return undefined } }

    pi.on('session_start', (event) => { guard(() => onSessionStart(session, event)) })
    pi.on('session_compact', () => { guard(() => onCompact(session)) })

    pi.on('input', (event) => guard((): PiInputResult => {
      const text = onInput(session, event.text)
      return text === undefined ? { action: 'continue' } : { action: 'transform', text }
    }))

    pi.on('before_agent_start', (event, ctx) => guard(() => {
      const d = load(ctx)
      const body = (p: string) => readBody(isAbsolute(p) ? p : join(root, p))
      const step = onBeforeAgentStart(d, session, event, ctx, now(), body)
      write(step.log)
      return step.result
    }))

    pi.on('tool_call', (event, ctx) => guard(() => {
      const step = onToolCall(current(ctx), session, event, now())
      write(step.log)
      return step.result
    }))

    pi.on('tool_result', (event, ctx) => guard(() => {
      const step = onToolResult(current(ctx), session, event, now())
      write(step.log)
      return step.result
    }))
  }
}

export default createPiAdapter()
