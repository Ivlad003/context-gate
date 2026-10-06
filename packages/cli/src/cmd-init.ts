// `context-gate init | migrate | example skills` (SPEC «Сценарії», сценарій 1; «Єдина модель», G310).

import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Diagnostic, ProfileConfig } from '../../core/src/types.ts'
import { loadConfig, migrateConfig } from '../../core/src/config.ts'
import { ensureGitignore, readText, writeJson, writeText } from './util.ts'

export const GITIGNORE_LINES = ['.claude/prompt/.compiled/', '.claude/prompt/.trace/', '.claude/gate.debug.log', '.claude/gate.log.jsonl', '.claude/gate.index.json']

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }
const listDirs = (p: string): string[] => { try { return readdirSync(p).filter((d) => !d.startsWith('.') && isDir(join(p, d))).sort() } catch { return [] } }

const FRONTEND = /^(web|frontend|client|ui|app|site|www|dashboard|admin|mobile)$/
const BACKEND = /^(api|backend|server|service|services|worker|gateway)$/

export interface InitGuess { profiles: Record<string, ProfileConfig>; groups: Record<string, string[]>; notes: string[] }

/** Profiles from repo structure: apps/web → frontend, apps/api → backend, packages/* → one each, docs → docs. */
export function guessProfiles(root: string): InitGuess {
  const profiles: Record<string, ProfileConfig> = {}
  const groups: Record<string, string[]> = { core: ['skill:tdd', 'skill:diagnosing-bugs'], always: ['tool:mcp__github__*'] }
  const notes: string[] = []
  const addPaths = (name: string, paths: string[], groupGlobs: string[]): void => {
    const p = profiles[name] ?? { groups: [name, 'always'], when: { paths: [] } }
    p.when!.paths = [...new Set([...(p.when!.paths ?? []), ...paths])]
    profiles[name] = p
    groups[name] = [...new Set([...(groups[name] ?? []), ...groupGlobs])]
  }
  for (const top of ['apps', '']) {
    const base = top ? join(root, top) : root
    for (const d of top ? listDirs(base) : ['web', 'frontend', 'client', 'api', 'backend', 'server'].filter((x) => isDir(join(root, x)))) {
      const rel = top ? `${top}/${d}` : d
      if (FRONTEND.test(d)) { addPaths('frontend', [`${rel}/**`], ['skill:react-*', 'skill:tailwind*', 'skill:storybook', 'tool:mcp__figma__*', 'tool:mcp__playwright__*', 'rule:react*', 'rule:frontend*']); notes.push(`${rel} → frontend`) }
      else if (BACKEND.test(d)) { addPaths('backend', [`${rel}/**`], ['skill:nestjs', 'skill:prisma', 'skill:api-*', 'tool:mcp__postgres__*', 'rule:api*', 'rule:backend*']); notes.push(`${rel} → backend`) }
      else if (top) { addPaths(d, [`${rel}/**`], [`rule:${d}*`, `skill:${d}*`]); notes.push(`${rel} → ${d}`) }
    }
  }
  for (const d of listDirs(join(root, 'packages'))) {
    const name = profiles[d] ? `pkg-${d}` : d
    addPaths(name, [`packages/${d}/**`], [`rule:${d}*`, `skill:${d}*`])
    notes.push(`packages/${d} → ${name}`)
  }
  if (isDir(join(root, 'docs'))) {
    addPaths('docs', ['docs/**', '**/*.md'], ['skill:writing-*', 'rule:docs*'])
    profiles.docs!.groups = ['docs']
    notes.push('docs → docs')
  }
  if (isDir(join(root, 'prisma')) || isDir(join(root, 'migrations'))) {
    addPaths('backend', [...(isDir(join(root, 'prisma')) ? ['prisma/**'] : []), '**/migrations/**'], ['skill:prisma'])
    notes.push('prisma/migrations → backend')
  }
  return { profiles, groups, notes }
}

export function initConfig(root: string): { json: Record<string, unknown>; guess: InitGuess } {
  const guess = guessProfiles(root)
  const json: Record<string, unknown> = {
    groups: guess.groups,
    tiers: { premium: { groups: ['core'] }, standard: { groups: ['core'] }, quick: { groups: ['core'] } },
    models: { '*opus*': 'premium', '*sonnet*': 'standard', '*haiku*': 'quick' },
    profiles: guess.profiles,
    classify: { mode: 'shadow', minConfidence: 0.7, recheckOn: ['/gate new', 'compact'] },
    budgets: { default: { softContextPct: 70, hardContextPct: 85 } },
    cursorRules: { enabled: true, nested: existsSync(join(root, 'packages')) || existsSync(join(root, 'apps')), maxCharsPerInjection: 30000 },
    prompt: { dir: '.claude/prompt', runCacheDefault: '5m' },
  }
  return { json, guess }
}

