// `hooks-adapter install`: the settings snippet (hooks entries + skillOverrides) and an idempotent merge
// into `.claude/settings.local.json`. Pure; main.ts does the file I/O and the backup.

import type { Gate, GateConfig, Item, Signals } from '../../core/src/types.ts'
import { decideGate, profileParts, skillOverridesFor, type SkillOverride } from '../../core/src/decide.ts'
import { ownEntry } from '../../core/src/items.ts'

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

/** `args`: flags for hook mode (`--with-mod`: run even when the context-gate mod plugin is enabled). */
export function hookCommand(scriptPath: string, node = 'node', args: readonly string[] = []): string {
  return [node, shellQuote(scriptPath), ...args.map(shellQuote)].join(' ')
}

/** The events of the `claude-code-hooks` adapter. SubagentStart delivers the Always rules to subagents (they don't
 * inherit SessionStart context). `modelSwitch` adds PostModelSwitch (the tier follows `/model`); it is opt-in
 * because older Claude Code builds, the ones this fallback exists for, may not know the event. */
export function hookEntries(command: string, timeout = 10, opts: { modelSwitch?: boolean } = {}): HooksBlock {
  const h = (): CommandHook[] => [{ type: 'command', command, timeout }]
  const out: HooksBlock = {
    SessionStart: [{ hooks: h() }],
    UserPromptSubmit: [{ hooks: h() }],
    PostToolUse: [{ matcher: 'Read|Edit|Write|NotebookEdit', hooks: h() }],
    PreToolUse: [{ matcher: 'mcp__.*|Edit|Write|NotebookEdit', hooks: h() }],
    SubagentStart: [{ hooks: h() }],
  }
  if (opts.modelSwitch) out.PostModelSwitch = [{ hooks: h() }]
  return out
}

export interface InstallOptions {
  profile?: string
  tier?: string
  model?: string
  hard?: boolean
  /** Write hooks only, no skillOverrides. */
  noSkillOverrides?: boolean
}

/** `--profile` names that gate.json does not declare (a typo would hide most skills for good; the mod says G502). */
export function unknownProfiles(config: GateConfig, profile: string | undefined): string[] {
  return profileParts(profile, config).filter((p) => ownEntry(config.profiles, p) === undefined)
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

/** One of our hook commands: `<node> <path>/hooks-adapter.js [flags]` (the script word, not any substring). */
export function isOurHook(h: CommandHook | undefined): boolean {
  return typeof h?.command === 'string' && /^\s*\S+\s+(?:'(?:[^']*[\\/])?|(?:[^\s']*[\\/])?)hooks-adapter\.js'?(?:\s|$)/.test(h.command)
}

/** A matcher without our hooks; undefined when nothing of the user's is left in it. */
function withoutOurs(m: HookMatcher): HookMatcher | undefined {
  if (!Array.isArray(m?.hooks)) return m
  const hooks = m.hooks.filter((h) => !isOurHook(h))
  if (hooks.length === m.hooks.length) return m
  return hooks.length ? { ...m, hooks } : undefined
}

/** Merge our hooks and overrides into existing settings. Our previous entries are replaced; others are kept.
 * `managedSkills`: override keys that are ours (main.ts passes the keys a previous install wrote and the user
 * has not changed since); they are dropped before ours are written. Any other key is the user's. */
export function mergeSettings(existing: Settings, add: { hooks?: HooksBlock; skillOverrides?: Record<string, SkillOverride>; managedSkills?: string[] }): Settings {
  const out: Settings = { ...existing }
  if (add.hooks) {
    const hooks: HooksBlock = {}
    for (const [ev, list] of Object.entries(existing.hooks ?? {})) {
      // Only our commands go: a user's hook that shares the matcher group stays (L83).
      const kept = (Array.isArray(list) ? list : []).map(withoutOurs).filter((m): m is HookMatcher => m !== undefined)
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
