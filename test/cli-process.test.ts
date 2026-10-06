import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, copyFixture } from './cli-helpers.ts'

const SRC = join(REPO, 'packages/cli/src/main.ts')
const DIST = join(REPO, 'dist/cli.js')

test('entry point runs as a process: exit codes and stdout', () => {
  const root = copyFixture()
  const env = { ...process.env }
  const v = spawnSync(process.execPath, [SRC, 'version'], { env, encoding: 'utf8' })
  assert.equal(v.status, 0, v.stderr)
  assert.match(v.stdout, /^context-gate \d/)
  assert.equal(spawnSync(process.execPath, [SRC, 'nope'], { env, encoding: 'utf8' }).status, 2)
  // Pipe through real stdin/stdout.
  const collected = execFileSync(process.execPath, [SRC, 'collect', '--kind', 'rule', '--root', root], { env, encoding: 'utf8' })
  const t = spawnSync(process.execPath, [SRC, 'tokens', '--root', root], { env, input: collected, encoding: 'utf8' })
  assert.equal(t.status, 0, t.stderr)
  assert.equal(JSON.parse(t.stdout).count, 3)
})

test('dist/cli.js run --trace on examples/basic (after npm run build)', { skip: !existsSync(DIST) || !existsSync(join(REPO, 'examples/basic/.claude/prompt')) }, () => {
  const root = copyFixture(join(REPO, 'examples/basic'), 'basic')
  const b = spawnSync(process.execPath, [DIST, 'build', '--root', root], { encoding: 'utf8' })
  assert.equal(b.status, 0, b.stdout + b.stderr)
  const r = spawnSync(process.execPath, [DIST, 'run', '--trace', '--root', root], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /<!-- section:identity static -->/)
  assert.match(r.stdout, /\| секція \| scope \| стан \| токени \| причина \|/)
})
