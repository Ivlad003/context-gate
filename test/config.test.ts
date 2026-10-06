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

// ───────────── G-01: models attributes, tier from thresholds ─────────────

test('models: attribute entries infer the tier from tiers[*].thresholds; harness attrs for unknown models', async () => {
  const { inferTier, modelForTier } = await import('../packages/core/src/config.ts')
  const cfg = defaultConfig()
  cfg.tiers = {
    premium: { groups: [], thresholds: { minCostPer1k: 0.01 } },
    standard: { groups: [], thresholds: { minCostPer1k: 0.002 } },
    quick: { groups: [], thresholds: { maxContextWindow: 64000 } },
  }
  cfg.models = {
    'claude-opus-*': 'premium',
    'local-big': { contextWindow: 128000, costPer1k: 0.005 },
    cheap: { match: 'llama-*', contextWindow: 32000, costPer1k: 0 },
    pinned: { match: 'gemma-*', tier: 'quick', contextWindow: 999999 },
  }
  const cases: [string, Parameters<typeof tierForModel>[2], string, boolean][] = [
    ['claude-opus-4-5', undefined, 'premium', false],
    ['local-big', undefined, 'standard', false],
    ['llama-3-8b', undefined, 'quick', false],
    ['gemma-2', undefined, 'quick', false],
    ['mystery', { costPer1k: 0.02 }, 'premium', false],
    ['mystery', { contextWindow: 16000 }, 'quick', false],
    ['mystery', undefined, 'standard', true],
    ['mystery', { contextWindow: 200000 }, 'standard', true],
  ]
  for (const [model, attrs, tier, fallback] of cases) {
    const r = tierForModel(cfg, model, attrs)
    assert.equal(r.tier, tier, `${model} ${JSON.stringify(attrs)}: ${r.reason}`)
    assert.equal(r.fallback, fallback, model)
  }
  assert.match(tierForModel(cfg, 'local-big').reason, /поріг tier standard/)
  // No thresholds declared anywhere → built-in cost thresholds on premium/standard/quick.
  const d = defaultConfig()
  assert.equal(inferTier(d, { costPer1k: 0.015 }), 'premium')
  assert.equal(inferTier(d, { costPer1k: 0.003 }), 'standard')
  assert.equal(inferTier(d, { costPer1k: 0.0008 }), 'quick')
  assert.equal(inferTier(d, {}), undefined)
  assert.equal(modelForTier(cfg, 'quick'), 'gemma-*')
  assert.equal(modelForTier(cfg, 'premium'), 'claude-opus-*')
})

test('schema: models attributes, thresholds, classify/brief providers, prompt.packages, debugLog, assertFail', () => {
  const ok = validateConfig({
    tiers: { premium: { thresholds: { minCostPer1k: 0.01 } }, standard: {}, quick: {} },
    models: { 'x-*': { contextWindow: 32000, costPer1k: 0.001 }, y: 'quick', z: { tier: 'premium', match: 'zz-*' } },
    classify: { mode: 'auto', provider: { kind: 'cli', command: ['node', 'scripts/classify.js'], timeout: '5s' } },
    brief: { enabled: true, provider: 'builtin' },
    prompt: { packages: ['@acme/prompts'], commitCompiled: true },
    debug: true, debugLog: { path: '.claude/x.log', maxBytes: 1000 }, assertFail: 'fail',
  })
  assert.deepEqual(ok.diagnostics.filter((d) => d.severity === 'error'), [])
  assert.ok(ok.config)
  assert.equal(validateConfig({ classify: { mode: 'auto', provider: 'jev' } }).config?.classify?.provider, 'jev')
  const bad = [
    { classify: { mode: 'auto', provider: 'gpt' } },
    { classify: { mode: 'auto', provider: { kind: 'cli' } } },
    { models: { x: { contextWindow: 'big' } } },
    { assertFail: 'warn' },
    { tiers: { quick: { thresholds: { minCostPer1k: -1 } } } },
  ]
  for (const b of bad) assert.ok(validateConfig(b).diagnostics.some((d) => d.severity === 'error'), JSON.stringify(b))
  assert.ok(validateConfig({ models: { x: { tier: 'nope' } } }).diagnostics.some((d) => d.code === 'G305'))
})

