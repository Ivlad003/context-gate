// Regressions from the 2026-10-06 review, core config: path containment (S2/M05/H01, G314), glob and profile
// name checks (G315, G316), tier references (L34, L36), merged budgets (L35), `version` (R6), model ids (O5,
// L37), the binary whitelist (L33) and secret masking (M04).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandAllowed, configPathDiagnostics, loadConfig, maskSecrets, maskSecretsDeep, normalizeModelId, repoPathProblem, tierForModel, validateConfig, defaultConfig } from '../packages/core/src/config.ts'
import type { Diagnostic } from '../packages/core/src/types.ts'

const codes = (json: unknown): string[] => validateConfig(json).diagnostics.map((d: Diagnostic) => d.code)

test('G314: config paths must stay inside the repo (error: the config is rejected)', () => {
  const bad: [string, unknown][] = [
    ['prompt.dir ..', { prompt: { dir: '../home/private-notes' } }],
    ['prompt.dir absolute', { prompt: { dir: '/etc' } }],
    ['prompt.dir home', { prompt: { dir: '~/notes' } }],
    ['itemSources dir', { itemSources: [{ kind: 'markdown-dir', dir: 'docs/../../x' }] }],
    ['ruleSources dir drive', { ruleSources: [{ kind: 'cursor-mdc', dir: 'C:\\Users\\u' }] }],
    ['gates baseline', { gates: [{ name: 'lint', on: 'write', baseline: '/home/u/.bashrc' }] }],
    ['debugLog path', { debugLog: { path: '../victim.txt', maxBytes: 10 } }],
    ['provider path', { providers: { x: { kind: 'file', path: '/etc/passwd' } } }],
    ['UNC', { prompt: { dir: '\\\\server\\share' } }],
  ]
  for (const [name, json] of bad) {
    const r = validateConfig(json)
    assert.ok(r.diagnostics.some((d) => d.code === 'G314' && d.severity === 'error'), name)
    assert.equal(r.config, undefined, name)
  }
  const good = { prompt: { dir: '.claude/prompt' }, itemSources: [{ kind: 'cursor-mdc', dir: './rules/cursor/' }], gates: [{ name: 'lint', on: 'write', baseline: '.claude/gate.baseline.json' }], debugLog: { path: 'tmp/x..log' }, providers: { pkg: { kind: 'file', path: 'package.json' } } }
  assert.deepEqual(configPathDiagnostics(good), [])
  assert.ok(validateConfig(good).config)
  assert.equal(repoPathProblem('a/b'), undefined)
  assert.ok(repoPathProblem(''))
})

test('G315: invalid globs, `kind:!x`, negated preload, only-negative when.paths (warnings)', () => {
  const rows: [string, unknown][] = [
    ['reversed class in group', { groups: { g: ['skill:[z-a]*'] } }],
    ['kind:!x', { groups: { g: ['skill:!react'] } }],
    ['negated preload', { tiers: { standard: { groups: [], preload: ['!skill:a'] } } }],
    ['only negative when.paths', { profiles: { p: { when: { paths: ['!src/**'] } } } }],
    ['bad when.paths', { profiles: { p: { when: { paths: ['src/[9-0]*'] } } } }],
  ]
  for (const [name, json] of rows) {
    const r = validateConfig(json)
    assert.ok(r.diagnostics.some((d) => d.code === 'G315' && d.severity === 'warning'), name)
    assert.ok(r.config, `${name}: still loads`)
  }
  assert.ok(!codes({ groups: { g: ['skill:react-*', '!skill:react-old'] } }).includes('G315'))
})

test('G316: profile names /gate cannot reach or that read as a union', () => {
  for (const name of ['c++', 'build', 'rules', 'sort', 'on', 'a b']) assert.ok(codes({ profiles: { [name]: {} } }).includes('G316'), name)
  assert.ok(!codes({ profiles: { frontend: {}, 'фронт': {} } }).includes('G316'))
  // `[gate:off|auto|new]` are commands, so the hint does not offer them as a way to reach the profile.
  const msg = (name: string) => validateConfig({ profiles: { [name]: {} } }).diagnostics.find((d: Diagnostic) => d.code === 'G316')?.message ?? ''
  assert.doesNotMatch(msg('off'), /\[gate:off\]/)
  assert.match(msg('rules'), /\[gate:rules\]/)
})

