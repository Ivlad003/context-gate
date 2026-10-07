// Node side shared by the `pi` and `opencode` adapters: read `.claude/gate.json`, every rule source (core `loadRuleSources`),
// skills from disk, the git branch, and append to `.claude/gate.log.jsonl`. Imports only core and `node:*`
// (the harness adapters must not depend on hooks-adapter or the CLI).

import type { Dirent } from 'node:fs'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { DecisionLogEntry, Diagnostic, GateConfig, Item, MdcRule } from '../../core/src/types.ts'
import { defaultConfig, loadConfig } from '../../core/src/config.ts'
import { loadRuleSources, type RuleSourceFs } from '../../core/src/mdc.ts'
import { staticProviderValue } from '../../core/src/providers.ts'
import { makeItem } from '../../core/src/items.ts'
import { toJsonl } from '../../core/src/journal.ts'
import { detectWindows } from '../../core/src/glob.ts'
import type { GateData, GateEnv } from './session.ts'
import { GATE_ENV_KEYS, GATE_LOG } from './session.ts'

function readText(p: string): string | undefined {
  try { return readFileSync(p, 'utf8') } catch { return undefined }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
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
 * cli/module/mcp providers need trust and are skipped with G208). Empty when `cursorRules.enabled: false`.
 */
export function loadRules(root: string, config: GateConfig): { rules: MdcRule[]; diagnostics: Diagnostic[] } {
  const fs = nodeRuleFs(root)
  return loadRuleSources(config, fs, { providerValue: (name) => staticProviderValue(config, name, fs.read) })
}

/** Split a SKILL.md into frontmatter keys and body (linear, no YAML library). */
export function splitFrontmatter(text: string): { fm: Record<string, string>; body: string } {
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

/** Body of a SKILL.md without its frontmatter (preload), or undefined when unreadable. */
export function readSkillBody(path: string): string | undefined {
  const text = readText(path)
  return text === undefined ? undefined : splitFrontmatter(text).body
}

/** Skills `<dir>/<name>/SKILL.md` from the given dirs, first dir wins on a name clash. */
export function loadSkillDirs(root: string, dirs: readonly string[]): Item[] {
  const items: Item[] = []
  const seen = new Set<string>()
  for (const base of dirs) {
    let entries: Dirent[]
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      const file = join(base, e.name, 'SKILL.md')
      const text = readText(file)
      if (text === undefined) continue
      const { fm, body } = splitFrontmatter(text)
      const name = fm.name || e.name
      if (seen.has(name)) continue
      seen.add(name)
      const rel = toPosix(relative(root, file))
      const extra: Partial<Item> = { body, provenance: { source: 'claude-skills', path: rel.startsWith('..') ? toPosix(file) : rel } }
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

export function gateEnv(env: Record<string, string | undefined> = process.env): GateEnv {
  const out: GateEnv = {}
  for (const k of GATE_ENV_KEYS) {
    const v = env[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

/** Everything a turn needs from disk. `items` are extra items the adapter loaded (skills, agents). */
export function loadGateData(root: string, items: readonly Item[] = [], env: Record<string, string | undefined> = process.env): GateData & { diagnostics: Diagnostic[] } {
  const c = loadGateConfig(root)
  const r = loadRules(root, c.config)
  const data: GateData & { diagnostics: Diagnostic[] } = { root, config: c.config, rules: r.rules, items, env: gateEnv(env), windows: detectWindows(root, env.OS), diagnostics: [...c.diagnostics, ...r.diagnostics] }
  const branch = readBranch(root)
  if (branch) data.branch = branch
  return data
}

/** Append entries to `<root>/.claude/gate.log.jsonl` (metadata only, never prompt text). Never throws. */
export function appendJournal(root: string, entries: readonly DecisionLogEntry[]): void {
  if (!entries.length) return
  try {
    const p = join(root, GATE_LOG)
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, entries.map((e) => toJsonl(e)).join(''))
  } catch { /* a read-only checkout must not break the harness */ }
}
