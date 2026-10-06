import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pushLog, formatWhy, toJsonl, fromJsonl, parseWhere, filterWhere, journalResolve } from '../packages/core/src/journal.ts'
import { collectFromRules, collectFromSkillListing, decideStage, normalize, tokens, whereFilter, itemsToJsonl } from '../packages/core/src/pipeline.ts'
import { parseMdc } from '../packages/core/src/mdc.ts'
import { mergeDefaults } from '../packages/core/src/config.ts'
import type { DecisionLogEntry } from '../packages/core/src/types.ts'

const entry = (turn: number, over: Partial<DecisionLogEntry> = {}): DecisionLogEntry => ({ ts: turn, turn, trigger: 'when:paths', profile: 'frontend', tier: 'standard', enabled: ['skill:a'], disabled: ['skill:b'], reason: ['r'], kind: 'decision', ...over })

test('pushLog ring buffer', () => {
  let buf: number[] = []
  for (let i = 0; i < 205; i++) buf = pushLog(buf, i)
  assert.equal(buf.length, 200)
  assert.equal(buf[0], 5)
  assert.deepEqual(pushLog([1, 2, 3], 4, 3), [2, 3, 4])
  const orig = [1]
  pushLog(orig, 2)
  assert.deepEqual(orig, [1], 'pure')
})

test('formatWhy table', () => {
  const entries = [
    entry(1),
    entry(2, { trigger: 'manual', profile: 'backend', enabled: ['skill:b'], disabled: ['skill:a'], reason: ['/gate backend', 'x|y'] }),
    entry(3, { trigger: 'classify', profile: undefined, enabled: ['skill:b'], disabled: ['skill:a'], data: { proposed: { profile: 'docs', confidence: 0.84 } } }),
    entry(4, { kind: 'deny' }),
  ]
  const md = formatWhy(entries)
  const lines = md.split('\n')
  assert.equal(lines[0], '| хід | тригер | профіль | tier | зміни | причина |')
  assert.equal(lines.length, 5, 'non-decision entries skipped')
  assert.equal(lines[2], '| 1 | when:paths | frontend | standard | 1 увімк., 1 вимк. | r |')
  assert.equal(lines[3], '| 2 | manual | backend | standard | +b −a | /gate backend; x\\|y |')
  assert.equal(lines[4], '| 3 | classify 0.84 | (docs?) | standard | — | r |')
  assert.equal(formatWhy(entries, 1).split('\n').length, 3)
  assert.match(formatWhy([]), /рішень ще не було/)
})

test('jsonl', () => {
  const line = toJsonl(entry(1))
  assert.ok(line.endsWith('\n'))
  const { items, bad } = fromJsonl(line + 'garbage\n\n' + line)
  assert.equal(items.length, 2)
  assert.equal(bad, 1)
})

test('where filter', () => {
  const recs = [{ status: 'unverified', n: 3, tags: ['x'] }, { status: 'ok', n: 10, tags: [] }, { data: { status: 'unverified' }, n: 1 }]
  const rows: [string, number][] = [
    ['where status=unverified', 1],
    ['status!=ok', 2],
    ['n>2', 2],
    ['n>=3 and status=ok', 1],
    ['tags=x', 1],
    ['status~VER', 1],
    ['status="ok"', 1],
  ]
  for (const [expr, count] of rows) {
    const r = filterWhere(recs, expr)
    assert.ok('items' in r, expr)
    assert.equal('items' in r && r.items.length, count, expr)
  }
  const j = filterWhere(recs, 'status=unverified', journalResolve)
  assert.equal('items' in j && j.items.length, 2, 'journal resolver reads data.*')
  assert.ok('error' in parseWhere('where ???'))
  assert.ok('error' in parseWhere('where'))
})

test('pipeline stages', () => {
  const rules = [
    parseMdc('---\nglobs: src/**\n---\nR1', { path: '.cursor/rules/api-x.mdc', id: 'api-x' }).rule,
    parseMdc('---\nalwaysApply: true\n---\nalways body', { path: '.cursor/rules/sec.mdc', id: 'sec' }).rule,
  ]
  const items = normalize([...collectFromRules(rules), ...collectFromSkillListing('- react-a: React\n- nestjs: Nest'), ...collectFromRules(rules)])
  assert.equal(items.length, 4)
  const cfg = mergeDefaults({
    groups: { fe: ['skill:react-*'], be: ['skill:nestjs', 'rule:api-*'] },
    profiles: { fe: { groups: ['fe'], when: { paths: ['**/*.tsx'] } } },
  })
  const decided = decideStage(items, cfg, { paths: ['a.tsx'], model: 'claude-sonnet-4' })
  const by = Object.fromEntries(decided.map((d) => [d.id, d.decision]))
  assert.deepEqual(by, { 'rule:api-x': 'off', 'rule:sec': 'on', 'skill:react-a': 'on', 'skill:nestjs': 'off' })
  const t = tokens(decided)
  assert.equal(t.count, 4)
  assert.equal(t.byKind.rule!.count, 2)
  assert.equal(t.byDecision.off!.count, 2)
  assert.equal(t.included.chars, 'always body'.length + 'React'.length + 'react-a'.length)
  const w = whereFilter(decided, 'group=be', cfg)
  assert.deepEqual('items' in w && w.items.map((i) => i.id), ['rule:api-x', 'skill:nestjs'])
  const w2 = whereFilter(decided, 'kind=rule when=always')
  assert.deepEqual('items' in w2 && w2.items.map((i) => i.id), ['rule:sec'])
  assert.equal(itemsToJsonl(decided).trim().split('\n').length, 4)
})
