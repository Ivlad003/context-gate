import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ADDITIONAL_CONTEXT_LIMIT, handleHook, newState, packWithin, reviveState, type HookContext, type HookInput, type SessionState } from '../packages/hooks-adapter/src/handle.ts'
import { hookCommand, hookEntries, installGate, mergeSettings, skillOverridesFor, unmergeSettings, HOOK_MARKER } from '../packages/hooks-adapter/src/install.ts'
import { runHook } from '../packages/hooks-adapter/src/main.ts'
import { parseMdc } from '../packages/core/src/mdc.ts'
import { mergeDefaults } from '../packages/core/src/config.ts'
import { makeItem } from '../packages/core/src/items.ts'
import type { GateConfig, MdcRule } from '../packages/core/src/types.ts'

const rule = (id: string, text: string): MdcRule => parseMdc(text, { path: `.cursor/rules/${id}.mdc`, id }).rule

const rules: MdcRule[] = [
  rule('project', '---\nalwaysApply: true\n---\nМонорепозиторій на pnpm.'),
  rule('react', '---\nglobs: **/*.tsx\n---\nКомпоненти — функції.'),
  rule('api', '---\nglobs: apps/api/**, !apps/api/legacy/**\n---\nREST: kebab-case.'),
  rule('release', 'Реліз: оновити CHANGELOG.'),
  rule('agentish', '---\ndescription: коли пишеш міграції\n---\nМіграції незворотні.'),
]

const cfg: GateConfig = mergeDefaults({
  groups: {
    core: ['skill:tdd'],
    frontend: ['skill:react-*', 'tool:mcp__figma__*'],
    backend: ['skill:nestjs', 'tool:mcp__postgres__*'],
    always: ['tool:mcp__github__*'],
  },
  tiers: { premium: { groups: ['core'] }, standard: { groups: ['core'] }, quick: { groups: ['core'], preload: ['tdd'] } },
  models: { 'claude-opus-*': 'premium', 'claude-sonnet-*': 'standard', 'claude-haiku-*': 'quick' },
  profiles: {
    frontend: { groups: ['frontend', 'always'], when: { paths: ['apps/web/**'] } },
    backend: { groups: ['backend', 'always'], when: { paths: ['apps/api/**'], ticketType: ['api'] } },
  },
  gates: [{ name: 'read-before-write', on: 'write', builtin: true, tiers: ['quick', 'standard'] }],
  cursorRules: { enabled: true, strictWrite: true },
})

const items = [
  makeItem('skill', 'tdd', { body: 'Пиши тест першим.', provenance: { source: 'claude-skills', path: '.claude/skills/tdd/SKILL.md' } }),
  makeItem('skill', 'react-components', { description: 'react' }),
  makeItem('skill', 'nestjs', { description: 'nest' }),
  makeItem('skill', 'misc', { description: 'misc' }),
]

function ctx(over: Partial<HookContext> = {}, existing: string[] = ['src/a.ts', 'apps/web/x.tsx']): HookContext {
  return { root: '/repo', config: cfg, rules, items, env: {}, now: 1000, exists: (p) => existing.includes(p), ...over }
}

const ev = (e: Partial<HookInput> & { hook_event_name: string }): HookInput => ({ session_id: 's', cwd: '/repo', ...e })

function run(events: HookInput[], c: HookContext = ctx(), state: SessionState = newState()) {
  const outs = []
  let s = state
  const logs = []
  for (const e of events) {
    const r = handleHook(e, c, s)
    s = r.state
    outs.push(r.output)
    logs.push(...r.log)
  }
  return { outs, state: s, logs }
}

