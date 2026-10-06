// Р5 canonical nodes (G-25): `store=` → a separate `store` node carrying the run's metadata, `@let x = scripts.f()`
// → `call`, and `tiers[*].preload` → the generated `preload` section of `include skill inline` nodes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Node, Value } from '../packages/core/src/types.ts'
import { canonicalNodes, scriptsCallOf } from '../packages/core/src/canonical.ts'
import { parseMarkdownPrompt, printMarkdownNodes } from '../packages/core/src/mddsl.ts'
import { assemblePrompts, preloadPrompt, PRELOAD_ID } from '../packages/core/src/assemble.ts'
import { renderPrompt, type RenderHostExt } from '../packages/core/src/render.ts'
import { cli, sandbox } from './cli-helpers.ts'

test('canonicalNodes: store= on run/call → node + store; nested too; scripts lets only at the top level', () => {
  const nodes: Node[] = [
    { t: 'run', lang: 'python', code: 'x', as: 'api', cache: '1h', store: 'api-endpoints' },
    { t: 'run', lang: 'bash', code: 'y', store: 'run' },
    { t: 'call', fn: 'u.f', args: [], as: 'r', store: 'r' },
    { t: 'if', test: 'true', then: [{ t: 'run', lang: 'bash', code: 'z', as: 'z', store: 'zz' }, { t: 'let', name: 'n', value: 'scripts.count("src")' }] },
    { t: 'let', name: 'todos', value: 'scripts.open_todos("src", limit=3)' },
    { t: 'let', name: 'k', value: 'scripts.a() + 1' },
  ]
  assert.deepEqual(canonicalNodes(nodes), [
    { t: 'run', lang: 'python', code: 'x', as: 'api', cache: '1h' },
    { t: 'store', name: 'api', key: 'api-endpoints' },
    { t: 'run', lang: 'bash', code: 'y' },
    { t: 'store', name: 'run' },
    { t: 'call', fn: 'u.f', args: [], as: 'r' },
    { t: 'store', name: 'r' },
    { t: 'if', test: 'true', then: [{ t: 'run', lang: 'bash', code: 'z', as: 'z' }, { t: 'store', name: 'z', key: 'zz' }, { t: 'let', name: 'n', value: 'scripts.count("src")' }] },
    { t: 'call', fn: 'scripts.open_todos', args: ['"src"'], kwargs: { limit: '3' }, as: 'todos' },
    { t: 'let', name: 'k', value: 'scripts.a() + 1' },
  ])
  const rows: [string, ReturnType<typeof scriptsCallOf>][] = [
    ['scripts.f()', { fn: 'scripts.f', args: [] }],
    ['scripts.f(a, "b,c", [1, 2])', { fn: 'scripts.f', args: ['a', '"b,c"', '[1, 2]'] }],
    ['scripts.f(a) | len', undefined],
    ['util.f(a)', undefined],
    ['scripts.f(a)(b)', undefined],
  ]
  for (const [src, want] of rows) assert.deepEqual(scriptsCallOf(src), want, src)
})

test('Markdown: @store name to=key round-trips; store= emits G180 and normalizes', () => {
  const r = parseMarkdownPrompt('---\nscope: volatile\n---\n@run python as=api store=api-endpoints cache=1h\nprint(1)\n@end\n@set n = 1\n@store n to=counter\n@let t = scripts.todos("src")', { path: 'p/x.md' })
  assert.deepEqual(r.diagnostics.map((d) => d.code), ['G180'])
  assert.match(r.diagnostics[0]!.hint!, /@store api to=api-endpoints/)
  assert.deepEqual(r.section.children.map((n) => n.t), ['run', 'store', 'set', 'store', 'call'])
  assert.deepEqual(r.section.children[3], { t: 'store', name: 'n', key: 'counter' })
  const printed = printMarkdownNodes(r.section.children)
  assert.match(printed, /@store api to=api-endpoints/)
  assert.match(printed, /@store n to=counter/)
  assert.doesNotMatch(printed, /store=/)
})

function host(cache: Map<string, { value: Value; at: number }>, clock: number): RenderHostExt {
  return {
    async readFile() { return undefined },
    async run() { return { exitCode: 0, stdout: '{"count":12}\n', stderr: '', ms: 5 } },
    async cacheGet(k) { return cache.get(k) },
    async cacheSet(k, v) { cache.set(k, { value: v, at: clock }) },
    now: () => clock,
    trusted: true,
  }
}

