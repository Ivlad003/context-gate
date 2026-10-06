// WP5 observability: build-time trace labels, secret masking, the debug log, the @call cache key by module
// hash (render.ts); H011/H012/H002-from-usage/D001/cache hit rate (health.ts); `run --debug`, assertFail.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RenderResult, RenderedSection, SectionNode, Scope_, Value } from '../packages/core/src/types.ts'
import { capDebugLog, callCacheKey, debugLogLines, maskSecrets, renderPrompt, secretValues, type RenderHostExt } from '../packages/core/src/render.ts'
import { computeHealth, formatHealth } from '../packages/core/src/health.ts'
import { assertFailOf, envSecrets } from '../packages/cli/src/cmd-run.ts'
import { cli, copyFixture } from './cli-helpers.ts'

const host = (extra: Partial<RenderHostExt> = {}): RenderHostExt => ({ readFile: async () => undefined, now: () => 1_000_000, trusted: false, ...extra })
const section = (children: SectionNode['children'], id = 's'): SectionNode => ({ id, scope: 'profile', children })

// ───────────────────────── render.ts ─────────────────────────

test('constant text is labelled build-time in the trace; imported text includes too', async () => {
  const r = await renderPrompt([section([{ t: 'text', value: 'Привіт, ' }, { t: 'expr', expr: 'name' }, { t: 'include', source: 'text', mode: 'inline', text: 'CONV', as: 'conv', ref: 'CONVENTIONS.md' } as never])], { name: 'світ' }, host(), { tier: 'standard' })
  assert.equal(r.text.includes('Привіт, світ'), true)
  const bt = r.trace.filter((t) => t.source === 'build-time')
  assert.ok(bt.some((t) => t.kind === 'section' && /константи збірки: 8 символів/.test(t.detail)), JSON.stringify(r.trace))
  assert.ok(bt.some((t) => t.kind === 'include' && /text:conv inline/.test(t.detail)))
})

test('@trace on labels each constant text node build-time', async () => {
  const r = await renderPrompt([section([{ t: 'trace', on: true }, { t: 'text', value: 'abc' }])], {}, host(), { tier: 'standard' })
  assert.ok(r.trace.some((t) => t.kind === 'debug' && t.source === 'build-time' && t.detail.includes('abc')))
})

test('secrets from scope.env and opts.secrets are masked in debug trace and diagnostics, never in the text', async () => {
  const scope: Scope_ = { env: { API_TOKEN: 'sk-live-12345', SHORT: 'ab' }, other: 'pw-98765' }
  const sec = section([
    { t: 'debug', exprs: ['env.API_TOKEN', 'other', 'env.SHORT'] },
    { t: 'assert', test: 'false', message: 'token {{ env.API_TOKEN }}' },
  ])
  const r = await renderPrompt([sec], scope, host(), { tier: 'standard', debug: true, secrets: ['pw-98765'] })
  const all = JSON.stringify([r.trace, r.diagnostics])
  assert.equal(all.includes('sk-live-12345'), false, all)
  assert.equal(all.includes('pw-98765'), false)
  assert.ok(all.includes('***'))
  assert.ok(all.includes('env.SHORT=ab'), 'values shorter than 4 chars are not masked')
  assert.deepEqual(secretValues(scope, ['pw-98765']), ['sk-live-12345', 'pw-98765'])
  assert.equal(maskSecrets('a sk-live-12345 b', ['sk-live-12345']), 'a *** b')
})

test('@debug never changes the rendered bytes (with or without debug)', async () => {
  const children: SectionNode['children'] = [{ t: 'text', value: 'A' }, { t: 'debug', exprs: ['1 + 1'] }, { t: 'text', value: 'B' }]
  const a = await renderPrompt([section(children)], {}, host(), { tier: 'standard', debug: true })
  const b = await renderPrompt([section(children)], {}, host(), { tier: 'standard' })
  assert.equal(a.text, b.text)
  assert.ok(a.trace.some((t) => t.kind === 'debug' && t.detail.includes('1 + 1=2')))
  assert.equal(b.trace.some((t) => t.kind === 'debug' && t.source !== 'build-time'), false)
})

test('debug log lines: @debug/@log/@assert + D001, masked; capped from the head at whole lines', () => {
  const res: Pick<RenderResult, 'trace' | 'diagnostics'> = {
    trace: [
      { section: 's', kind: 'debug', detail: 'x=secret-value' },
      { section: 's', kind: 'log', detail: 'info: hi' },
      { section: 's', kind: 'if', detail: 'a → true' },
      { section: 's', kind: 'debug', detail: 'текст «x»', source: 'build-time' },
    ],
    diagnostics: [{ code: 'D001', severity: 'warning', message: 'assert: boom' }, { code: 'G120', severity: 'warning', message: 'no' }],
  }
  const lines = debugLogLines(res, Date.UTC(2026, 9, 6), { tier: 'quick', secrets: ['secret-value'] })
  assert.equal(lines.split('\n').filter(Boolean).length, 3)
  assert.match(lines, /^2026-10-06T00:00:00.000Z tier=quick s debug: x=\*\*\*$/m)
  assert.match(lines, /D001 warning: assert: boom/)
  assert.equal(debugLogLines({ trace: [], diagnostics: [] }, 0), '')
  const capped = capDebugLog('line-1\nline-2\n', 'line-3\n', 10)
  assert.equal(capped, 'line-3\n')
  assert.ok(capped.length <= 10)
  assert.equal(capDebugLog('a\n', 'b\n', 100), 'a\nb\n')
})

