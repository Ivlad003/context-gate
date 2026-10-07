// Node side of the hooks adapter: load gate.json, .cursor/rules, skills, git branch; session state and journal I/O.

import type { Dirent } from 'node:fs'
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { DecisionLogEntry, Diagnostic, GateConfig, Item, MdcRule } from '../../core/src/types.ts'
import { defaultConfig, loadConfig } from '../../core/src/config.ts'
import { loadRuleSources, type RuleSourceFs } from '../../core/src/mdc.ts'
import { staticProviderValue } from '../../core/src/providers.ts'
import { makeItem } from '../../core/src/items.ts'
import { toJsonl } from '../../core/src/journal.ts'
import { mergeStates, reviveState, stateChanged, type SessionState } from './handle.ts'
import { GATE_LOG } from './shiftwork.ts'

function readText(p: string): string | undefined {
  try { return readFileSync(p, 'utf8') } catch { return undefined }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export function projectRoot(input: { cwd?: string }, env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
}

export function loadGateConfig(root: string): { config: GateConfig; diagnostics: Diagnostic[]; present: boolean } {
  const text = readText(join(root, '.claude', 'gate.json'))
  const r = loadConfig(text)
  return { config: r.config ?? defaultConfig(), diagnostics: r.diagnostics, present: text !== undefined }
}

/** Sync repo port for core `loadRuleSources` (repo-relative POSIX paths; links are not followed). */
export function nodeRuleFs(root: string): RuleSourceFs {
  return {
    list(dir) {
      let entries: Dirent[]
      try { entries = readdirSync(dir ? join(root, dir) : root, { withFileTypes: true }) } catch { return [] }
      const out: { name: string; kind: 'file' | 'dir' }[] = []
      for (const e of entries) {
        if (e.isFile()) out.push({ name: e.name, kind: 'file' })
        else if (e.isDirectory()) out.push({ name: e.name, kind: 'dir' })
      }
      return out
    },
    read: (path) => readText(join(root, path)),
  }
}

/**
 * Rules of every source, as the mod (core `loadRuleSources`): `.cursor/rules`, `cursor-mdc` dirs (and nested
 * `*\/.cursor/rules`), `markdown-dir`, and `provider` sources over `file` providers (core `staticProviderValue`;
 * cli/module/mcp providers need trust and are skipped with G208). Empty when the cursor layer is off or
 * transpiled `.claude/rules/cursor/` exists (edge case 7).
 */
export function loadRules(root: string, config: GateConfig): { rules: MdcRule[]; diagnostics: Diagnostic[]; skipped?: string } {
  if (config.cursorRules?.enabled === false) return { rules: [], diagnostics: [], skipped: 'cursorRules.enabled: false' }
  if (existsSync(join(root, '.claude', 'rules', 'cursor'))) return { rules: [], diagnostics: [], skipped: '.claude/rules/cursor/ є: правила доставляє Claude Code нативно' }
  const fs = nodeRuleFs(root)
  return loadRuleSources(config, fs, { providerValue: (name) => staticProviderValue(config, name, fs.read) })
}

function frontmatter(text: string): { fm: Record<string, string>; body: string } {
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t)
  if (!m) return { fm: {}, body: t }
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return { fm, body: t.slice(m[0].length) }
}

/** Skills from `<root>/.claude/skills/<name>/SKILL.md` and `~/.claude/skills/<name>/SKILL.md` (project wins). */
export function loadSkills(root: string, home: string = process.env.HOME || homedir()): Item[] {
  const items: Item[] = []
  const seen = new Set<string>()
  for (const [base, source] of [[join(root, '.claude', 'skills'), 'project'], [join(home, '.claude', 'skills'), 'user']] as const) {
    let entries: Dirent[]
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      const file = join(base, e.name, 'SKILL.md')
      const text = readText(file)
      if (text === undefined) continue
      const { fm, body } = frontmatter(text)
      const name = fm.name || e.name
      if (seen.has(name)) continue
      seen.add(name)
      const rel = toPosix(relative(root, file))
      const path = source === 'project' && !rel.startsWith('..') ? rel : toPosix(file)
      const extra: Partial<Item> = { body, provenance: { source: 'claude-skills', path } }
      if (fm.description) extra.description = fm.description
      items.push(makeItem('skill', name, extra))
    }
  }
  return items
}

