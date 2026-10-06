import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { defaultConfig, validateConfig, normalizeConfig, migrateConfig, tierForModel, budgetFor, gateJsonSchema, loadConfig } from '../packages/core/src/config.ts'
import { parseDuration, formatDuration } from '../packages/core/src/duration.ts'
import { explain, diag } from '../packages/core/src/codes.ts'
import type { GateConfig } from '../packages/core/src/types.ts'

const SPEC_EXAMPLE = {
  skillGroups: {
    core: ['tdd', 'diagnosing-bugs'],
    frontend: ['react-*', 'tailwind', 'storybook'],
    backend: ['nestjs', 'prisma', 'api-design'],
    git: ['git-conventions', 'resolving-merge-conflicts'],
    docs: ['writing-for-agents'],
  },
  mcpGroups: { frontend: ['figma', 'playwright'], backend: ['postgres'], always: ['github'] },
  tiers: { premium: { skills: ['core'] }, standard: { skills: ['core', 'git'] }, quick: { skills: ['core', 'git', 'docs'], preload: ['project-conventions'] } },
  models: { 'claude-opus-*': 'premium', 'claude-sonnet-*': 'standard', 'claude-haiku-*': 'quick' },
  profiles: {
    frontend: { skills: ['frontend'], mcp: ['frontend', 'always'], agents: ['ui-reviewer'], when: { paths: ['apps/web/**', '**/*.tsx'], branch: '^feat/ui' } },
    backend: { skills: ['backend'], mcp: ['backend', 'always'], when: { paths: ['apps/api/**', '**/*.service.ts'] } },
    git: { skills: ['git'], mcp: ['always'], agents: [] },
    docs: { skills: ['docs'], mcp: [] },
  },
  classify: { mode: 'shadow', model: 'haiku', minConfidence: 0.7, recheckOn: ['/gate new', 'compact'] },
  budgets: { default: { softContextPct: 70, hardContextPct: 85 }, tiers: { quick: { softContextPct: 55, hardContextPct: 70 } } },
  onExceed: { softContextPct: { do: 'section', section: 'budget-warning' }, hardContextPct: { do: 'notice', text: 'Контекст {pct}%' } },
  escalation: { order: ['quick', 'standard', 'premium'], after: { verifyFailed: 2, stallTurns: 6 } },
  brief: { enabled: true, model: 'opus', maxChars: 2000, tiers: ['quick', 'standard'] },
  providers: { git: { kind: 'module', builtin: true }, fs: { kind: 'module', builtin: true } },
  ruleSources: [{ kind: 'cursor-mdc', dir: '.cursor/rules' }],
  gates: [
    { name: 'read-before-write', on: 'write', builtin: true, tiers: ['quick', 'standard'] },
    { name: 'tests', on: 'commit', run: ['pnpm', 'test'], pass: 'exitCode == 0' },
  ],
  cursorRules: { enabled: true, nested: true, maxCharsPerInjection: 30000 },
  prompt: { dir: '.claude/prompt', runCacheDefault: '5m' },
}

test('spec example validates; legacy → G310 on load', () => {
  const v = validateConfig(SPEC_EXAMPLE)
  assert.ok(v.config, JSON.stringify(v.diagnostics))
  assert.deepEqual(v.diagnostics.filter((d) => d.severity === 'error'), [])
  const l = loadConfig(JSON.stringify(SPEC_EXAMPLE))
  assert.ok(l.config)
  assert.ok(l.diagnostics.some((d) => d.code === 'G310'))
  assert.equal(l.config!.skillGroups, undefined)
})

