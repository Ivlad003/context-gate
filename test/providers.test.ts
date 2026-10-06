// Core provider helpers (`providers.ts`): the cli exit-code decision (`okExitCodes`, `parseOnError`), `pick`,
// `file` values; and the CLI running the examples/providers/eslint provider (exit 1 with JSON is data).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileProviderValue, pickFields, providerResultOk } from '../packages/core/src/providers.ts'
import { loadConfig } from '../packages/core/src/config.ts'
import { REPO, cli, sandbox } from './cli-helpers.ts'

test('providerResultOk: okExitCodes (default [0]) and parseOnError', () => {
  const rows: [Parameters<typeof providerResultOk>[0], number, string, boolean, unknown][] = [
    [{}, 0, '{"a":1}', true, { a: 1 }],
    [{}, 0, 'plain', true, 'plain'],
    [{}, 0, '', true, null],
    [{}, 1, '[]', false, undefined],
    [{ okExitCodes: [0, 1] }, 1, '[{"x":1}]', true, [{ x: 1 }]],
    [{ okExitCodes: [0, 1] }, 1, 'text', true, 'text'],
    [{ okExitCodes: [0, 1] }, 2, '[]', false, undefined],
    [{ parseOnError: true }, 1, '[{"errorCount":2}]', true, [{ errorCount: 2 }]],
    [{ parseOnError: true }, 2, 'Oops! Something went wrong', false, undefined],
    [{ parseOnError: true }, 2, '', false, undefined],
    [{ okExitCodes: [] }, 0, '1', true, 1],
  ]
  for (const [cfg, code, out, ok, value] of rows) {
    const r = providerResultOk(cfg, code, out)
    assert.equal(r.ok, ok, `${JSON.stringify(cfg)} exit ${code}`)
    if (r.ok) assert.deepEqual(r.value, value)
    else assert.match(r.error, new RegExp(`exit ${code}`))
  }
})

test('pickFields and fileProviderValue', () => {
  assert.deepEqual(pickFields({ a: 1, b: { c: 2, d: 3 } }, ['b.c']), { b: { c: 2 } })
  assert.deepEqual(pickFields([1, 2], ['x']), [1, 2])
  assert.deepEqual(fileProviderValue('x.json', '{"a":1,"b":2}', ['a']), { value: { a: 1 } })
  assert.ok('error' in fileProviderValue('x.json', '{'))
  assert.deepEqual(fileProviderValue('notes.txt', 'hi'), { value: 'hi' })
  assert.deepEqual(fileProviderValue('doc.md', '# x'), { markdown: true })
})

test('config: okExitCodes / parseOnError are schema keys of cli providers; on other kinds G302', () => {
  const ok = loadConfig(JSON.stringify({ providers: { eslint: { kind: 'cli', command: ['eslint'], okExitCodes: [0, 1], parseOnError: true } } }))
  assert.deepEqual(ok.diagnostics, [])
  assert.deepEqual(ok.config!.providers!.eslint!.okExitCodes, [0, 1])
  const bad = loadConfig(JSON.stringify({ providers: { f: { kind: 'file', path: 'x.json', parseOnError: true } } }))
  assert.ok(bad.diagnostics.some((d) => d.code === 'G302' && d.message.includes('parseOnError')))
  const wrongType = loadConfig(JSON.stringify({ providers: { e: { kind: 'cli', command: ['e'], okExitCodes: ['1'] } } }))
  assert.ok(wrongType.diagnostics.some((d) => d.code === 'G303'))
})

test('examples/providers/eslint: the fake eslint exits 1 with JSON and the section renders (okExitCodes)', async () => {
  const dir = sandbox()
  const root = join(dir, 'eslint-demo')
  mkdirSync(join(root, '.claude', 'prompt'), { recursive: true })
  cpSync(join(REPO, 'examples/providers/eslint/gate.json'), join(root, '.claude', 'gate.json'))
  cpSync(join(REPO, 'examples/providers/eslint/lint.md'), join(root, '.claude', 'prompt', 'lint.md'))
  mkdirSync(join(process.env.HOME!, '.claude'), { recursive: true })
  writeFileSync(join(process.env.HOME!, '.claude', 'context-gate.json'), JSON.stringify({ allowBinaries: ['eslint', 'node', 'sh'] }))
  const path = process.env.PATH
  process.env.PATH = `${join(REPO, 'examples/providers/eslint/bin')}:${path}`
  try {
    const r = await cli(root, ['run', '--trust-repo', '--no-markers'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /ESLint: 3 файлів перевірено, з помилками — 2/)
    assert.doesNotMatch(r.err, /G203/)
  } finally {
    process.env.PATH = path
  }
})

test('markdownProviderValue: one shape for the CLI, the mod and static adapters', async () => {
  const { markdownProviderValue, staticProviderValue } = await import('../packages/core/src/providers.ts')
  const md = '---\ntitle: Рішення\ntags:\n  - api\n  - db\n---\n# ADR 1\ntext\n## Наслідки\n'
  const want = { meta: { title: 'Рішення', tags: ['api', 'db'] }, body: '# ADR 1\ntext\n## Наслідки\n', headings: [{ level: 1, text: 'ADR 1' }, { level: 2, text: 'Наслідки' }] }
  assert.deepEqual(markdownProviderValue(md), want)
  assert.deepEqual(staticProviderValue({ providers: { d: { kind: 'file', path: 'docs/d.md' } } }, 'd', () => md), want)
})