/** Branch from `.git/HEAD` (worktrees: `.git` is a `gitdir:` file). */
export function readBranch(root: string): string | undefined {
  let gitDir = join(root, '.git')
  try {
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))
      if (!m) return undefined
      gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : join(root, m[1].trim())
    }
  } catch { return undefined }
  const head = readText(join(gitDir, 'HEAD'))
  const m = head && /^ref:\s*refs\/heads\/(.+)$/m.exec(head)
  return m ? m[1].trim() : undefined
}

// ───────────────────────── state ─────────────────────────

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONTEXT_GATE_CACHE_DIR ? join(env.CONTEXT_GATE_CACHE_DIR, 'hooks') : join(env.HOME || homedir(), '.cache', 'context-gate', 'hooks')
}

export function statePath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = sessionId.replace(/[^\w.-]+/g, '_').slice(0, 128) || 'unknown'
  return join(stateDir(env), `${safe}.json`)
}

export function readState(sessionId: string, env: NodeJS.ProcessEnv = process.env): SessionState {
  const text = readText(statePath(sessionId, env))
  if (text === undefined) return reviveState(undefined)
  try { return reviveState(JSON.parse(text)) } catch { return reviveState(undefined) }
}

/** Atomic replace: write a sibling temp file, then rename over the target. */
export function writeFileAtomic(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, p)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* nothing to clean */ }
    throw e
  }
}

export function writeState(sessionId: string, state: SessionState, env: NodeJS.ProcessEnv = process.env): void {
  writeFileAtomic(statePath(sessionId, env), JSON.stringify(state))
}

/** Lock waits: parallel tool calls run their hooks concurrently (R4); handling an event under the lock takes ms. */
const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 10_000

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** O_EXCL lock file next to the state file; a lock older than LOCK_STALE_MS (crashed process) is broken. */
export function acquireLock(path: string, waitMs = LOCK_WAIT_MS): (() => void) | undefined {
  const lock = `${path}.lock`
  try { mkdirSync(dirname(lock), { recursive: true }) } catch { return undefined }
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      closeSync(fd)
      return () => { try { unlinkSync(lock) } catch { /* already gone */ } }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
      let stale = false
      try { stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS } catch { /* released meanwhile */ }
      if (stale) { try { unlinkSync(lock) } catch { /* another process broke it */ } }
      if (Date.now() >= deadline) return undefined
      if (stale) continue
      sleepMs(5 + Math.floor(Math.random() * 10))
    }
  }
}

/**
 * Read-modify-write of one session's state under a lock (R4): `fn` gets the current state and returns the next.
 * Without the lock (timeout, unwritable dir) the write still merges with what is on disk by then, so parallel
 * PostToolUse hooks never drop each other's `read` / `seen` entries. An unchanged state is not written.
 * Write errors are returned, never thrown: the hook output must reach stdout anyway.
 */
export function updateState<T extends { state: SessionState }>(sessionId: string, env: NodeJS.ProcessEnv, fn: (state: SessionState) => T): { result: T; error?: Error } {
  const p = statePath(sessionId, env)
  const release = acquireLock(p)
  try {
    const base = readState(sessionId, env)
    const result = fn(base)
    if (!stateChanged(base, result.state)) return { result }
    try {
      writeState(sessionId, release ? result.state : mergeStates(base, result.state, readState(sessionId, env)), env)
      return { result }
    } catch (e) { return { result, error: e as Error } }
  } finally {
    release?.()
  }
}

/**
 * The parent session of a forked transcript: the last `sessionId` that is not `self`, read from the transcript's
 * tail. The copied lines keep their original ids, so a fork of a fork holds the grandparent's lines first and the
 * direct parent's right before the fork point. (Assumed transcript format, not verified against Claude Code's
 * fork output.) Undefined when unreadable or not found.
 */
