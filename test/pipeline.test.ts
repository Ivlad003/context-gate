// Core pipe executors (`runPipeStage` / `runPipeline` over a PipeHost), `/gate` provenance and the shared
// index builder: the same code the CLI (`context-gate pipe`, `index`) and the mod (`/gate a | b`) run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGateCommand, type PipeStage } from '../packages/core/src/gatecmd.ts'
import { formatPipeText, itemProvenance, runPipeStage, runPipeline, type PipeHost } from '../packages/core/src/pipeline.ts'
import { buildGateIndex, indexKey, sampleValue, symbolsOf, varsOf } from '../packages/core/src/gateindex.ts'
import { makeItem } from '../packages/core/src/items.ts'
import { decideGate } from '../packages/core/src/decide.ts'
import type { DecisionLogEntry, GateConfig, Item, ItemDecision, MdcRule } from '../packages/core/src/types.ts'

const CFG = {
  groups: { frontend: ['skill:react-*', 'tool:mcp__figma__*'], backend: ['skill:prisma', 'tool:mcp__postgres__*'], base: ['skill:tdd'] },
  tiers: { standard: { groups: ['base'] }, quick: { groups: [] } },
  profiles: { frontend: { groups: ['frontend'], when: { paths: ['apps/web/**'] } }, backend: { groups: ['backend'] } },
} as unknown as GateConfig

const ITEMS: Item[] = [
  makeItem('skill', 'react-hooks', { description: 'React hooks', provenance: { source: 'claude-skills' } }),
  makeItem('skill', 'prisma', { provenance: { source: 'claude-skills' } }),
  makeItem('skill', 'tdd', { provenance: { source: 'claude-skills' } }),
  makeItem('skill', 'misc', { provenance: { source: 'claude-skills' } }),
  makeItem('tool', 'mcp__figma__get_file', { provenance: { source: 'claude-tools' } }),
  makeItem('tool', 'mcp__postgres__query', { provenance: { source: 'claude-tools' } }),
  makeItem('section', 'workflow', { provenance: { source: 'prompt-dir' }, cost: { chars: 400 } }),
]

const LOG: DecisionLogEntry[] = [
  { ts: 1000, turn: 1, trigger: 'manual', tier: 'standard', enabled: ['skill:prisma'], disabled: [], reason: [], kind: 'decision' },
  { ts: 2000, turn: 1, trigger: 'deny', tier: 'standard', enabled: [], disabled: [], reason: [], kind: 'deny', data: { tool: 'mcp__figma__get_file' } },
]

function host(over: Partial<PipeHost> = {}): PipeHost {
  return {
    config: CFG,
    now: 10_000,
    collect: () => ITEMS,
    decide: (items, f) => decideGate(CFG, { paths: f.paths, ...(f.profile ? { manual: { profile: f.profile, add: [], remove: [] } } : {}) }, { turn: 0 }, items, f.tier ? { tier: f.tier } : {}).gate.items,
    signals: (a) => ({ paths: [], model: a.model ?? 'm' }),
    render: async (ids) => ({ tier: 'standard', sections: new Map([...ids].map((id) => [id, { text: `## ${id}`, tokens: 2, included: true, status: 'ok' }])) }),
    log: () => LOG,
    ...over,
  }
}

function stages(text: string): PipeStage[] {
  const p = parseGateCommand(text)
  assert.ok(!('error' in p) && p.cmd === 'pipe', JSON.stringify(p))
  return p.stages
}

const ids = (out: Awaited<ReturnType<typeof runPipeline>>): string[] => ('records' in out ? out.records.map((r) => (r as Item).id) : [])

test('runPipeline: the spec examples over a host', async () => {
  const rows: [string, (out: Awaited<ReturnType<typeof runPipeline>>) => void][] = [
    ['collect kind=skill | where group=frontend', (o) => assert.deepEqual(ids(o), ['skill:react-hooks'])],
    ['collect kind=skill | decide --profile backend | off', (o) => assert.deepEqual(ids(o), ['skill:react-hooks'])],
    ['collect kind=skill | decide --profile backend | on', (o) => assert.deepEqual(ids(o), ['skill:prisma', 'skill:tdd', 'skill:misc'])],
    ['collect --id prisma,tdd | take 1', (o) => assert.deepEqual(ids(o), ['skill:prisma'])],
    ['collect kind=tool | observe --status denied', (o) => assert.deepEqual(ids(o), ['tool:mcp__figma__get_file'])],
    ['collect kind=section | render | preview', (o) => assert.equal('text' in o && o.text, '<!-- section:workflow -->\n## workflow\n')],
    ['collect | decide --profile frontend | tokens', (o) => assert.equal('records' in o && (o.records[0] as { count: number }).count, ITEMS.length)],
    ['collect kind=skill | sort -id | take 2', (o) => assert.deepEqual(ids(o), ['skill:tdd', 'skill:react-hooks'])],
    ['collect kind=skill | deliver', (o) => assert.equal('records' in o && (o.records[0] as { event: string }).event, 'prompt.attachment skill_listing')],
    ['why | where trigger=manual', (o) => assert.deepEqual('records' in o ? o.records.map((r) => (r as DecisionLogEntry).turn) : [], [1])],
  ]
  for (const [text, check] of rows) {
    const out = await runPipeline(stages(text), [], host())
    assert.ok(!('error' in out), `${text}: ${'error' in out ? out.error : ''}`)
    check(out)
  }
})

