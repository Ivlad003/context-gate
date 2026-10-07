// Regression tests (review 2026-10-06, package cli): processes and git.
// M50 timeouts reach grandchildren, M46 a big @run input never fails the spawn (E2BIG), M47 export lists keyed by
// the module hash, M42/M43 git status parsing and lock-free git, P2 shared provider deadline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../packages/cli/src/util.ts'
import { NodeHost } from '../packages/cli/src/host-node.ts'
import { loadConfig } from '../packages/core/src/config.ts'
import { gitInfo, loadRepo, parsePorcelainZ, Providers } from '../packages/cli/src/context.ts'
import { sandbox } from './cli-helpers.ts'

test('M50 runProcess: a timeout kills the whole process group; a grandchild holding the pipes does not hang it', async () => {
  const cwd = sandbox()
  const t0 = Date.now()
  const r = await runProcess(['bash', '-c', 'sleep 30 & sleep 30; echo never'], { cwd, timeoutMs: 300, killGraceMs: 100 })
  assert.equal(r.timedOut, true)
  assert.equal(r.exitCode, -1)
  assert.ok(Date.now() - t0 < 5000, `settled in ${Date.now() - t0} ms`)
  // The direct child exits at once, a background grandchild keeps stdout open: settle after drainMs, keep output.
  const t1 = Date.now()
  const b = await runProcess(['bash', '-c', 'echo hi; sleep 30 &'], { cwd, timeoutMs: 20_000, drainMs: 300 })
  assert.equal(b.exitCode, 0)
  assert.equal(b.stdout, 'hi\n')
  assert.ok(Date.now() - t1 < 5000, `settled in ${Date.now() - t1} ms`)
  // Normal runs are unchanged.
  const c = await runProcess(['node', '-e', 'process.stdin.pipe(process.stdout)'], { cwd, stdin: 'abc', timeoutMs: 10_000 })
  assert.deepEqual([c.exitCode, c.stdout], [0, 'abc'])
  const d = await runProcess(['definitely-not-a-binary-cg'], { cwd })
  assert.equal(d.exitCode, -1)
  assert.match(d.stderr, /ENOENT/)
})

test('M50 a signal to the CLI reaches its detached children: no orphaned script after Ctrl+C or a harness kill', { skip: process.platform === 'win32' }, async () => {
  const util = join(import.meta.dirname, '../packages/cli/src/util.ts')
  const marker = `${40 + Math.floor(Math.random() * 9)}.${process.pid % 1000}`
  const inner = `import { runProcess } from ${JSON.stringify(util)}; await runProcess(['sleep', '${marker}'], { cwd: '/tmp', timeoutMs: 60000 })`
  const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', inner], { detached: true, stdio: 'ignore' })
  const count = () => execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter((l) => l.trim() === `sleep ${marker}`).length
  try {
    for (let i = 0; i < 50 && count() === 0; i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(count(), 1)
    process.kill(-p.pid!, 'SIGTERM')
    for (let i = 0; i < 30 && count() > 0; i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(count(), 0)
  } finally {
    try { execFileSync('pkill', ['-x', '-f', `sleep ${marker}`]) } catch { /* none left */ }
  }
})

test('L28 pipe reads input from a Node child_process pipe (a socketpair)', () => {
  const main = join(import.meta.dirname, '../packages/cli/src/main.ts')
  const root = join(import.meta.dirname, 'fixtures/cli-repo')
  const input = '{"kind":"skill","name":"a"}\n{"kind":"skill","name":"b"}\n'
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', main, 'pipe', 'take 10', '--root', root], { input, encoding: 'utf8', timeout: 20_000 })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 2)
})

test('M46 @run with a scope above the env limit: input on stdin and in CONTEXT_GATE_INPUT_FILE, no E2BIG', async () => {
  const root = sandbox()
  const host = new NodeHost({ root, config: loadConfig(undefined).config!, trusted: true, cacheDir: join(root, 'cache'), settings: {} })
  const big = JSON.stringify({ ctx: { rules: 'x'.repeat(300 * 1024) }, args: {} })
  const r = await host.run({ lang: 'bash', code: 'wc -c | tr -d " "; test -z "${CONTEXT_GATE_INPUT:-}" && wc -c < "$CONTEXT_GATE_INPUT_FILE" | tr -d " "', stdin: big, timeoutMs: 10_000 })
  assert.equal(r.exitCode, 0, r.stderr)
  assert.deepEqual(r.stdout.trim().split('\n'), [String(big.length), String(big.length)])
  const small = await host.run({ lang: 'bash', code: 'printf %s "$CONTEXT_GATE_INPUT"', stdin: '{"a":1}', timeoutMs: 10_000 })
  assert.equal(small.stdout, '{"a":1}', 'small inputs keep the env variable')
})

test('M47 listExports: an export added to the module is seen without clearing the cache', async () => {
  const root = sandbox()
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'lib/m.mjs'), 'export function a() { return 1 }\n')
  const mk = () => new NodeHost({ root, config: loadConfig(undefined).config!, trusted: true, cacheDir: join(root, 'cache'), settings: {} })
  assert.deepEqual(await mk().listExports('lib/m.mjs'), ['a'])
  writeFileSync(join(root, 'lib/m.mjs'), 'export function a() { return 1 }\nexport function b() { return 2 }\n')
  assert.deepEqual(await mk().listExports('lib/m.mjs'), ['a', 'b'])
})

test('M42 git status: -z porcelain with renames; Cyrillic names and files in new directories are listed', async () => {
  const cases: [string, string[]][] = [
    [' M a.ts\0?? docs/новий.md\0', ['a.ts', 'docs/новий.md']],
    ['R  new.ts\0old.ts\0 M b.ts\0', ['new.ts', 'b.ts']],
    ['', []],
  ]
  for (const [out, want] of cases) assert.deepEqual(parsePorcelainZ(out), want, JSON.stringify(out))
  const root = sandbox()
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' })
  git('init', '-q')
  mkdirSync(join(root, 'docs/нові'), { recursive: true })
  writeFileSync(join(root, 'docs/нові/правило.md'), 'x')
  writeFileSync(join(root, 'plain.ts'), 'x')
  const info = await gitInfo(root)
  assert.deepEqual([...(info.changed as string[])].sort(), ['docs/нові/правило.md', 'plain.ts'])
  assert.equal(info.dirty, true)
})

test('P2 providers resolve under one shared deadline: a slow one is null with G203, the others keep their values', async () => {
  const root = sandbox()
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude/gate.json'), JSON.stringify({ providers: { slow: { kind: 'cli', command: ['bash', '-c', 'sleep 5; echo 1'] }, fast: { kind: 'cli', command: ['bash', '-c', 'echo \'{"ok":true}\''] } } }))
  const repo = loadRepo(root)
  const host = new NodeHost({ root, config: repo.config, trusted: true, cacheDir: repo.cacheDir, settings: {} })
  const providers = new Providers({ repo, host, rules: [], liveGit: false })
  const t0 = Date.now()
  const v = await providers.resolveAll(undefined, 800)
  assert.ok(Date.now() - t0 < 4000, `resolved in ${Date.now() - t0} ms`)
  assert.deepEqual(v, { slow: null, fast: { ok: true } })
  assert.ok(host.notes.some((d) => d.code === 'G203' && /slow/.test(d.message)))
})