export function parentSessionId(transcriptPath: string | undefined, self: string): string | undefined {
  if (!transcriptPath) return undefined
  let text: string
  try {
    const fd = openSync(transcriptPath, 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(size, 256 * 1024)
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, size - len)
      text = buf.subarray(0, n).toString('utf8')
    } finally { closeSync(fd) }
  } catch { return undefined }
  const re = /"session_?[iI]d"\s*:\s*"([^"]+)"/g
  let m: RegExpExecArray | null
  let last: string | undefined
  while ((m = re.exec(text))) if (m[1] !== self) last = m[1]
  return last
}

/** A state file exists for this session (a fork seeds only from a real parent). */
export function hasState(sessionId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(statePath(sessionId, env))
}

// ───────────────────────── install side ─────────────────────────

/** `~/.cache/context-gate` (or CONTEXT_GATE_CACHE_DIR): state, backups. */
export function cacheBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONTEXT_GATE_CACHE_DIR || join(env.HOME || homedir(), '.cache', 'context-gate')
}

/** Backup copy of a settings file outside the repo (it may hold tokens; L86): `<cache>/backups/<path>.bak-<ts>`. */
export function backupPath(settingsPath: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): string {
  const safe = settingsPath.replace(/[^\w.-]+/g, '_').replace(/^_+/, '').slice(-160)
  return join(cacheBase(env), 'backups', `${safe}.bak-${now.toISOString().replace(/[:.]/g, '-')}`)
}

/** Sidecar record of the skillOverrides `install` wrote into a settings file (only those keys are ours). */
export function installRecordPath(settingsPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = settingsPath.replace(/[^\w.-]+/g, '_').replace(/^_+/, '').slice(-160)
  return join(cacheBase(env), 'installs', `${safe}.json`)
}

export function readInstallRecord(settingsPath: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const text = readText(installRecordPath(settingsPath, env))
  if (text === undefined) return {}
  try {
    const raw = JSON.parse(text) as { skillOverrides?: unknown }
    const so = raw?.skillOverrides
    if (!so || typeof so !== 'object') return {}
    return Object.fromEntries(Object.entries(so as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch { return {} }
}

export function writeInstallRecord(settingsPath: string, skillOverrides: Record<string, string>, env: NodeJS.ProcessEnv = process.env): void {
  writeFileAtomic(installRecordPath(settingsPath, env), JSON.stringify({ settings: settingsPath, skillOverrides }, null, 2) + '\n')
}

/**
 * Is the context-gate mod plugin enabled (`enabledPlugins["context-gate@…"]: true` in user, project or local
 * settings)? Then the mod delivers rules and denies itself, and this adapter would do it twice (O3).
 */
export function modPluginEnabled(root: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.HOME || homedir()
  // Most specific scope first: a local `false` beats a user-wide `true`.
  const decided = new Map<string, { on: boolean; file: string }>()
  for (const p of [join(root, '.claude', 'settings.local.json'), join(root, '.claude', 'settings.json'), join(home, '.claude', 'settings.json')]) {
    const text = readText(p)
    if (!text) continue
    try {
      const ep = (JSON.parse(text) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins
      if (!ep || typeof ep !== 'object') continue
      for (const [k, v] of Object.entries(ep)) if (/^context-gate@/.test(k) && !decided.has(k) && typeof v === 'boolean') decided.set(k, { on: v, file: p })
    } catch { /* unparsable settings: not our call */ }
  }
  for (const d of decided.values()) if (d.on) return d.file
  return undefined
}

// ───────────────────────── journal ─────────────────────────

/** Append entries to `.claude/gate.log.jsonl` (only metadata, never prompt text). */
export function appendJournal(root: string, entries: readonly DecisionLogEntry[]): void {
  if (!entries.length) return
  const p = join(root, GATE_LOG)
  mkdirSync(dirname(p), { recursive: true })
  appendFileSync(p, entries.map((e) => toJsonl(e)).join(''))
}

export function fileExists(root: string, rel: string): boolean {
  return existsSync(isAbsolute(rel) ? rel : join(root, rel))
}
