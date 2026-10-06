import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Node, SectionNode, Value } from '../packages/core/src/types.ts'
import { dataEnvelope, estimateTokens, formatTrace, isDataEnvelope, materializeData, hashString, normalizeMarkdown, orderSections, renderPrompt, type RenderHostExt, type RenderOptionsExt } from '../packages/core/src/render.ts'
import { parseMarkdownPrompt, resolveTierVariant } from '../packages/core/src/mddsl.ts'

function fakeHost(over: Partial<RenderHostExt> = {}, files: Record<string, string> = {}) {
  const state = { clock: 1_000_000, runs: [] as string[], calls: 0, lazies: [] as string[] }
  const cache = new Map<string, { value: Value; at: number }>()
  const host: RenderHostExt = {
    async readFile(p) { return files[p] },
    async run(req) {
      state.runs.push(req.code)
      return { exitCode: 0, stdout: JSON.stringify({ files: ['a.ts', 'b.ts'], code: req.code }) + '\n', stderr: '', ms: 40 }
    },
    async cacheGet(k) { return cache.get(k) },
    async cacheSet(k, v) { cache.set(k, { value: v, at: state.clock }) },
    registerLazy(name) { state.lazies.push(name) },
    now: () => state.clock,
    trusted: true,
    ...over,
  }
  return { host, state, cache }
}

const md = (text: string, path = 'p/s.md'): SectionNode => {
  const r = parseMarkdownPrompt(text, { path })
  assert.deepEqual(r.diagnostics.filter(d => d.severity === 'error'), [], 'parse errors')
  return r.section
}
const opts = (o: Partial<RenderOptionsExt> = {}): RenderOptionsExt => ({ tier: 'standard', ...o })

test('spec example: @let limit by tier, @each with @if and @set counters', async () => {
  const sec = md([
    '@let limit = gate.tier == "quick" ? 3 : 6',
    '@set shown = 0',
    '@set total = 0',
    '',
    '@each r in cursor.auto | sort("cost.chars")',
    '  @if shown < limit',
    '- {{ r.id }} ({{ r.cost.chars / 1000 | round(1) }}k)',
    '    @set shown = shown + 1',
    '    @set total = total + r.cost.chars',
    '  @end',
    '@end',
    '',
    'Показано {{ shown }} з {{ len(cursor.auto) }}, разом {{ total / 1000 | round(1) }}k символів.',
  ].join('\n'))
  const auto = [1800, 400, 2500, 900, 1200].map((c, i) => ({ id: `r${i}`, cost: { chars: c } }))
  const scope = { gate: { tier: 'quick' }, cursor: { auto } }
  const { host } = fakeHost()
  const res = await renderPrompt([sec], scope, host, opts({ tier: 'quick' }))
  assert.equal(res.text, '- r1 (0.4k)\n- r3 (0.9k)\n- r4 (1.2k)\n\nПоказано 3 з 5, разом 2.5k символів.')
  const res6 = await renderPrompt([sec], { ...scope, gate: { tier: 'standard' } }, host, opts())
  assert.match(res6.text, /Показано 5 з 5, разом 6\.8k/)
})

test('spec example: @repeat min(attempts, 3) with .at(i)', async () => {
  const sec = md([
    '@set attempts = data.verify-log.failures | len',
    '@repeat min(attempts, 3)',
    '- спроба {{ i + 1 }}: {{ data.verify-log.failures.at(i).reason }}',
    '@end',
    '@if attempts > 3',
    '…ще {{ attempts - 3 }} спроб у журналі.',
    '@end',
  ].join('\n'))
  const failures = ['tsc', 'lint', 'test', 'e2e', 'fmt'].map(reason => ({ reason }))
  const { host } = fakeHost()
  const res = await renderPrompt([sec], { data: { 'verify-log': { failures } } }, host, opts())
  assert.equal(res.text, '- спроба 1: tsc\n- спроба 2: lint\n- спроба 3: test\n…ще 2 спроб у журналі.')
})

test('@repeat with @break and @continue', async () => {
  const sec = md('@repeat 10\n@if i == 1\n@continue\n@end\n@if i == 4\n@break\n@end\n{{ i }}\n@end')
  const { host } = fakeHost()
  assert.equal((await renderPrompt([sec], {}, host, opts())).text, '0\n2\n3')
})

