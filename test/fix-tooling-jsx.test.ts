// Regressions of the 2026-10-06 review in @context-gate/jsx (M77-M82, L91-L97).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Node } from '../packages/core/src/types.ts'
import { parseExpr } from '../packages/core/src/expr.ts'
import {
  h, Fragment, Prompt, Section, Each, Repeat, Let, Run, Mcp, Fence, HealthWarning, ctx, e, takeDiagnostics, compilePrompt,
  type SectionMarker,
} from '../packages/jsx/src/index.ts'
import { numberLiteral } from '../packages/jsx/src/core.ts'
import { preserveJsxText } from '../packages/cli/src/jsx-text.ts'

const codes = () => takeDiagnostics().map((d) => d.code)
const kids = (...children: unknown[]) => (h(Section, { id: 's', scope: 'profile' }, ...children) as SectionMarker).section.children
const text = (nodes: Node[]) => nodes.map((n) => (n.t === 'text' ? n.value : n.t === 'expr' ? `{{${n.expr}}}` : `<${n.t}>`)).join('')

test('M81: data strings keep their own indentation; authored text is still dedented', () => {
  const py = 'def handler(event):\n    if event.ok:\n        return 200\n    return 500'
  const yaml = 'deploy:\n  stage: prod'
  const cases: [string, Node[], string][] = [
    ['code as the only child', (h(Fence, { lang: 'python' }, py) as { children: Node[] }).children, py],
    ['YAML next to indented authored text', kids('\n      Конфіг:\n      ', yaml, '\n    '), `Конфіг:\n${yaml}`],
    ['nested list data', kids('Steps:\n  - lint\n  - test'), 'Steps:\n  - lint\n  - test'],
    ['authored text after an expression', kids('\n    Гілка ', ctx.git.branch, ' активна.\n    Другий рядок.\n  '), 'Гілка {{git.branch}} активна.\nДругий рядок.'],
  ]
  for (const [name, got, want] of cases) assert.equal(text(got), want, name)
  assert.deepEqual(codes(), [])
})

test('M81: text wrapped on its tag line loses its source indentation (no Markdown code block)', () => {
  const cases: [string, string, string][] = [
    ['li on the tag line', '<li>Review the diff before\n          committing anything.</li>', 'Review the diff before\ncommitting anything.'],
    ['p with an expression', '<p>Paragraph that\n   wraps {x} here</p>', 'Paragraph that\nwraps '],
    ['Section with nesting', '<Section id="s">Intro\n      - a\n        - b\n    </Section>', 'Intro\n- a\n  - b\n'],
    ['text after an expression is left to the runtime', '<p>{x} tail\n        more</p>', ' tail\n        more'],
  ]
  for (const [name, src, want] of cases) {
    const r = preserveJsxText(`x = ${src}`)
    assert.ok(r.ok, name)
    const m = /\{("(?:[^"\\]|\\.)*")/.exec(r.code!.replace(/^x = <[^>]*>/, ''))
    assert.equal(JSON.parse(m![1]!), want, name)
  }
})

test('M80: JS methods on values are G160; provider calls are not', () => {
  const cases: [string, () => unknown, string[]][] = [
    ['provider call', () => h(Let, { name: 'l', value: ctx.git.log(3) }), []],
    ['fs provider', () => h(Let, { name: 'x', value: ctx.fs.glob('src/*.ts') }), []],
    ['cursor.match', () => h(Let, { name: 'm', value: ctx.cursor.match('a.ts') }), []],
    ['module namespace with a JS-method-like name', () => h(Let, { name: 't', value: (ctx as any).tools.todo.find('src') }), []],
    ['join on a data value', () => h(Let, { name: 'd', value: (ctx as any).data.tags.join(', ') }), ['G160']],
    ['join on a ctx list', () => h(Let, { name: 'j', value: (ctx.git.changed as any).join(', ') }), ['G160']],
    ['method on an Each item', () => h(Each, { of: 'commits' }, (c: any) => h('li', null, c.subject.toUpperCase())), ['G160']],
    ['join on an Each item', () => h(Each, { of: 'xs' }, (x: any) => x.join(', ')), ['G160']],
  ]
  for (const [name, f, want] of cases) { f(); assert.deepEqual(codes(), want, name) }
})

test('M79: Mcp args: objects are G160, partial placeholders are templates, strings encode for the core lexer', () => {
  const node = h(Mcp, { server: 'gh', tool: 'search', args: { q: 'repo:{{ args.repo }} is:open', n: 0.0000001, s: 'a\u0008b\u001bc', list: ['x', '{{ args.y }}'] } }) as { args: Record<string, string> }
  assert.equal(node.args.q, '"repo:" + (args.repo) + " is:open"')
  assert.equal(node.args.n, '0.0000001')
  assert.equal(node.args.list, '["x", args.y]')
  for (const v of Object.values(node.args)) assert.ok(parseExpr(v).ast, v)
  assert.deepEqual(codes(), [])
  h(Mcp, { server: 'gh', tool: 'search', args: { filter: { state: 'open' } } })
  assert.deepEqual(codes(), ['G160'])
})

