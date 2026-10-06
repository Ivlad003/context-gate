import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Diagnostic, Value } from '../packages/core/src/types.ts'
import { StepLimitError, callPaths, evalExpr, freeVars, newBudget, parseExpr, type EvalEnv } from '../packages/core/src/expr.ts'

const scope: Record<string, Value> = {
  gate: { tier: 'quick', profile: 'frontend' },
  git: { branch: 'feat/ui-button' },
  n: 7,
  zero: 0,
  name: 'world',
  list: [3, 1, 2],
  items: [
    { id: 'a', type: 'feat', cost: { chars: 300 } },
    { id: 'b', type: 'fix', cost: { chars: 100 } },
    { id: 'c', type: 'feat', cost: { chars: 200 } },
  ],
  data: { 'api-endpoints': { count: 12 }, 'verify-log': { failures: [{ reason: 'tsc' }, { reason: 'lint' }] } },
  pkg: { scripts: { storybook: 'sb' } },
  counter: null,
}

function ev(src: string, env: EvalEnv = {}): Value {
  const p = parseExpr(src)
  assert.ok(p.ast, `parse failed for ${src}: ${JSON.stringify(p.diagnostics)}`)
  return evalExpr(p.ast, scope, newBudget(), env)
}

const cases: [string, Value][] = [
  ['1 + 2 * 3', 7],
  ['(1 + 2) * 3', 9],
  ['10 - 4 - 3', 3],
  ['2 * 3 % 4', 2],
  ['-n + 10', 3],
  ['!true || true', true],
  ['1 < 2 && 2 < 1', false],
  ['1 + 1 == 2', true],
  ['"a" + 1', 'a1'],
  ["'hello ' + name", 'hello world'],
  ['n / zero', null],
  ['n % zero', null],
  ['gate.tier == "quick" ? 3 : 6', 3],
  ['gate.tier == "premium" ? 3 : gate.tier == "quick" ? 4 : 6', 4],
  ['counter ?? 5', 5],
  ['(counter ?? 0) + 1', 1],
  ['data.api-endpoints.count', 12],
  ['data.api-endpoints.count - 2', 10],
  ['n-2', 5],
  ['n - 2', 5],
  ['data.verify-log.failures.at(1).reason', 'lint'],
  ['data.verify-log.failures.at(-1).reason', 'lint'],
  ['data.verify-log.failures[0].reason', 'tsc'],
  ['data.missing?.x', null],
  ['data.missing.x.y', null],
  ['list.length', 3],
  ['len(items)', 3],
  ['min(n, 3)', 3],
  ['max(list)', 3],
  ['abs(-4)', 4],
  ['round(3.14159, 2)', 3.14],
  ['floor(2.7) + ceil(2.1)', 5],
  ['"feat" in ["feat", "fix"]', true],
  ['"x" in "xyz"', true],
  ['gate.profile.in(["frontend", "backend"])', true],
  ['git.branch ~ "^feat/ui"', true],
  ["pkg.scripts.storybook != null && git.branch ~ '^feat/ui'", true],
  ['[1, 2] + [3]', [1, 2, 3]],
  ['list | sort', [1, 2, 3]],
  ['list | sort("", "desc")', [3, 2, 1]],
  ['items | sort("cost.chars") | map("id")', ['b', 'c', 'a']],
  ['items | sort("-cost.chars") | take(1) | map("id")', ['a']],
  ['items | where("type", "feat") | len', 2],
  ['items | where("type", "feat") | map("{{ item.id }}={{ item.cost.chars }}") | join("; ")', 'a=300; c=200'],
  ['items | grep("^f", "type") | len', 3],
  ['items | grep("feat", "type") | map("id") | join(",")', 'a,c'],
  ['[1, 1, 2] | unique', [1, 2]],
  ['items | unique("type") | len', 2],
  ['"abcdefgh" | truncate(4)', 'abc…'],
  ['"x" | fence("ts")', '```ts\nx\n```'],
  ['1234 / 1000 | round(1)', 1.2],
  ['data.verify-log.failures | len', 2],
  ['items | take(2) | len', 2],
]

for (const [src, want] of cases) {
  test(`expr: ${src}`, () => assert.deepEqual(ev(src), want))
}

test('division by zero gives null and a G106 warning', () => {
  const diagnostics: Diagnostic[] = []
  assert.equal(ev('n / 0', { diagnostics }), null)
  assert.equal(diagnostics[0]?.code, 'G106')
})

test('ago filter uses env.now', () => {
  assert.equal(ev('1000 | ago', { now: 1000 + 5 * 60_000 }), '5 хв тому')
})

const errors: [string, string][] = [
  ['1 +', 'G101'],
  ['"abc', 'G102'],
  ['foo(1)', 'G103'],
  ['list | evil', 'G104'],
  ['list | util.fn', 'G154'],
  ['list | take(2) | util.fn(1)', 'G154'],
  ['1 2', 'G101'],
  ['a #', 'G101'],
]
for (const [src, code] of errors) {
  test(`parse error ${code}: ${src}`, () => {
    const p = parseExpr(src)
    assert.equal(p.ast, undefined)
    assert.ok(p.diagnostics.some(d => d.code === code), JSON.stringify(p.diagnostics))
  })
}

test('provider call at the start of a pipe is allowed and resolved via env.call', () => {
  const calls: string[] = []
  const v = ev('util.fn(1, tier=gate.tier) | take(2)', {
    call: (path, args, kwargs) => { calls.push(`${path}(${JSON.stringify(args)},${JSON.stringify(kwargs)})`); return [1, 2, 3] },
  })
  assert.deepEqual(v, [1, 2])
  assert.deepEqual(calls, ['util.fn([1],{"tier":"quick"})'])
})

test('G157: calls without a host resolver are impossible', () => {
  const diagnostics: Diagnostic[] = []
  assert.equal(ev('fs.read("/etc/passwd")', { diagnostics }), null)
  assert.equal(diagnostics[0]?.code, 'G157')
})

test('no prototype leaks through identifiers or members', () => {
  assert.equal(ev('constructor'), null)
  assert.equal(ev('gate.constructor'), null)
  assert.equal(ev('name.length'), 5)
})

test('step limit G155 via StepLimitError', () => {
  const big = Array.from({ length: 5000 }, (_, i) => i)
  const p = parseExpr('xs | sort | map("{{ item }}") | join(",")')
  assert.ok(p.ast)
  assert.throws(() => evalExpr(p.ast!, { xs: big }, newBudget(10_000)), StepLimitError)
  assert.doesNotThrow(() => evalExpr(p.ast!, { xs: big.slice(0, 100) }, newBudget(10_000)))
})

test('freeVars and callPaths', () => {
  const p = parseExpr('gate.tier == "quick" ? util.fn(data.x) : items | map("{{ item.id }} {{ name }}")')
  assert.ok(p.ast)
  assert.deepEqual(freeVars(p.ast!), ['data', 'gate', 'items', 'name'])
  assert.deepEqual(callPaths(p.ast!), ['util.fn'])
})