test('@set + @store persists to result.stored', async () => {
  const sec = md('@set counter = (data.counter ?? 0) + 1\n@store counter\nn={{ counter }}')
  const { host } = fakeHost()
  const a = await renderPrompt([sec], { data: {} }, host, opts())
  assert.deepEqual(a.stored, { counter: 1 })
  const b = await renderPrompt([sec], { data: { counter: 4 } }, host, opts())
  assert.deepEqual(b.stored, { counter: 5 })
  assert.equal(b.text, 'n=5')
})

test('ordering: static → profile → volatile, `after` inside scope', async () => {
  const s = (id: string, scope: SectionNode['scope'], after?: string): SectionNode => ({ id, scope, ...(after ? { after } : {}), children: [{ t: 'text', value: id }] })
  const { host } = fakeHost()
  const res = await renderPrompt([s('vol', 'volatile'), s('p1', 'profile'), s('st', 'static'), s('p2', 'profile'), s('p3', 'profile', 'p1'), s('x', 'static', 'p1')], {}, host, opts())
  assert.deepEqual(res.sections.map(x => x.id), ['st', 'x', 'p1', 'p3', 'p2', 'vol'])
  assert.equal(res.text, 'st\n\nx\n\np1\n\np3\n\np2\n\nvol')
  assert.ok(res.diagnostics.some(d => d.code === 'G020'))
  assert.deepEqual(orderSections([{ id: 'a', scope: 'profile', after: 'b' }, { id: 'b', scope: 'profile' }]).map(x => x.id), ['b', 'a'])
})

test('section when, section tier and <Tier> nodes', async () => {
  const sections: SectionNode[] = [
    { id: 'w', scope: 'profile', when: 'gate.profile != "docs"', children: [{ t: 'text', value: 'W' }] },
    { id: 'off', scope: 'profile', when: 'gate.profile == "docs"', children: [{ t: 'text', value: 'OFF' }] },
    { id: 'q', scope: 'profile', tier: ['quick'], children: [{ t: 'text', value: 'Q' }] },
    {
      id: 't', scope: 'profile', children: [
        { t: 'text', value: 'base\n' },
        { t: 'tier', is: ['quick', 'standard'], children: [{ t: 'text', value: 'steps\n' }] },
        { t: 'tier', is: 'non-premium', children: [{ t: 'text', value: 'np\n' }] },
      ],
    },
  ]
  const { host } = fakeHost()
  const scope = { gate: { profile: 'backend' } }
  const quick = await renderPrompt(sections, scope, host, opts({ tier: 'quick' }))
  assert.equal(quick.text, 'W\n\nQ\n\nbase\nsteps\nnp')
  const premium = await renderPrompt(sections, scope, host, opts({ tier: 'premium' }))
  assert.equal(premium.text, 'W\n\nbase')
  const off = premium.sections.find(s => s.id === 'off')!
  assert.equal(off.included, false)
  assert.match(off.reason ?? '', /^when/)
  assert.match(premium.sections.find(s => s.id === 'q')!.reason ?? '', /^tier/)
})

test('budget truncates with marker', async () => {
  const sec: SectionNode = { id: 'b', scope: 'static', budget: 10, children: [{ t: 'text', value: 'abcdefghijklmnopqrstuvwxyz' }] }
  const { host } = fakeHost()
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(res.text, 'abcdefghij\n…[обрізано за budget 10]')
  assert.equal(res.sections[0].truncated, true)
})

test('include cycle → G159, render continues', async () => {
  const a = md('A\n@section b inline', 'p/a.md')
  const b = md('B\n@section a inline', 'p/b.md')
  const { host } = fakeHost()
  const res = await renderPrompt([a, b], {}, host, opts())
  assert.ok(res.diagnostics.some(d => d.code === 'G159'), JSON.stringify(res.diagnostics))
  assert.equal(res.sections.find(s => s.id === 'a')!.text, 'A\n\nB')
})

