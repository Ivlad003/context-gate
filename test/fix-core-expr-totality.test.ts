// Totality of the expression language (SPEC «Межі мови»): steps, value size, string length and regex cost are all
// bounded, and every overrun is a StepLimitError (G155), never a hang or a RangeError. Review 2026-10-06: H05, H06,
// M51, M59, L41-L45.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Diagnostic, Value } from '../packages/core/src/types.ts'
import { MAX_STRING_LENGTH, StepLimitError, ValueLimitError, chargeValue, deepEqual, evalExpr, freeVars, newBudget, parseExpr, valueCells, type Budget, type EvalEnv } from '../packages/core/src/expr.ts'
import { renderPrompt, type RenderHostExt } from '../packages/core/src/render.ts'
import { parseMarkdownPrompt } from '../packages/core/src/mddsl.ts'

function ev(src: string, scope: Record<string, Value> = {}, budget: Budget = newBudget(), env: EvalEnv = {}): Value {
  const p = parseExpr(src)
  assert.ok(p.ast, `parse failed for ${src}: ${JSON.stringify(p.diagnostics)}`)
  return evalExpr(p.ast, scope, budget, env)
}

/** Run `@set name = expr` `times` times on one budget, like `@repeat` does. */
function repeatSet(name: string, expr: string, init: Value, times: number, budget = newBudget()): Value {
  const scope: Record<string, Value> = { [name]: init }
  for (let i = 0; i < times; i++) scope[name] = ev(expr, scope, budget)
  return scope[name]
}

function timed(f: () => void): number {
  const t = Date.now()
  f()
  return Date.now() - t
}

const overruns: { name: string; expr: string; init: Value; times: number }[] = [
  { name: 'H05 list literal doubling [x, x]', expr: '[x, x]', init: 0, times: 60 },
  { name: 'H05 doubling then take keeps the DAG', expr: '[x, x] | take(2)', init: 0, times: 60 },
  { name: 'H06 list + doubling', expr: 'x + x', init: [1], times: 60 },
  { name: 'H06 string + doubling', expr: 'x + x', init: 'x', times: 60 },
  { name: 'H06 string + doubling from a list', expr: '"" + [x, x]', init: 'x', times: 60 },
  { name: 'deep nesting [x]', expr: '[x]', init: 0, times: 5000 },
]
for (const c of overruns) {
  test(`${c.name}: StepLimitError within the budget, no RangeError, fast`, () => {
    const ms = timed(() => assert.throws(() => repeatSet('x', c.expr, c.init, c.times, newBudget(1_000_000)), StepLimitError))
    assert.ok(ms < 3000, `took ${ms} ms`)
  })
}

test('H05: comparing two 2^k-leaf DAGs is charged by their tree size', () => {
  const budget = newBudget()
  const x = repeatSet('x', '[x, x]', 0, 18, budget)
  const y = repeatSet('y', '[y, y]', 0, 18, budget)
  assert.ok(valueCells(x) > 100_000)
  const ms = timed(() => assert.throws(() => ev('x == y', { x, y }, budget), StepLimitError))
  assert.ok(ms < 1000, `took ${ms} ms`)
  // A small structure is still compared for free beyond the base steps.
  assert.equal(ev('[1, [2, 3]] == [1, [2, 3]]'), true)
  assert.equal(deepEqual([1, [2]], [1, [2]], newBudget(5)), true)
})

test('H05: text output and in / where / unique / sort walks are charged', () => {
  const budget = newBudget()
  const x = repeatSet('x', '[x, x]', 0, 19, budget)
  for (const src of ['"" + x', 'x | join(",")', '[0, 0] in [x]', '[x] | where("", [0])', '[x, 1] | unique', '[x, 1] | sort', '[x] | map("{{ item }}")']) {
    assert.throws(() => ev(src, { x }, newBudget()), StepLimitError, src)
  }
  assert.throws(() => chargeValue(newBudget(), x), StepLimitError)
})

test('H06: renderPrompt turns size overruns into G155 for the section, never a rejection', async () => {
  const host: RenderHostExt = { async readFile() { return undefined }, now: () => 0, trusted: true }
  const bodies = [
    '@set x = 0\n@set y = 0\n@repeat 40\n@set x = [x, x]\n@set y = [y, y]\n@end\n@if x == y\nsame\n@end',
    '@set l = [1]\n@repeat 40\n@set l = l + l\n@end\n{{ len(l) }}',
    '@set s = "x"\n@repeat 40\n@set s = s + s\n@end\n{{ len(s) }}',
  ]
  for (const body of bodies) {
    const r = parseMarkdownPrompt(`${body}\n`, { path: 'p/s.md' })
    const t = Date.now()
    const res = await renderPrompt([r.section], {}, host, { tier: 'standard' })
    assert.ok(Date.now() - t < 5000, body)
    assert.ok(res.diagnostics.some((d: Diagnostic) => d.code === 'G155'), `${body}: ${JSON.stringify(res.diagnostics)}`)
  }
})

test('ValueLimitError is a StepLimitError (hosts map both to G155)', () => {
  const e = new ValueLimitError('test')
  assert.ok(e instanceof StepLimitError)
  assert.match(e.message, /^G155: test/)
})

