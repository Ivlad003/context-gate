// `report` aggregates (core report.ts): per-tier attempts and tokens per task, deny → group suggestions,
// runner vs mod by ticketId, skill-render cost and args samples, gate failures from the journal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionLogEntry, GateConfig } from '../packages/core/src/types.ts'
import { compareRunnerMod, denySuggestions, entryTokens, formatTierCosts, gateFailures, skillRenderStats, tierCosts } from '../packages/core/src/report.ts'
import { buildReport, formatReport } from '../packages/cli/src/cmd-report.ts'

let ts = 0
const e = (x: Partial<DecisionLogEntry>): DecisionLogEntry => ({ ts: ++ts, turn: 1, trigger: 'x', tier: 'standard', enabled: [], disabled: [], reason: [], ...x })

const CONFIG: GateConfig = {
  groups: { frontend: ['skill:react-*', 'tool:mcp__figma__*'], backend: ['skill:prisma', 'tool:mcp__postgres__*'] },
  tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [] } },
  models: {},
  profiles: { frontend: { groups: ['frontend'] }, backend: { groups: ['backend'] } },
}

test('tierCosts: attempts, failures and tokens per tier per ticket', () => {
  const log = [
    e({ kind: 'gate-failed', trigger: 'verify', tier: 'quick', turn: 1, data: { adapter: 'shiftwork', ticket: 'f/1', gate: 'verify', passed: false, attempt: 1 } }),
    e({ kind: 'gate-failed', trigger: 'verify', tier: 'quick', turn: 2, data: { adapter: 'shiftwork', ticket: 'f/1', gate: 'verify', passed: false, attempt: 2 } }),
    e({ kind: 'decision', trigger: 'verify', tier: 'standard', turn: 3, data: { adapter: 'shiftwork', ticket: 'f/1', gate: 'verify', passed: true, attempt: 3, tokens: 1200 } }),
    e({ kind: 'debug', trigger: 'verify-failed', tier: 'quick', data: { tool: 'Bash' } }),
    e({ kind: 'debug', trigger: 'turn', tier: 'quick', data: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } } }),
  ]
  const c = tierCosts(log)
  const f1 = c.find((t) => t.task === 'f/1')!
  assert.deepEqual(f1.tiers.map((t) => [t.tier, t.attempts, t.failed, t.passed, t.tokens]), [['quick', 2, 2, 0, 0], ['standard', 1, 0, 1, 1200]])
  const session = c.find((t) => t.task === 'сесія')!
  assert.deepEqual(session.tiers.map((t) => [t.tier, t.attempts, t.tokens]), [['quick', 1, 105]])
  assert.equal(entryTokens(e({ data: { usage: { input_tokens: 1, output_tokens: 2 } } })), 3)
  assert.match(formatTierCosts(c), /\| f\/1 \| quick \| 2 \| 2 \| 0 \| — \|/)
  assert.match(formatTierCosts([]), /ще не було/)
})

test('denySuggestions: repeated denies under one profile → add the enabling group', () => {
  const log = [
    e({ kind: 'decision', trigger: 'when:paths', profile: 'frontend' }),
    ...Array.from({ length: 4 }, () => e({ kind: 'deny', trigger: 'mcp', data: { tool: 'mcp__postgres__query' } })),
    e({ kind: 'deny', trigger: 'skill', data: { skill: 'prisma' } }),
    e({ kind: 'deny', trigger: 'deny', profile: 'frontend', data: { tool: 'tool:mcp__postgres__query', shadow: true } }),
  ]
  const s = denySuggestions(log, CONFIG)
  assert.equal(s.length, 1)
  assert.equal(s[0]!.group, 'backend')
  assert.equal(s[0]!.count, 4)
  assert.equal(s[0]!.text, 'postgres: 4 deny у профілі frontend → додай групу `backend` у `profiles.frontend.groups` (на сесію: /gate +backend)')
  assert.equal(denySuggestions(log, CONFIG, 5).length, 0)
})

test('compareRunnerMod: by ticketId, else by ticket type', () => {
  const log = [
    e({ kind: 'decision', trigger: 'when:ticketType', profile: 'git', data: { adapter: 'shiftwork', ticket: 'f/1', ticketType: 'git' } }),
    e({ kind: 'decision', trigger: 'classify', profile: 'backend', data: { ticketId: 'f/1' } }),
    e({ kind: 'decision', trigger: 'when:ticketType', profile: 'docs', data: { adapter: 'shiftwork', ticket: 'f/2', ticketType: 'docs' } }),
    e({ kind: 'decision', trigger: 'when:ticketType', profile: 'docs', data: { adapter: 'claude-code-hooks', ticketType: 'docs' } }),
    e({ kind: 'decision', trigger: 'when:ticketType', profile: 'x', data: { adapter: 'shiftwork', ticket: 'f/3' } }),
  ]
  assert.deepEqual(compareRunnerMod(log), [
    { ticket: 'f/1', ticketType: 'git', runner: 'git', mod: 'backend', agree: false },
    { ticket: 'f/2', ticketType: 'docs', runner: 'docs', mod: 'docs', agree: true },
  ])
})

test('skillRenderStats and gateFailures', () => {
  const log = [
    e({ kind: 'skill-render', data: { skill: 'pr-review', args: { pr: 1 }, ms: 10, chars: 100, status: 'ok' } }),
    e({ kind: 'skill-render', data: { skill: 'pr-review', args: { pr: 2 }, ms: 30, chars: 300, status: 'unverified' } }),
    e({ kind: 'gate-failed', data: { gate: 'tests' } }),
    e({ kind: 'debug', trigger: 'gate-override', data: { gate: 'tests' } }),
  ]
  assert.deepEqual(skillRenderStats(log), [{ skill: 'pr-review', renders: 2, avgMs: 20, avgChars: 200, failed: 1, args: ['{"pr":1}', '{"pr":2}'] }])
  assert.deepEqual(gateFailures(log), { tests: { blocks: 1, overrides: 1 } })
})

test('formatReport prints suggestions, tier costs, runner vs mod and skill costs', () => {
  const log = [
    e({ kind: 'decision', trigger: 'manual', profile: 'frontend' }),
    ...Array.from({ length: 4 }, () => e({ kind: 'deny', trigger: 'mcp', data: { tool: 'mcp__postgres__query' } })),
    e({ kind: 'gate-failed', trigger: 'gate:commit', tier: 'quick', data: { gate: 'tests' } }),
    e({ kind: 'decision', trigger: 'when:ticketType', profile: 'git', data: { adapter: 'shiftwork', ticket: 'f/1', ticketType: 'git' } }),
    e({ kind: 'decision', trigger: 'classify', profile: 'backend', data: { ticket: 'f/1' } }),
    e({ kind: 'skill-render', data: { skill: 'explain', args: { q: 'a|b' }, ms: 5, chars: 50, status: 'ok' } }),
  ]
  const md = formatReport(buildReport(log, [], undefined, CONFIG))
  assert.match(md, /### Пропозиції\n\n- postgres: 4 deny у профілі frontend → додай групу `backend`/)
  assert.match(md, /## Спроби і токени за tier/)
  assert.match(md, /\| f\/1 \| git \| git \| backend \| \*\*ні\*\* \|/)
  assert.match(md, /Розбіжностей: 1/)
  assert.match(md, /\| explain \| 1 \| 5 \| 50 \| 0 \| `\{"q":"a\\\|b"\}` \|/)
})