test('include depth is limited to 3', async () => {
  const secs = ['a', 'b', 'c', 'd', 'e'].map((id, i, all) => md(`${id}\n${all[i + 1] ? `@section ${all[i + 1]} inline` : ''}`, `p/${id}.md`))
  const { host } = fakeHost()
  const res = await renderPrompt(secs, {}, host, opts({ only: 'a' }))
  assert.ok(res.diagnostics.some(d => d.code === 'G159' && /Глибина/.test(d.message)))
  assert.equal(res.text, 'a\n\nb\n\nc\n\nd')
})

test('debug/assert/log/trace never change the text (byte-identical)', async () => {
  const plain = md('@let commits = data.commits\nCommits:\n@each c in commits | take(10)\n- {{ c }}\n@end')
  const withDebug = md([
    '@let commits = data.commits',
    '@debug "commits", len(commits), gate.tier',
    '@assert len(commits) < 500, "забагато"',
    '@log level=info "rendering {{ len(commits) }}"',
    '@trace on',
    'Commits:',
    '@each c in commits | take(10)',
    '  @debug c',
    '- {{ c }}',
    '@end',
    '@trace off',
  ].join('\n'))
  const scope = { data: { commits: ['x', 'y'] }, gate: { tier: 'quick' } }
  const { host } = fakeHost()
  const a = await renderPrompt([plain], scope, host, opts())
  for (const debug of [false, true]) {
    const b = await renderPrompt([withDebug], scope, host, opts({ debug }))
    assert.equal(b.text, a.text)
    assert.equal(b.sections[0].hash, a.sections[0].hash)
    if (debug) assert.ok(b.trace.some(t => t.kind === 'debug' && t.detail.includes('len(commits)=2')))
    assert.ok(b.trace.some(t => t.kind === 'log' && t.detail === 'info: rendering 2'))
  }
})

test('assert false → D001 and section skipped (or failed)', async () => {
  const sec = md('@assert len(data.commits) > 0, "Немає комітів"\nbody')
  const { host } = fakeHost()
  const res = await renderPrompt([sec], { data: { commits: [] } }, host, opts())
  assert.equal(res.text, '')
  assert.equal(res.sections[0].included, false)
  assert.ok(res.diagnostics.some(d => d.code === 'D001' && d.severity === 'warning'))
  const failed = await renderPrompt([sec], { data: { commits: [] } }, host, opts({ assertFail: 'fail' }))
  assert.equal(failed.sections[0].status, 'fail')
  assert.ok(failed.diagnostics.some(d => d.code === 'D001' && d.severity === 'error'))
})

test('untrusted repo: @run renders a stub and the section is unverified', async () => {
  const sec = md('---\nscope: volatile\n---\n@run python as=diff\nprint(1)\n@end\nDiff: {{ diff }}')
  const { host, state } = fakeHost({ trusted: false })
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(res.text, 'Diff: [run: python, unverified]')
  assert.equal(res.sections[0].status, 'unverified')
  assert.equal(state.runs.length, 0)
})

test('@run result is data; cache hit with a fake clock; stale after cache window', async () => {
  const sec = md('---\nscope: volatile\n---\n@run bash cache=5m\ngit diff --stat\n@end\nЗмінені файли: {{ run.files | join(", ") }}')
  const { host, state } = fakeHost()
  const r1 = await renderPrompt([sec], {}, host, opts())
  assert.equal(r1.text, 'Змінені файли: a.ts, b.ts')
  assert.equal(state.runs.length, 1)
  assert.equal(r1.trace.find(t => t.kind === 'run')?.source, 'run')
  state.clock += 60_000
  const r2 = await renderPrompt([sec], {}, host, opts())
  assert.equal(r2.text, r1.text)
  assert.equal(state.runs.length, 1)
  assert.equal(r2.trace.find(t => t.kind === 'run')?.source, 'cache')
  state.clock += 10 * 60_000
  await renderPrompt([sec], {}, host, opts())
  assert.equal(state.runs.length, 2)
})

test('dry scripts: cache only, otherwise a stub', async () => {
  const sec = md('---\nscope: volatile\n---\n@run python as=x\nprint(2)\n@end\n{{ x }}')
  const { host, state } = fakeHost({ dryScripts: true })
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(res.text, '[run: python, dry]')
  assert.equal(state.runs.length, 0)
})

