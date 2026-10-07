// Regressions for the 2026-10-06 review fixes in core mddsl.ts, health.ts and assemble.ts (M56, M57, L32, L49, L50, L53–L58).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CompiledPrompt, RenderResult, RenderedSection, Value } from '../packages/core/src/types.ts'
import { parseMarkdownPrompt, printMarkdownNodes } from '../packages/core/src/mddsl.ts'
import { renderPrompt, type RenderHostExt } from '../packages/core/src/render.ts'
import { computeHealth } from '../packages/core/src/health.ts'
import { assemblePrompts, dataScope } from '../packages/core/src/assemble.ts'

const parse = (text: string, path = 'p/s.md') => parseMarkdownPrompt(text, { path })
const host = (): RenderHostExt => ({ async readFile() { return undefined }, now: () => 0, trusted: true })
const render = async (text: string, scope: Record<string, Value> = {}): Promise<string> =>
  (await renderPrompt([parse(text).section], scope, host(), { tier: 'standard' })).text

test('M56: a chain of double @fn calls is bounded at parse time (G156), not 2^N nodes', () => {
  const lines = ['@fn f0()', 'x', '@end']
  for (let i = 1; i <= 24; i++) lines.push(`@fn f${i}()`, `@f${i - 1}()`, `@f${i - 1}()`, '@end')
  lines.push('@f24()')
  const t0 = Date.now()
  const r = parse(lines.join('\n'))
  assert.ok(Date.now() - t0 < 2000, 'parse is fast')
  assert.deepEqual(r.diagnostics.map(d => d.code), ['G156'])
  assert.equal(JSON.stringify(r.section.children).length < 10_000, true)
})

test('M56: unused functions are still validated (unknown call, recursion) without expanding them', () => {
  assert.deepEqual(parse('@fn a()\n@nope()\n@end').diagnostics.map(d => d.code), ['G001'])
  assert.deepEqual(parse('@fn a()\n@b()\n@end\n@fn b()\n@a()\n@end').diagnostics.map(d => d.code), ['G151'])
  assert.deepEqual(parse('@fn a(x)\nx\n@end\n@a(1, 2)').diagnostics.map(d => d.code), ['G004'])
})

test('M57: @fn arguments are evaluated in the caller frame', async () => {
  const cases: [string, string][] = [
    ['@let a = 1\n@let b = 2\n@fn pair(a, b)\n{{ a }},{{ b }}\n@end\n@pair(b, a)', '2,1'],
    ['@let item = "outer"\n@let it = "a"\n@fn row(item, label)\n{{ item }}: {{ label }}\n@end\n@row(it, item)', 'a: outer'],
    ['@fn one(x)\n{{ x }}\n@end\n@one(5)', '5'],
  ]
  for (const [text, want] of cases) assert.equal(await render(text), want, text)
})

test('L55: fences follow CommonMark (same character, at least as long, no info string)', () => {
  const cases: [string, string, string[]][] = [
    ['inner ``` inside ````', '````md\n```bash\n@if x\n```\n````\nafter', []],
    ['~~~ inside ```', '```\n~~~\n@let a = 1\n```', []],
    ['closing needs no info', '```js\n@if x\n``` js\n@end\n```', []],
  ]
  for (const [name, text, codes] of cases) {
    const r = parse(text)
    assert.deepEqual(r.diagnostics.map(d => d.code), codes, name)
    assert.ok(r.section.children.every(n => n.t === 'text'), name)
  }
  // After the fence closes, directives work again.
  assert.deepEqual(parse('````\n```\n````\n@let a = 1').section.children.at(-1), { t: 'let', name: 'a', value: '1' })
})

test('L54: \\{{ is a literal {{ (GitHub Actions, Helm samples)', async () => {
  assert.equal(await render('```yaml\nrun: echo $\\{{ github.sha }}\n```'), '```yaml\nrun: echo ${{ github.sha }}\n```')
  assert.equal(await render('literal \\{{ x }} and {{ x }}', { x: 1 }), 'literal {{ x }} and 1')
  assert.deepEqual(parse('a \\{{ .Values.image }}').diagnostics, [])
})

test('L53: with configured tiers, a dotted file name keeps its suffix in the id', () => {
  assert.equal(parseMarkdownPrompt('x', { path: 'p/release.notes.md', tiers: ['quick', 'standard'] }).section.id, 'release.notes')
  assert.equal(parseMarkdownPrompt('x', { path: 'p/release.quick.md', tiers: ['quick', 'standard'] }).section.id, 'release')
  const set = assemblePrompts([], [{ path: 'p/release.md', text: 'Release checklist' }, { path: 'p/release.notes.md', text: 'Notes' }], 'standard', ['quick', 'standard'], { builtins: false })
  assert.deepEqual(set.system.map(p => p.sections[0].id), ['release', 'release.notes'])
})

test('L57: a quoted @include path; a `when` expression keeps its quotes', () => {
  const inc = parse('@include "docs/my notes.md" inline "Нотатки"').section.children[0]
  assert.deepEqual(inc, { t: 'include', source: 'file', ref: 'docs/my notes.md', mode: 'inline', description: 'Нотатки' })
  const r = parse("---\nwhen: 'a' in tags || mode == 'b'\n---\nx")
  assert.deepEqual(r.diagnostics, [])
  assert.equal(r.section.when, "'a' in tags || mode == 'b'")
  assert.equal(parse('---\nwhen: "ci"\n---\nx').section.when, 'ci')
})

