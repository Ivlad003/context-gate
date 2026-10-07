// Shared on-disk repo for the pi / opencode adapter tests.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const GATE_JSON = {
  log: { file: true },
  groups: {
    core: ['skill:tdd'],
    frontend: ['skill:react-components', 'tool:mcp__figma__*'],
    backend: ['skill:nestjs', 'tool:mcp__postgres__*'],
  },
  tiers: { premium: { groups: ['core'] }, standard: { groups: ['core'] }, quick: { groups: ['core'], preload: ['tdd'] } },
  models: { 'claude-opus-*': 'premium', 'claude-sonnet-*': 'standard', 'claude-haiku-*': 'quick' },
  profiles: {
    frontend: { groups: ['frontend'], when: { paths: ['apps/web/**'] } },
    backend: { groups: ['backend'], when: { paths: ['apps/api/**'] } },
  },
}

/** A temp repo: gate.json, an Always and an Auto rule, three skills under `.claude/skills`, an empty home. */
export function tmpRepo(prefix: string): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const home = mkdtempSync(join(tmpdir(), `${prefix}home-`))
  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true })
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.cursor', 'rules', 'project.mdc'), '---\nalwaysApply: true\n---\nЗавжди pnpm.\n')
  writeFileSync(join(root, '.cursor', 'rules', 'react.mdc'), '---\nglobs: **/*.tsx\n---\nКомпоненти — функції.\n')
  for (const [name, body] of [['tdd', 'Тест першим.'], ['react-components', 'React.'], ['nestjs', 'Nest.'], ['misc', 'Misc.']]) {
    mkdirSync(join(root, '.claude', 'skills', name), { recursive: true })
    writeFileSync(join(root, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`)
  }
  writeFileSync(join(root, '.claude', 'gate.json'), JSON.stringify(GATE_JSON))
  return { root, home }
}
