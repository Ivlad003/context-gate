// examples/providers/{keylang,tsc}: the example configs validate, the keylang provider renders through the CLI
// (fake binary on PATH), and its provider rule source yields Always rules. The tsc gate itself runs in the mod
// (hooks/gate.test.ts covers onlyNew + baseline); here we pin the example's shape and baseline format.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../packages/core/src/config.ts'
import { REPO, cli, sandbox } from './cli-helpers.ts'

const EX = join(REPO, 'examples/providers')

for (const name of ['keylang', 'tsc', 'eslint']) {
  test(`examples/providers/${name}/gate.json validates without diagnostics`, () => {
    const r = loadConfig(readFileSync(join(EX, name, 'gate.json'), 'utf8'))
    assert.ok(r.config, 'config loads')
    assert.deepEqual(r.diagnostics.filter((d) => d.severity !== 'info'), [])
  })
}

test('examples/providers/tsc: one onlyNew turn gate; baseline lines are `tsc --pretty false` lines keyed by gate name', () => {
  const cfg = loadConfig(readFileSync(join(EX, 'tsc/gate.json'), 'utf8')).config!
  const g = cfg.gates!.find((x) => x.name === 'typecheck')!
  assert.equal(g.on, 'turn')
  assert.equal(g.onlyNew, true)
  assert.ok(g.run!.includes('--pretty') && g.run!.includes('false'))
  const baseline = JSON.parse(readFileSync(join(EX, 'tsc', g.baseline!), 'utf8')) as Record<string, string[]>
  assert.ok(Array.isArray(baseline.typecheck) && baseline.typecheck.length > 0)
  for (const line of baseline.typecheck) assert.match(line, /^[\w./-]+\(\d+,\d+\): error TS\d+: /)
})

test('examples/providers/keylang: the arch provider renders the architecture section via the fake keylang', async () => {
  const dir = sandbox()
  const root = join(dir, 'keylang-demo')
  mkdirSync(join(root, '.claude', 'prompt'), { recursive: true })
  cpSync(join(EX, 'keylang/gate.json'), join(root, '.claude', 'gate.json'))
  cpSync(join(EX, 'keylang/architecture.md'), join(root, '.claude', 'prompt', 'architecture.md'))
  mkdirSync(join(process.env.HOME!, '.claude'), { recursive: true })
  writeFileSync(join(process.env.HOME!, '.claude', 'context-gate.json'), JSON.stringify({ allowBinaries: ['keylang', 'node', 'sh'] }))
  const path = process.env.PATH
  process.env.PATH = `${join(EX, 'keylang/bin')}:${path}`
  try {
    const r = await cli(root, ['run', '--trust-repo', '--no-markers'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /Межі архітектури \(з keylang\):/)
    assert.match(r.out, /domain не імпортує infrastructure — домен не знає про БД і HTTP/)
    assert.match(r.out, /application\.purchase\.buy: use case купівлі/)
  } finally {
    process.env.PATH = path
  }
})

test('examples/providers/keylang: untrusted repo runs nothing — the section renders without provider data', async () => {
  const dir = sandbox()
  const root = join(dir, 'keylang-untrusted')
  mkdirSync(join(root, '.claude', 'prompt'), { recursive: true })
  cpSync(join(EX, 'keylang/gate.json'), join(root, '.claude', 'gate.json'))
  cpSync(join(EX, 'keylang/architecture.md'), join(root, '.claude', 'prompt', 'architecture.md'))
  const path = process.env.PATH
  process.env.PATH = `${join(EX, 'keylang/bin')}:${path}`
  try {
    const r = await cli(root, ['run', '--no-markers'])
    assert.equal(r.code, 0, r.err)
    assert.doesNotMatch(r.out, /domain не імпортує infrastructure/)
  } finally {
    process.env.PATH = path
  }
})
