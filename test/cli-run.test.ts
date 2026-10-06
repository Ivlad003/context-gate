import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CompiledPrompt, Value } from '../packages/core/src/types.ts'
import { renderPrompt, type RenderHostExt } from '../packages/core/src/render.ts'
import { REPO, cli, copyFixture } from './cli-helpers.ts'
import { parseRunJson } from '../packages/core/src/runjson.ts'

const basic = join(REPO, 'examples', 'basic')

test('build + run on examples/basic: CLI text equals core renderPrompt over the same scope (what prompt.compose gets)', { skip: !existsSync(join(basic, '.claude', 'prompt')) }, async () => {
  const root = copyFixture(basic, 'basic')
  const b = await cli(root, ['build', '--json'])
  assert.equal(b.code, 0, b.out + b.err)
  const built = JSON.parse(b.out)
  assert.ok(built.compiled.includes('main'))
  const plain = await cli(root, ['run', '--no-markers'])
  assert.equal(plain.code, 0, plain.err)
  const j = await cli(root, ['run', '--json'])
  const res = JSON.parse(j.out)
  assert.equal(res.text + '\n', plain.out)
  // Independent assembly: compiled JSON + the scope the CLI used + a bare untrusted host.
  const dir = join(root, '.claude', 'prompt', '.compiled')
  const compiled = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as CompiledPrompt).filter((c) => !c.skill).sort((a, c) => a.id.localeCompare(c.id))
  const host: RenderHostExt = { readFile: async (p) => { try { return readFileSync(join(root, p), 'utf8') } catch { return undefined } }, now: () => Date.now(), trusted: false }
  const direct = await renderPrompt(compiled, res.scope as Record<string, Value>, host, { tier: res.meta.tier, runCacheDefault: '5m' })
  assert.equal(direct.text, res.text)
  // Default output has section markers; --trace appends the table.
  const marked = await cli(root, ['run'])
  assert.match(marked.out, /<!-- section:identity static -->/)
  const traced = await cli(root, ['run', '--trace'])
  assert.match(traced.out, /\| секція \| scope \| стан \| токени \| причина \|/)
})

test('run --json: trace shape (sections, trace, diagnostics, scope, gate) and .trace/last.json', async () => {
  const root = copyFixture()
  const r = await cli(root, ['run', '--json'])
  assert.equal(r.code, 0, r.err)
  const j = JSON.parse(r.out)
  // Core RunJson: exactly these top-level keys.
  assert.deepEqual(Object.keys(j).sort(), ['diagnostics', 'health', 'meta', 'ms', 'scope', 'sections', 'text', 'trace'])
  assert.ok('json' in parseRunJson(r.out))
  for (const k of ['ok', 'mode', 'tier', 'profile', 'source', 'trusted', 'stored', 'lazies', 'gate', 'at']) assert.ok(k in j.meta, `missing meta.${k}`)
  assert.equal(j.meta.mode, 'prompt')
  assert.equal(j.meta.source, 'live')
  assert.equal(j.meta.trusted, false)
  assert.ok(Array.isArray(j.health.metrics))
  assert.deepEqual(j.sections.map((s: { id: string }) => s.id), ['intro', 'workflow', 'data'])
  for (const s of j.sections) for (const k of ['id', 'scope', 'text', 'chars', 'tokens', 'included', 'hash', 'status']) assert.ok(k in s, `section.${k}`)
  for (const t of j.trace) { assert.equal(typeof t.section, 'string'); assert.equal(typeof t.kind, 'string'); assert.equal(typeof t.detail, 'string') }
  for (const k of ['gate', 'git', 'cursor', 'session', 'ctx', 'budgets', 'args', 'data', 'pkg']) assert.ok(k in j.scope, `scope.${k}`)
  assert.equal(j.scope.pkg.name, 'fixture-app')
  assert.deepEqual(j.scope.cursor.always.map((x: { id: string }) => x.id), ['always'])
  assert.ok(j.diagnostics.some((d: { code: string }) => d.code === 'G205'), 'mcp provider is unverified in CLI')
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude/prompt/.trace/last.json'), 'utf8')).scope, j.scope, 'last.json holds the same RunJson, scope included')
  // Plain `run` (no --json) writes last.json too.
  rmSync(join(root, '.claude/prompt/.trace'), { recursive: true, force: true })
  await cli(root, ['run', '--no-markers'])
  assert.ok('json' in parseRunJson(readFileSync(join(root, '.claude/prompt/.trace/last.json'), 'utf8')))
  // --only renders one section.
  const one = JSON.parse((await cli(root, ['run', '--only', 'intro', '--json'])).out)
  assert.deepEqual(one.sections.map((s: { id: string }) => s.id), ['intro'])
  assert.equal(one.text, 'Проєкт fixture-app. Тести: `node --test`.')
})