test('itemSources: markdown-dir needs dir, provider needs a declared provider (G313, warnings)', () => {
  const r = validateConfig({
    providers: { arch: { kind: 'file', path: 'arch.json' } },
    itemSources: [{ kind: 'markdown-dir' }, { kind: 'provider' }, { kind: 'provider', name: 'nope' }, { kind: 'provider', name: 'arch', field: 'deny', as: 'always' }, { kind: 'markdown-dir', dir: 'docs/rules' }],
  })
  assert.ok(r.config, 'warnings only')
  assert.equal(r.diagnostics.filter((d) => d.code === 'G313').length, 3)
})

// ───────────── G-03: env whitelist, masking; debug log path ─────────────

test('filterEnv keeps whitelisted, set names; maskSecrets hides every value; debugLogPath only with debug', async () => {
  const { filterEnv, envMaskValues, maskSecrets, debugLogPath, DEBUG_LOG_PATH } = await import('../packages/core/src/config.ts')
  const env = filterEnv({ API_TOKEN: 'sekret-123', HOME: '/home/u', NUM: 5, EMPTY: undefined }, ['API_TOKEN', 'NUM', 'EMPTY', 'MISSING'])
  assert.deepEqual(env, { API_TOKEN: 'sekret-123' })
  assert.deepEqual(filterEnv({ A: 'x' }, undefined), {})
  const mask = envMaskValues({ ...env, SHORT: 'ab' })
  assert.deepEqual(mask, ['sekret-123'])
  assert.equal(maskSecrets('token=sekret-123; again sekret-123', mask), 'token=***; again ***')
  assert.equal(debugLogPath({}), undefined)
  assert.deepEqual(debugLogPath({}, true), { path: DEBUG_LOG_PATH, maxBytes: 1024 * 1024 })
  assert.deepEqual(debugLogPath({ debug: true, debugLog: { path: 'x.log', maxBytes: 10 } }), { path: 'x.log', maxBytes: 10 })
})

test('commandAllowed / commandGateDecision: binary whitelist and trust for command gates (Р2)', async () => {
  const { commandAllowed, commandGateDecision, binaryWhitelist } = await import('../packages/core/src/config.ts')
  const wl = binaryWhitelist(['node', 'eslint', 'bash'], undefined)
  const rows: [string[], boolean][] = [[['eslint', '-f', 'json'], true], [['/usr/local/bin/node', 'x.js'], true], [['npx', 'tsc'], false], [[], false], [[''], false]]
  for (const [argv, ok] of rows) {
    assert.equal(commandAllowed(argv, wl), ok, argv.join(' '))
    assert.equal(commandAllowed(argv, new Set(wl)), ok, `set: ${argv.join(' ')}`)
  }
  assert.deepEqual(commandGateDecision({ trusted: true, whitelist: wl }, ['eslint', '.']), { run: true })
  assert.deepEqual(commandGateDecision({ trusted: false, whitelist: wl }, ['eslint', '.']), { run: false, skipped: 'репозиторій не довірений' })
  assert.match((commandGateDecision({ trusted: true, whitelist: wl }, ['npx', 'tsc']) as { skipped: string }).skipped, /npx поза білим списком/)
  assert.match((commandGateDecision({ trusted: true, whitelist: wl, scriptsAllowed: false }, ['eslint']) as { skipped: string }).skipped, /allowScripts/)
  // The repo list only narrows the user list.
  assert.equal(commandAllowed(['eslint'], binaryWhitelist(['node', 'eslint'], ['node'])), false)
})
