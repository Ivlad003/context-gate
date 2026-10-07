// Regressions for the 2026-10-06 review fixes in core render.ts (M04, M59–M69, R3, L60, L61, duration drift).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CompiledPrompt, SectionNode, Value } from '../packages/core/src/types.ts'
import { dataEnvelope, fenceFor, materializeData, maskSecrets, maskValue, normalizeMarkdown, openFenceAt, parseStdout, renderPrompt, type RenderHostExt, type RenderOptionsExt } from '../packages/core/src/render.ts'
import { parseMarkdownPrompt } from '../packages/core/src/mddsl.ts'

function fakeHost(over: Partial<RenderHostExt> = {}) {
  const state = { clock: 1_000_000, runs: [] as { code: string; stdin: string }[], calls: [] as string[][], providers: [] as string[], lazies: [] as [string, string][] }
  const cache = new Map<string, { value: Value; at: number }>()
  const host: RenderHostExt = {
    async readFile() { return undefined },
    async run(req) {
      state.runs.push({ code: req.code, stdin: req.stdin })
      const input = JSON.parse(req.stdin) as { ctx: Record<string, Value>; args: Value }
      return { exitCode: 0, stdout: JSON.stringify({ args: input.args, item: input.ctx.item ?? null }), stderr: '', ms: 10 }
    },
    async cacheGet(k) { return cache.get(k) },
    async cacheSet(k, v) { cache.set(k, { value: v, at: state.clock }) },
    registerLazy(name, _d, ref) { state.lazies.push([name, ref]) },
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

test('R3/M65: @run cache key includes args — a skill with other args does not get the cached result', async () => {
  const { host, state } = fakeHost()
  const sec = md('@run node as=r\nx\n@end\nfile={{ r.args.path }}')
  const a = await renderPrompt([sec], { args: { path: 'a.ts' } }, host, opts())
  const b = await renderPrompt([sec], { args: { path: 'b.ts' } }, host, opts())
  const a2 = await renderPrompt([sec], { args: { path: 'a.ts' } }, host, opts())
  assert.equal(a.text, 'file=a.ts')
  assert.equal(b.text, 'file=b.ts')
  assert.equal(a2.text, 'file=a.ts')
  assert.equal(state.runs.length, 2, 'same args are served from the cache')
})

test('R3/M65: @run inside @each runs once per item and each iteration sees its own output', async () => {
  const { host, state } = fakeHost()
  const sec = md('@each item in ["a", "b", "c"]\n@run node as=r\necho\n@end\n- {{ item }} -> {{ r.item }}\n@end')
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(res.text, '- a -> a\n- b -> b\n- c -> c')
  assert.equal(state.runs.length, 3)
})

test('R3: per-turn ctx/session changes do not bust the @run cache', async () => {
  const { host, state } = fakeHost()
  const sec = md('@run node as=r\nx\n@end\n{{ r.args }}')
  await renderPrompt([sec], { ctx: { percent: 10 }, session: { turn: 1 } }, host, opts())
  await renderPrompt([sec], { ctx: { percent: 11 }, session: { turn: 2 } }, host, opts())
  assert.equal(state.runs.length, 1)
})

test('R3/M65: data.* refreshes, gate trigger/proposal and budgets do not re-key @run; own store= result neither', async () => {
  const { host, state } = fakeHost({ async run(req) { state.runs.push({ code: req.code, stdin: req.stdin }); return { exitCode: 0, stdout: 'plain', stderr: '', ms: 1 } } })
  const sec = md('@run node as=r store=k\nx\n@end\n{{ r }}')
  let stored: Record<string, Value> = {}
  for (let turn = 0; turn < 3; turn++) {
    const gate = { profile: 'be', tier: 'standard', off: false, trigger: turn ? 'sticky' : 'classify', proposed: { profile: 'be', confidence: 0.5 + turn / 10 }, groups: [] }
    const data = { ...stored, other: dataEnvelope('same', 1 + turn * 1000, '1m') }
    const res = await renderPrompt([sec], { gate, budgets: { fired: turn ? ['soft'] : [], active: [] }, data, ctx: { percent: turn }, session: { turn } }, host, opts())
    stored = res.storedEntries
    state.clock += 1000
  }
  assert.equal(state.runs.length, 1)
  // A real change of another data value still re-keys.
  await renderPrompt([sec], { data: { other: dataEnvelope('changed', 5, '1m') } }, host, opts())
  assert.equal(state.runs.length, 2)
})

test('M65/R3: a @run after a @let derived from a pending @call runs once, with the real value', async () => {
  const { host, state } = fakeHost({ async call(req) { return req.calls.map(() => 'v') } })
  const sec = md('@use u m.py\n@call u.f(1) as c\n@let x = c\n@run node as=r\nhello\n@end\n{{ x }}')
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(state.runs.length, 1)
  assert.equal((JSON.parse(state.runs[0]!.stdin) as { ctx: { x: Value } }).ctx.x, 'v')
  assert.equal(res.text, 'v')
})

test('L60: a script still gets fetchedAt / stale of an object data value on stdin', async () => {
  const { host, state } = fakeHost()
  await renderPrompt([md('@run node as=r\nx\n@end\n{{ r.args }}')], { data: { k: dataEnvelope({ a: 1 }, 7, '1m') } }, host, opts())
  const stdin = JSON.parse(state.runs[0]!.stdin) as { ctx: { data: Record<string, Value> } }
  assert.deepEqual(stdin.ctx.data.k, { a: 1, fetchedAt: 7, stale: true })
})

test('store: a failed run or call never overwrites stored data', async () => {
  const cases: [string, string, Partial<RenderHostExt>][] = [
    ['run store=', '@run bash as=v store=k\nfalse\n@end', { async run() { return { exitCode: 1, stdout: '', stderr: 'boom', ms: 1 } } }],
    ['run + @store', '@run bash as=v\nfalse\n@end\n@store v to=k', { async run() { return { exitCode: 1, stdout: '', stderr: 'boom', ms: 1 } } }],
    ['untrusted stub', '@run bash as=v\nx\n@end\n@store v to=k', { trusted: false }],
    ['call raises', '@use u m.py\n@call u.f() as v\n@store v to=k', { async call() { throw new Error('x') } }],
    ['let derived from a failed run', '@run bash as=v\nfalse\n@end\n@let w = v\n@let w2 = [w]\n@store w2 to=k', { async run() { return { exitCode: 1, stdout: '', stderr: 'boom', ms: 1 } } }],
  ]
  for (const [name, text, over] of cases) {
    const { host } = fakeHost(over)
    const res = await renderPrompt([md(text)], {}, host, opts())
    assert.deepEqual(res.stored, {}, name)
  }
  const { host } = fakeHost()
  const ok = await renderPrompt([md('@run node as=v\nx\n@end\n@store v to=k')], {}, host, opts())
  assert.deepEqual(Object.keys(ok.stored), ['k'])
})

test('M63: @run in the branch an @if on pending data does not take is never executed', async () => {
  const { host, state } = fakeHost({ async call(req) { state.calls.push(req.calls.map(c => c.fn)); return req.calls.map(() => true) } })
  const sec = md('@use s scripts/s.py\n@if s.is_ci()\nci mode\n@else\n@run bash as=heavy\ndeploy-preview\n@end\n@end')
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(res.text, 'ci mode')
  assert.equal(state.runs.length, 0)
})

test('M67: a @call whose argument comes from a pending @call waits instead of running with null', async () => {
  const { host, state } = fakeHost({
    async call(req) {
      state.calls.push(req.calls.map(c => `${c.fn}(${JSON.stringify(c.args)})`))
      return req.calls.map(c => {
        if (c.fn === 'issue') return { title: 'Fix it' }
        if (c.args[0] === null) throw new Error('TypeError: None')
        return (c.args[0] as { title: string }).title
      })
    },
  })
  const sec = md('@use gh scripts/gh.py\n@call gh.issue(42) as issue\n@call gh.title(issue) as t\nTask: {{ t }}')
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(res.text, 'Task: Fix it')
  assert.ok(state.calls.flat().every(c => !c.includes('null')), JSON.stringify(state.calls))
  assert.equal(res.sections[0].status, 'ok')
})

test('M66: needs= naming nothing that produces it → G207 and unverified, not a silent ok', async () => {
  const { host, state } = fakeHost()
  const sec = md('@run node as=a\nx\n@end\n@run node as=b needs=aa\ny\n@end\nB={{ b }}')
  const res = await renderPrompt([sec], {}, host, opts())
  assert.ok(res.diagnostics.some(d => d.code === 'G207'), JSON.stringify(res.diagnostics))
  assert.equal(res.sections[0].status, 'unverified')
  assert.equal(state.runs.length, 1)
})

test('needs= on a producer later in the source still orders the runs', async () => {
  const { host, state } = fakeHost()
  const sec = md('@run node as=b needs=a\nsecond\n@end\n@run node as=a\nfirst\n@end\n{{ b.item }}')
  const res = await renderPrompt([sec], {}, host, opts())
  assert.deepEqual(state.runs.map(r => r.code), ['first', 'second'])
  assert.deepEqual(res.diagnostics.filter(d => d.code === 'G207'), [])
})

test('M64: @let inside @if/@each is visible in the whole section; @fn parameters stay local', async () => {
  const cases: [string, string, string][] = [
    ['if/else branches', '@if mode == "ci"\n@let label = "CI run"\n@else\n@let label = "local run"\n@end\nMode: {{ label }}', 'Mode: CI run'],
    ['single branch', '@if 1 == 1\n@let label = "x"\n@end\n{{ label }}', 'x'],
    ['fn param does not leak', '@let item = "outer"\n@fn row(item)\n{{ item }}\n@end\n@row("inner")\n{{ item }}', 'inner\nouter'],
  ]
  for (const [name, text, want] of cases) {
    const { host } = fakeHost()
    const r = parseMarkdownPrompt(text, { path: 'p/s.md' })
    const res = await renderPrompt([r.section], { mode: 'ci' }, host, opts())
    assert.equal(res.text, want, name)
  }
})

test('M61: one raising @call in a module batch does not discard its healthy sibling', async () => {
  const { host } = fakeHost({
    async call(req) {
      if (req.calls.some(c => c.fn === 'b')) throw new Error('b failed')
      return req.calls.map(c => `${c.fn}-ok`)
    },
  })
  const sec = md('@use util scripts/util.py\n@call util.a() as a\n@call util.b() as b\na={{ a }} b={{ b }}')
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(res.text, 'a=a-ok b=')
  assert.equal(res.sections[0].status, 'unverified')
})

test('M61: a module-wide failure (every call fails alike) is not retried once per call', async () => {
  let spawned = 0
  const { host } = fakeHost({ async call() { spawned++; throw new Error('SyntaxError: invalid syntax') } })
  const sec = md('@use util scripts/util.py\n@call util.a() as a\n@call util.b() as b\n@call util.c() as c\n@call util.d() as d\n{{ a }}')
  const res = await renderPrompt([sec], {}, host, opts())
  assert.equal(spawned, 3) // the batch plus two single retries, not 1 + 4
  assert.equal(res.sections[0].status, 'unverified')
})

test('M62: a failing slow @call is charged to the render budget; later waves get stubs', async () => {
  const { host, state } = fakeHost()
  host.call = async () => { state.clock += 5000; throw new Error('timeout') }
  const provider: string[] = []
  host.provider = async (req) => { provider.push(req.path); return 1 }
  const sec = md('@use s scripts/s.py\n@call s.slow() as x\n@run node as=r needs=x\nlate\n@end\n{{ r }}')
  const res = await renderPrompt([sec], {}, host, opts({ runBudgetMs: 2000 }))
  assert.equal(state.runs.length, 0, 'the run after the budget is exhausted does not start')
  assert.ok(res.ms >= 5000)
  const res2 = await renderPrompt([md('@use s scripts/s.py\n@call s.slow() as x\nn={{ fs.count(x) }}')], {}, host, opts({ runBudgetMs: 2000 }))
  assert.deepEqual(provider, [], 'a provider in a later wave is charged to the same budget')
  assert.equal(res2.text, 'n=')
})

test('M60: stdout that only looks numeric stays text', () => {
  const cases: [string, Value][] = [
    ['42\n', 42], ['-1.5', -1.5], ['1.10', '1.10'], ['1.0', '1.0'], ['1234e56', '1234e56'], ['7e12345', '7e12345'],
    ['12345678901234567890', '12345678901234567890'], ['{"a":1}', { a: 1 }], ['[1,2]', [1, 2]], ['true', true], ['plain text', 'plain text'],
  ]
  for (const [out, want] of cases) assert.deepEqual(parseStdout(out), want, out)
})

test('M59: normalizeMarkdown handles 200k lines without overflowing the stack', () => {
  const text = Array.from({ length: 200_000 }, (_, i) => `  line ${i}`).join('\n')
  const out = normalizeMarkdown(text)
  assert.ok(out.startsWith('line 0\nline 1'))
})

test('M68: lazy includes with the same basename or a non-ASCII name get distinct tools', async () => {
  const { host, state } = fakeHost()
  const sec = md('@include docs/v1/README.md lazy\n@include docs/v2/README.md lazy\n@include docs/правила.md lazy\n@include docs/приклад.md lazy')
  const res = await renderPrompt([sec], {}, host, opts())
  const tools = state.lazies.map(([n]) => n)
  assert.equal(new Set(tools).size, 4, JSON.stringify(state.lazies))
  assert.deepEqual(state.lazies.map(([, r]) => r), ['docs/v1/README.md', 'docs/v2/README.md', 'docs/правила.md', 'docs/приклад.md'])
  assert.ok(tools.every(t => /^[A-Za-z0-9_-]{1,64}$/.test(t)))
  for (const t of tools) assert.ok(res.text.includes(t))
})

test('M69: `uses` bind per compiled prompt — the same namespace in two files calls each its own module', async () => {
  const seen: string[] = []
  const { host } = fakeHost({ async call(req) { seen.push(`${req.path}#${req.calls.map(c => c.fn).join(',')}`); return req.calls.map(() => req.path) } })
  const prompt = (id: string, path: string, fn: string): CompiledPrompt => ({
    version: 1, compiler: 'test', id, sourceHash: '', sources: [], diagnostics: [], uses: { util: path },
    sections: [{ id, scope: 'profile', children: [{ t: 'call', fn: `util.${fn}`, args: [], as: 'v' }, { t: 'expr', expr: 'v' }] }],
  })
  const res = await renderPrompt([prompt('a', 'scripts/a.py', 'f'), prompt('b', 'scripts/b.ts', 'g')], {}, host, opts())
  assert.equal(res.text, 'scripts/a.py\n\nscripts/b.ts')
  assert.deepEqual(seen.sort(), ['scripts/a.py#f', 'scripts/b.ts#g'])
})

test('M04: secrets are masked before serialization and truncation; trace stays valid JSON; reason is masked', async () => {
  const secrets: [string, string][] = [
    ['quote', 'pa"ss\\word-123'],
    ['pem', '-----BEGIN KEY-----\nAAAABBBB\n-----END KEY-----'],
    ['long', 'jwt.' + 'x'.repeat(400)],
  ]
  for (const [name, secret] of secrets) {
    const { host } = fakeHost()
    const sec = md('@let tok = env.TOKEN\n@debug env\n@trace on\n{{ env }}\n@assert env.TOKEN == "nope", "bad token {{ env.TOKEN }}"')
    const res = await renderPrompt([sec], { env: { TOKEN: secret } }, host, opts({ debug: true }))
    const dump = JSON.stringify(res.trace) + JSON.stringify(res.diagnostics) + JSON.stringify(res.sections.map(s => s.reason))
    for (const piece of [secret, JSON.stringify(secret).slice(1, -1), secret.slice(0, 100)]) assert.ok(!dump.includes(piece), `${name}: leaked`)
    assert.match(res.sections[0].reason ?? '', /\*\*\*/, name)
    const debug = res.trace.find(t => t.kind === 'debug' && t.detail.includes('env='))!
    JSON.parse(debug.detail.slice(debug.detail.indexOf('env=') + 4))
  }
})

test('M04: maskValue / maskSecrets', () => {
  assert.deepEqual(maskValue({ a: ['x sekret-1 y', 2], ['sekret-1']: true }, ['sekret-1']), { a: ['x *** y', 2], '***': true })
  assert.equal(maskSecrets(JSON.stringify({ t: 'a"b\\c' }), ['a"b\\c']), '{"t":"***"}')
})

test('M04: run stderr is masked before it is cut', async () => {
  const secret = 'tok-' + 'y'.repeat(300)
  const { host } = fakeHost({ async run() { return { exitCode: 22, stdout: '', stderr: `401 for ${secret}`, ms: 1 } } })
  const res = await renderPrompt([md('@run bash as=v\ncurl\n@end\n{{ v }}')], { env: { T: secret } }, host, opts({ onError: 'skip' }))
  const dump = JSON.stringify(res)
  assert.ok(!dump.includes(secret.slice(0, 50)))
})

test('L61: budget truncation closes an open code fence; no surrogate pair is split', async () => {
  const { host } = fakeHost()
  const sec = md('---\nbudget: 40\n---\n```bash\necho one\necho two\necho three\necho four\n```')
  const res = await renderPrompt([sec, md('---\nid: rule\n---\nIMPORTANT: never push to main.', 'p/rule.md')], {}, host, opts())
  const text = res.sections[0].text
  assert.equal(openFenceAt(text), undefined, text)
  assert.ok(res.text.includes('```\n…[обрізано'), text)
  const emoji = await renderPrompt([md('---\nbudget: 3\n---\nab😀cd')], {}, host, opts())
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji.text))
})

