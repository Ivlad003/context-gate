import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildModel, dtsToJsonSchema, resolveSchemaRef, splitSchemaRef, type GateIndex } from '../packages/lsp/src/model.ts'
import { checkExpr } from '../packages/lsp/src/exprcheck.ts'
import { loadModel } from '../packages/lsp/src/load.ts'
import { sandbox } from './cli-helpers.ts'

const DTS = `// arch provider
/** one rule */
export interface Rule { from: string; to: string }
export interface ArchResult {
  available: boolean
  deny: Rule[]
  layers?: Array<{ name: string; level: number }>
  kind: 'a' | 'b'
  meta: Record<string, number>
  note: string | null
}
export type Short = { n: number }
`

test('dtsToJsonSchema: interfaces, type aliases, arrays, unions, records, references', () => {
  const rule = { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }
  assert.deepEqual(dtsToJsonSchema(DTS), {
    type: 'object',
    properties: {
      available: { type: 'boolean' }, deny: { type: 'array', items: rule },
      layers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, level: { type: 'number' } }, required: ['name', 'level'] } },
      kind: { enum: ['a', 'b'] }, meta: { type: 'object', additionalProperties: { type: 'number' } }, note: { type: 'string' },
    },
    required: ['available', 'deny', 'kind', 'meta', 'note'],
  })
  assert.deepEqual(dtsToJsonSchema(DTS, 'Short'), { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] })
  assert.deepEqual(dtsToJsonSchema(DTS, 'Rule'), rule)
  assert.deepEqual(dtsToJsonSchema('export default interface X { a?: string[] }\n'), { type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } })
  assert.equal(dtsToJsonSchema('const x = 1\n'), undefined)
  assert.deepEqual(splitSchemaRef('types/a.d.ts#Rule'), { path: 'types/a.d.ts', type: 'Rule' })
  assert.equal(resolveSchemaRef('x.json'), undefined)
  assert.deepEqual(resolveSchemaRef({ type: 'string' }), { type: 'string' })
})

test('buildModel: provider schema as a .schema.json / .d.ts path (Р4); unreadable path stays unknown (G170)', () => {
  const files: Record<string, string> = { 'schemas/lint.schema.json': JSON.stringify({ type: 'object', properties: { count: { type: 'number' } } }), 'types/arch.d.ts': DTS }
  const model = buildModel({
    config: { providers: { lint: { kind: 'cli', schema: 'schemas/lint.schema.json' }, arch: { kind: 'cli', schema: 'types/arch.d.ts' }, gone: { kind: 'cli', schema: 'nope.json' } } },
    index: {} as GateIndex,
    readFile: (p) => files[p],
  })
  assert.equal(model.roots.lint!.k, 'object')
  assert.equal(model.roots.arch!.k, 'object')
  assert.equal(model.roots.gone!.k, 'unknown')
  const codes = (src: string) => checkExpr(src, model).map((d) => d.code)
  assert.deepEqual(codes('lint.count > 0'), [])
  assert.deepEqual(codes('arch.deny | len'), [])
  assert.deepEqual(codes('arch.nope'), ['G172'])
  assert.deepEqual(codes('gone.x'), ['G170'])
})

test('loadModel reads schema files relative to the repo root', () => {
  const root = sandbox()
  mkdirSync(join(root, '.claude'), { recursive: true })
  mkdirSync(join(root, 'types'), { recursive: true })
  writeFileSync(join(root, 'types/arch.d.ts'), DTS)
  writeFileSync(join(root, '.claude/gate.json'), JSON.stringify({ providers: { arch: { kind: 'cli', command: ['a'], schema: 'types/arch.d.ts#ArchResult' } } }))
  const { model } = loadModel(root)
  assert.deepEqual(checkExpr('arch.available && arch.kind == "a"', model).map((d) => d.code), [])
})
