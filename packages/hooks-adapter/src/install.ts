// `hooks-adapter install`: the settings snippet (hooks entries + skillOverrides) and an idempotent merge
// into `.claude/settings.local.json`. Pure; main.ts does the file I/O and the backup.

import type { Gate, GateConfig, Item, Signals } from '../../core/src/types.ts'
import { decideGate, skillOverridesFor, type SkillOverride } from '../../core/src/decide.ts'

/** Substring that marks our hook commands, so a re-install replaces them instead of adding duplicates. */
export const HOOK_MARKER = 'hooks-adapter.js'

export { skillOverridesFor, type SkillOverride }

export interface CommandHook { type: 'command'; command: string; timeout?: number }
export interface HookMatcher { matcher?: string; hooks: CommandHook[] }
export type HooksBlock = Record<string, HookMatcher[]>

export interface Settings {
  hooks?: HooksBlock
  skillOverrides?: Record<string, SkillOverride>
  [k: string]: unknown
}

/** Shell-quote a path for the hook `command` string. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

export function hookCommand(scriptPath: string, node = 'node'): string {
  return `${node} ${shellQuote(scriptPath)}`
}

/** The four events of the `claude-code-hooks` adapter. */
export function hookEntries(command: string, timeout = 10): HooksBlock {
  const h = (): CommandHook[] => [{ type: 'command', command, timeout }]
  return {
    SessionStart: [{ hooks: h() }],
    UserPromptSubmit: [{ hooks: h() }],
    PostToolUse: [{ matcher: 'Read|Edit|Write|NotebookEdit', hooks: h() }],
    PreToolUse: [{ matcher: 'mcp__.*|Edit|Write|NotebookEdit', hooks: h() }],
  }
}

export interface InstallOptions {
  profile?: string
  tier?: string
  model?: string
  hard?: boolean
  /** Write hooks only, no skillOverrides. */
  noSkillOverrides?: boolean
}

/** Decide for a fixed profile and tier (or model) — what `install` writes as skillOverrides. */
export function installGate(config: GateConfig, items: readonly Item[], opts: InstallOptions): Gate {
  let cfg = config
  let model = opts.model
  if (opts.tier && !opts.model) {
    // A tier without a model: route a synthetic model id to it.
    model = '__context-gate-tier__'
    cfg = { ...config, models: { [model]: opts.tier, ...config.models } }
  }
  const signals: Signals = { paths: [] }
  if (model) signals.model = model
  if (opts.profile) signals.manual = { profile: opts.profile, add: [], remove: [] }
  return decideGate(cfg, signals, { turn: 0 }, items).gate
}

function isOurs(m: HookMatcher): boolean {
  return Array.isArray(m?.hooks) && m.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER))
}

/** Merge our hooks and overrides into existing settings. Our previous entries are replaced; others are kept.
 * `managedSkills`: skill names we decide about; their old override keys are dropped before ours are written. */
export function mergeSettings(existing: Settings, add: { hooks?: HooksBlock; skillOverrides?: Record<string, SkillOverride>; managedSkills?: string[] }): Settings {
  const out: Settings = { ...existing }
  if (add.hooks) {
    const hooks: HooksBlock = {}
    for (const [ev, list] of Object.entries(existing.hooks ?? {})) {
      const kept = (Array.isArray(list) ? list : []).filter((m) => !isOurs(m))
      if (kept.length) hooks[ev] = kept
    }
    for (const [ev, list] of Object.entries(add.hooks)) hooks[ev] = [...(hooks[ev] ?? []), ...list]
    out.hooks = hooks
  }
  if (add.skillOverrides) {
    const so: Record<string, SkillOverride> = { ...(existing.skillOverrides ?? {}) }
    for (const n of add.managedSkills ?? []) delete so[n]
    Object.assign(so, add.skillOverrides)
    if (Object.keys(so).length) out.skillOverrides = so
    else delete out.skillOverrides
  }
  return out
}

/** Remove our hooks (and, with `managedSkills`, those override keys): `install --uninstall`. */
export function unmergeSettings(existing: Settings, managedSkills: string[] = []): Settings {
  const out = mergeSettings(existing, { hooks: {}, skillOverrides: {}, managedSkills })
  if (out.hooks && !Object.keys(out.hooks).length) delete out.hooks
  return out
}
