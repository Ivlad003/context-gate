import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decisionEvent, escalationEvent, escalationsSince, formatEvents, nextTier, planForTicket, profileForTicketType, shiftworkModelId, skillAdjustments, tierOf, verifyEvent, verifyFirstTry } from '../packages/hooks-adapter/src/shiftwork.ts'
import { loadConfig, mergeDefaults } from '../packages/core/src/config.ts'
import { fromJsonl } from '../packages/core/src/journal.ts'
import { makeItem } from '../packages/core/src/items.ts'
import type { DecisionLogEntry, GateConfig } from '../packages/core/src/types.ts'

const cfg: GateConfig = mergeDefaults({
  groups: {
    core: ['skill:tdd'],
    git: ['skill:git-conventions'],
    frontend: ['skill:react-*', 'tool:mcp__figma__*'],
    backend: ['skill:nestjs', 'tool:mcp__postgres__*'],
    docs: ['skill:writing-for-agents'],
  },
  tiers: { premium: { groups: ['core'] }, standard: { groups: ['core', 'git'] }, quick: { groups: ['core', 'git', 'docs'], preload: ['tdd'] } },
  models: { 'claude-opus-*': 'premium', 'claude-sonnet-*': 'standard', 'claude-haiku-*': 'quick' },
  profiles: {
    frontend: { groups: ['frontend'], when: { ticketType: ['ui', 'frontend'] } },
    backend: { groups: ['backend'], when: { ticketType: ['api'] } },
    infra: { groups: ['backend'], when: { ticketType: ['api'] } },
    docs: { groups: ['docs'] },
  },
  escalation: { order: ['quick', 'standard', 'premium'], after: { verifyFailed: 2, stallTurns: 6 } },
})

const items = [
  makeItem('skill', 'tdd', { body: 'Тест першим.', provenance: { source: 'claude-skills', path: '.claude/skills/tdd/SKILL.md' } }),
  makeItem('skill', 'git-conventions', { provenance: { source: 'claude-skills', path: '/home/u/.claude/skills/git-conventions/SKILL.md' } }),
  makeItem('skill', 'react-components', { provenance: { source: 'claude-skills', path: '.claude/skills/react-components/SKILL.md' } }),
  makeItem('skill', 'nestjs', { description: 'nest' }),
  makeItem('skill', 'writing-for-agents', { description: 'docs' }),
  makeItem('skill', 'misc', { description: 'misc' }),
  makeItem('tool', 'mcp__figma__get'),
  makeItem('tool', 'mcp__postgres__query'),
]