test('strings stop at MAX_STRING_LENGTH with G155 instead of V8 RangeError', () => {
  const big = 'x'.repeat(MAX_STRING_LENGTH / 2 + 1)
  assert.throws(() => ev('s + s', { s: big }, newBudget(1_000_000)), StepLimitError)
  assert.throws(() => ev('[s, s] | join("")', { s: big }, newBudget(1_000_000)), StepLimitError)
  assert.throws(() => ev('[1, 2, 3] | map("{{ s }}{{ s }}")', { s: big }, newBudget(1_000_000)), StepLimitError)
})

test('M59: min/max over a long list loop instead of spreading (no RangeError)', () => {
  const xs = Array.from({ length: 300_000 }, (_, i) => (i * 7919) % 300_000)
  assert.equal(ev('min(xs)', { xs }, newBudget(1_000_000)), 0)
  assert.equal(ev('max(xs)', { xs }, newBudget(1_000_000)), 299_999)
  assert.equal(ev('min(3, "a", 1)'), 1)
  assert.equal(ev('max([])'), null)
  assert.throws(() => ev('min(xs)', { xs }), StepLimitError)
})

// ── M51: regex (`~`, grep) is linear-time ──

test('M51: catastrophic patterns finish fast and give the RegExp answer', () => {
  const evil: [string, string, boolean][] = [
    ['a'.repeat(40) + '!', '^(a+)+$', false],
    ['a'.repeat(40) + '!', '^(a|a)*$', false],
    ['a'.repeat(40), '^(a|aa)+$', true],
    ['x'.repeat(5000) + 'y', '(.*)*z', false],
    [' '.repeat(5000) + 'x', '^\\s*\\s*\\s*\\s*$', false],
  ]
  for (const [s, re, want] of evil) {
    const ms = timed(() => assert.equal(ev('s ~ re', { s, re }, newBudget(100_000)), want, re))
    assert.ok(ms < 1000, `${re} took ${ms} ms`)
  }
  const ms = timed(() => assert.deepEqual(ev('xs | grep("^(a+)+$")', { xs: ['a'.repeat(30) + '!', 'aaa'] }), ['aaa']))
  assert.ok(ms < 1000)
})

test('M51: regex cost is charged to the budget (subject × program)', () => {
  const s = 'ab'.repeat(1_000_000)
  const ms = timed(() => assert.throws(() => ev('s ~ "(a|b)*c"', { s }, newBudget()), StepLimitError))
  assert.ok(ms < 100, `charged before the scan, took ${ms} ms`)
  assert.equal(ev('s ~ "(a|b)*c"', { s: s.slice(0, 100_000) }, newBudget()), false)
})

// Differential: the Pike VM must agree with V8 RegExp on the supported syntax.
const patterns = [
  'abc', '^abc$', 'a.c', 'a*', 'a+b', 'ab?c', 'a{2}', 'a{2,}', 'a{1,3}b', '(ab)+', '(?:ab|cd)+e', 'x|y|z', '^(a|b)*$',
  '[abc]', '[^abc]', '[a-z]+\\d', '[\\w-]+', '[-a]', '[a-]', '[]', '[^]', '\\bfoo\\b', '\\Bo', '\\s+', '\\S\\D\\W', '.+',
  'release/(\\d+)', '^feat/', 'fix(es)?$', '\\.ts$', '\\x41', '\\u0042', '\\cJ', 'a{', 'a{,2}', '}', ']', 'a{2}?', 'a+?b',
  '(?<n>ab)c', '\\/', '[\\b]', '\\t', '^$', '$^', '(a*)*b', '(|a)+', 'é+', '[à-ÿ]', '\\0',
]
const subjects = ['', 'abc', 'aabc', 'xabcx', 'ab', 'abab', 'cdcde', 'a1', 'foo bar', 'foobar', 'release/12', 'feat/x', 'fixes',
  'a.ts', 'A', 'B', '\n', 'a{', 'a{,2}', '}', ']', 'aaab', 'b', 'abc\n', 'café', 'x-y_z', '\b', '\t', 'é', 'aaa', ' \t ', '\0']
test('M51: linear matcher agrees with RegExp.prototype.test', () => {
  for (const p of patterns) {
    const native = new RegExp(p)
    for (const s of subjects) assert.equal(ev('s ~ p', { s, p }), native.test(s), `/${p}/.test(${JSON.stringify(s)})`)
  }
})

test('L43/M51: unsupported or invalid patterns give G107 on every evaluation, not only the first', () => {
  for (const p of ['(a)\\1', 'a(?=b)', '(?<!x)y', '(a', 'a{2,1}', 'x'.repeat(501), '(a{100}){100}']) {
    for (let round = 0; round < 2; round++) {
      const diagnostics: Diagnostic[] = []
      assert.equal(ev('"ab" ~ p', { p }, newBudget(), { diagnostics }), false)
      assert.equal(diagnostics.filter(d => d.code === 'G107').length, 1, `${p} round ${round}: ${JSON.stringify(diagnostics)}`)
    }
  }
  const diagnostics: Diagnostic[] = []
  assert.deepEqual(ev('["a", "b"] | grep("(")', {}, newBudget(), { diagnostics }), [])
  assert.equal(diagnostics[0]?.code, 'G107')
})