test('validator errors and warnings', () => {
  const rows: [unknown, string, boolean][] = [
    [42, 'G301', false],
    [[], 'G301', false],
    [{ bogus: 1 }, 'G302', true],
    [{ profiles: { a: { groups: 'x' } } }, 'G303', false],
    [{ classify: { mode: 'loud' } }, 'G308', false],
    [{ classify: { mode: 'auto', minConfidence: 1.5 } }, 'G309', false],
    [{ classify: {} }, 'G311', false],
    [{ profiles: { a: { when: { branch: '([' } } } }, 'G306', false],
    [{ prompt: { runCacheDefault: 'soon' } }, 'G307', false],
    [{ models: { 'x-*': 'ultra' } }, 'G305', true],
    [{ groups: {}, profiles: { a: { groups: ['nope'] } } }, 'G304', true],
    [{ budgets: { default: { softContextPct: 90, hardContextPct: 80 } } }, 'G312', true],
    [{ onExceed: { softContextPct: { do: 'explode' } } }, 'G308', false],
    [{ onExceed: { softContextPct: { do: 'notice', text: 'x' } } }, '', true],
    [{ providers: { p: { kind: 'cli', functions: { a: ['x'] } } } }, '', true],
    [{ tiers: { quick: { preload: ['x'], extra: 1 } } }, 'G302', true],
  ]
  for (const [json, code, ok] of rows) {
    const r = validateConfig(json)
    if (code) assert.ok(r.diagnostics.some((d) => d.code === code), `${JSON.stringify(json)} → ${code}; got ${r.diagnostics.map((d) => d.code)}`)
    else assert.deepEqual(r.diagnostics, [], JSON.stringify(json))
    assert.equal(!!r.config, ok, JSON.stringify(json))
  }
})

test('unknown keys are dropped, defaults merged', () => {
  const r = validateConfig({ bogus: 1, profiles: { a: { groups: [] } } })
  assert.ok(r.config)
  assert.equal((r.config as unknown as Record<string, unknown>).bogus, undefined)
  assert.equal(r.config!.classify!.mode, 'shadow')
  assert.ok(r.config!.tiers.standard)
  assert.equal(r.config!.cursorRules!.maxCharsPerInjection, 30000)
})

test('loadConfig never throws', () => {
  assert.equal(loadConfig('{not json').config, undefined)
  assert.equal(loadConfig('{not json').diagnostics[0].code, 'G301')
  assert.ok(loadConfig(undefined).config)
  assert.ok(loadConfig('﻿{}').config)
})

test('normalizeConfig converts legacy to kind-prefixed groups', () => {
  const { config, diagnostics } = normalizeConfig(SPEC_EXAMPLE as unknown as GateConfig)
  assert.equal(diagnostics.filter((d) => d.code === 'G310').length, 1)
  const g = config.groups!
  assert.deepEqual(g.core, ['skill:tdd', 'skill:diagnosing-bugs'])
  assert.deepEqual(g.frontend, ['skill:react-*', 'skill:tailwind', 'skill:storybook', 'tool:mcp__figma__*', 'tool:mcp__playwright__*'])
  assert.deepEqual(g.always, ['tool:mcp__github__*'])
  assert.deepEqual(g['frontend-agents'], ['agent:ui-reviewer'])
  assert.deepEqual(config.profiles.frontend.groups, ['frontend', 'always', 'frontend-agents'])
  assert.equal(config.profiles.frontend.when!.branch, '^feat/ui')
  assert.equal(config.profiles.frontend.skills, undefined)
  // `docs` exists only in skillGroups → plain reference
  assert.deepEqual(config.profiles.docs.groups, ['docs'])
  assert.deepEqual(config.tiers.quick, { preload: ['project-conventions'], groups: ['core', 'git', 'docs'] })
  assert.deepEqual(config.itemSources, [{ kind: 'cursor-mdc', dir: '.cursor/rules' }])
  assert.equal(config.ruleSources, undefined)
  assert.equal(config.mcpGroups, undefined)
})

test('normalizeConfig splits colliding names when only one kind is referenced', () => {
  const { config } = normalizeConfig({ skillGroups: { x: ['a'] }, mcpGroups: { x: ['srv'] }, profiles: { p: { skills: ['x'] }, q: { skills: ['x'], mcp: ['x'] } } } as unknown as GateConfig)
  assert.deepEqual(config.profiles.p.groups, ['x-skills'])
  assert.deepEqual(config.groups!['x-skills'], ['skill:a'])
  assert.deepEqual(config.profiles.q.groups, ['x'])
  assert.deepEqual(config.groups!.x, ['skill:a', 'tool:mcp__srv__*'])
})