export function initCommand(root: string, o: { force?: boolean; dryRun?: boolean }): { code: number; out: string } {
  const path = join(root, '.claude', 'gate.json')
  if (existsSync(path) && !o.force) return { code: 1, out: `.claude/gate.json уже існує — додай --force, щоб перезаписати, або context-gate migrate\n` }
  const { json, guess } = initConfig(root)
  const check = loadConfig(JSON.stringify(json))
  const errs = check.diagnostics.filter((d) => d.severity === 'error')
  if (errs.length) return { code: 1, out: errs.map((d) => `${d.code} ${d.message}`).join('\n') + '\n' }
  if (o.dryRun) return { code: 0, out: JSON.stringify(json, null, 2) + '\n' }
  writeJson(path, json)
  const added = ensureGitignore(root, GITIGNORE_LINES)
  const lines = ['створено .claude/gate.json (classify.mode: shadow — нічого не фільтрується, /gate why показує пропозиції)']
  lines.push(guess.notes.length ? `профілі: ${guess.notes.join('; ')}` : 'профілі не вгадано: структура без apps/, packages/, docs/ — додай їх у profiles вручну')
  if (added.length) lines.push(`.gitignore: + ${added.join(', ')}`)
  return { code: 0, out: lines.join('\n') + '\n' }
}

export function migrateCommand(root: string, o: { dryRun?: boolean }): { code: number; out: string; diagnostics: Diagnostic[] } {
  const path = join(root, '.claude', 'gate.json')
  const text = readText(path)
  if (text === undefined) return { code: 1, out: 'немає .claude/gate.json — спершу context-gate init\n', diagnostics: [] }
  let raw: unknown
  try { raw = JSON.parse(text.replace(/^﻿/, '')) } catch (e) { return { code: 1, out: `G301 gate.json не парситься: ${(e as Error).message}\n`, diagnostics: [] } }
  const { json, diagnostics } = migrateConfig(raw)
  if (!json) return { code: 1, out: diagnostics.map((d) => `${d.code} ${d.message}`).join('\n') + '\n', diagnostics }
  const next = JSON.stringify(json, null, 2) + '\n'
  if (o.dryRun) return { code: 0, out: next, diagnostics }
  if (next.trim() === text.trim() || JSON.stringify(json) === JSON.stringify(raw)) return { code: 0, out: 'gate.json уже в новому форматі\n', diagnostics }
  let backup = `${path}.bak`
  for (let i = 1; existsSync(backup); i++) backup = `${path}.bak.${i}`
  copyFileSync(path, backup)
  writeText(path, next)
  const conv = diagnostics.filter((d) => d.code === 'G310').length ? 'конвертовано skillGroups/mcpGroups/ruleSources у groups/itemSources' : 'записано'
  return { code: 0, out: `${conv}; резервна копія ${backup.slice(root.length + 1)}\n` + diagnostics.filter((d) => d.code !== 'G310').map((d) => `${d.code} ${d.message}\n`).join(''), diagnostics }
}

/** Plugin root: works from sources (`packages/cli/src`) and from the bundle (`dist/cli.js`). */
export function pluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const c of [resolve(here, '..'), resolve(here, '../../..')]) if (existsSync(join(c, 'examples', 'skills'))) return c
  return resolve(here, '../../..')
}

export function exampleCommand(root: string, what: string | undefined, o: { force?: boolean; dir?: string }): { code: number; out: string } {
  if (what !== 'skills') return { code: 2, out: 'використання: context-gate example skills\n' }
  const src = join(pluginRoot(), 'examples', 'skills')
  if (!existsSync(src)) return { code: 1, out: `не знайдено ${src}\n` }
  const dest = join(root, o.dir ?? '.claude/prompt')
  const lines: string[] = []
  for (const f of readdirSync(src).sort()) {
    if (!f.endsWith('.prompt.tsx')) continue
    const to = join(dest, f)
    if (existsSync(to) && !o.force) { lines.push(`пропущено ${f} (уже є; --force перезаписати)`); continue }
    writeText(to, readText(join(src, f)) ?? '')
    lines.push(`скопійовано ${f}`)
  }
  lines.push('далі: context-gate build (або збірка на session.start у mod-і)')
  return { code: 0, out: lines.join('\n') + '\n' }
}
