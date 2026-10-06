import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideGate, denyText, skillOffText, statusLine } from '../packages/core/src/decide.ts'
import { mergeDefaults } from '../packages/core/src/config.ts'
import { makeItem } from '../packages/core/src/items.ts'
import type { GateConfig, GateState, Signals } from '../packages/core/src/types.ts'

const cfg: GateConfig = mergeDefaults({
  groups: {
    core: ['skill:tdd'],
    git: ['skill:git-conventions'],
    docs: ['skill:writing-for-agents'],
    frontend: ['skill:react-*', 'skill:tailwind', 'tool:mcp__figma__*', 'agent:ui-reviewer'],
    backend: ['skill:nestjs', 'tool:mcp__postgres__*'],
    always: ['tool:mcp__github__*'],
  },
  tiers: { premium: { groups: ['core'] }, standard: { groups: ['core', 'git'] }, quick: { groups: ['core', 'git', 'docs'], preload: ['project-conventions'] } },
  models: { 'claude-opus-*': 'premium', 'claude-sonnet-*': 'standard', 'claude-haiku-*': 'quick' },
  profiles: {
    frontend: { groups: ['frontend', 'always'], when: { paths: ['apps/web/**', '**/*.tsx'], branch: '^feat/ui' } },
    backend: { groups: ['backend', 'always'], when: { paths: ['apps/api/**', '**/*.service.ts'] } },
    git: { groups: ['git', 'always'], when: { ticketType: ['git'] } },
    docs: { groups: ['docs'], when: { expr: 'ctx.docs == true' } },
  },
  classify: { mode: 'shadow', minConfidence: 0.7 },
})

const items = [
  ...['tdd', 'git-conventions', 'writing-for-agents', 'react-components', 'tailwind', 'nestjs', 'project-conventions', 'random-skill'].map((n) => makeItem('skill', n, { description: n })),
  ...['mcp__figma__get', 'mcp__postgres__query', 'mcp__github__list_prs', 'mcp__other__x', 'Read'].map((n) => makeItem('tool', n)),
  makeItem('agent', 'ui-reviewer'),
  makeItem('agent', 'general-purpose'),
]

const sig = (over: Partial<Signals> = {}): Signals => ({ paths: [], model: 'claude-sonnet-4-5', ...over })
const s0: GateState = { turn: 0 }

test('when:paths → frontend; skills/mcp/agents decisions', () => {
  const { gate, state, log } = decideGate(cfg, sig({ paths: ['apps/web/src/Button.tsx'] }), s0, items)
  assert.equal(gate.profile, 'frontend')
  assert.equal(gate.trigger, 'when:paths')
  assert.equal(gate.tier, 'standard')
  assert.deepEqual(gate.skills.on.sort(), ['git-conventions', 'react-components', 'tailwind', 'tdd'])
  assert.deepEqual(gate.skills.off.sort(), ['nestjs', 'writing-for-agents'])
  assert.deepEqual(gate.skills.nameOnly, ['project-conventions', 'random-skill'], 'ungrouped skills → nameOnly')
  assert.deepEqual(gate.mcp.on.sort(), ['mcp__figma__get', 'mcp__github__list_prs'])
  assert.deepEqual(gate.mcp.off.sort(), ['mcp__other__x', 'mcp__postgres__query'])
  assert.equal(gate.items['tool:Read'], 'on')
  assert.deepEqual(gate.agents, { on: ['ui-reviewer', 'general-purpose'], off: [] })
  assert.equal(state.profile, 'frontend')
  assert.equal(state.turn, 1)
  assert.equal(log.turn, 1)
  assert.ok(log.disabled.includes('tool:mcp__postgres__query'))
  assert.ok(gate.reason.some((r) => r.includes('when:paths')))
})

test('signal kinds: branch, ticketType, expr', () => {
  assert.equal(decideGate(cfg, sig({ branch: 'feat/ui-btn' }), s0, items).gate.trigger, 'when:branch')
  assert.equal(decideGate(cfg, sig({ ticketType: 'git' }), s0, items).gate.profile, 'git')
  const evalExpr = (e: string, d: Record<string, unknown>) => e === 'ctx.docs == true' && d.docs === true
  const r = decideGate(cfg, sig({ data: { docs: true } }), s0, items, { evalExpr })
  assert.equal(r.gate.profile, 'docs')
  assert.equal(r.gate.trigger, 'when:expr')
  assert.equal(decideGate(cfg, sig({ data: { docs: true } }), s0, items).gate.profile, undefined, 'no evaluator → expr ignored')
})

test('union of several matching profiles', () => {
  const { gate } = decideGate(cfg, sig({ paths: ['apps/web/a.tsx', 'apps/api/users.service.ts'] }), s0, items)
  assert.equal(gate.profile, 'frontend+backend')
  assert.ok(gate.skills.on.includes('nestjs') && gate.skills.on.includes('tailwind'))
  assert.ok(gate.mcp.on.includes('mcp__postgres__query'))
})