test('fences: the fence is longer than any backtick run in the content', async () => {
  assert.equal(fenceFor('plain'), '```')
  assert.equal(fenceFor('a ``` b'), '````')
  const { host } = fakeHost()
  const sec: SectionNode = { id: 's', scope: 'profile', children: [{ t: 'fence', lang: 'md', children: [{ t: 'expr', expr: 'body' }] }] }
  const res = await renderPrompt([sec], { body: '```js\nx\n```' }, host, opts())
  assert.equal(res.text, '````md\n```js\nx\n```\n````')
  const cases: [string, string | undefined][] = [
    ['```\nx\n```', undefined], ['```\nx', '```'], ['````\n```\nx', '````'], ['```\n~~~\nx', '```'], ['~~~\nx\n~~~~', undefined], ['```\nx\n``` js', '```'],
  ]
  for (const [t, want] of cases) assert.equal(openFenceAt(t), want, t)
})

test('L60: data metadata does not show up as user keys; real fields win', async () => {
  const { data } = materializeData({ counts: dataEnvelope({ api: 3, web: 5 }, 1000, '1h'), own: dataEnvelope({ fetchedAt: 'mine' }, 1000) }, 2000)
  const { host } = fakeHost()
  const sec = md('@each e in data.counts\n- {{ e.key }}={{ e.value }}\n@end\nn={{ len(data.counts) }} at={{ data.counts.fetchedAt }} stale={{ data.counts.stale }} own={{ data.own.fetchedAt }}')
  const res = await renderPrompt([sec], { data }, host, opts())
  assert.equal(res.text, '- api=3\n- web=5\nn=2 at=1000 stale=false own=mine')
})

