// Node side of the hooks adapter: load gate.json, .cursor/rules, skills, git branch; session state and journal I/O.

import type { Dirent } from 'node:fs'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { DecisionLogEntry, Diagnostic, GateConfig, Item, MdcRule } from '../../core/src/types.ts'
import { defaultConfig, loadConfig } from '../../core/src/config.ts'
import { parseMdc, ruleIdFromPath } from '../../core/src/mdc.ts'
import { makeItem } from '../../core/src/items.ts'
import { toJsonl } from '../../core/src/journal.ts'
import { reviveState, type SessionState } from './handle.ts'
import { GATE_LOG } from './shiftwork.ts'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', 'vendor', '.venv'])

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

function walkMdc(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkMdc(p, out, depth + 1)
    else if (e.isFile() && e.name.endsWith('.mdc')) out.push(p)
  }
}

/** `.cursor/rules` dirs: the root one and, with `nested`, `*\/.cursor/rules` below (bounded depth). */
function ruleDirs(root: string, nested: boolean): string[] {
  const dirs: string[] = []
  const top = join(root, '.cursor', 'rules')
  if (existsSync(top)) dirs.push(top)
  if (!nested) return dirs
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.cursor')) continue
      const p = join(dir, e.name)
      if (e.name === '.cursor') {
        if (dir !== root && existsSync(join(p, 'rules'))) dirs.push(join(p, 'rules'))
        continue
      }
      visit(p, depth + 1)
    }
  }
  visit(root, 0)
  return dirs
}

/** Parsed `.mdc` rules. Empty when the cursor layer is off or transpiled `.claude/rules/cursor/` exists (edge case 7). */
export function loadRules(root: string, config: GateConfig): { rules: MdcRule[]; diagnostics: Diagnostic[]; skipped?: string } {
  if (config.cursorRules?.enabled === false) return { rules: [], diagnostics: [], skipped: 'cursorRules.enabled: false' }
  if (existsSync(join(root, '.claude', 'rules', 'cursor'))) return { rules: [], diagnostics: [], skipped: '.claude/rules/cursor/ є: правила доставляє Claude Code нативно' }
  const files: string[] = []
  for (const d of ruleDirs(root, !!config.cursorRules?.nested)) walkMdc(d, files)
  const rules: MdcRule[] = []
  const diagnostics: Diagnostic[] = []
  for (const f of files.sort()) {
    const rel = toPosix(relative(root, f))
    const text = readText(f)
    if (text === undefined) continue
    const { id, dirPrefix } = ruleIdFromPath(rel)
    const r = parseMdc(text, { path: rel, id, dirPrefix })
    rules.push(r.rule)
    diagnostics.push(...r.diagnostics)
  }
  return { rules, diagnostics }
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

export function writeState(sessionId: string, state: SessionState, env: NodeJS.ProcessEnv = process.env): void {
  const p = statePath(sessionId, env)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, p)
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