// ── Low-severity expression bugs ──

test('L41: dashes join a member only for a store key directly under data', () => {
  const scope = { items: [1, 2, 3], x: { count: 5, total: 9 }, b: { done: 4 }, data: { 'api-endpoints': { count: 12 } } }
  const cases: [string, Value][] = [
    ['items.length-1', 2],
    ['x.count-1', 4],
    ['x.total-b.done', 5],
    ['data.api-endpoints.count', 12],
    ['data.api-endpoints.count-2', 10],
    ['data.api-endpoints.count - 2', 10],
    ['data?.api-endpoints.count', 12],
  ]
  for (const [src, want] of cases) assert.deepEqual(ev(src, scope), want, src)
})

test('L42: string escapes decode \\uXXXX, \\u{…}, \\xHH, \\b, \\f, \\v, \\0 like JSON.stringify emits them', () => {
  const values = ['esc\u001b[31m', 'a\bb\fc\vd', 'nul\u0000', 'smile 😀', 'lone \ud800', 'q"\\/', 'tab\tnl\n']
  for (const v of values) assert.equal(ev(JSON.stringify(v)), v, JSON.stringify(v))
  assert.equal(ev('"\\u{1F600}"'), '😀')
  assert.equal(ev('"\\x41\\/"'), 'A/')
  assert.equal(ev('"\\q"'), 'q')
})

test('L44: sort("-key") keeps items without the key last and ties in source order', () => {
  const xs: Value = [{ id: 'a', n: 1 }, { id: 'b' }, { id: 'c', n: 1 }, { id: 'd', n: 2 }]
  assert.deepEqual(ev('xs | sort("-n") | map("id")', { xs }), ['d', 'a', 'c', 'b'])
  assert.deepEqual(ev('xs | sort("n", "desc") | map("id")', { xs }), ['d', 'a', 'c', 'b'])
  assert.deepEqual(ev('xs | sort("n") | map("id")', { xs }), ['a', 'c', 'd', 'b'])
  assert.deepEqual(ev('xs | sort("-n") | take(1) | map("id")', { xs }), ['d'])
  assert.deepEqual(ev('["b", "a", "c"] | sort("-")'), ['c', 'b', 'a'])
})

test('L45: fence is one backtick longer than any backtick run in the data', () => {
  const cases: [string, string][] = [
    ['plain', '```\nplain\n```'],
    ['a ``` b', '````\na ``` b\n````'],
    ['x\n`````\ny\n\n\n', '``````\nx\n`````\ny\n``````'],
  ]
  for (const [s, want] of cases) assert.equal(ev('s | fence', { s }), want)
  assert.equal(ev('s | fence("md")', { s: '```js\nx\n```' }), '````md\n```js\nx\n```\n````')
  // Trailing newlines are trimmed in linear time (the old /\n+$/ was quadratic on long newline runs).
  const s = '\n'.repeat(200_000) + 'x'
  const ms = timed(() => ev('s | fence', { s }, newBudget(100_000)))
  assert.ok(ms < 1000, `took ${ms} ms`)
})

test('deeply nested expression source is a G101 diagnostic, not a stack overflow', () => {
  for (const src of ['('.repeat(50_000) + '1' + ')'.repeat(50_000), '-'.repeat(50_000) + '1', '['.repeat(50_000)]) {
    const r = parseExpr(src)
    assert.equal(r.ast, undefined)
    assert.equal(r.diagnostics[0]?.code, 'G101')
  }
  assert.equal(ev('('.repeat(100) + '1' + ')'.repeat(100)), 1)
})

test('long left-associative chains are a G101 diagnostic, so freeVars/evalExpr never see a 20k-deep spine', () => {
  const chains = [Array(20_000).fill('1').join('+'), 'a' + '.b'.repeat(20_000), 'a' + '[0]'.repeat(20_000), 'a' + ' | len'.repeat(20_000), Array(20_000).fill('a').join(' && ')]
  for (const src of chains) {
    const r = parseExpr(src)
    assert.equal(r.ast, undefined, src.slice(0, 20))
    assert.equal(r.diagnostics[0]?.code, 'G101')
  }
  const ok = parseExpr(Array(500).fill('1').join('+'))
  assert.ok(ok.ast)
  assert.doesNotThrow(() => freeVars(ok.ast!))
  assert.equal(evalExpr(ok.ast!, {}, newBudget(), {}), 500)
})

test('regexTest: the linear matcher for hosts (config patterns), null + G107 when unsupported', async () => {
  const { regexTest } = await import('../packages/core/src/expr.ts')
  assert.equal(regexTest('^feat/', 'feat/x'), true)
  assert.equal(regexTest('^(a+)+$', 'a'.repeat(40) + '!'), false)
  const diagnostics: Diagnostic[] = []
  assert.equal(regexTest('(a)\\1', 'aa', newBudget(), { diagnostics }), null)
  assert.equal(diagnostics[0]?.code, 'G107')
})
