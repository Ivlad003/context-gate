// User-level settings (SPEC Р2/Р3): binary whitelist `~/.claude/context-gate.json`, trust store
// `~/.claude/context-gate.trust.json` keyed by root + remote, cache dir `~/.cache/context-gate/<repo>/`.

import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { GateConfig } from '../../core/src/types.ts'
import { binaryWhitelist as coreWhitelist } from '../../core/src/config.ts'
import { readJson, sha256, writeJson } from './util.ts'

export interface UserSettings {
  /** Binaries executors / cli providers may start. The repo can only narrow this list. */
  allowBinaries?: string[]
  /** `always` trusts every repo, `never` none; default asks (`trust grant`). */
  trustBuild?: 'always' | 'never' | 'ask'
  /** Allow `@run`/`@call` at all (default true when trusted). */
  allowScripts?: boolean
}

export { DEFAULT_BINARIES } from '../../core/src/config.ts'

export function homeDir(): string {
  return process.env.HOME || homedir()
}

export function userSettingsPath(): string {
  return join(homeDir(), '.claude', 'context-gate.json')
}

export function readUserSettings(): UserSettings {
  return readJson<UserSettings>(userSettingsPath()) ?? {}
}

/** Effective whitelist: user list (or defaults) ∩ repo narrowing (`executors` commands, when the repo declares any). */
export function binaryWhitelist(user: UserSettings, repoNarrow?: string[]): Set<string> {
  return new Set(coreWhitelist(user.allowBinaries, repoNarrow))
}

export function binaryName(cmd: string): string {
  return basename(cmd)
}

// ───────────────────────── repo identity ─────────────────────────

export function gitRemote(root: string): string {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim()
  } catch {
    return ''
  }
}

export function repoKey(root: string, remote = gitRemote(root)): string {
  return `${root}|${remote}`
}

/** Directory name for the per-repo cache: `<name>-<hash12>`. */
export function repoHash(root: string, remote?: string): string {
  return `${basename(root).replace(/[^\w.-]+/g, '_') || 'repo'}-${sha256(repoKey(root, remote)).slice(0, 12)}`
}

export function cacheRoot(): string {
  return join(process.env.XDG_CACHE_HOME || join(homeDir(), '.cache'), 'context-gate')
}

export function repoCacheDir(root: string, remote?: string): string {
  return join(cacheRoot(), repoHash(root, remote))
}

// ───────────────────────── trust ─────────────────────────

export interface TrustRecord { decision: 'trusted' | 'denied'; at: number; commandsHash: string; root: string; remote: string }
export interface TrustStore { version: 1; repos: Record<string, TrustRecord> }

export function trustPath(): string {
  return join(homeDir(), '.claude', 'context-gate.trust.json')
}

export function readTrust(): TrustStore {
  const t = readJson<TrustStore>(trustPath())
  return t && typeof t === 'object' && t.repos ? t : { version: 1, repos: {} }
}

/** Hash of every command the repo config can start (executors, cli providers, gates): a change re-asks trust. */
export function commandsHash(config: Partial<GateConfig> | undefined): string {
  const cmds = {
    executors: config?.executors ?? {},
    providers: Object.fromEntries(Object.entries(config?.providers ?? {}).filter(([, p]) => p.kind === 'cli' || p.kind === 'module' || p.kind === 'mcp').map(([k, p]) => [k, { kind: p.kind, command: p.command, functions: p.functions, path: p.path, tool: p.tool }])),
    gates: (config?.gates ?? []).map((g) => g.run ?? null),
  }
  return sha256(JSON.stringify(cmds)).slice(0, 16)
}

export type TrustState = { trusted: boolean; source: 'flag' | 'settings' | 'store' | 'none' | 'changed' | 'denied'; key: string }

export function trustState(root: string, config: Partial<GateConfig> | undefined, opts: { flag?: boolean; remote?: string } = {}): TrustState {
  const remote = opts.remote ?? gitRemote(root)
  const key = repoKey(root, remote)
  if (opts.flag) return { trusted: true, source: 'flag', key }
  const user = readUserSettings()
  if (user.trustBuild === 'always') return { trusted: true, source: 'settings', key }
  if (user.trustBuild === 'never') return { trusted: false, source: 'settings', key }
  const rec = readTrust().repos[key]
  if (!rec) return { trusted: false, source: 'none', key }
  if (rec.decision === 'denied') return { trusted: false, source: 'denied', key }
  if (rec.commandsHash !== commandsHash(config)) return { trusted: false, source: 'changed', key }
  return { trusted: true, source: 'store', key }
}

export function setTrust(root: string, config: Partial<GateConfig> | undefined, decision: TrustRecord['decision'] | 'revoke', remote = gitRemote(root)): string {
  const store = readTrust()
  const key = repoKey(root, remote)
  if (decision === 'revoke') delete store.repos[key]
  else store.repos[key] = { decision, at: Date.now(), commandsHash: commandsHash(config), root, remote }
  writeJson(trustPath(), store)
  return key
}