test('failed @run: stderr never reaches the prompt, section unverified', async () => {
  const sec = md('---\nscope: volatile\n---\n@run as=x\nexit 1\n@end\nvalue=[{{ x }}]')
  const { host } = fakeHost({ async run() { return { exitCode: 2, stdout: '', stderr: 'SECRET-STDERR', ms: 5 } } })
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(res.text, 'value=[]')
  assert.equal(res.sections[0].status, 'unverified')
  assert.ok(!res.text.includes('SECRET'))
  assert.ok(!JSON.stringify(res.diagnostics).includes('SECRET'))
  const skip = await renderPrompt([sec], {}, host, opts({ onError: 'skip' }))
  assert.equal(skip.sections[0].included, false)
})

test('needs= orders runs; independent runs share one wave', async () => {
  const order: string[] = []
  const sec = md([
    '---', 'scope: volatile', '---',
    '@run as=b needs=a',
    'echo b',
    '@end',
    '@run as=a',
    'echo a',
    '@end',
    '@run as=c',
    'echo c',
    '@end',
    '{{ a.code }} {{ b.code }} {{ c.code }}',
  ].join('\n'))
  const { host } = fakeHost({
    async run(req) { order.push(req.code); return { exitCode: 0, stdout: JSON.stringify({ code: req.code }), stderr: '', ms: 10 } },
  })
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(res.text, 'echo a echo b echo c')
  assert.deepEqual(order, ['echo a', 'echo c', 'echo b'])
})

test('run budget: a run past the total budget skips the section with a warning', async () => {
  const sec = md('---\nscope: volatile\n---\n@run as=a\nslow\n@end\n@run as=b needs=a\nnext\n@end\n{{ b }}')
  const { host } = fakeHost({ async run(req) { return { exitCode: 0, stdout: '"ok"', stderr: '', ms: req.code === 'slow' ? 2500 : 1 } } })
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(res.text, '')
  assert.equal(res.sections[0].included, false)
  assert.match(res.sections[0].reason ?? '', /бюджет @run/)
  assert.ok(res.diagnostics.some(d => d.code === 'G203' && d.severity === 'warning'))
})

test('run budget is shared across sections; an expired cache value is used instead of skipping', async () => {
  const a = md('---\nid: a\nscope: volatile\n---\n@run as=x\nslow\n@end\nA={{ x }}', 'p/a.md')
  const b = md('---\nid: b\nscope: volatile\n---\n@run as=y\nfast\n@end\n@run as=z needs=y\nlater\n@end\nB={{ z }}', 'p/b.md')
  const { host, state, cache } = fakeHost({ async run(req) { return { exitCode: 0, stdout: JSON.stringify(req.code), stderr: '', ms: req.code === 'slow' ? 2100 : 5 } } })
  const r1 = await renderPrompt([a, b], {}, host, opts())
  assert.equal(r1.text, 'A=slow')
  assert.equal(r1.sections.find(s => s.id === 'b')!.included, false)
  // A previous value of `later` exists (expired): render it, unverified and stale, instead of skipping.
  for (const [k, v] of cache) if (JSON.stringify(v.value).includes('"slow"')) cache.delete(k)
  await renderPrompt([md('---\nscope: volatile\n---\n@run as=z\nlater\n@end\n', 'p/c.md')], {}, host, opts())
  state.clock += 60 * 60_000
  const r2 = await renderPrompt([a, b], {}, host, opts())
  const sb = r2.sections.find(s => s.id === 'b')! as any
  assert.equal(sb.text, 'B=later')
  assert.equal(sb.status, 'unverified')
  assert.deepEqual(sb.stale, ['run:z'])
})

test('data pass is parallel across sections and the output order is stable', async () => {
  let inflight = 0
  let maxInflight = 0
  const secs = ['one', 'two', 'three'].map(id => md(`---\nid: ${id}\nscope: volatile\n---\n@run as=r\necho ${id}\n@end\n{{ r }}`, `p/${id}.md`))
  const delays: Record<string, number> = { 'echo one': 30, 'echo two': 1, 'echo three': 15 }
  const { host } = fakeHost({
    async run(req) {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise(r => setTimeout(r, delays[req.code]))
      inflight--
      return { exitCode: 0, stdout: JSON.stringify(req.code.slice(5)), stderr: '', ms: 1 }
    },
  })
  const res = await renderPrompt(secs, {}, host, opts())
  assert.equal(maxInflight, 3)
  assert.equal(res.text, 'one\n\ntwo\n\nthree')
})