test('render: a store node persists with the fetchedAt / cache of the run that produced the variable', async () => {
  const clock = 10_000_000
  const cache = new Map<string, { value: Value; at: number }>()
  const sec = parseMarkdownPrompt('---\nscope: volatile\n---\n@run python as=api store=api-endpoints cache=1h\nprint(1)\n@end\n{{ api.count }}', { path: 'p/x.md' }).section
  const first = await renderPrompt([sec], {}, host(cache, clock), { tier: 'standard' })
  assert.equal(first.text, '12')
  assert.deepEqual(first.storedEntries['api-endpoints'], { __cgData: 1, value: { count: 12 }, fetchedAt: clock, cache: '1h' })
  // A later render served from the cache keeps the original fetchedAt (not "now").
  const later = await renderPrompt([sec], {}, host(cache, clock + 600_000), { tier: 'standard' })
  assert.equal((later.storedEntries['api-endpoints'] as { fetchedAt: number }).fetchedAt, clock)
  // The legacy JSON form (store= on the run node, old .compiled) renders the same.
  const legacy = { ...sec, children: [{ t: 'run', lang: 'python', code: 'print(1)', as: 'api', cache: '1h', store: 'api-endpoints' } as Node] }
  const old = await renderPrompt([legacy], {}, host(cache, clock + 600_000), { tier: 'standard' })
  assert.deepEqual(old.storedEntries['api-endpoints'], later.storedEntries['api-endpoints'])
  // @set after the run: the store takes the new value with render time, no run metadata.
  const reset = parseMarkdownPrompt('---\nscope: volatile\n---\n@run python as=api cache=1h\nprint(1)\n@end\n@set api = 5\n@store api', { path: 'p/x.md' }).section
  const r3 = await renderPrompt([reset], {}, host(cache, clock + 700_000), { tier: 'standard' })
  assert.deepEqual(r3.storedEntries.api, { __cgData: 1, value: 5, fetchedAt: clock + 700_000 })
})

test('scripts.f() as a call node renders like the let it replaces (provider path)', async () => {
  const calls: string[] = []
  const h: RenderHostExt = {
    async readFile() { return undefined },
    now: () => 0,
    trusted: true,
    async provider(req) { calls.push(`${req.path}(${JSON.stringify(req.args)})`); return ['a', 'b'] },
  }
  const sec = parseMarkdownPrompt('---\nscope: volatile\n---\n@let todos = scripts.open_todos("src")\n{{ todos | join(", ") }}', { path: 'p/x.md' }).section
  assert.equal(sec.children[0]!.t, 'call')
  const r = await renderPrompt([sec], {}, h, { tier: 'standard' })
  assert.equal(r.text, 'a, b')
  assert.deepEqual(calls, ['scripts.open_todos(["src"])'])
})

test('preload: tiers[*].preload → generated section of include skill inline nodes, first profile section', async () => {
  const p = preloadPrompt([], ['conv', 'conv', 'tdd'], 'quick')!
  assert.equal(p.id, PRELOAD_ID)
  assert.deepEqual(p.sections[0]!.children.filter((n) => n.t === 'include'), [
    { t: 'include', source: 'skill', ref: 'conv', mode: 'inline' },
    { t: 'include', source: 'skill', ref: 'tdd', mode: 'inline' },
  ])
  assert.equal(p.sections[0]!.scope, 'profile')
  const own = assemblePrompts([], [{ path: '.claude/prompt/preload.md', text: '---\nid: preload\n---\nmine' }], 'quick', [], { preload: ['conv'] })
  assert.equal(own.system.filter((cp) => cp.sections.some((s) => s.id === 'preload')).length, 1, 'a repo section named preload wins')
  const set = assemblePrompts([], [{ path: '.claude/prompt/a.md', text: '---\nid: a\nscope: profile\n---\nA' }], 'quick', [], { preload: ['conv'], builtins: false })
  assert.equal(set.system[0]!.id, PRELOAD_ID)
  const h: RenderHostExt = { async readFile() { return undefined }, now: () => 0, trusted: true, async itemBody(_k, n) { return n === 'conv' ? { body: 'Tabs.' } : undefined } }
  const r = await renderPrompt(set.system, {}, h, { tier: 'quick' })
  assert.equal(r.text, 'Skills, вбудовані для tier quick (не викликай їх окремо):\n\n## conv\n\nTabs.\n\nA')
  assert.equal(assemblePrompts([], [], 'quick', [], {}).system.length, 0, 'no preload option → no section')
})

test('CLI run: the preload section from tiers[*].preload with the skill body', async () => {
  const root = join(sandbox(), 'repo')
  const files: Record<string, string> = {
    '.claude/gate.json': JSON.stringify({ tiers: { quick: { preload: ['conventions'] }, standard: {}, premium: {} }, models: { 'claude-haiku*': 'quick' } }),
    '.claude/skills/conventions/SKILL.md': '---\nname: conventions\ndescription: Repo conventions\n---\nUse pnpm.',
  }
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t) }
  const r = await cli(root, ['run', '--model', 'claude-haiku-4-5', '--no-markers'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /Skills, вбудовані для tier quick \(не викликай їх окремо\):\n\n## conventions\n\nUse pnpm\./)
  const std = await cli(root, ['run', '--tier', 'standard', '--no-markers'])
  assert.doesNotMatch(std.out, /вбудовані/)
})