test('M58: cache durations use the core parser (combined units, weeks)', async () => {
  for (const cache of ['1h30m', '2w', '90s']) {
    const { host, state } = fakeHost()
    const sec = md(`@run node as=r cache=${cache}\nx\n@end\n{{ r.args }}`)
    await renderPrompt([sec], {}, host, opts())
    state.clock += 60_000
    await renderPrompt([sec], {}, host, opts())
    assert.equal(state.runs.length, 1, cache)
  }
  const { host, state } = fakeHost()
  const sec = md('@run node as=r\nx\n@end\n{{ r.args }}')
  await renderPrompt([sec], {}, host, opts({ runCacheDefault: '1h30m' }))
  state.clock += 3_600_000
  await renderPrompt([sec], {}, host, opts({ runCacheDefault: '1h30m' }))
  assert.equal(state.runs.length, 1, 'runCacheDefault 1h30m')
})

test('L56: @break in an @fn called outside a loop does not drop the rest of the section', async () => {
  const r = parseMarkdownPrompt('@fn stopIf(c)\n@if c\n@break\n@end\n@end\nbefore\n@stopIf(true)\nafter — important', { path: 'p/s.md' })
  assert.ok(r.diagnostics.some(d => d.code === 'G005'))
  const { host } = fakeHost()
  const res = await renderPrompt([r.section], {}, host, opts())
  assert.equal(res.text, 'before\nafter — important')
})