test('runPipeStage: errors, text in the middle, deliver needs --dry-run on the CLI host', async () => {
  const mid = await runPipeline(stages('collect | preview | take 1'), [], host())
  assert.ok('error' in mid && mid.error.startsWith('G504'))
  const bad = await runPipeline(stages('collect | where (('), [], host())
  assert.ok('error' in bad && bad.error.startsWith('G508'))
  const cli = await runPipeStage(stages('collect | deliver')[1], ITEMS, host({ deliverNeedsDryRun: true }))
  assert.ok('error' in cli)
  const dry = await runPipeStage(stages('collect | deliver --dry-run')[1], ITEMS, host({ deliverNeedsDryRun: true }))
  assert.ok('records' in dry)
  const why = await runPipeStage(stages('collect | why')[1], [], host(), { last: true })
  assert.ok('text' in why && why.text.includes('| хід |'))
  const sig = await runPipeline(stages('signals --model haiku | take 1'), [], host())
  assert.deepEqual('records' in sig && sig.records[0], { paths: [], model: 'haiku' })
})

test('formatPipeText: items as a list with decision and counters, others as JSON, capped', async () => {
  const out = await runPipeline(stages('collect kind=skill | decide --profile backend | observe'), [], host())
  const text = formatPipeText(out)
  assert.match(text, /^4 записів:/)
  assert.match(text, /- skill:react-hooks \[off\] — React hooks \(\d+ симв\.\) · доставлено 0, увімкнено 0, відмов 0/)
  assert.match(text, /- skill:prisma \[on\] .*увімкнено 1/)
  assert.equal(formatPipeText({ records: [] }), 'Порожньо: жоден запис не пройшов pipe.')
  assert.equal(formatPipeText({ records: [{ a: 1 }, { a: 2 }] }, 1), '2 записів:\n`{"a":1}`\n…(+1)')
  assert.equal(formatPipeText({ error: 'G501 x' }), 'G501 x')
})

test('itemProvenance: manual +group, tier group, the profile trigger, ungrouped and preload (SPEC scenario 4)', () => {
  const { gate } = decideGate(CFG, { paths: ['apps/web/a.tsx'], manual: { add: ['backend'], remove: [] } }, { turn: 0 }, ITEMS, {})
  const prov = itemProvenance(ITEMS, { config: CFG, gate, profileSource: 'when:paths', manual: { add: ['backend'], remove: [] } })
  assert.equal(prov.get('skill:react-hooks'), 'when:paths frontend: frontend')
  assert.equal(prov.get('skill:prisma'), 'manual +backend')
  assert.equal(prov.get('skill:tdd'), 'tier standard: base')
  assert.equal(prov.get('section:workflow'), 'не в групах')
  assert.equal(prov.get('skill:misc'), 'поза групами (лише назва)')
  const manual = itemProvenance(ITEMS, { config: CFG, gate: { ...gate, profile: 'frontend' }, profileSource: 'when:paths', manual: { profile: 'frontend', add: [], remove: [] } })
  assert.equal(manual.get('skill:react-hooks'), 'manual frontend: frontend')
  const pre = itemProvenance(ITEMS, { config: CFG, gate: { ...gate, items: { ...gate.items, 'skill:tdd': 'preload' as ItemDecision } } })
  assert.equal(pre.get('skill:tdd'), 'tier standard (preload)')
  const off = itemProvenance(ITEMS, { config: CFG, gate: { ...gate, off: true } })
  assert.equal(off.get('skill:prisma'), 'off (усе увімкнено)')
  assert.equal(prov.has('tool:mcp__postgres__query') && prov.get('tool:mcp__postgres__query'), 'manual +backend')
})

test('buildGateIndex: config, items, sections, rules, vars (sampled, no contents) and the session block', () => {
  const rule: MdcRule = { id: 'react', path: '.cursor/rules/react.mdc', type: 'auto', globs: ['src/**'], negGlobs: [], alwaysApply: false, body: 'SECRET BODY', fileRefs: [] }
  const ix = buildGateIndex({
    generatedBy: 'test', generatedAt: '2026-01-01T00:00:00.000Z', config: CFG, items: ITEMS,
    sections: [{ id: 'workflow', scope: 'static', chars: 400, tokens: 100 }], rules: [rule],
    scope: { gate: { tier: 'standard' }, cursor: { always: [{ id: 'x', body: 'SECRET BODY' }] }, args: { a: 1 }, git: { changed: ['a', 'b', 'c', 'd'] } },
    session: { tools: [{ name: 'Read', mcp: false }], mcpServers: ['figma'], skills: [{ name: 'tdd' }], tier: 'standard' },
  })
  assert.deepEqual(Object.keys(ix.profiles as object), ['frontend', 'backend'])
  assert.equal((ix.sections as { uri: string }[])[0].uri, 'prompt://workflow')
  assert.deepEqual((ix.rules as { id: string; type: string }[]).map((r) => `${r.id}:${r.type}`), ['react:auto'])
  const vars = ix.vars as Record<string, { type: string; value: unknown }>
  assert.equal(vars.gate.type, 'object')
  assert.equal(vars.args, undefined)
  assert.deepEqual(vars.git.value, { changed: ['a', 'b', 'c'] })
  assert.deepEqual((ix.session as { mcpServers: string[] }).mcpServers, ['figma'])
  assert.doesNotMatch(JSON.stringify(ix), /SECRET BODY/)
  const again = buildGateIndex({ generatedBy: 'test', generatedAt: 'later', config: CFG, items: ITEMS, sections: [], rules: [] })
  assert.equal(indexKey(again), indexKey({ ...again, generatedAt: 'other' }))
  assert.equal(sampleValue('x'.repeat(200)), 'x'.repeat(80) + '…')
  assert.deepEqual(varsOf(undefined), {})
  assert.deepEqual(symbolsOf({ symbols: [{ id: 'f', signature: 'f()', path: 'a.ts' }, 'g', 3] }, 'kl'), [{ provider: 'kl', id: 'f', signature: 'f()', file: 'a.ts' }, { provider: 'kl', id: 'g' }])
})