test('normalizeConfig is identity for new format', () => {
  const cfg = { groups: { a: ['skill:x'] }, profiles: { p: { groups: ['a'] } } } as unknown as GateConfig
  const r = normalizeConfig(cfg)
  assert.equal(r.config, cfg)
  assert.deepEqual(r.diagnostics, [])
})

test('migrateConfig yields new format only', () => {
  const { json } = migrateConfig({ $schema: 's', ...SPEC_EXAMPLE })
  assert.ok(json)
  const keys = Object.keys(json!)
  assert.deepEqual(keys.slice(0, 2), ['$schema', 'groups'])
  for (const k of ['skillGroups', 'mcpGroups', 'ruleSources']) assert.ok(!keys.includes(k))
  assert.ok(!JSON.stringify(json).includes('"skills"'))
  assert.ok(!JSON.stringify(json).includes('"mcp"'))
  const v = validateConfig(json)
  assert.ok(v.config)
  assert.ok(!v.diagnostics.length, JSON.stringify(v.diagnostics))
  assert.equal(migrateConfig(5).json, undefined)
})

test('tierForModel', () => {
  const cfg = defaultConfig()
  cfg.models = { 'claude-opus-*': 'premium', 'claude-sonnet-*': 'standard', 'claude-haiku-*': 'quick', 'my-exact': 'quick' }
  const rows: [string | undefined, string, boolean][] = [
    ['claude-opus-4-5', 'premium', false],
    ['claude-sonnet-4-5[1m]', 'standard', false],
    ['us.anthropic.claude-haiku-4-5', 'quick', false],
    ['CLAUDE-HAIKU-4', 'quick', false],
    ['my-exact', 'quick', false],
    ['gpt-5', 'standard', true],
    [undefined, 'standard', true],
  ]
  for (const [m, tier, fallback] of rows) {
    const r = tierForModel(cfg, m)
    assert.equal(r.tier, tier, String(m))
    assert.equal(r.fallback, fallback, String(m))
    assert.ok(r.reason)
  }
  assert.equal(tierForModel(defaultConfig(), 'claude-opus-4-5').tier, 'premium')
})

test('budgetFor', () => {
  const cfg = { budgets: { default: { softContextPct: 70, hardContextPct: 85 }, tiers: { quick: { softContextPct: 55 } } } }
  assert.deepEqual(budgetFor(cfg, 'quick'), { softContextPct: 55, hardContextPct: 85 })
  assert.deepEqual(budgetFor(cfg, 'premium'), { softContextPct: 70, hardContextPct: 85 })
  assert.deepEqual(budgetFor({}, 'x'), { softContextPct: 70, hardContextPct: 85 })
})

test('schema file is in sync with gateJsonSchema', () => {
  const file = JSON.parse(readFileSync(new URL('../schema/context-gate.schema.json', import.meta.url), 'utf8'))
  assert.deepEqual(file, JSON.parse(JSON.stringify(gateJsonSchema)))
})

test('durations', () => {
  const rows: [unknown, number | undefined][] = [['5m', 300000], ['10s', 10000], ['1h', 3600000], ['500ms', 500], ['1h30m', 5400000], ['1.5s', 1500], ['250', 250], ['', undefined], ['soon', undefined], ['5x', undefined], [7, 7], [-1, undefined]]
  for (const [s, ms] of rows) assert.equal(parseDuration(s as string), ms, String(s))
  assert.equal(formatDuration(300000), '5m')
  assert.equal(formatDuration(500), '500ms')
})

test('codes: explain and diag', () => {
  assert.match(explain('G310'), /^G310 — Застарілий формат/)
  assert.match(explain('g310'), /context-gate migrate/)
  assert.match(explain('G599'), /Невідомий код G599.*G5xx/)
  for (const c of ['G151', 'G152', 'G153', 'G154', 'G155', 'G156', 'G157', 'G158', 'G159', 'G160', 'G161', 'G162', 'G170', 'G180', 'G501', 'H001', 'H005', 'H010', 'H013', 'D001']) {
    assert.doesNotMatch(explain(c), /Невідомий/, c)
  }
  const d = diag('G310')
  assert.equal(d.severity, 'warning')
  assert.ok(d.hint)
  assert.equal(diag('G303', 'x', { path: 'p' }).path, 'p')
})