test('dry scripts with an expired cache entry → stub with last run metadata', async () => {
  const sec = md('---\nscope: volatile\n---\n@run python as=x cache=1m\nprint(3)\n@end\n{{ x }}')
  const { host, state } = fakeHost()
  host.run = async () => ({ exitCode: 0, stdout: JSON.stringify('y'.repeat(210)), stderr: '', ms: 400 })
  await renderPrompt([sec], {}, host, opts())
  host.dryScripts = true
  const fresh = await renderPrompt([sec], {}, host, opts())
  assert.equal(fresh.text, 'y'.repeat(210))
  state.clock += 5 * 60_000
  const dry = await renderPrompt([sec], {}, host, opts())
  assert.equal(dry.text, '[run: python, 0.4 s, 212 B]')
  assert.equal(dry.sections[0].status, 'unverified')
})

test('data.* envelopes expose fetchedAt / stale; `ago` works on them; storedEntries carry fetchedAt', async () => {
  const { host, state } = fakeHost()
  const t = state.clock - 2 * 3_600_000
  const data = {
    'api-endpoints': dataEnvelope({ count: 12 }, t, '1h'),
    'last-release': dataEnvelope('v1.4.0', state.clock - 60_000, '1d'),
    plain: { n: 1 },
  }
  const sec = md('{{ data.api-endpoints.count }} від {{ data.api-endpoints.fetchedAt | ago }}, stale={{ data.api-endpoints.stale }}\n{{ data.last-release.value }} stale={{ data.last-release.stale }} {{ data.plain.n }}')
  const res = await renderPrompt([sec], { data }, host, opts())
  assert.equal(res.text, '12 від 2 год тому, stale=true\nv1.4.0 stale=false 1')
  assert.deepEqual((res.sections[0] as any).stale, ['data.api-endpoints'])

  const store = md('---\nscope: volatile\n---\n@run as=api store=api-endpoints cache=1h\nparse\n@end\n@set counter = 1\n@store counter')
  const r2 = await renderPrompt([store], {}, host, opts())
  assert.ok(isDataEnvelope(r2.storedEntries['api-endpoints']))
  assert.equal((r2.storedEntries['api-endpoints'] as any).fetchedAt, state.clock)
  assert.equal((r2.storedEntries['api-endpoints'] as any).cache, '1h')
  assert.deepEqual(materializeData({ counter: r2.storedEntries.counter }, state.clock).data, { counter: { value: 1, fetchedAt: state.clock, stale: false } })
})

test('sections included via @section are not emitted standalone (static ref targets are)', async () => {
  const main = md('---\nid: main\nscope: profile\n---\nMain\n@section glossary ref\n@section safety inline\n@section identity ref', 'p/main.md')
  const glossary = md('---\nid: glossary\nscope: profile\n---\nGlossary', 'p/glossary.md')
  const safety = md('---\nid: safety\nscope: static\n---\nSafety', 'p/safety.md')
  const identity = md('---\nid: identity\nscope: static\n---\nIdentity', 'p/identity.md')
  const { host } = fakeHost()
  const res = await renderPrompt([main, glossary, safety, identity], {}, host, opts())
  assert.equal(res.text, 'Identity\n\nMain\n- glossary (prompt://glossary)\n\nSafety\n\n- identity (prompt://identity)')
  const g = res.sections.find(s => s.id === 'glossary')! as any
  assert.equal(g.included, false)
  assert.equal(g.reason, 'включена в main (ref)')
  assert.equal(g.includedBy, 'main')
  assert.equal(res.sections.find(s => s.id === 'safety')!.included, false)
  const only = await renderPrompt([main, glossary], {}, host, opts({ only: 'glossary' }))
  assert.equal(only.text, 'Glossary')
})