test('L58: printMarkdownNodes round-trips @elif chains, mid-line @ and messages', async () => {
  const src = '@if n == 1\none\n@elif n == 2\ntwo\n@elif n == 3\nthree\n@elif n == 4\nfour\n@else\nmany\n@end\nPing {{ who }}@team\n\\@line'
  const first = parse(src)
  assert.deepEqual(first.diagnostics, [])
  const printed = printMarkdownNodes(first.section.children)
  const again = parse(printed)
  assert.deepEqual(again.diagnostics, [], printed)
  for (const n of [1, 3, 9]) {
    const scope = { n, who: 'Ann' }
    const a = (await renderPrompt([first.section], scope, host(), { tier: 'standard' })).text
    const b = (await renderPrompt([again.section], scope, host(), { tier: 'standard' })).text
    assert.equal(b, a)
  }
  assert.match(printed, /Ping \{\{ who \}\}@team\n\\@line/)
  const msg = parse('@log "say \\"hi\\""').section.children[0]
  assert.deepEqual(msg, { t: 'log', level: 'info', message: 'say "hi"' })
  assert.deepEqual(parse(printMarkdownNodes([msg])).section.children[0], msg)
  const fence = printMarkdownNodes([{ t: 'fence', lang: 'md', children: [{ t: 'text', value: '```js\nx\n```' }] }])
  assert.match(fence, /^````md\n```js\nx\n```\n````$/)
})

test('L56: @break inside @fn is fine when every call site is in a loop', () => {
  assert.deepEqual(parse('@fn stop()\n@break\n@end\n@each x in xs\n@stop()\n@end').diagnostics, [])
  assert.deepEqual(parse('@fn stop()\n@break\n@end\n@stop()').diagnostics.map(d => d.code), ['G005'])
})

test('invalid cache= on @run/@call is a warning, not a silently disabled cache', () => {
  assert.deepEqual(parse('---\nscope: volatile\n---\n@run cache=soon\nx\n@end').diagnostics.map(d => [d.code, d.severity]), [['G004', 'warning']])
  assert.deepEqual(parse('---\nscope: volatile\n---\n@run cache=1h30m\nx\n@end').diagnostics, [])
})

const sec = (id: string, text: string, scope: RenderedSection['scope'] = 'profile'): RenderedSection => ({
  id, scope, text, chars: text.length, tokens: Math.ceil(text.length / 4), included: true, hash: `${id}:${text}`, status: 'ok',
})
const result = (sections: RenderedSection[]): RenderResult => ({ sections, text: '', trace: [], diagnostics: [], ms: 0, stored: {} })
const metric = (r: ReturnType<typeof computeHealth>, code: string) => r.metrics.find(m => m.code === code)!

test('L49: H002 stable share is the unchanged prefix (prompt cache), not the sum of unchanged sections', () => {
  const big = 'x'.repeat(36_000)
  const cases: [string, RenderedSection[], RenderedSection[], number][] = [
    ['head changes', [sec('head', 'turn 1', 'static'), sec('body', big)], [sec('head', 'turn 2', 'static'), sec('body', big)], 0],
    ['tail changes', [sec('body', big), sec('tail', 'a', 'volatile')], [sec('body', big), sec('tail', 'b', 'volatile')], 100],
    ['reordered', [sec('a', big), sec('b', big)], [sec('b', big), sec('a', big)], 0],
    ['unchanged', [sec('a', 'a'), sec('b', 'b')], [sec('a', 'a'), sec('b', 'b')], 100],
  ]
  for (const [name, prev, cur, want] of cases) assert.equal(metric(computeHealth(result(cur), result(prev)), 'H002').value, want, name)
})

test('L50: H003 drift measures changed content, not the size delta', () => {
  const a = 'a'.repeat(8000)
  const b = 'b'.repeat(8004)
  const rewrite = computeHealth(result([sec('s', b, 'static')]), result([sec('s', a, 'static')]))
  assert.ok((metric(rewrite, 'H003').value as number) >= 2000)
  assert.equal(metric(rewrite, 'H003').ok, false)
  const append = computeHealth(result([sec('s', a + ' tail', 'static')]), result([sec('s', a, 'static')]))
  assert.ok((metric(append, 'H003').value as number) <= 2)
})

test('L32: assembly order is code-unit order, independent of the locale', () => {
  const cp = (id: string): CompiledPrompt => ({ version: 1, compiler: 't', id, sourceHash: '', sources: [], diagnostics: [], sections: [{ id, scope: 'profile', children: [] }] })
  const set = assemblePrompts([cp('b'), cp('aa-intro'), cp('B'), cp('zz')], [], 'premium')
  assert.deepEqual(set.system.map(p => p.id), ['B', 'aa-intro', 'b', 'zz'])
  assert.deepEqual(Object.keys(dataScope([{ key: 'b', value: 1 }, { key: 'B', value: 2 }, { key: 'a', value: 3 }]) as object), ['B', 'a', 'b'])
})