test('@call results are cached under the module content hash: an edited module is a cache miss', async () => {
  const store = new Map<string, { value: Value; at: number }>()
  let src = 'export const f = () => 1'
  let calls = 0
  const h = (): RenderHostExt => host({
    trusted: true,
    readFile: async (p) => (p === 'lib/m.mjs' ? src : undefined),
    cacheGet: async (k) => store.get(k),
    cacheSet: async (k, v) => { store.set(k, { value: v, at: 1_000_000 }) },
    call: async (req) => { calls++; return req.calls.map(() => calls) },
  })
  const sec = section([{ t: 'use', name: 'm', path: 'lib/m.mjs' }, { t: 'call', fn: 'm.f', args: [], as: 'v', cache: '1h' } as never, { t: 'expr', expr: 'v' }])
  const r1 = await renderPrompt([sec], {}, h(), { tier: 'standard' })
  const r2 = await renderPrompt([sec], {}, h(), { tier: 'standard' })
  assert.equal(r1.text, '1')
  assert.equal(r2.text, '1', 'same module → cache hit')
  assert.equal(calls, 1)
  src = 'export const f = () => 2 // edited'
  const r3 = await renderPrompt([sec], {}, h(), { tier: 'standard' })
  assert.equal(calls, 2, 'edited module → new key → fresh call')
  assert.equal(r3.text, '2')
  assert.ok([...store.keys()].every((k) => /#[0-9a-f]{8}$/.test(k)), [...store.keys()].join())
  // A host hash wins over reading the file.
  const keys: string[] = []
  await renderPrompt([sec], {}, host({ trusted: true, fileHash: () => 'abc123', cacheGet: async (k) => { keys.push(k); return undefined }, call: async (req) => req.calls.map(() => 0) }), { tier: 'standard' })
  assert.ok(keys[0]!.endsWith('#abc123'))
  assert.equal(callCacheKey('call:x:f:[]', null), 'call:x:f:[]')
})

// ───────────────────────── health.ts ─────────────────────────

const sec = (id: string, scope: RenderedSection['scope'], tokens: number): RenderedSection => ({ id, scope, text: '', chars: tokens * 4, tokens, included: true, hash: id, status: 'ok' })
const result = (sections: RenderedSection[], extra: Partial<RenderResult> = {}): RenderResult => ({ sections, text: '', trace: [], diagnostics: [], ms: 10, stored: {}, ...extra })
const m = (r: ReturnType<typeof computeHealth>, code: string) => r.metrics.find((x) => x.code === code)

test('H011: a gate blocking more than 30 % of attempts; per-gate rows with avg ms and overrides', () => {
  const r = computeHealth(result([sec('a', 'static', 100)]), undefined, { gates: { tests: { attempts: 10, blocks: 2, ms: 1000 }, 'read-before-write': { attempts: 4, blocks: 3, ms: 0, overrides: 2 } } })
  assert.equal(m(r, 'H011')?.value, 75)
  assert.equal(m(r, 'H011')?.ok, false)
  assert.match(String(m(r, 'H011')?.advice), /read-before-write.*«все одно» 2/)
  assert.ok(r.metrics.some((x) => x.name === 'Гейт tests' && /2\/10 заблоковано \(20 %\), 100 мс/.test(String(x.value))))
  assert.equal(computeHealth(result([]), undefined, { gates: { t: { attempts: 10, blocks: 3 } } }).metrics.find((x) => x.code === 'H011')?.ok, true)
  assert.equal(m(computeHealth(result([])), 'H011'), undefined, 'no gate data → no H011 row')
})

test('H012: system prompt share of input tokens; H002 from real cache usage', () => {
  const cur = result([sec('a', 'static', 4500), sec('b', 'volatile', 500)])
  const r = computeHealth(cur, undefined, { usage: { inputTokens: 1000, cacheReadTokens: 6000, cacheCreationTokens: 3000 } })
  assert.equal(m(r, 'H012')?.value, 50)
  assert.equal(m(r, 'H012')?.ok, false)
  assert.equal(m(r, 'H002')?.value, 60, 'cache_read / all input')
  assert.equal(m(r, 'H002')?.ok, false)
  assert.equal(r.metrics.filter((x) => x.code === 'H002').length, 1)
  const ok = computeHealth(cur, undefined, { usage: { inputTokens: 500, cacheReadTokens: 19_000, cacheCreationTokens: 500 } })
  assert.equal(m(ok, 'H012')?.ok, true)
  assert.equal(m(ok, 'H002')?.value, 95)
})

test('cost, compactions, decision, skills without description show under «Сесія»', () => {
  const r = computeHealth(result([sec('a', 'static', 10)]), undefined, {
    usage: { inputTokens: 100, cacheReadTokens: 0, sessionInputTokens: 200_000 }, costPer1k: 0.003, compactions: 2,
    decision: { profile: 'frontend', confidence: 0.82, manualOverrides: 1 }, skillsNoDescription: 4, skillListingChars: 40_000, contextWindow: 200_000,
  })
  const md = formatHealth(r)
  assert.match(md, /\| Сесія \| Значення \|/)
  assert.match(md, /Вартість сесії, \$ \(оцінка\) \| 0\.60/)
  assert.match(md, /Компакції за сесію \| 2/)
  assert.match(md, /профіль frontend, confidence 0\.82, ручних перевизначень 1/)
  assert.match(md, /Skills без опису в листингу \| 4/)
  assert.equal(m(r, 'H009')?.ok, false, 'description-less skills fail H009')
  assert.match(String(m(r, 'H009')?.advice), /4 skills без опису/)
  assert.equal(/\| tokens \|/.test(md), false, 'internal metrics stay out of the table')
})

test('H004/H005: top slow @run/@call and the cache hit rate; D001 from asserts', () => {
  const trace: RenderResult['trace'] = [
    { section: 'a', kind: 'run', detail: '', ms: 900, source: 'run' },
    { section: 'b', kind: 'call', detail: '', source: 'cache' },
    { section: 'c', kind: 'run', detail: '', ms: 1500, source: 'run' },
    { section: 'd', kind: 'mcp', detail: '', source: 'cache' },
  ]
  const r = computeHealth(result([], { trace, ms: 2600, diagnostics: [{ code: 'D001', severity: 'warning', message: '[a] assert: x' }] }))
  assert.match(String(m(r, 'H005')?.advice), /найдовші: c run 1500 мс, a run 900 мс; cache hit 50 %/)
  assert.ok(r.metrics.some((x) => x.name.startsWith('Cache hit rate') && x.value === 50))
  assert.equal(m(r, 'D001')?.value, 1)
  assert.equal(m(r, 'D001')?.ok, false)
  assert.equal(m(computeHealth(result([])), 'D001')?.ok, true)
})

// ───────────────────────── CLI ─────────────────────────

test('assertFail and env secrets come from gate.json', () => {
  assert.equal(assertFailOf({ assertFail: 'fail' } as never), 'fail')
  assert.equal(assertFailOf({ prompt: { assertFail: 'skip' } } as never), 'skip')
  assert.equal(assertFailOf({ assertFail: 'nope' } as never), undefined)
  assert.deepEqual(envSecrets({ env: ['A', 'B', 'C'] } as never, { A: 'value-a', B: '' }), ['value-a'])
})

test('run --debug writes .claude/gate.debug.log (masked); without debug nothing is written; assertFail: fail fails the run', async () => {
  const root = copyFixture()
  const prompt = join(root, '.claude', 'prompt', 'dbg.md')
  writeFileSync(prompt, '---\nid: dbg\nscope: volatile\n---\n@debug "tok", env_token\nТекст.\n')
  const log = join(root, '.claude', 'gate.debug.log')
  const plain = await cli(root, ['run', '--dry-scripts'])
  assert.equal(plain.code, 0, plain.err)
  assert.equal(existsSync(log), false)
  const r = await cli(root, ['run', '--dry-scripts', '--debug'])
  assert.equal(r.code, 0, r.err)
  assert.ok(existsSync(log))
  assert.match(readFileSync(log, 'utf8'), /dbg debug: \[debug dbg\] tok/)
  // Secrets: a gate.json env whitelist masks the process value.
  const cfgPath = join(root, '.claude', 'gate.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  writeFileSync(prompt, '---\nid: dbg\nscope: volatile\n---\n@debug "секрет MY_SECRET_TOKEN_VALUE"\n@assert false, "впало"\nТекст.\n')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, env: ['CG_TEST_SECRET'], assertFail: 'fail' }))
  process.env.CG_TEST_SECRET = 'MY_SECRET_TOKEN_VALUE'
  try {
    const r2 = await cli(root, ['run', '--dry-scripts', '--debug'])
    const text = readFileSync(log, 'utf8')
    assert.equal(text.includes('MY_SECRET_TOKEN_VALUE'), false, text)
    assert.match(text, /секрет \*\*\*/)
    assert.match(text, /D001 error: \[dbg\] assert: впало/)
    assert.equal(r2.code, 1, 'assertFail: fail → D001 error → exit 1')
  } finally { delete process.env.CG_TEST_SECRET }
})

test('a fence title is a template (Examples: title="{{ ex.path }}")', async () => {
  const r = await renderPrompt([section([{ t: 'fence', lang: 'ts', title: '{{ p }}', children: [{ t: 'text', value: 'x' }] } as never])], { p: 'src/a.ts' }, host(), { tier: 'standard' })
  assert.match(r.text, /```ts title="src\/a\.ts"/)
})
