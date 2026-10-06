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
import { mcpServersFromConfig, newOcSession, onCompaction, onContext, onPermission, onPrompt, onToolAfter, type OcSession } from './plan.ts'
import type { OcPluginContext, OcPluginDefinition } from './types.ts'

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
  const journal = opts.journal ?? appendJournal
  const home = opts.home ?? env.HOME ?? homedir()

  return {
    id: 'context-gate',
    setup(ctx: OcPluginContext) {
      const root = ctx.location?.directory ?? opts.root ?? process.cwd()
      const sessions = new Map<string, OcSession>()
      let data: GateData | undefined
      let servers: string[] = []
      const load = (): GateData => {
        data = loadGateData(root, loadSkillDirs(root, opencodeSkillDirs(root, home)), env)
        servers = [...new Set([
          ...mcpServersFromConfig(readText(join(root, 'opencode.json'))),
          ...mcpServersFromConfig(readText(join(root, 'opencode.jsonc'))),
          ...mcpServersFromConfig(readText(join(root, '.opencode', 'opencode.json'))),
          ...mcpServersFromConfig(readText(join(home, '.config', 'opencode', 'opencode.json'))),
        ])]
        return data
      }
      const current = () => data ?? load()
      const session = (id: string | undefined): OcSession => {
        const key = id ?? '_'
        let s = sessions.get(key)
        if (!s) { s = newOcSession(); sessions.set(key, s) }
        return s
      }
      const write = (entries: readonly DecisionLogEntry[]) => { if (entries.length) journal(root, entries) }
      const readBody = (p: string) => readSkillBody(isAbsolute(p) ? p : join(root, p))
      const guard = (fn: () => void) => { try { fn() } catch { /* never break the harness */ } }

      ctx.session.hook('prompt', (e) => guard(() => write(onPrompt(load(), session(e.sessionID), e, now()).log)))
      ctx.session.hook('context', (e) => guard(() => write(onContext(current(), session(e.sessionID), e, servers, now(), readBody).log)))
      ctx.session.hook('compaction', (e) => guard(() => onCompaction(session(e.sessionID))))
      ctx.permission.hook('evaluate', (e) => guard(() => write(onPermission(current(), session(e.sessionID), e, servers, now()).log)))
      ctx.tool.hook('execute.after', (e) => guard(() => write(onToolAfter(current(), session(e.sessionID), e, now()).log)))
      return () => sessions.clear()
    },
  }
}

export default createOpencodePlugin()
