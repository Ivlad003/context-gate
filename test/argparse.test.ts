import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, usageLine, argumentHint, argsToJsonSchema, tokenize } from '../packages/core/src/argparse.ts'
import type { ArgSpec } from '../packages/core/src/types.ts'

const spec: Record<string, ArgSpec> = {
  since: { type: 'string', positional: 0, required: true, hint: '<tag|sha>' },
  format: { type: 'enum', values: ['md', 'slack', 'github'], default: 'md' },
  scope: { type: 'string', default: null },
  dry: { type: 'flag' },
}

test('usage line and argument-hint', () => {
  assert.equal(usageLine('release-notes', spec), '/release-notes <tag|sha> [--format md|slack|github] [--scope <scope>] [--dry]')
  assert.equal(argumentHint(spec), '<tag|sha> [--format md|slack|github] [--scope <scope>] [--dry]')
  assert.equal(argumentHint({ n: { type: 'number', required: true }, tail: { type: 'rest' }, maxItems: { type: 'list' } }), '--n <n> [--max-items <maxItems,…>] [-- <tail…>]')
})

test('parse table', () => {
  const rows: [string, Record<string, unknown>][] = [
    ['v1.4.0', { since: 'v1.4.0', format: 'md', scope: null, dry: false }],
    ['--since v1.4.0 --format slack', { since: 'v1.4.0', format: 'slack', scope: null, dry: false }],
    ['v1 --format=github --dry', { since: 'v1', format: 'github', scope: null, dry: true }],
    ['--dry v1', { since: 'v1', format: 'md', scope: null, dry: true }],
    ['v1 --scope "api core"', { since: 'v1', format: 'md', scope: 'api core', dry: false }],
    ["'v 1' --no-dry", { since: 'v 1', format: 'md', scope: null, dry: false }],
    ['v1 --dry=false', { since: 'v1', format: 'md', scope: null, dry: false }],
  ]
  for (const [input, want] of rows) {
    const r = parseArgs(input, spec)
    assert.ok(r.ok, input + ' ' + (r.ok ? '' : r.error))
    assert.deepEqual(r.ok && r.args, want, input)
  }
})

test('errors render usage', () => {
  const rows: [string, RegExp][] = [
    ['v1 --format pdf', /`format` має бути md\|slack\|github/],
    ['', /бракує обов'язкового аргументу `since`/],
    ['v1 extra', /зайвий аргумент «extra»/],
    ['v1 --bogus', /невідомий параметр `--bogus`/],
    ['v1 --scope', /`scope` потребує значення/],
    ['v1 -- tail', /хвіст після `--`/],
  ]
  for (const [input, re] of rows) {
    const r = parseArgs(input, spec, { name: 'release-notes' })
    assert.equal(r.ok, false, input)
    if (!r.ok) {
      assert.match(r.error, re, input)
      assert.match(r.error, /^Невірні аргументи: .*Використання: \/release-notes <tag\|sha>/)
      assert.equal(r.usage, usageLine('release-notes', spec))
    }
  }
})

test('types: number, list, json, path, rest', () => {
  const s: Record<string, ArgSpec> = {
    pr: { type: 'number', required: true },
    focus: { type: 'list' },
    meta: { type: 'json' },
    file: { type: 'path' },
    maxItems: { type: 'number', default: 5 },
    tail: { type: 'rest' },
  }
  const r = parseArgs('--pr 123 --focus security,perf --focus a11y --meta \'{"a":[1]}\' --file ./src/x.ts --max-items 9 -- raw  "tail" --x', s, { pathExists: (p) => p === 'src/x.ts' })
  assert.ok(r.ok, r.ok ? '' : r.error)
  assert.deepEqual(r.ok && r.args, { pr: 123, focus: ['security', 'perf', 'a11y'], meta: { a: [1] }, file: 'src/x.ts', maxItems: 9, tail: 'raw  "tail" --x' })
  const bad = parseArgs('--pr abc', s)
  assert.ok(!bad.ok && /числом/.test(bad.error))
  const missing = parseArgs('--pr 1 --file nope.ts', s, { pathExists: () => false })
  assert.ok(!missing.ok && /не існує/.test(missing.error))
  const extra = parseArgs('--pr 1 a b', s)
  assert.ok(extra.ok && extra.args.tail === 'a b', 'extra positionals flow into rest')
  const argv = parseArgs(['--pr', '2', '--', 'x', 'y'], s)
  assert.ok(argv.ok && argv.args.tail === 'x y' && argv.args.pr === 2)
})

test('structured object input (tool call)', () => {
  const r = parseArgs({ since: 'v1', format: 'github', dry: true }, spec)
  assert.ok(r.ok)
  assert.deepEqual(r.ok && r.args, { since: 'v1', format: 'github', dry: true, scope: null })
  const bad = parseArgs({ since: 'v1', format: 'pdf' }, spec)
  assert.ok(!bad.ok)
})

test('argsToJsonSchema', () => {
  assert.deepEqual(argsToJsonSchema(spec), {
    type: 'object',
    additionalProperties: false,
    required: ['since'],
    properties: {
      since: { type: 'string', description: '<tag|sha>' },
      format: { type: 'string', enum: ['md', 'slack', 'github'], default: 'md' },
      scope: { type: 'string' },
      dry: { type: 'boolean' },
    },
  })
})

test('tokenize quotes and escapes', () => {
  assert.deepEqual(tokenize(`a "b c" 'd "e"' f\\ g "h\\"i"`).map((t) => t.value), ['a', 'b c', 'd "e"', 'f g', 'h"i'])
})