const ctxText = (o: unknown): string => ((o as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? '')
const decision = (o: unknown): string | undefined => (o as { hookSpecificOutput?: { permissionDecision?: string } })?.hookSpecificOutput?.permissionDecision

test('SessionStart injects Always rules and preload for the quick tier', () => {
  const { outs, state, logs } = run([ev({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-haiku-4-5' })], ctx({ env: { CONTEXT_GATE_MODE: 'auto' } }))
  const t = ctxText(outs[0])
  assert.match(t, /Contents of \.cursor\/rules\/project\.mdc \(Cursor rule project\):\nМонорепозиторій/)
  assert.match(t, /Preloaded skill tdd/)
  assert.ok(!t.includes('Компоненти'))
  assert.deepEqual(state.seen, ['main:project'])
  assert.equal(state.model, 'claude-haiku-4-5')
  assert.equal(logs[0].kind, 'decision')
  assert.equal(logs[0].tier, 'quick')
  assert.ok(logs.some((l) => l.kind === 'rule-delivered'))
})

test('SessionStart clear/compact resets dedup; startup keeps it', () => {
  const s = { ...newState(), seen: ['main:project', 'main:react'], read: ['src/a.ts'] }
  for (const [source, seenAfter, readAfter] of [['startup', 3, 1], ['compact', 1, 1], ['clear', 1, 0]] as const) {
    const r = handleHook(ev({ hook_event_name: 'SessionStart', source }), ctx(), s)
    assert.equal(r.state.seen.length, source === 'startup' ? 2 : seenAfter, source)
    assert.equal(r.state.read.length, readAfter, source)
  }
})

test('PostToolUse delivers Auto Attached rules once per session and agent', () => {
  const read = (p: string, agent?: string) => ev({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: `/repo/${p}` }, ...(agent ? { agent_id: agent } : {}) })
  const { outs, logs } = run([read('apps/web/x.tsx'), read('apps/web/y.tsx'), read('apps/web/z.tsx', 'sub1'), read('apps/api/legacy/old.ts'), read('apps/api/users.ts')])
  assert.match(ctxText(outs[0]), /Cursor rule react/)
  assert.equal(outs[1], undefined)
  assert.match(ctxText(outs[2]), /Cursor rule react/)
  assert.equal(outs[3], undefined, 'negated glob')
  assert.match(ctxText(outs[4]), /REST: kebab-case/)
  assert.equal(logs.filter((l) => l.kind === 'rule-delivered').length, 3)
})

test('PostToolUse: a full Read of the .mdc itself counts as delivery, a partial one does not', () => {
  const mdc = (input: Record<string, unknown>) => ev({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/.cursor/rules/react.mdc', ...input } })
  const partial = run([mdc({ limit: 5 })])
  assert.ok(!partial.state.seen.includes('main:react'))
  const full = run([mdc({})])
  assert.ok(full.state.seen.includes('main:react'))
})

test('NotebookEdit reads notebook_path', () => {
  const { outs } = run([ev({ hook_event_name: 'PostToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: '/repo/apps/web/n.tsx', new_source: '' } })])
  assert.match(ctxText(outs[0]), /Cursor rule react/)
})

test('UserPromptSubmit: @rule, /rule, @file and unknown /rule', () => {
  const cases: { prompt: string; has: RegExp[]; not?: RegExp[] }[] = [
    { prompt: 'зроби реліз @release', has: [/Cursor rule release/] },
    { prompt: '/rule release', has: [/Cursor rule release/] },
    { prompt: 'подивись @apps/web/x.tsx', has: [/Cursor rule react/] },
    { prompt: '/rule nope', has: [/правило nope не знайдено/] },
    { prompt: 'просто текст', has: [], not: [/Cursor rule/] },
  ]
  for (const c of cases) {
    const { outs } = run([ev({ hook_event_name: 'UserPromptSubmit', prompt: c.prompt })])
    const t = ctxText(outs[0])
    for (const re of c.has) assert.match(t, re, c.prompt)
    for (const re of c.not ?? []) assert.doesNotMatch(t, re, c.prompt)
  }
})

test('UserPromptSubmit: @rule is deduplicated, /rule re-sends', () => {
  const { outs } = run([
    ev({ hook_event_name: 'UserPromptSubmit', prompt: '@release' }),
    ev({ hook_event_name: 'UserPromptSubmit', prompt: '@release' }),
    ev({ hook_event_name: 'UserPromptSubmit', prompt: '/rule release' }),
  ])
  assert.match(ctxText(outs[0]), /release/)
  assert.equal(outs[1], undefined)
  assert.match(ctxText(outs[2]), /release/)
})

test('PreToolUse mcp__: shadow logs only, [gate:x] / env profile / mode auto deny', () => {
  const call = ev({ hook_event_name: 'PreToolUse', tool_name: 'mcp__postgres__query', tool_input: {} })
  const shadow = run([ev({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), call])
  assert.equal(shadow.outs[1], undefined)
  assert.ok(shadow.logs.some((l) => l.kind === 'deny' && l.data?.shadow === true))

  const flagged = run([ev({ hook_event_name: 'UserPromptSubmit', prompt: '[gate:frontend] fix button' }), call])
  assert.equal(decision(flagged.outs[1]), 'deny')
  const reason = (flagged.outs[1] as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason
  assert.match(reason, /postgres вимкнено профілем frontend/)
  assert.match(reason, /\[gate:backend\]/)

  const env = run([call], ctx({ env: { CONTEXT_GATE_PROFILE: 'frontend' } }))
  assert.equal(decision(env.outs[0]), 'deny')
  const allowed = run([ev({ hook_event_name: 'PreToolUse', tool_name: 'mcp__github__list', tool_input: {} })], ctx({ env: { CONTEXT_GATE_PROFILE: 'frontend' } }))
  assert.equal(allowed.outs[0], undefined)

  const auto = run([ev({ hook_event_name: 'UserPromptSubmit', prompt: 'look at @apps/web/x.tsx' }), call], ctx({ env: { CONTEXT_GATE_MODE: 'auto' } }))
  assert.equal(decision(auto.outs[1]), 'deny')

  const off = run([ev({ hook_event_name: 'UserPromptSubmit', prompt: '[gate:off] go' }), call], ctx({ env: { CONTEXT_GATE_MODE: 'auto' } }))
  assert.equal(off.outs[1], undefined)

  const own = run([ev({ hook_event_name: 'PreToolUse', tool_name: 'mcp__context-gate__get_x', tool_input: {} })], ctx({ env: { CONTEXT_GATE_PROFILE: 'frontend' } }))
  assert.equal(own.outs[0], undefined)
})

test('PreToolUse: ticket type via env selects the profile', () => {
  const c = ctx({ env: { CONTEXT_GATE_TICKET_TYPE: 'api', CONTEXT_GATE_MODE: 'auto' } })
  const { outs, state } = run([ev({ hook_event_name: 'SessionStart', source: 'startup' }), ev({ hook_event_name: 'PreToolUse', tool_name: 'mcp__figma__get', tool_input: {} })], c)
  assert.equal(state.gate.profile, 'backend')
  assert.equal(decision(outs[1]), 'deny')
})

test('read-before-write gate by tier', () => {
  const edit = ev({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } })
  const readA = ev({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/src/a.ts' } })
  const cases: { model: string; events: HookInput[]; deny: boolean }[] = [
    { model: 'claude-haiku-4-5', events: [edit], deny: true },
    { model: 'claude-sonnet-4-6', events: [edit], deny: true },
    { model: 'claude-opus-4-7', events: [edit], deny: false },
    { model: 'claude-haiku-4-5', events: [readA, edit], deny: false },
  ]
  for (const c of cases) {
    const r = run(c.events, ctx({ env: { CONTEXT_GATE_MODEL: c.model } }))
    assert.equal(decision(r.outs.at(-1)) === 'deny', c.deny, `${c.model} ${c.events.length}`)
    if (c.deny) assert.ok(r.logs.some((l) => l.kind === 'gate-failed' && l.trigger === 'read-before-write'))
  }
  // A new file can be written without a Read.
  const fresh = run([ev({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/src/new.ts', content: '' } })], ctx({ env: { CONTEXT_GATE_MODEL: 'claude-haiku-4-5' } }))
  assert.equal(fresh.outs[0], undefined)
})

test('strictWrite: Write of a new file with an undelivered Auto rule is denied once with the rule text', () => {
  const write = ev({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/apps/web/new.tsx', content: 'x' } })
  const { outs } = run([write, write])
  assert.equal(decision(outs[0]), 'deny')
  assert.match((outs[0] as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason, /Компоненти — функції[\s\S]*Повтори запис/)
  assert.equal(outs[1], undefined)
})

test('packWithin respects the additionalContext limit with pointer lines', () => {
  const big = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, path: `.cursor/rules/r${i}.mdc`, body: 'x'.repeat(3000) }))
  const p = packWithin(big, ADDITIONAL_CONTEXT_LIMIT)
  assert.ok(p.text.length <= ADDITIONAL_CONTEXT_LIMIT)
  assert.equal(p.included.length, 3)
  assert.equal(p.deferred.length, 3)
  assert.match(p.text, /також діє: \.cursor\/rules\/r5\.mdc/)
  const small = packWithin(big, 10_000, 4000)
  assert.equal(small.included.length, 1)
})

test('reviveState tolerates garbage', () => {
  for (const raw of [undefined, null, 1, 'x', { v: 2 }, { v: 1, seen: 'bad' }]) {
    const s = reviveState(raw)
    assert.equal(s.v, 1)
    assert.ok(Array.isArray(s.seen))
  }
})

// ───────────────────────── install ─────────────────────────

test('mergeSettings is idempotent and keeps foreign hooks and overrides', () => {
  const cmd = hookCommand('/opt/cg/dist/hooks-adapter.js')
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'echo hi' }] }
  const existing = { model: 'opus', hooks: { PreToolUse: [foreign] }, skillOverrides: { other: 'off' as const, misc: 'off' as const } }
  const once = mergeSettings(existing, { hooks: hookEntries(cmd), skillOverrides: { nestjs: 'name-only' }, managedSkills: ['misc', 'nestjs'] })
  const twice = mergeSettings(once, { hooks: hookEntries(cmd), skillOverrides: { nestjs: 'name-only' }, managedSkills: ['misc', 'nestjs'] })
  assert.deepEqual(twice, once)
  assert.equal(once.model, 'opus')
  assert.equal(once.hooks!.PreToolUse.length, 2)
  assert.deepEqual(once.hooks!.PreToolUse[0], foreign)
  assert.equal(once.hooks!.PostToolUse[0].matcher, 'Read|Edit|Write|NotebookEdit')
  assert.deepEqual(once.skillOverrides, { other: 'off', nestjs: 'name-only' })
  const un = unmergeSettings(once, ['nestjs'])
  assert.deepEqual(un.hooks, { PreToolUse: [foreign] })
  assert.deepEqual(un.skillOverrides, { other: 'off' })
  assert.ok(cmd.includes(HOOK_MARKER))
  assert.equal(hookCommand('/a b/hooks-adapter.js'), "node '/a b/hooks-adapter.js'")
})

test('installGate + skillOverridesFor by profile and tier', () => {
  const g = installGate(cfg, items, { profile: 'frontend', tier: 'standard' })
  assert.equal(g.tier, 'standard')
  assert.deepEqual(skillOverridesFor(g), { nestjs: 'user-invocable-only', misc: 'name-only' })
  assert.deepEqual(skillOverridesFor(g, { hard: true }), { nestjs: 'off', misc: 'name-only' })
  const q = installGate(cfg, items, { model: 'claude-haiku-4-5' })
  assert.equal(q.tier, 'quick')
  assert.deepEqual(q.skills.preload, ['tdd'])
})

// ───────────────────────── end to end on disk ─────────────────────────

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cg-hooks-'))
  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true })
  mkdirSync(join(root, '.claude', 'skills', 'tdd'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, '.cursor', 'rules', 'project.mdc'), '---\nalwaysApply: true\n---\nЗавжди pnpm.\n')
  writeFileSync(join(root, '.cursor', 'rules', 'ts.mdc'), '---\nglobs: *.ts\n---\nБез any.\n')
  writeFileSync(join(root, '.claude', 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\ndescription: test first\n---\nТест першим.\n')
  writeFileSync(join(root, 'src', 'a.ts'), 'export {}\n')
  writeFileSync(join(root, '.claude', 'gate.json'), JSON.stringify({
    groups: { core: ['skill:tdd'], db: ['tool:mcp__postgres__*'] },
    tiers: { premium: { groups: ['core'] }, standard: { groups: ['core'] }, quick: { groups: ['core'] } },
    models: { '*haiku*': 'quick', '*sonnet*': 'standard', '*opus*': 'premium' },
    profiles: { web: { groups: ['core'] }, db: { groups: ['core', 'db'] } },
    gates: [{ name: 'read-before-write', on: 'write', builtin: true }],
    log: { file: true },
  }))
  return root
}

test('runHook end to end: state file, journal, outputs', () => {
  const root = tmpRepo()
  const cache = mkdtempSync(join(tmpdir(), 'cg-cache-'))
  const env = { HOME: cache, CONTEXT_GATE_CACHE_DIR: cache, CONTEXT_GATE_PROFILE: 'web' }
  try {
    const start = runHook({ hook_event_name: 'SessionStart', session_id: 'abc/../x', cwd: root, source: 'startup', model: 'claude-sonnet-4-6' }, env)
    assert.match(start.stdout, /Завжди pnpm/)
    const post = runHook({ hook_event_name: 'PostToolUse', session_id: 'abc/../x', cwd: root, tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'a.ts') } }, env)
    assert.match(JSON.parse(post.stdout).hookSpecificOutput.additionalContext, /Без any/)
    const again = runHook({ hook_event_name: 'PostToolUse', session_id: 'abc/../x', cwd: root, tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'a.ts') } }, env)
    assert.equal(again.stdout, '')
    const deny = runHook({ hook_event_name: 'PreToolUse', session_id: 'abc/../x', cwd: root, tool_name: 'mcp__postgres__query', tool_input: {} }, env)
    assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny')
    const stateFile = join(cache, 'hooks', 'abc_.._x.json')
    assert.ok(existsSync(stateFile))
    const journal = readFileSync(join(root, '.claude', 'gate.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(journal.some((e) => e.kind === 'decision' && e.profile === 'web'))
    assert.ok(journal.some((e) => e.kind === 'deny'))
    assert.ok(journal.every((e) => !JSON.stringify(e).includes('Завжди pnpm')), 'journal has no rule/prompt text')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('main.ts: stdin hook and install --print / install + backup', () => {
  const root = tmpRepo()
  const cache = mkdtempSync(join(tmpdir(), 'cg-cache-'))
  const main = join(import.meta.dirname, '..', 'packages', 'hooks-adapter', 'src', 'main.ts')
  const node = (args: string[], input?: string) => execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', main, ...args], { cwd: root, input, env: { ...process.env, HOME: cache, CONTEXT_GATE_CACHE_DIR: cache }, encoding: 'utf8' })
  try {
    const out = node([], JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: root, source: 'startup' }))
    assert.equal(JSON.parse(out).hookSpecificOutput.hookEventName, 'SessionStart')
    assert.equal(node([], 'not json'), '')
    const printed = JSON.parse(node(['install', '--print', '--profile', 'web', '--tier', 'quick']))
    assert.ok(printed.hooks.SessionStart[0].hooks[0].command.includes('hooks-adapter.js'))
    assert.ok(!existsSync(join(root, '.claude', 'settings.local.json')))
    writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }))
    node(['install', '--profile', 'db'])
    const written = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'))
    assert.deepEqual(written.permissions, { allow: ['Bash(ls)'] })
    assert.equal(written.hooks.PreToolUse[0].matcher, 'mcp__.*|Edit|Write|NotebookEdit')
    const plan = JSON.parse(node(['plan', '--type', 'db', '--model', 'claude:claude-haiku-4-5']))
    assert.equal(plan.profile, 'db')
    assert.equal(plan.tier, 'quick')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('read-before-write journals gate-attempt entries (core contract) → H011 counters', async () => {
  const { gateStatsFromJournal } = await import('../packages/core/src/journal.ts')
  const edit = ev({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } })
  const readA = ev({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/src/a.ts' } })
  const r = run([edit, readA, edit], ctx({ env: { CONTEXT_GATE_MODEL: 'claude-haiku-4-5' } }))
  const attempts = r.logs.filter((l) => l.kind === 'gate-attempt')
  assert.deepEqual(attempts.map((l) => [l.data!.gate, l.data!.outcome, l.data!.adapter, l.data!.sessionId]), [['read-before-write', 'block', 'claude-code-hooks', 's'], ['read-before-write', 'pass', 'claude-code-hooks', 's']])
  assert.deepEqual(gateStatsFromJournal(r.logs), { 'read-before-write': { attempts: 2, blocks: 1, ms: 0, overrides: 0 } })
  // Premium: the gate is inactive, nothing is journaled.
  assert.equal(run([edit], ctx({ env: { CONTEXT_GATE_MODEL: 'claude-opus-4-7' } })).logs.filter((l) => l.kind === 'gate-attempt').length, 0)
})