test('G305: tier names in gates/brief/budgets, and custom tiers without models', () => {
  assert.ok(codes({ gates: [{ name: 't', on: 'write', tiers: ['premuim'] }] }).includes('G305'))
  assert.ok(codes({ brief: { enabled: true, tiers: ['qick'] } }).includes('G305'))
  assert.ok(codes({ budgets: { tiers: { stanard: { softContextPct: 50 } } } }).includes('G305'))
  assert.ok(codes({ groups: { core: ['skill:tdd'] }, tiers: { fast: { groups: ['core'] }, smart: { groups: ['core'] } } }).includes('G305'))
  assert.ok(!codes({ tiers: { fast: { groups: [] } }, models: { '*': 'fast' } }).includes('G305'))
  assert.ok(!codes({ gates: [{ name: 't', on: 'write', tiers: ['premium'] }] }).includes('G305'))
})

test('G312 on the effective (merged) budgets', () => {
  assert.ok(codes({ budgets: { default: { hardContextPct: 60 } } }).includes('G312'))
  assert.ok(codes({ budgets: { tiers: { quick: { softContextPct: 90 } } } }).includes('G312'))
  assert.ok(!codes({ budgets: { default: { softContextPct: 50 }, tiers: { quick: { hardContextPct: 60 } } } }).includes('G312'))
})

test('version: accepted; a newer one warns (G317) and still loads', () => {
  assert.deepEqual(codes({ version: 1 }), [])
  const r = validateConfig({ version: 2 })
  assert.ok(r.diagnostics.some((d) => d.code === 'G317' && d.severity === 'warning'))
  assert.ok(r.config)
  assert.equal(loadConfig('{"version":1}').config?.version, 1)
})

test('normalizeModelId / tierForModel: Bedrock, ARN and gateway ids', () => {
  const rows: [string, string, string][] = [
    ['us.anthropic.claude-sonnet-4-5', 'claude-sonnet-4-5', 'standard'],
    ['global.anthropic.claude-opus-4-5-20251101-v1:0', 'claude-opus-4-5-20251101-v1:0', 'premium'],
    ['apac.anthropic.claude-haiku-4-5', 'claude-haiku-4-5', 'quick'],
    ['us-gov.anthropic.claude-sonnet-4', 'claude-sonnet-4', 'standard'],
    ['arn:aws:bedrock:us-east-1:1:inference-profile/global.anthropic.claude-haiku-4-5', 'claude-haiku-4-5', 'quick'],
    ['anthropic/claude-opus-4.1', 'claude-opus-4.1', 'premium'],
    ['claude-opus-4-5[1m]', 'claude-opus-4-5', 'premium'],
  ]
  for (const [id, norm, tier] of rows) {
    assert.equal(normalizeModelId(id), norm, id)
    assert.equal(tierForModel(defaultConfig(), id).tier, tier, id)
  }
  // A key written for a gateway alias still matches the raw id.
  assert.equal(tierForModel({ ...defaultConfig(), models: { 'gw/fast': 'quick' } }, 'gw/fast').tier, 'quick')
})

test('commandAllowed: a path is judged as a path, not by its basename', () => {
  const wl = ['git', 'node', 'git.exe']
  const rows: [string, boolean][] = [
    ['git', true], ['/usr/bin/git', true], ['/usr/local/bin/node', true], ['/opt/homebrew/bin/git', true],
    ['./tools/git', false], ['scripts/git', false], ['/tmp/x/node', false], ['/usr/bin/../../tmp/git', false],
    ['./node_modules/.bin/git', false], ['C:\\Windows\\System32\\git.exe', true], ['C:\\repo\\git.exe', false],
    // User-writable dirs under C:\Windows are not system bin dirs; Program Files (admin-only) is, at any depth.
    ['C:\\Windows\\Temp\\git', false], ['C:\\Windows\\System32\\sub\\git.exe', false], ['C:\\Program Files\\Git\\cmd\\git.exe', true],
  ]
  for (const [cmd, ok] of rows) assert.equal(commandAllowed([cmd], wl), ok, cmd)
  assert.equal(commandAllowed(['./tools/git'], ['./tools/git']), true)
})

test('masking: escaped secrets in JSON text; structural masking keeps JSON valid', () => {
  const text = JSON.stringify({ a: 'ab"cd', b: 'x\\y' })
  const masked = maskSecrets(text, ['ab"cd', 'x\\y'])
  assert.ok(!masked.includes('ab\\"cd') && !masked.includes('x\\\\y'), masked)
  const deep = maskSecretsDeep({ shadow: true, trusted: null, n: 1, s: 'true-token', arr: ['zz-true'], k: { true: 'v' } }, ['true'])
  assert.deepEqual(deep, { shadow: true, trusted: null, n: 1, s: '***-token', arr: ['zz-***'], k: { '***': 'v' } })
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(deep)))
})
