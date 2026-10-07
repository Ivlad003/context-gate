// OpenCode V2 plugin entry (experimental): list this file under `plugins` in opencode.json, or drop a
// re-export into `.opencode/plugins/`. Harness glue only; the logic is in plan.ts and ../common/session.ts.
// `Plugin.define` from `@opencode/plugin` is assumed to accept `{ id, setup }` as exported here; the package
// is not a dependency, so the definition object is exported plain.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { DecisionLogEntry } from '../../core/src/types.ts'
import type { GateData } from '../common/session.ts'
import { appendJournal, loadGateData, loadSkillDirs, readSkillBody } from '../common/load.ts'
import { inheritSession, mcpServersFromConfigChecked, newOcSession, onCompaction, onContext, onPermission, onPrompt, onToolAfter, type OcSession } from './plan.ts'
import type { OcPermissionEvent, OcPluginContext, OcPluginDefinition, OcToolAfterEvent } from './types.ts'

export interface OpencodeAdapterOptions {
  now?: () => number
  env?: Record<string, string | undefined>
  journal?: (root: string, entries: readonly DecisionLogEntry[]) => void
  home?: string
  /** Repo root when `ctx.location.directory` is missing. */
  root?: string
}

function readText(p: string): string | undefined {
  try { return readFileSync(p, 'utf8') } catch { return undefined }
}

/** Skill dirs OpenCode V2 discovers (research notes): its own, then the Claude and agents compatibility paths. */
export function opencodeSkillDirs(root: string, home: string): string[] {
  return [
    join(root, '.opencode', 'skills'), join(root, '.claude', 'skills'), join(root, '.agents', 'skills'),
    join(home, '.config', 'opencode', 'skills'), join(home, '.claude', 'skills'), join(home, '.agents', 'skills'),
  ]
}

export function createOpencodePlugin(opts: OpencodeAdapterOptions = {}): OcPluginDefinition {
  const now = opts.now ?? Date.now
  const env = opts.env ?? process.env
  const journal = opts.journal
  const home = opts.home ?? env.HOME ?? homedir()

  return {
    id: 'context-gate',
    setup(ctx: OcPluginContext) {
      const root = ctx.location?.directory ?? opts.root ?? process.cwd()
      const sessions = new Map<string, OcSession>()
      let data: GateData | undefined
      let servers: string[] = []
      const unreadable = new Set<string>()
      // As the mod and the hooks adapter: the file journal only with `log.file` (M28).
      const write = (entries: readonly DecisionLogEntry[]) => {
        if (!entries.length) return
        if (journal) journal(root, entries)
        else if (data?.config.log?.file) appendJournal(root, entries)
      }
      const load = (): GateData => {
        data = loadGateData(root, loadSkillDirs(root, opencodeSkillDirs(root, home)), env)
        const found: string[] = []
        for (const p of [join(root, 'opencode.json'), join(root, 'opencode.jsonc'), join(root, '.opencode', 'opencode.json'), join(home, '.config', 'opencode', 'opencode.json')]) {
          const names = mcpServersFromConfigChecked(readText(p))
          if (names) { found.push(...names); continue }
          // Without server names `<server>_<tool>` is not recognised as MCP and is never gated: say so once (L12).
          if (!unreadable.has(p)) {
            unreadable.add(p)
            write([{ ts: now(), turn: 0, trigger: 'opencode-config', tier: '', enabled: [], disabled: [], reason: [`${p} не парситься: MCP-сервери з нього не гейтяться`], kind: 'debug', data: { adapter: 'opencode', path: p } }])
          }
        }
        servers = [...new Set(found)]
        return data
      }
      const current = () => data ?? load()
      // A child (task subagent) session inherits its parent's overrides. The parent is the event's `parentID`, else
      // the session whose `task` tool is running right now (permission `task` seen, its execute.after not yet): a
      // child is created only inside that call. Any other new session (`/new`, a second client, a new tab) starts
      // fresh — inheriting from merely the latest session would leak its [gate:x] / [gate:off] into it (M27).
      const openTasks: OcSession[] = []
      const session = (id: string | undefined, parentID?: string): OcSession => {
        const key = id ?? '_'
        let s = sessions.get(key)
        if (!s) {
          s = newOcSession()
          const parent = (parentID ? sessions.get(parentID) : undefined) ?? openTasks[openTasks.length - 1]
          if (parent) inheritSession(s, parent)
          sessions.set(key, s)
        }
        return s
      }
      const taskStarted = (e: OcPermissionEvent, s: OcSession): void => { if (e.action === 'task') openTasks.push(s) }
      const taskEnded = (e: OcToolAfterEvent, s: OcSession): void => {
        if (e.tool !== 'task') return
        const i = openTasks.lastIndexOf(s)
        if (i >= 0) openTasks.splice(i, 1)
      }
      const parentOf = (e: unknown): string | undefined => {
        const p = (e as { parentID?: unknown })?.parentID
        return typeof p === 'string' ? p : undefined
      }
      const readBody = (p: string) => readSkillBody(isAbsolute(p) ? p : join(root, p))
      const guard = (fn: () => void) => { try { fn() } catch { /* never break the harness */ } }

      ctx.session.hook('prompt', (e) => guard(() => { const d = load(); write(onPrompt(d, session(e.sessionID, parentOf(e)), e, now()).log) }))
      ctx.session.hook('context', (e) => guard(() => write(onContext(current(), session(e.sessionID, parentOf(e)), e, servers, now(), readBody).log)))
      ctx.session.hook('compaction', (e) => guard(() => onCompaction(session(e.sessionID, parentOf(e)))))
      ctx.permission.hook('evaluate', (e) => guard(() => { const s = session(e.sessionID, parentOf(e)); write(onPermission(current(), s, e, servers, now()).log); if (e.effect !== 'deny') taskStarted(e, s) }))
      ctx.tool.hook('execute.after', (e) => guard(() => { const s = session(e.sessionID, parentOf(e)); taskEnded(e, s); write(onToolAfter(current(), s, e, now()).log) }))
      return () => sessions.clear()
    },
  }
}

export default createOpencodePlugin()
