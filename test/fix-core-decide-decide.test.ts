// Regressions from the 2026-10-06 review, core decide: group negation, prompt-only turns (M21), harness
// model attributes (M22), inherited keys (L31), `+` in profile names (L38), out-of-root and Windows paths
// (M54, L39), preload negation, classifier JSON (L40), ticket data in the journal (L64).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideGate, parseClassify, profileParts } from '../packages/core/src/decide.ts'
import { mergeDefaults } from '../packages/core/src/config.ts'
import { makeItem } from '../packages/core/src/items.ts'
import type { GateConfig, GateState, Signals } from '../packages/core/src/types.ts'

const sig = (over: Partial<Signals> = {}): Signals => ({ paths: [], model: 'claude-sonnet-4-5', ...over })
const s0: GateState = { turn: 0 }

test('group negation: an excluded item is off like its group mates, never more visible', () => {
  const cfg = mergeDefaults({
    groups: { backend: ['agent:*', '!agent:dangerous', 'rule:api-*', '!rule:api-legacy', 'skill:be-*', '!skill:be-secret'], fe: ['skill:react'] },
    profiles: { frontend: { groups: ['fe'] } },
  })
  const items = [makeItem('agent', 'dangerous'), makeItem('agent', 'other'), makeItem('rule', 'api-legacy'), makeItem('rule', 'api-v2'), makeItem('skill', 'be-secret'), makeItem('skill', 'be-x'), makeItem('skill', 'react')]
  const { gate } = decideGate(cfg, sig({ manual: { profile: 'frontend', add: [], remove: [] } }), s0, items)
  const rows: [string, string][] = [['agent:dangerous', 'off'], ['agent:other', 'off'], ['rule:api-legacy', 'off'], ['rule:api-v2', 'off'], ['skill:be-secret', 'off'], ['skill:be-x', 'off'], ['skill:react', 'on']]
  for (const [id, want] of rows) assert.equal(gate.items[id], want, id)
})

test('group negation: `skill:!x` reads as `!skill:x` (an exclusion), not «all skills but x»', () => {
  const cfg = mergeDefaults({ groups: { fe: ['skill:react-*', 'skill:!react-legacy'] }, profiles: { frontend: { groups: ['fe'] } } })
  const items = ['react-a', 'react-legacy', 'unrelated'].map((n) => makeItem('skill', n))
  const { gate } = decideGate(cfg, sig({ manual: { profile: 'frontend', add: [], remove: [] } }), s0, items)
  assert.deepEqual([gate.items['skill:react-a'], gate.items['skill:react-legacy'], gate.items['skill:unrelated']], ['on', 'off', 'nameOnly'])
})

test('preload: a negated entry preloads nothing; /gate -group beats the tier preload', () => {
  const cfg = mergeDefaults({ groups: { conv: ['skill:conv'] }, tiers: { standard: { groups: ['conv'], preload: ['!skill:a', 'skill:!b', 'conv'] }, premium: { groups: [] }, quick: { groups: [] } } })
  const items = ['a', 'b', 'conv', 'other'].map((n) => makeItem('skill', n))
  const plain = decideGate(cfg, sig(), s0, items).gate
  assert.deepEqual(plain.skills.preload, ['conv'])
  const removed = decideGate(cfg, sig({ manual: { add: [], remove: ['conv'] } }), s0, items).gate
  assert.deepEqual(removed.skills.preload, [])
  assert.equal(removed.items['skill:conv'], 'off')
})

test('ungrouped mcp__ide__* stays on; other ungrouped MCP tools stay off', () => {
  const cfg = mergeDefaults({ groups: { g: ['skill:x'] } })
  const items = [makeItem('tool', 'mcp__ide__getDiagnostics'), makeItem('tool', 'mcp__other__x')]
  const { gate } = decideGate(cfg, sig(), s0, items)
  assert.equal(gate.items['tool:mcp__ide__getDiagnostics'], 'on')
  assert.equal(gate.items['tool:mcp__other__x'], 'off')
})

const hcfg: GateConfig = mergeDefaults({
  groups: { fe: ['skill:react'], be: ['skill:nest'], docs: ['skill:docs'] },
  profiles: { frontend: { groups: ['fe'], when: { paths: ['apps/web/**'] } }, backend: { groups: ['be'], when: { paths: ['apps/api/**'] } } },
})
const hitems = ['react', 'nest', 'docs'].map((n) => makeItem('skill', n))

test('advance: false (recompute in the same turn) moves neither turn nor hysteresis', () => {
  const t1 = decideGate(hcfg, sig({ paths: ['apps/web/a.ts'] }), s0, hitems)
  assert.equal(t1.state.profile, 'frontend')
  const t2 = decideGate(hcfg, sig({ paths: ['apps/api/a.ts'] }), t1.state, hitems)
  assert.deepEqual(t2.state.pending, { profile: 'backend', count: 1 })
  // `/gate +docs` in the same turn: the same signals, no switch, the counter stays at 1/2.
  const again = decideGate(hcfg, sig({ paths: ['apps/api/a.ts'], manual: { add: ['docs'], remove: [] } }), t2.state, hitems, { advance: false })
  assert.equal(again.state.profile, 'frontend')
  assert.equal(again.state.turn, t2.state.turn)
  assert.deepEqual(again.state.pending, { profile: 'backend', count: 1 })
  assert.equal(again.gate.items['skill:docs'], 'on')
  // The next real prompt completes the hysteresis.
  const t3 = decideGate(hcfg, sig({ paths: ['apps/api/a.ts'] }), again.state, hitems)
  assert.equal(t3.state.profile, 'backend')
})