test('manual profile beats when; /gate +x -y; /gate auto', () => {
  const r = decideGate(cfg, sig({ paths: ['apps/web/a.tsx'], manual: { profile: 'backend', add: [], remove: [] } }), s0, items)
  assert.equal(r.gate.profile, 'backend')
  assert.equal(r.gate.trigger, 'manual')
  assert.equal(r.state.profileSource, 'manual')
  // manual sticks while the signal is present
  const r2 = decideGate(cfg, sig({ paths: ['apps/web/a.tsx'], manual: { profile: 'backend', add: [], remove: [] } }), r.state, items)
  assert.equal(r2.gate.profile, 'backend')
  // `/gate auto` = manual signal removed → recheck: when wins immediately, no hysteresis
  const r3 = decideGate(cfg, sig({ paths: ['apps/web/a.tsx'] }), r2.state, items)
  assert.equal(r3.gate.profile, 'frontend')

  const add = decideGate(cfg, sig({ paths: ['apps/web/a.tsx'], manual: { add: ['docs', 'backend'], remove: ['git'] } }), s0, items)
  assert.equal(add.gate.profile, 'frontend')
  assert.ok(add.gate.skills.on.includes('writing-for-agents'))
  assert.ok(add.gate.skills.on.includes('nestjs'), '+profile adds its groups')
  assert.ok(add.gate.skills.off.includes('git-conventions'))
  assert.ok(add.gate.groups.includes('docs') && !add.gate.groups.includes('git'))
})

test('/gate off → everything on', () => {
  const { gate } = decideGate(cfg, sig({ paths: ['apps/web/a.tsx'], manual: { off: true, add: [], remove: [] } }), s0, items)
  assert.equal(gate.off, true)
  assert.equal(gate.trigger, 'off')
  assert.ok(Object.values(gate.items).every((d) => d === 'on'))
  assert.equal(gate.mcp.off.length, 0)
})

test('hysteresis: a different when profile must hold two turns', () => {
  let r = decideGate(cfg, sig({ paths: ['apps/web/a.tsx'] }), s0, items)
  assert.equal(r.gate.profile, 'frontend')
  r = decideGate(cfg, sig({ paths: ['apps/api/x.ts'] }), r.state, items)
  assert.equal(r.gate.profile, 'frontend', 'one turn is not enough')
  assert.deepEqual(r.state.pending, { profile: 'backend', count: 1 })
  // interruption resets the counter
  const interrupted = decideGate(cfg, sig({ paths: [] }), r.state, items)
  assert.equal(interrupted.state.pending, undefined)
  assert.equal(interrupted.gate.profile, 'frontend', 'no signal → stable')
  r = decideGate(cfg, sig({ paths: ['apps/api/x.ts'] }), r.state, items)
  assert.equal(r.gate.profile, 'backend')
  assert.equal(r.state.pending, undefined)
  assert.equal(r.state.turn, 3)
  // recheck switches immediately
  const re = decideGate(cfg, sig({ paths: ['apps/web/a.tsx'] }), r.state, items, { recheck: true, recheckReason: 'compact' })
  assert.equal(re.gate.profile, 'frontend')
  assert.equal(re.gate.trigger, 'when:paths')
})

test('classifier: shadow records proposal, auto applies above threshold', () => {
  const sh = decideGate(cfg, sig({ classified: { profile: 'backend', confidence: 0.9 } }), s0, items)
  assert.equal(sh.gate.profile, undefined)
  assert.deepEqual(sh.gate.proposed, { profile: 'backend', confidence: 0.9 })
  assert.equal(sh.gate.trigger, 'tier')
  assert.equal(statusLine(sh.gate).startsWith('gate (backend?)'), true)

  const auto: GateConfig = { ...cfg, classify: { mode: 'auto', minConfidence: 0.7 } }
  const ok = decideGate(auto, sig({ classified: { profile: 'backend', confidence: 0.84 } }), s0, items)
  assert.equal(ok.gate.profile, 'backend')
  assert.equal(ok.gate.trigger, 'classify')
  const low = decideGate(auto, sig({ classified: { profile: 'frontend', confidence: 0.62 } }), s0, items)
  assert.equal(low.gate.profile, undefined)
  assert.ok(low.gate.reason.some((r) => r.includes('0.62 < 0.7')))
  // when beats classifier
  const both = decideGate(auto, sig({ paths: ['apps/web/a.tsx'], classified: { profile: 'backend', confidence: 0.99 } }), s0, items)
  assert.equal(both.gate.profile, 'frontend')
  // classifier does not switch an established profile without recheck
  const later = decideGate(auto, sig({ classified: { profile: 'frontend', confidence: 0.99 } }), ok.state, items)
  assert.equal(later.gate.profile, 'backend')
  const rechecked = decideGate(auto, sig({ classified: { profile: 'frontend', confidence: 0.99 } }), ok.state, items, { recheck: true, recheckReason: 'new' })
  assert.equal(rechecked.gate.profile, 'frontend')
})