test('untrusted run: @run/@call stubs and cli providers not started; --trust-repo runs them', async () => {
  const root = copyFixture()
  const u = JSON.parse((await cli(root, ['run', 'data', '--json'])).out)
  const sec = u.sections.find((s: { id: string }) => s.id === 'data')
  assert.equal(sec.status, 'unverified')
  assert.match(u.text, /\[call: util\.bump, unverified\]/)
  assert.ok(u.diagnostics.some((d: { code: string }) => d.code === 'G204'), 'cli provider skipped as untrusted')
  assert.doesNotMatch(u.text, /team-a/)
  const t = await cli(root, ['run', 'data', '--trust-repo', '--no-markers'])
  assert.equal(t.code, 0, t.err)
  assert.match(t.out, /Власник: team-a; сервісів 2\./)
  assert.match(t.out, /Наступна версія: 1\.3\.0\./)
  assert.match(t.out, /Привіт світ\./)
  // A persisted trust grant works the same way; revoke drops it.
  assert.equal((await cli(root, ['trust', 'grant'])).code, 0)
  assert.match((await cli(root, ['run', 'data', '--no-markers'])).out, /team-a/)
  assert.match((await cli(root, ['trust', 'status'])).out, /^довірений/)
  await cli(root, ['trust', 'revoke'])
  assert.match((await cli(root, ['trust', 'status'])).out, /^не довірений/)
})

test('skill prompt: run <skill> --args parses with core parseArgs; a bad arg prints the usage section', async () => {
  const root = copyFixture()
  assert.equal((await cli(root, ['build'])).code, 0)
  assert.ok(existsSync(join(root, '.claude/skills/greet/SKILL.md')))
  const ok = await cli(root, ['run', 'greet', '--args', 'Оля --style formal'])
  assert.equal(ok.code, 0, ok.err)
  assert.match(ok.out, /^Добрий день, Оля\.\n+Tier: standard\.\n$/)
  const casual = await cli(root, ['run', 'greet', '--args', '"Петро Іванович"', '--tier', 'quick'])
  assert.match(casual.out, /^Привіт, Петро Іванович!\n+Tier: quick\.\n$/)
  const bad = await cli(root, ['run', 'greet', '--args', 'Оля --style loud'])
  assert.equal(bad.code, 0)
  assert.match(bad.out, /^Невірні аргументи: `style` має бути casual\|formal\. Використання: \/greet <імʼя> \[--style casual\|formal\]/)
  const missing = JSON.parse((await cli(root, ['run', 'greet', '--args', '', '--json'])).out)
  assert.equal(missing.meta.ok, false)
  assert.match(missing.meta.usage, /Невірні аргументи/)
})