test('advance: false before the first prompt keeps turn 0 (classifier and brief still see the first prompt)', () => {
  const r = decideGate(hcfg, sig(), s0, hitems, { advance: false })
  assert.equal(r.state.turn, 0)
  // A manual profile still applies without a turn.
  const m = decideGate(hcfg, sig({ manual: { profile: 'backend', add: [], remove: [] } }), s0, hitems, { advance: false })
  assert.equal(m.state.profile, 'backend')
  assert.equal(m.state.turn, 0)
})

test('modelAttrs: a model id no `models` glob matches takes its tier from thresholds (G-01)', () => {
  const cfg = mergeDefaults({ tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [], thresholds: { maxContextWindow: 64000 } } } })
  assert.equal(decideGate(cfg, sig({ model: 'gw/custom-small' }), s0, []).gate.tier, 'standard')
  assert.equal(decideGate(cfg, sig({ model: 'gw/custom-small' }), s0, [], { modelAttrs: { contextWindow: 32000 } }).gate.tier, 'quick')
})

test('inherited keys (`/gate +constructor`, classifier `toString`) never throw', () => {
  const cfg = mergeDefaults({ groups: { g: ['skill:x'] }, profiles: { p: { groups: ['g'] } }, classify: { mode: 'auto', minConfidence: 0.5 } })
  const items = [makeItem('skill', 'x')]
  for (const name of ['constructor', 'toString', '__proto__', 'valueOf']) {
    assert.doesNotThrow(() => decideGate(cfg, sig({ manual: { add: [name], remove: [name] } }), s0, items), name)
    assert.doesNotThrow(() => decideGate(cfg, sig({ manual: { profile: name, add: [], remove: [] } }), s0, items), name)
    const c = decideGate(cfg, sig({ classified: { profile: name, confidence: 0.9 } }), s0, items)
    assert.equal(c.gate.profile, undefined, name)
  }
})

test('a declared profile named `c++` is one profile, not a union', () => {
  const cfg = mergeDefaults({ groups: { cpp: ['skill:clang-tidy'] }, profiles: { 'c++': { groups: ['cpp'], when: { paths: ['**/*.cpp'] } } } })
  const { gate } = decideGate(cfg, sig({ paths: ['src/a.cpp'] }), s0, [makeItem('skill', 'clang-tidy')])
  assert.equal(gate.profile, 'c++')
  assert.equal(gate.items['skill:clang-tidy'], 'on')
  assert.deepEqual(profileParts('a+b', cfg), ['a', 'b'])
  assert.deepEqual(profileParts('c++', cfg), ['c++'])
})

test('when.paths: paths outside the repo root are no signal; nocase for Windows', () => {
  const cfg = mergeDefaults({ groups: { j: ['skill:j'] }, profiles: { json: { groups: ['j'], when: { paths: ['**/*.json', 'apps/web/**'] } } } })
  const rows: [string, boolean | undefined, string | undefined][] = [
    ['/home/u/.claude/settings.json', undefined, undefined],
    ['../sibling/package.json', undefined, undefined],
    ['C:/Users/u/x.json', undefined, undefined],
    ['config/x.json', undefined, 'json'],
    ['Apps/Web/src/App.tsx', undefined, undefined],
    ['Apps/Web/src/App.tsx', true, 'json'],
  ]
  for (const [p, nocase, want] of rows) {
    assert.equal(decideGate(cfg, sig({ paths: [p] }), s0, [], nocase ? { nocase } : {}).gate.profile, want, p)
  }
})

test('parseClassify: nested JSON and stray braces before the answer', () => {
  const ps = ['frontend', 'backend']
  const rows: [string, { profile: string; confidence: number } | undefined][] = [
    ['{"profile":"frontend","confidence":0.9,"scores":{"frontend":0.9}}', { profile: 'frontend', confidence: 0.9 }],
    ['I think {frontend} fits. {"profile":"backend","confidence":0.8}', { profile: 'backend', confidence: 0.8 }],
    ['{"note":"a } brace","profile":"frontend","confidence":2}', { profile: 'frontend', confidence: 1 }],
    ['{"profile":"other","confidence":1}', undefined],
    ['no json', undefined],
  ]
  for (const [text, want] of rows) assert.deepEqual(parseClassify(text, ps), want, text)
  // Unbalanced untrusted input is bounded, not O(n²).
  const t0 = Date.now()
  assert.equal(parseClassify('{'.repeat(50_000), ps), undefined)
  assert.equal(parseClassify('{"'.repeat(20_000), ps), undefined)
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`)
})

test('decision log carries ticketId / ticketType for report (сценарій 11)', () => {
  const { log } = decideGate(hcfg, sig({ ticketType: 'bug', ticketId: 'T-1' }), s0, hitems)
  assert.equal(log.data?.ticketType, 'bug')
  assert.equal(log.data?.ticketId, 'T-1')
})
