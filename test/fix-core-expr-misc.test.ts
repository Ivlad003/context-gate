// Review 2026-10-06 low-severity fixes in argparse, toolheader, shims and sha256 (L31, L65, L66, L67).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArgSpec } from '../packages/core/src/types.ts'
import { parseArgs } from '../packages/core/src/argparse.ts'
import { parseToolHeader } from '../packages/core/src/toolheader.ts'
import { parseShimOutput, shimCommand, type ShimCall } from '../packages/core/src/shims.ts'
import { sha256Hex } from '../packages/core/src/sha256.ts'

const spec: Record<string, ArgSpec> = { version: { type: 'string', positional: 0 }, dry: { type: 'flag' } }

test('L31: inherited names are unknown parameters, in argv and in tool-call objects', () => {
  const unknown: (string | Record<string, unknown>)[] = [
    'v1 --constructor x', 'v1 --toString x', 'v1 --__proto__ x', 'v1 --has-own-property x',
    { constructor: 'x' }, { hasOwnProperty: 'x' }, JSON.parse('{"__proto__": "x"}') as Record<string, unknown>,
  ]
  for (const input of unknown) {
    const r = parseArgs(input, spec)
    assert.equal(r.ok, false, JSON.stringify(input))
    if (!r.ok) assert.match(r.error, /невідомий параметр/)
  }
  const ok = parseArgs('v1 --dry', spec)
  assert.deepEqual(ok, { ok: true, args: { version: 'v1', dry: true } })
})

test('L31: a positional named like an Object.prototype member is still filled', () => {
  const r = parseArgs('x', { constructor: { type: 'string', positional: 0 } } as Record<string, ArgSpec>)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(Object.getOwnPropertyDescriptor(r.args, 'constructor')?.value, 'x')
})

test('L67: shorthand input with a parameter named `type` is not read as a full schema', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['{ "type": "string", "message": "string" }', { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } }, required: ['type', 'message'], additionalProperties: false }],
    ['{ "type": "string", "description": "string?" }', { type: 'object', properties: { type: { type: 'string' }, description: { type: 'string' } }, required: ['type'], additionalProperties: false }],
    ['{ "type": "object", "properties": { "p": { "type": "string" } } }', { type: 'object', properties: { p: { type: 'string' } } }],
    ['{ "type": "string", "description": "Шлях" }', { type: 'object', properties: { input: { type: 'string', description: 'Шлях' } }, required: ['input'] }],
    ['{ "items": "string[]" }', { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'], additionalProperties: false }],
    // Real schemas with keywords outside the old whitelist stay schemas.
    ['{ "q": { "type": "string", "deprecated": true } }', { type: 'object', properties: { q: { type: 'string', deprecated: true } }, required: ['q'], additionalProperties: false }],
    ['{ "q": { "type": "string", "$comment": "x", "readOnly": true } }', { type: 'object', properties: { q: { type: 'string', $comment: 'x', readOnly: true } }, required: ['q'], additionalProperties: false }],
    ['{ "type": "object", "patternProperties": { "^a": { "type": "string" } }, "minProperties": 1 }', { type: 'object', patternProperties: { '^a': { type: 'string' } }, minProperties: 1 }],
    ['{ "q": { "type": "string", "contentEncoding": "base64" } }', { type: 'object', properties: { q: { type: 'string', contentEncoding: 'base64' } }, required: ['q'], additionalProperties: false }],
    // An unknown key with a string value is still a parameter.
    ['{ "type": "string", "message": "Текст?" }', { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string', description: 'Текст' } }, required: ['type'], additionalProperties: false }],
  ]
  for (const [input, want] of cases) {
    const r = parseToolHeader(`# gate-tool: t\n# input: ${input}\n`)
    assert.deepEqual(r.header?.inputSchema, want, input)
  }
})

test('sha256Hex matches node:crypto, lone surrogates included', () => {
  for (const t of ['', 'abc', 'a\ud800b', '\udc00', 'x😀', '\ud800𐀀', 'тест'.repeat(50)]) {
    assert.equal(sha256Hex(t), createHash('sha256').update(t).digest('hex'), JSON.stringify(t))
  }
})

function has(bin: string): boolean { return spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0 }

function runShim(file: string, calls: ShimCall[]) {
  const cmd = shimCommand(file, file, calls, {})
  if (!cmd.ok) throw new Error(cmd.error)
  const r = spawnSync(cmd.argv[0]!, cmd.argv.slice(1), { input: cmd.stdin, encoding: 'utf8' })
  return parseShimOutput(cmd, { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }, calls)
}

test('L66: a bash module with `set -euo pipefail` fails per call, not the whole batch', { skip: !has('bash') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-shim-'))
  try {
    const file = join(dir, 'm.sh')
    writeFileSync(file, 'set -euo pipefail\nis_ci() { [ -n "${CI_NOPE_XYZ:-}" ]; }\nversion() { echo 1.2.3; }\nstrict() { false; echo after; }\nargc() { echo "$#"; }\n')
    const r = runShim(file, [{ fn: 'is_ci', args: [] }, { fn: 'version', args: [] }, { fn: 'strict', args: [] }, { fn: 'argc', args: ['a', 'b'] }])
    assert.equal(r.errors[0], 'exit 1')
    assert.deepEqual([r.results[1], r.errors[1]], ['1.2.3', null])
    // The module's errexit still applies inside its own functions.
    assert.equal(r.errors[2], 'exit 1')
    assert.deepEqual([r.results[3], r.errors[3]], [2, null])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('L65: a python NaN result fails that call only', { skip: !has('python3') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-shim-'))
  try {
    const file = join(dir, 'm.py')
    writeFileSync(file, "def ok():\n    return 'fine'\n\ndef avg(xs):\n    return sum(xs) / len(xs) if xs else float('nan')\n")
    const r = runShim(file, [{ fn: 'ok', args: [] }, { fn: 'avg', args: [[]] }, { fn: 'avg', args: [[1, 3]] }])
    assert.deepEqual([r.results[0], r.errors[0]], ['fine', null])
    assert.equal(r.results[1], null)
    assert.ok(r.errors[1], 'NaN call reports an error')
    assert.deepEqual([r.results[2], r.errors[2]], [2, null])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
