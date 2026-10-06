import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXAMPLE_TRUNCATION_MARKER, pickExamples } from '../packages/core/src/examples.ts'

const files = [
  { path: 'src/b.service.ts', size: 300, body: 'b'.repeat(300) },
  { path: 'src/a.service.ts', size: 300, body: 'a'.repeat(300) },
  { path: 'src/c.service.ts', size: 120, body: 'c'.repeat(120) },
  { path: 'src/d.service.ts', size: 900, body: 'd'.repeat(900) },
]

const cases: [string, number, number | undefined, string[]][] = [
  ['one smallest', 1, undefined, ['src/c.service.ts']],
  ['ties broken by path', 3, undefined, ['src/c.service.ts', 'src/a.service.ts', 'src/b.service.ts']],
  ['n larger than list', 10, undefined, ['src/c.service.ts', 'src/a.service.ts', 'src/b.service.ts', 'src/d.service.ts']],
  ['n = 0', 0, undefined, []],
  ['negative / NaN', NaN, undefined, []],
]
for (const [name, n, budget, want] of cases) {
  test(`pickExamples: ${name}`, () => assert.deepEqual(pickExamples(files, n, budget).map(f => f.path), want))
}

test('pickExamples truncates bodies to budget, keeps size, does not mutate input', () => {
  const out = pickExamples(files, 2, 100)
  assert.equal(out[0].body, 'c'.repeat(100) + '\n' + EXAMPLE_TRUNCATION_MARKER)
  assert.equal(out[0].size, 120)
  assert.equal(files[2].body.length, 120)
  assert.equal(pickExamples(files, 1, 500)[0].body, 'c'.repeat(120))
})
