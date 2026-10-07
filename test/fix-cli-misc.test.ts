// Regression tests (review 2026-10-06, package cli): secrets, module providers, data formats, flags and CI.
// M04 env values masked in run --json/.trace/index, M44/M45 module bundles (helper edits, npm imports), L24/L31
// YAML/TOML edge cases, S10 --trust-repo in CI, L17 report --since, L13 render flags, L15/L16 init.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseToml, parseYaml } from '../packages/cli/src/dataformats.ts'
import { ciTrustCheck } from '../packages/cli/src/main.ts'
import { NodeHost } from '../packages/cli/src/host-node.ts'
import { loadRepo, Providers } from '../packages/cli/src/context.ts'
import { guessProfiles, removeGitignoreLines } from '../packages/cli/src/cmd-init.ts'
import { parseArgv } from '../packages/cli/src/argv.ts'
import { cli, sandbox } from './cli-helpers.ts'

function repo(files: Record<string, string>): string {
  const root = sandbox()
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text) }
  return root
}

test('M04 values of the env whitelist never reach run --json, .trace/last.json or gate.index.json', async () => {
  process.env.CG_TEST_TOKEN = 'tok-SECRET-123'
  try {
    const root = repo({ '.claude/gate.json': JSON.stringify({ env: ['CG_TEST_TOKEN'] }), '.claude/prompt/main.md': '---\nid: m\n---\nhello\n' })
    const r = await cli(root, ['run', '--json'])
    assert.equal(r.code, 0, r.err)
    const j = JSON.parse(r.out)
    assert.deepEqual(j.scope.env, { CG_TEST_TOKEN: '***' })
    assert.ok(!r.out.includes('tok-SECRET-123'))
    assert.ok(!readFileSync(join(root, '.claude/prompt/.trace/last.json'), 'utf8').includes('tok-SECRET-123'))
    assert.equal((await cli(root, ['index'])).code, 0)
    assert.ok(!readFileSync(join(root, '.claude/gate.index.json'), 'utf8').includes('tok-SECRET-123'))
  } finally { delete process.env.CG_TEST_TOKEN }
})

test('M44/M45 module provider: npm imports resolve from the repo; editing an imported helper rebuilds the bundle', async () => {
  const root = repo({
    'node_modules/fakedep/package.json': JSON.stringify({ name: 'fakedep', type: 'module', main: 'index.js' }),
    'node_modules/fakedep/index.js': 'export const greet = (s) => `hi ${s}`\n',
    '.claude/prompt/lib/helper.ts': 'export const who = "v1"\n',
    '.claude/prompt/lib/hello.ts': "import { greet } from 'fakedep'\nimport { who } from './helper.ts'\nexport default () => greet(who)\n",
  })
  const value = async () => {
    const r = loadRepo(root)
    const host = new NodeHost({ root, config: r.config, trusted: true, cacheDir: r.cacheDir, settings: {} })
    const p = new Providers({ repo: r, host, rules: [], liveGit: false })
    return { v: await p.value('hello'), notes: host.notes }
  }
  const a = await value()
  assert.equal(a.v, 'hi v1', JSON.stringify(a.notes))
  writeFileSync(join(root, '.claude/prompt/lib/helper.ts'), 'export const who = "v2"\n')
  assert.equal((await value()).v, 'hi v2')
})

test('L24 YAML: an empty or comment-only sequence item is null, not a list of its siblings; L31 TOML/YAML own keys', () => {
  const yaml: [string, unknown][] = [
    ['- a\n- # TODO\n- c\n', ['a', null, 'c']],
    ['- a\n-\n- c\n', ['a', null, 'c']],
    ['-\n  - x\n- y\n', [['x'], 'y']],
    ['k:\n- a\n- b\n', { k: ['a', 'b'] }],
  ]
  for (const [src, want] of yaml) { const r = parseYaml(src); assert.ok(r.ok, src); assert.deepEqual((r as { value: unknown }).value, want, src) }
  const t = parseToml('[constructor]\nx = 1\n[toString]\ny = 2\n[__proto__]\npolluted = true\n')
  assert.ok(t.ok, JSON.stringify(t))
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype untouched')
  const v = (t as { value: Record<string, unknown> }).value
  assert.deepEqual(Object.keys(v), ['constructor', 'toString', '__proto__'])
  assert.deepEqual(JSON.parse(JSON.stringify(v)), JSON.parse('{"constructor":{"x":1},"toString":{"y":2},"__proto__":{"polluted":true}}'))
  const y = parseYaml('__proto__:\n  polluted: true\n')
  assert.ok(y.ok)
  assert.equal(Object.getPrototypeOf((y as { value: object }).value), Object.prototype)
  assert.ok(Object.hasOwn((y as { value: object }).value, '__proto__'))
})

test('S10 --trust-repo in CI: refused on pull_request_target, warned on pull_request, silent elsewhere', () => {
  const cases: [Record<string, string>, boolean, boolean][] = [
    [{}, true, false],
    [{ GITHUB_EVENT_NAME: 'push' }, true, false],
    [{ GITHUB_EVENT_NAME: 'pull_request' }, true, true],
    [{ GITHUB_EVENT_NAME: 'pull_request_target' }, false, true],
    [{ GITHUB_EVENT_NAME: 'pull_request_target', CONTEXT_GATE_TRUST_PR_TARGET: '1' }, true, true],
  ]
  for (const [env, allow, warns] of cases) {
    const r = ciTrustCheck(env)
    assert.equal(r.allow, allow, JSON.stringify(env))
    assert.equal(!!r.warning, warns, JSON.stringify(env))
  }
})

test('L17 report --since: an unparseable window or a unitless number is a usage error', async () => {
  const root = repo({})
  for (const bad of ['7days', '1 week', '2024']) assert.equal((await cli(root, ['report', '--since', bad])).code, 2, bad)
  assert.equal((await cli(root, ['report', '--since', '7d'])).code, 0)
})

test('L13 stage flags never swallow the target: render --json prompt://x', () => {
  const p = parseArgv(['--json', 'prompt://x'], {}, true)
  assert.deepEqual(p.positional, ['prompt://x'])
})

test('L15 init: packages/core gets its own group, not the tier-wide core; L16 equivalent .compiled ignore lines go', () => {
  const root = repo({ 'packages/core/src/a.ts': '', 'packages/web/src/b.ts': '' })
  const g = guessProfiles(root)
  assert.deepEqual(g.groups.core, ['skill:tdd', 'skill:diagnosing-bugs'])
  assert.ok(g.groups['pkg-core']?.includes('rule:core*'))
  writeFileSync(join(root, '.gitignore'), 'node_modules\n/.claude/prompt/.compiled\n.claude/prompt/.compiled/\n')
  assert.deepEqual(removeGitignoreLines(root, ['.claude/prompt/.compiled/']), ['/.claude/prompt/.compiled', '.claude/prompt/.compiled/'])
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules\n')
})

test('L16 init --commit-compiled warns when another pattern still ignores .compiled', async () => {
  const root = repo({ '.gitignore': '**/.compiled\n' })
  execFileSync('git', ['init', '-q'], { cwd: root })
  const r = await cli(root, ['init', '--commit-compiled'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /досі ігнорується \(\.gitignore:1:\*\*\/\.compiled\)/)
})