test('@elif / @else if chains render the first true branch', async () => {
  const sec = md('@if n > 10\nbig\n@elif n > 5\nmid\n@else if n > 0\nsmall\n@else\nnone\n@end\nend')
  const { host } = fakeHost()
  const out = async (n: number) => (await renderPrompt([sec], { n }, host, opts())).text
  assert.equal(await out(20), 'big\nend')
  assert.equal(await out(7), 'mid\nend')
  assert.equal(await out(1), 'small\nend')
  assert.equal(await out(0), 'none\nend')
})

test('@call through @use is batched per module; provider calls via host.provider; G157 otherwise', async () => {
  const batches: number[] = []
  const sec = md([
    '---', 'scope: volatile', 'use:', '  util: scripts/util.py', '---',
    'Версія: {{ util.next_version(pkg.version, "minor") }}',
    '@call util.summarize(data.commits, tier=gate.tier) as summary',
    '{{ summary.text }}',
    '@each ex in fs.examples("src/**/*.ts", 1)',
    '{{ ex.path }}',
    '@end',
    'x{{ fs.read("/etc/passwd") }}',
  ].join('\n'))
  const { host } = fakeHost({
    async call(req) {
      batches.push(req.calls.length)
      return req.calls.map(c => (c.fn === 'next_version' ? '1.5.0' : { text: `sum of ${(c.args[0] as Value[]).length} for ${c.kwargs?.tier}` }))
    },
    async provider(req) { return req.fn === 'examples' ? [{ path: 'src/a.ts' }] : null },
    callables: ['fs.examples'],
  })
  const res = await renderPrompt([sec], { pkg: { version: '1.4.0' }, data: { commits: [1, 2] }, gate: { tier: 'quick' } }, host, opts())
  assert.equal(res.text, 'Версія: 1.5.0\nsum of 2 for quick\nsrc/a.ts\nx')
  assert.deepEqual(batches, [2])
  assert.ok(res.diagnostics.some(d => d.code === 'G157'))
})

test('includes: file inline with budget, ref line, lazy registers get_<name>, skill inline/ref, mcp data', async () => {
  const sec = md([
    '---', 'scope: profile', '---',
    '@include CONVENTIONS.md inline budget=5',
    '@include docs/api.md ref "REST"',
    '@include docs/big.md lazy "Велике"',
    '@skill tdd inline',
    '@skill deploy ref',
    '@section other ref',
    '@mcp github.list_prs(state="open") as prs',
    'PRs: {{ prs | map("title") | join(", ") }}',
  ].join('\n'))
  const { host, state } = fakeHost({
    async itemBody(kind, name) { return name === 'tdd' ? { body: 'Red, green, refactor.' } : { description: 'Деплой', path: '.claude/skills/deploy/SKILL.md' } },
    async mcp(req) { return req.args.state === 'open' ? [{ title: '#1' }, { title: '#2' }] : [] },
  }, { 'CONVENTIONS.md': '1234567890' })
  const res = await renderPrompt([sec, { id: 'other', scope: 'profile', children: [] }], {}, host, opts({ only: 's' }))
  assert.equal(res.text, [
    '12345',
    '…[обрізано за budget 5]',
    '',
    '- api — REST (docs/api.md)',
    '- Велике — інструмент `get_big`',
    '',
    'Red, green, refactor.',
    '',
    '- deploy — Деплой (.claude/skills/deploy/SKILL.md)',
    '- other (prompt://other)',
    'PRs: #1, #2',
  ].join('\n'))
  assert.deepEqual(state.lazies, ['get_big'])
})

test('untrusted @mcp → stub', async () => {
  const sec = md('@mcp github.list_prs(state="open") as prs\n{{ prs }}')
  const { host } = fakeHost({ trusted: false, async mcp() { return [] } })
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(res.text, '[mcp: github.list_prs, unverified]')
})

test('step limit G155 excludes the section', async () => {
  const sec = md('@repeat 1000\n@each x in data.xs\n{{ x }}\n@end\n@end')
  const { host } = fakeHost()
  const res = await renderPrompt([sec], { data: { xs: Array.from({ length: 50 }, (_, i) => i) } }, host, opts())
  assert.equal(res.sections[0].included, false)
  assert.ok(res.diagnostics.some(d => d.code === 'G155'))
})