test('shiftworkModelId strips backend and provider prefixes', () => {
  const cases: [string | undefined, string | undefined][] = [
    ['claude:claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['anthropic/claude-haiku-4-5', 'claude-haiku-4-5'],
    ['pi:anthropic/claude-opus-4-7', 'claude-opus-4-7'],
    ['claude-opus-4-7', 'claude-opus-4-7'],
    [undefined, undefined],
  ]
  for (const [i, o] of cases) assert.equal(shiftworkModelId(i), o, String(i))
  assert.equal(tierOf(cfg, 'claude:claude-haiku-4-5').tier, 'quick')
})

test('skillAdjustments parses the ticket Skills line', () => {
  assert.deepEqual(skillAdjustments('+frontend -git docs'), { add: ['frontend', 'docs'], remove: ['git'] })
  assert.deepEqual(skillAdjustments(['`+a`', '-b']), { add: ['a'], remove: ['b'] })
  assert.deepEqual(skillAdjustments(undefined), { add: [], remove: [] })
})

test('profileForTicketType: when.ticketType (union), then same name, else none', () => {
  const cases: [string | undefined, string | undefined, string | undefined][] = [
    ['ui', 'frontend', 'when:ticketType'],
    ['api', 'backend+infra', 'when:ticketType'],
    ['docs', 'docs', 'name'],
    ['code', undefined, undefined],
    [undefined, undefined, undefined],
  ]
  for (const [t, p, via] of cases) {
    const r = profileForTicketType(cfg, t)
    assert.equal(r.profile, p, String(t))
    assert.equal(r.via, via, String(t))
  }
})

test('planForTicket: table of Type × Model', () => {
  const cases: { type?: string; model?: string; skills?: string; profile?: string; tier: string; has: string[]; not: string[]; preload: string[]; mcpOff: string[] }[] = [
    { type: 'ui', model: 'claude:claude-sonnet-4-6', profile: 'frontend', tier: 'standard', has: ['tdd', 'git-conventions', 'react-components'], not: ['nestjs'], preload: [], mcpOff: ['mcp__postgres__query'] },
    { type: 'api', model: 'claude:claude-haiku-4-5', profile: 'backend+infra', tier: 'quick', has: ['nestjs', 'tdd', 'writing-for-agents'], not: ['react-components'], preload: ['tdd'], mcpOff: ['mcp__figma__get'] },
    { type: 'code', model: 'claude-opus-4-7', profile: undefined, tier: 'premium', has: ['tdd'], not: ['git-conventions', 'react-components'], preload: [], mcpOff: ['mcp__figma__get', 'mcp__postgres__query'] },
    { type: 'ui', model: 'claude-opus-4-7', skills: '+git -frontend', profile: 'frontend', tier: 'premium', has: ['tdd', 'git-conventions'], not: ['react-components'], preload: [], mcpOff: ['mcp__figma__get', 'mcp__postgres__query'] },
  ]
  for (const c of cases) {
    const p = planForTicket(cfg, { ticketType: c.type, model: c.model, skills: c.skills, items })
    const label = `${c.type} ${c.model} ${c.skills ?? ''}`
    assert.equal(p.profile, c.profile, label)
    assert.equal(p.tier, c.tier, label)
    for (const s of c.has) assert.ok(p.skills.includes(s), `${label}: has ${s}`)
    for (const s of c.not) assert.ok(!p.skills.includes(s), `${label}: not ${s}`)
    assert.deepEqual(p.preload, c.preload, label)
    assert.deepEqual(p.mcpOff.sort(), c.mcpOff.sort(), label)
    for (const s of c.not) assert.ok(p.settings.skillOverrides[s] === 'off' || p.settings.skillOverrides[s] === 'name-only', `${label}: override ${s}`)
  }
})

test('planForTicket: appendSystemPrompt, symlinks, env, log', () => {
  const p = planForTicket(cfg, { ticketType: 'ui', model: 'claude:claude-haiku-4-5', items }, 42)
  assert.equal(p.appendSystemPrompt, '<!-- Preloaded skill: .claude/skills/tdd/SKILL.md -->\nТест першим.')
  assert.ok(p.pluginDirSymlinks.includes('.claude/skills/tdd'))
  assert.ok(p.pluginDirSymlinks.includes('/home/u/.claude/skills/git-conventions'))
  assert.deepEqual(p.env, { CONTEXT_GATE_PROFILE: 'frontend', CONTEXT_GATE_TICKET_TYPE: 'ui', CONTEXT_GATE_MODEL: 'claude-haiku-4-5' })
  assert.equal(p.settings.skillOverrides.misc, 'name-only')
  assert.equal(p.log.kind, 'decision')
  assert.equal(p.log.trigger, 'when:ticketType')
  assert.equal(p.log.ts, 42)
  assert.match(p.log.reason[0], /тип тікета ui → профіль frontend/)
  const d = decisionEvent(p, { ts: 100, turn: 2, ticket: 'feat/03' })
  assert.equal(d.ts, 100)
  assert.equal(d.turn, 2)
  assert.equal(d.data?.ticket, 'feat/03')
})

test('planForTicket reads the shared example gate.json (legacy skillGroups format)', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'examples', 'basic', '.claude', 'gate.json'), 'utf8')
  const { config } = loadConfig(text)
  assert.ok(config)
  const p = planForTicket(config!, { ticketType: 'git', model: 'claude:claude-haiku-4-5', items: [makeItem('skill', 'git-conventions'), makeItem('skill', 'project-conventions', { body: 'conv' }), makeItem('skill', 'react-components')] })
  assert.equal(p.profile, 'git')
  assert.equal(p.tier, 'quick')
  assert.ok(p.skills.includes('git-conventions'))
  assert.deepEqual(p.preload, ['project-conventions'])
  assert.ok(p.appendSystemPrompt.includes('conv'))
})

test('escalation and verify events round-trip through JSONL', () => {
  assert.equal(nextTier(cfg, 'quick'), 'standard')
  assert.equal(nextTier(cfg, 'premium'), undefined)
  const base = { ts: 10, turn: 3, tier: 'quick', profile: 'frontend', ticket: 'f/01' }
  assert.equal(escalationEvent(cfg, base, { verifyFailed: 1 }), undefined)
  const esc = escalationEvent(cfg, base, { verifyFailed: 2 })!
  assert.equal(esc.kind, 'escalation-suggested')
  assert.equal(esc.data?.to, 'standard')
  assert.match(esc.reason[0], /2 невдалі перевірки на quick — перейди на standard/)
  const top = escalationEvent(cfg, { ...base, tier: 'premium' }, { stallTurns: 7 })!
  assert.match(top.reason[0], /вищого tier немає/)

  const fail = verifyEvent(base, { passed: false, attempt: 1, exitCode: 1, command: 'npm test' })
  const pass = verifyEvent({ ...base, ts: 20 }, { passed: true, attempt: 2 })
  assert.equal(fail.kind, 'gate-failed')
  assert.equal(pass.kind, 'decision')

  const text = formatEvents([fail, esc, pass])
  assert.equal(text.split('\n').filter(Boolean).length, 3)
  const back = fromJsonl<DecisionLogEntry>(text)
  assert.equal(back.bad, 0)
  assert.deepEqual(back.items[1], esc)
  assert.deepEqual(escalationsSince(back.items, 5, 'f/01'), [esc])
  assert.deepEqual(escalationsSince(back.items, 10), [])
})

test('verifyFirstTry counts the first verify event per ticket', () => {
  const b = (ticket: string, ts: number) => ({ ts, turn: 1, tier: 'quick', ticket })
  const entries = [
    verifyEvent(b('a', 1), { passed: true, attempt: 1 }),
    verifyEvent(b('b', 2), { passed: false, attempt: 1 }),
    verifyEvent(b('b', 3), { passed: true, attempt: 2 }),
    verifyEvent(b('c', 4), { passed: true, attempt: 1 }),
  ]
  assert.deepEqual(verifyFirstTry(entries), { tickets: 3, firstTry: 2, rate: 2 / 3 })
  assert.deepEqual(verifyFirstTry([]), { tickets: 0, firstTry: 0, rate: undefined })
})