test('tier from model, preload, fallback to standard with warning, subagent', () => {
  const q = decideGate(cfg, sig({ model: 'claude-haiku-4-5' }), s0, items)
  assert.equal(q.gate.tier, 'quick')
  assert.deepEqual(q.gate.skills.preload, ['project-conventions'])
  assert.equal(q.gate.items['skill:project-conventions'], 'preload')
  assert.ok(q.gate.skills.on.includes('writing-for-agents'))
  assert.ok(q.gate.skills.off.includes('react-components'), 'no profile → tier set only')

  const unk = decideGate(cfg, sig({ model: 'mystery-model' }), s0, items)
  assert.equal(unk.gate.tier, 'standard')
  assert.equal(unk.gate.trigger, 'default')
  assert.ok(unk.gate.reason.some((r) => r.includes('попередження')))

  const sub = decideGate(cfg, sig({ model: 'claude-opus-4-5', agentId: 'agent-7' }), s0, items)
  assert.equal(sub.gate.tier, 'premium')
  assert.ok(sub.gate.reason[0].startsWith('субагент agent-7'))

  const mc = decideGate(cfg, sig({ model: 'claude-haiku-4-5' }), s0, items, { prevModel: 'claude-sonnet-4-5' })
  assert.equal(mc.gate.trigger, 'model-change')
})

test('legacy config is normalised on the fly', () => {
  const legacy = mergeDefaults({
    skillGroups: { fe: ['react-*'] },
    mcpGroups: { fe: ['figma'] },
    profiles: { fe: { skills: ['fe'], mcp: ['fe'], when: { paths: ['**/*.tsx'] } } },
  } as Partial<GateConfig>)
  const { gate } = decideGate(legacy, sig({ paths: ['a.tsx'] }), s0, items)
  assert.equal(gate.profile, 'fe')
  assert.ok(gate.mcp.on.includes('mcp__figma__get'))
  assert.ok(gate.skills.on.includes('react-components'))
})

test('no groups at all → everything on', () => {
  const { gate } = decideGate(mergeDefaults({}), sig(), s0, items)
  assert.ok(Object.values(gate.items).every((d) => d === 'on'))
})

test('deny texts', () => {
  const { gate } = decideGate(cfg, sig({ paths: ['apps/web/a.tsx'] }), s0, items)
  assert.equal(denyText('tool', 'mcp__postgres__query', gate, cfg), 'postgres вимкнено профілем frontend. Користувач може увімкнути: /gate +backend')
  assert.equal(denyText('tool', 'mcp__other__x', gate, cfg), 'other вимкнено профілем frontend. Користувач може увімкнути: /gate off')
  assert.equal(skillOffText('nestjs', gate, cfg), 'Skill nestjs вимкнено профілем frontend. Увімкни: /gate +backend')
  assert.match(statusLine(gate, { ctxPct: 38.2 }), /^gate frontend · tier standard · skills 4\/8 · mcp 2\/4 · rules 0 · ctx 38%$/)
})

test('decideGate opts.tier forces the tier regardless of the model', () => {
  const cfg = mergeDefaults({})
  const { gate } = decideGate(cfg, { paths: [], model: 'claude-opus-4-5' }, { turn: 0 }, [], { tier: 'quick' })
  assert.equal(gate.tier, 'quick')
  assert.ok(gate.reason.some((r) => r.includes('tier quick задано явно')))
  assert.equal(decideGate(cfg, { paths: [], model: 'claude-opus-4-5' }, { turn: 0 }, []).gate.tier, 'premium')
})

test('statusLine in shadow: nothing filtered → all/all counts, proposal with ?', () => {
  const items = [makeItem('skill', 'tdd'), makeItem('skill', 'nestjs'), makeItem('skill', 'react-hooks'), makeItem('tool', 'mcp__figma__get', { mcp: true } as never)]
  const { gate } = decideGate(cfg, { paths: [], manual: { profile: 'backend', add: [], remove: [] } }, { turn: 0 }, items)
  assert.match(statusLine(gate), /^gate backend · tier \w+ · skills (\d+)\/3/)
  assert.notEqual(statusLine(gate).match(/skills (\d+)\/3/)![1], '3')
  const { profile, ...rest } = gate
  const shadow = { ...rest, profile: undefined, shadow: true, proposed: { profile: profile!, confidence: 0.9 } }
  assert.match(statusLine(shadow), /^gate \(backend\?\) · tier \w+ · skills 3\/3 · mcp (\d+)\/\1 · rules \d+$/)
})