test('el/list/fence/table nodes render to Markdown', async () => {
  const children: Node[] = [
    { t: 'el', tag: 'h2', children: [{ t: 'text', value: 'Кроки' }] },
    {
      t: 'el', tag: 'ol', children: [
        { t: 'el', tag: 'li', children: [{ t: 'text', value: 'Прочитай ' }, { t: 'el', tag: 'b', children: [{ t: 'text', value: 'файли' }] }] },
        { t: 'each', of: 'steps', as: 's', children: [{ t: 'el', tag: 'li', children: [{ t: 'expr', expr: 's' }] }] },
        { t: 'el', tag: 'li', children: [{ t: 'text', value: 'Запусти ' }, { t: 'el', tag: 'code', children: [{ t: 'text', value: 'pnpm test' }] }] },
      ],
    },
    { t: 'list', children: [{ t: 'each', of: 'steps', as: 's', children: [{ t: 'expr', expr: 's' }, { t: 'text', value: '\n' }] }] },
    { t: 'fence', lang: 'ts', title: 'a.ts', children: [{ t: 'text', value: 'const x = 1' }] },
    { t: 'table', columns: ['id', 'n'], rows: 'rows', cells: ['row.id', 'row.n * 2'] },
  ]
  const { host } = fakeHost()
  const res = await renderPrompt([{ id: 'f', scope: 'static', children }], { steps: ['план', 'правка'], rows: [{ id: 'a|b', n: 2 }] }, host, opts())
  assert.equal(res.text, [
    '## Кроки',
    '',
    '1. Прочитай **файли**',
    '2. план',
    '3. правка',
    '4. Запусти `pnpm test`',
    '',
    '- план',
    '- правка',
    '',
    '```ts title="a.ts"',
    'const x = 1',
    '```',
    '',
    '| id | n |',
    '| --- | --- |',
    '| a\\|b | 4 |',
  ].join('\n'))
})

test('markers mode, hash and token estimate', async () => {
  const { host } = fakeHost()
  const res = await renderPrompt([{ id: 'a', scope: 'static', children: [{ t: 'text', value: 'hello' }] }], {}, host, opts({ markers: true }))
  assert.equal(res.text, '<!-- section:a static -->\nhello')
  assert.equal(res.sections[0].hash, hashString('hello'))
  assert.equal(res.sections[0].tokens, estimateTokens('hello'))
  assert.equal(hashString('hello'), '4f9f2cab')
})

test('tier variant file overrides the canonical section in render', async () => {
  const base = md('---\nid: workflow\nscope: profile\n---\nканон\n@tier quick\nдиректива\n@end', 'p/workflow.md')
  const quick = parseMarkdownPrompt('варіант quick', { path: 'p/workflow.quick.md', inherit: base }).section
  const { host } = fakeHost()
  const q = await renderPrompt([resolveTierVariant(base, { quick }, 'quick')], {}, host, opts({ tier: 'quick' }))
  assert.equal(q.text, 'варіант quick')
  const s = await renderPrompt([resolveTierVariant(base, { quick }, 'standard')], {}, host, opts())
  assert.equal(s.text, 'канон')
})

test('compiled prompts: uses and sections; formatTrace lists sections', async () => {
  const { host } = fakeHost()
  const res = await renderPrompt([{
    version: 1, compiler: 'test', id: 'p', sourceHash: 'x', sources: [], diagnostics: [],
    sections: [{ id: 'one', scope: 'static', children: [{ t: 'text', value: 'One' }] }, { id: 'two', scope: 'volatile', when: 'false', children: [] }],
  }], {}, host, opts())
  assert.equal(res.text, 'One')
  const t = formatTrace(res)
  assert.match(t, /\| one \| static \| увійшла \| 1 \|/)
  assert.match(t, /\| two \| volatile \| пропущена \| 0 \| when: false \|/)
})

test('normalizeMarkdown: dedent, trailing spaces, blank-line collapse', () => {
  assert.equal(normalizeMarkdown('\n\n    a  \n      b\n\n\n\n    c\n\n'), 'a\n  b\n\nc')
})
