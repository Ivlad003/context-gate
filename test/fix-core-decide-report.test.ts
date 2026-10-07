// Regressions from the 2026-10-06 review, core journal aggregates: shadow agreement (M2), tier attempts (L62),
// stale deny profile (L63), verify rows in /gate why (L51), observe counts (L59), env in the index (M04).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { denySuggestions, shadowAgreement, tierCosts } from '../packages/core/src/report.ts'
import { formatWhy } from '../packages/core/src/journal.ts'
import { observeCounts } from '../packages/core/src/pipeline.ts'
import { varsOf } from '../packages/core/src/gateindex.ts'
import type { DecisionLogEntry } from '../packages/core/src/types.ts'

const e = (over: Partial<DecisionLogEntry> & { kind?: string }): DecisionLogEntry => ({ ts: 0, turn: 1, trigger: 'tier', tier: 'standard', enabled: [], disabled: [], reason: [], ...over } as DecisionLogEntry)

test('shadowAgreement: shadow decisions (no profile) are measured against labels and manual choices', () => {
  const shadow = (profile: string, turn: number) => e({ kind: 'decision', turn, trigger: 'when:paths', data: { shadow: true, proposed: { profile, confidence: 1 } } })
  const entries = [
    shadow('frontend', 1), e({ kind: 'label' as DecisionLogEntry['kind'], data: { correct: true } }),
    shadow('backend', 2), e({ kind: 'decision', turn: 2, trigger: 'manual', profile: 'frontend' }),
    shadow('docs', 3), e({ kind: 'label' as DecisionLogEntry['kind'], data: { profile: 'docs+backend' } }),
    shadow('frontend', 4),
    // Apply mode: the decision's own profile is the reference (the legacy fixture shape).
    e({ kind: 'decision', turn: 5, trigger: 'classify', profile: 'backend', data: { proposed: { profile: 'backend', confidence: 0.9 } } }),
  ]
  assert.deepEqual(shadowAgreement(entries), { proposed: 5, labeled: 4, matched: 3, differed: 1, unlabeled: 1, rate: 0.75 })
  assert.equal(shadowAgreement([shadow('x', 1)]).rate, undefined)
  // A shadow proposal logged next to a `when` profile it did not influence (no data.shadow, as the hooks adapter logs it):
  // no reference, so unlabeled — not a mismatch against the `when` profile.
  const whenRow = e({ kind: 'decision', trigger: 'when:paths', profile: 'fe', data: { proposed: { profile: 'be', confidence: 0.9 } } })
  assert.deepEqual(shadowAgreement([whenRow]), { proposed: 1, labeled: 0, matched: 0, differed: 0, unlabeled: 1 })
})

test('tierCosts: gate-attempt pass/block are attempts; the gate-failed twin of a block counts once', () => {
  const entries = [
    e({ kind: 'gate-attempt', trigger: 'gate:write', data: { gate: 'lint', outcome: 'pass' } }),
    e({ kind: 'gate-attempt', trigger: 'gate:write', data: { gate: 'lint', outcome: 'pass' } }),
    e({ kind: 'gate-attempt', trigger: 'gate:write', data: { gate: 'lint', outcome: 'block' } }),
    e({ kind: 'gate-failed', trigger: 'gate:write', data: { gate: 'lint' } }),
    e({ kind: 'gate-attempt', trigger: 'gate:write', data: { gate: 'lint', outcome: 'skip' } }),
    e({ kind: 'gate-failed', trigger: 'verify', data: { gate: 'verify', passed: false } }),
  ]
  assert.deepEqual(tierCosts(entries), [{ task: 'сесія', tiers: [{ tier: 'standard', attempts: 4, failed: 2, passed: 2, turns: 1, tokens: 0 }] }])
})

test('denySuggestions: a decision without a profile resets the running profile', () => {
  const deny = () => e({ kind: 'deny', trigger: 'tool', data: { tool: 'mcp__pg__query' } })
  const entries = [e({ kind: 'decision', profile: 'frontend' }), e({ kind: 'decision' }), deny(), deny(), deny(), deny()]
  assert.deepEqual(denySuggestions(entries, undefined), [])
  const withProfile = [e({ kind: 'decision', profile: 'frontend' }), deny(), deny(), deny(), deny()]
  assert.equal(denySuggestions(withProfile, undefined)[0]?.profile, 'frontend')
})

test('formatWhy: a shiftwork verify pass is not a decision row', () => {
  const d = (turn: number) => e({ kind: 'decision', turn, profile: 'fe', enabled: ['skill:a', 'skill:b'] })
  const out = formatWhy([d(1), e({ kind: 'decision', turn: 2, trigger: 'verify', data: { gate: 'verify', passed: true } }), d(3)])
  assert.ok(!/\| verify \|/.test(out), out)
  assert.ok(!/\+a/.test(out), out)
})

test('observeCounts: the mod’s skill denies count; shadow denies do not', () => {
  const c = observeCounts([
    e({ kind: 'deny', trigger: 'skill', data: { skill: 'tdd' } }),
    e({ kind: 'deny', trigger: 'tool', data: { tool: 'mcp__pg__query', shadow: true } }),
    e({ kind: 'deny', trigger: 'tool', data: { tool: 'mcp__gh__x' } }),
  ])
  assert.equal(c.get('skill:tdd')?.denied, 1)
  assert.equal(c.get('tool:mcp__pg__query'), undefined)
  assert.equal(c.get('tool:mcp__gh__x')?.denied, 1)
})

test('varsOf: env values never reach the index (top level and under providers)', () => {
  const v = varsOf({ env: { GITHUB_TOKEN: 'ghp_secret', CI: 'true' }, providers: { env: { NPM_TOKEN: 'npm_x' }, pkg: { name: 'p' } }, git: { branch: 'main' } })
  assert.deepEqual(v.env, { type: 'object', value: { GITHUB_TOKEN: '***', CI: '***' } })
  assert.ok(!JSON.stringify(v).includes('ghp_secret') && !JSON.stringify(v).includes('npm_x'))
  assert.deepEqual((v.git as { value: unknown }).value, { branch: 'main' })
})