test('--ctx-from fixture and session:latest; --diff against the snapshot text', async () => {
  const root = copyFixture()
  const f = JSON.parse((await cli(root, ['run', '--ctx-from', 'fixture-ctx.json', '--json'])).out)
  assert.equal(f.meta.source, 'fixture')
  assert.equal(f.meta.tier, 'quick')
  assert.equal(f.scope.gate.profile, 'frontend')
  assert.match(f.text, /Проєкт from-fixture\. Тести: `vitest`\./)
  assert.match(f.text, /Профіль фронтенду\./)
  // fs.examples picks the smallest matching file (a.ts) for the quick tier.
  assert.match(f.text, /Зразок apps\/web\/src\/a\.js: export const A = 1/)
  const s = JSON.parse((await cli(root, ['run', '--ctx-from', 'session:latest', '--json'])).out)
  assert.equal(s.meta.source, 'session')
  assert.equal(s.meta.tier, 'quick')
  assert.equal(s.scope.ctx.percent, 42)
  assert.equal(s.scope.gate.profile, 'frontend')
  const byId = JSON.parse((await cli(root, ['run', '--ctx-from', 'session:s1', '--json'])).out)
  assert.equal(byId.meta.tier, 'quick')
  const d = await cli(root, ['run', '--only', 'intro', '--diff', 'session:latest'])
  assert.match(d.out, /^- Проєкт fixture-app\.$/m)
  assert.match(d.out, /^\+ Проєкт fixture-app\. Тести: `node --test`\.$/m)
})

test('render prompt://<id> renders one section without markers; health reports metrics', async () => {
  const root = copyFixture()
  const r = await cli(root, ['render', 'prompt://intro'])
  assert.equal(r.out, 'Проєкт fixture-app. Тести: `node --test`.\n')
  const h = JSON.parse((await cli(root, ['health', '--json'])).out)
  assert.ok(h.metrics.some((m: { code?: string }) => m.code === 'H001'))
  assert.ok(h.metrics.some((m: { code?: string; ok: boolean }) => m.code === 'H007' && !m.ok), 'untrusted data section is unverified')
  const text = (await cli(root, ['health'])).out
  assert.match(text, /\| H001 \| Розмір промпту/)
})

test('binary whitelist: user ~/.claude/context-gate.json allowBinaries; gate.json allowBinaries can only narrow it', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const root = copyFixture()
  mkdirSync(join(process.env.HOME!, '.claude'), { recursive: true })
  writeFileSync(join(process.env.HOME!, '.claude', 'context-gate.json'), JSON.stringify({ allowBinaries: ['bash', 'node'] }))
  const a = JSON.parse((await cli(root, ['run', 'data', '--trust-repo', '--json'])).out)
  assert.match(a.text, /Привіт світ\./, 'bash allowed')
  assert.match(a.text, /Власник: team-a/, 'node cli provider allowed')
  assert.ok(a.diagnostics.some((d: { code: string; message: string }) => d.code === 'G201' && d.message.includes('python3')), 'python3 refused')
  // The repo adds python3 and drops node: only the intersection (bash) remains.
  const cfgPath = join(root, '.claude/gate.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, allowBinaries: ['bash', 'python3'] }))
  const b = JSON.parse((await cli(root, ['run', 'data', '--trust-repo', '--json'])).out)
  assert.match(b.text, /Привіт світ\./)
  assert.doesNotMatch(b.text, /team-a/)
  assert.ok(b.diagnostics.some((d: { code: string; message: string }) => d.code === 'G203' && d.message.includes('node')))
  assert.ok(!b.diagnostics.some((d: { code: string }) => d.code === 'G302'), 'allowBinaries is not an unknown key')
})

test('build --only takes a repo-relative file path (what the mod passes) or a prompt id', { skip: !existsSync(join(basic, '.claude', 'prompt')) }, async () => {
  const root = copyFixture(basic, 'basic')
  const compiled = join(root, '.claude/prompt/.compiled/main.json')
  for (const only of ['.claude/prompt/main.prompt.tsx', 'main']) {
    rmSync(join(root, '.claude/prompt/.compiled'), { recursive: true, force: true })
    const r = await cli(root, ['build', '--only', only, '--json'])
    assert.equal(r.code, 0, r.out + r.err)
    assert.deepEqual(JSON.parse(r.out).compiled, ['main'], only)
    assert.ok(existsSync(compiled), only)
  }
  const none = JSON.parse((await cli(root, ['build', '--only', 'nope', '--json'])).out)
  assert.deepEqual(none.compiled, [])
})