test('M82, L96: Run code never interpolates; single-line separators between parts are kept', () => {
  assert.equal((h(Run, { lang: 'bash' }, 'echo a', ' ', 'b') as { code: string }).code, 'echo a b')
  assert.equal((h(Run, { lang: 'bash' }, '\n    ', 'grep -rn', ' ', 'TODO', ' ', 'src/', '\n  ') as { code: string }).code, 'grep -rn TODO src/')
  assert.deepEqual(codes(), [])
  h(Run, { lang: 'sh', as: 'log' }, `git log -n ${ctx.args.n} --oneline`)
  h(Run, { lang: 'sh', as: 'log' }, 'git log -n ', ctx.args.n)
  // A template literal stringifies the reference before Run sees it: only the second form is detectable.
  assert.deepEqual(codes(), ['G160'])
})

test('M77: each skill of a multi-skill module owns its build diagnostics', () => {
  takeDiagnostics()
  const a = h(Prompt, { as: 'skill', name: 'a-skill', description: 'a' }, 'ok')
  const b = h(Prompt, { as: 'skill', name: 'b-skill', description: 'b' }, h(Let, { name: 'x', value: { obj: 1 } }))
  const ra = compilePrompt(a)
  const rb = compilePrompt(b)
  assert.deepEqual(ra.diagnostics.map((d) => d.code), [])
  assert.deepEqual(rb.diagnostics.map((d) => d.code), ['G160'])
  // A Section shared by two skills reports its error in both, whichever is compiled first.
  const shared = h(Section, { id: 'common', scope: 'profile', when: true as never }, 'Shared')
  const s1 = h(Prompt, { as: 'skill', name: 's1', description: 'd' }, shared, 'one')
  const s2 = h(Prompt, { as: 'skill', name: 's2', description: 'd' }, shared, 'two')
  assert.deepEqual(compilePrompt(s2).diagnostics.map((d) => d.code), ['G160'])
  assert.deepEqual(compilePrompt(s1).diagnostics.map((d) => d.code), ['G160'])
})

test('M78: loop bodies keep their authored trailing line break', () => {
  const cases: [string, Node[], string][] = [
    ['build-time template string', kids(h(Each, { of: ['a', 'b', 'c'] }, (x: string) => `- ${x}\n`)), '- a\n- b\n- c'],
    ['inline body without a newline is unchanged', kids(h(Each, { of: ['a', 'b'] }, (x: string) => `${x}, `)), 'a, b, '],
  ]
  for (const [name, got, want] of cases) assert.equal(text(got), want, name)
  const rt = h(Each, { of: 'git.changed' }, (f: any) => h(Fragment, null, '- ', f, '\n')) as { children: Node[] }
  assert.deepEqual(rt.children, [{ t: 'text', value: '- ' }, { t: 'expr', expr: 'f' }, { t: 'text', value: '\n' }])
  const rep = h(Repeat, { n: 2 }, '\n  * пункт\n') as { children: Node[] }
  assert.deepEqual(rep.children, [{ t: 'text', value: '* пункт\n' }], 'one line per iteration')
  const li = h(Each, { of: 'xs' }, (x: any) => h(Fragment, null, '\n  ', h('li', null, x), '\n')) as { children: Node[] }
  assert.equal(li.children.length, 1, 'block bodies get no extra line break')
  assert.deepEqual(codes(), [])
})

test('L91: destructuring a runtime Each item is G160, not a crash', () => {
  const n = h(Each, { of: 'data.pairs' }, ([k, v]: any) => `${k}=${v}`) as { t: string; children: Node[] }
  assert.equal(n.t, 'each')
  assert.deepEqual(n.children, [])
  assert.deepEqual(codes(), ['G160'])
})

test('L92-L94, L97: thresholds, dashed keys, numbers, intrinsic attributes', () => {
  assert.equal((h(HealthWarning, { threshold: 'data.limit ?? 70' }) as { test: string }).test, 'ctx.percent > (data.limit ?? 70)')
  assert.equal((h(HealthWarning, null) as { test: string }).test, 'ctx.percent > budgets.soft')
  assert.equal(e`${(ctx.data as any)['api-endpoints'].length}`, 'data.api-endpoints.length')
  assert.equal(e`${(ctx.args as any)['a-b']}`, 'args["a-b"]')
  assert.deepEqual(codes(), [])
  void (ctx as any)['arch-info'].layers
  assert.deepEqual(codes(), ['G160'])
  const nums: [number, string][] = [[1e-7, '0.0000001'], [1.5e-7, '0.00000015'], [-2e-7, '-0.0000002'], [1e21, '1000000000000000000000'], [12.5, '12.5']]
  for (const [n, want] of nums) { assert.equal(numberLiteral(n), want); assert.ok(parseExpr(want).ast, want) }
  assert.deepEqual(codes(), [])
  assert.equal((h(Let, { name: 'x', value: Number.NaN }) as { value: string }).value, 'null')
  assert.deepEqual(codes(), ['G160'])
  h('pre', { lang: ctx.data.lang }, 'x')
  assert.deepEqual(codes(), ['G160'])
})
