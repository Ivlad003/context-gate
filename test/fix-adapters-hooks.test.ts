// Regressions for the 2026-10-06 review, hooks adapter (packages/hooks-adapter): M03, M38, M71-M76, L75-L90, R4, O3.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { handleHook, mergeStates, newState, readBeforeWriteActive, type HookContext, type HookInput, type SessionState } from '../packages/hooks-adapter/src/handle.ts'
import { hookCommand, hookEntries, isOurHook, mergeSettings, unmergeSettings } from '../packages/hooks-adapter/src/install.ts'
import { isMainModule, runHook } from '../packages/hooks-adapter/src/main.ts'
import { readState, statePath } from '../packages/hooks-adapter/src/node.ts'
import { planForTicket } from '../packages/hooks-adapter/src/shiftwork.ts'
import { parseMdc } from '../packages/core/src/mdc.ts'
import { mergeDefaults } from '../packages/core/src/config.ts'
import { makeItem } from '../packages/core/src/items.ts'
import { gateFailures } from '../packages/core/src/report.ts'
import type { GateConfig, MdcRule } from '../packages/core/src/types.ts'

const pexec = promisify(execFile)
const MAIN = join(import.meta.dirname, '..', 'packages', 'hooks-adapter', 'src', 'main.ts')

const rule = (id: string, text: string): MdcRule => parseMdc(text, { path: `.cursor/rules/${id}.mdc`, id }).rule
const rules: MdcRule[] = [
  rule('project', '---\nalwaysApply: true\n---\nМонорепозиторій на pnpm.'),
  rule('backend-conv', '---\nalwaysApply: true\n---\nREST: kebab-case.'),
  rule('react', '---\nglobs: **/*.tsx\n---\nКомпоненти — функції.'),
]

const base = {
  groups: {
    core: ['skill:tdd'],
    frontend: ['skill:react-*', 'tool:mcp__figma__*'],
    backend: ['skill:nestjs', 'tool:mcp__postgres__*', 'rule:backend-conv'],
    pg: ['tool:mcp__pg__*'],
  },
  tiers: { premium: { groups: ['core'] }, standard: { groups: ['core'] }, quick: { groups: ['core'], preload: ['tdd'] } },
  models: { 'claude-opus-*': 'premium', 'claude-sonnet-*': 'standard', 'claude-haiku-*': 'quick' },
  profiles: {
    frontend: { groups: ['frontend'], when: { paths: ['apps/web/**'] } },
    backend: { groups: ['backend', 'pg'], when: { paths: ['apps/api/**'] } },
  },
  gates: [{ name: 'read-before-write', on: 'write' as const, builtin: true }],
}
const cfgOf = (over: Record<string, unknown> = {}): GateConfig => mergeDefaults({ ...base, ...over } as never)

const items = [
  makeItem('skill', 'tdd', { body: 'Пиши тест першим.', provenance: { source: 'claude-skills', path: '.claude/skills/tdd/SKILL.md' } }),
  makeItem('skill', 'react-components', { description: 'react' }),
  makeItem('skill', 'nestjs', { description: 'nest' }),
]

function ctx(over: Partial<HookContext> = {}, existing: string[] = ['src/a.ts']): HookContext {
  return { root: '/repo', config: cfgOf(), rules, items, env: {}, now: 1000, exists: (p) => existing.includes(p), ...over }
}
const ev = (e: Partial<HookInput> & { hook_event_name: string }): HookInput => ({ session_id: 's', cwd: '/repo', ...e })
function run(events: HookInput[], c: HookContext = ctx(), state: SessionState = newState()) {
  const outs = []
  const logs = []
  let s = state
  for (const e of events) {
    const r = handleHook(e, c, s)
    s = r.state
    outs.push(r.output)
    logs.push(...r.log)
  }
  return { outs, state: s, logs }
}
const ctxText = (o: unknown): string => ((o as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? '')
const reasonOf = (o: unknown): string => ((o as { hookSpecificOutput?: { permissionDecisionReason?: string } })?.hookSpecificOutput?.permissionDecisionReason ?? '')
const denied = (o: unknown): boolean => (o as { hookSpecificOutput?: { permissionDecision?: string } })?.hookSpecificOutput?.permissionDecision === 'deny'
const edit = (p: string) => ev({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: `/repo/${p}`, old_string: 'a', new_string: 'b' } })
const mcp = (tool: string) => ev({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} })

// ───────────────────────── handle.ts ─────────────────────────

test('M03: tier preload only for the applied gate; resume/fork and CONTEXT_GATE_PRELOAD=system skip it (L90)', () => {
  const cases: { env: Record<string, string>; source?: string; preload: boolean }[] = [
    { env: {}, preload: false },
    { env: { CONTEXT_GATE_MODE: 'auto' }, preload: true },
    { env: { CONTEXT_GATE_PROFILE: 'frontend' }, preload: true },
    { env: { CONTEXT_GATE_PROFILE: 'frontend', CONTEXT_GATE_PRELOAD: 'system' }, preload: false },
    { env: { CONTEXT_GATE_PROFILE: 'frontend' }, source: 'resume', preload: false },
    { env: { CONTEXT_GATE_PROFILE: 'frontend', CONTEXT_GATE_OFF: '1' }, preload: false },
  ]
  for (const c of cases) {
    const { outs } = run([ev({ hook_event_name: 'SessionStart', source: c.source ?? 'startup', model: 'claude-haiku-4-5' })], ctx({ env: c.env }))
    assert.equal(/Preloaded skill tdd/.test(ctxText(outs[0])), c.preload, JSON.stringify(c))
  }
})

test('M72: an @file mention counts as read for read-before-write', () => {
  const c = ctx({ env: { CONTEXT_GATE_MODEL: 'claude-haiku-4-5' } })
  assert.ok(denied(run([edit('src/a.ts')], c).outs[0]))
  const r = run([ev({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the typo in @src/a.ts' }), edit('src/a.ts')], c)
  assert.equal(r.outs[1], undefined)
  assert.ok(r.state.read.includes('src/a.ts'))
})

test('M73: the deny hint names a declared profile; [gate:<undeclared>] is ignored with G502 (mod parity)', () => {
  const env = { CONTEXT_GATE_MODE: 'auto' }
  // `pg` is only a group: the hint must name the profile that contains it, not `[gate:pg]`.
  const r = run([ev({ hook_event_name: 'UserPromptSubmit', prompt: '[gate:frontend] go' }), mcp('mcp__pg__query')], ctx({ env }))
  assert.ok(denied(r.outs[1]))
  assert.match(reasonOf(r.outs[1]), /\[gate:backend\] у промпті/)
  assert.doesNotMatch(reasonOf(r.outs[1]), /\[gate:pg\]/)

  const typed = run([ev({ hook_event_name: 'UserPromptSubmit', prompt: '[gate:frontend] go' }), ev({ hook_event_name: 'UserPromptSubmit', prompt: '[gate:pg] list' }), mcp('mcp__figma__get')], ctx({ env }))
  assert.equal(typed.state.manual?.profile, 'frontend', 'undeclared flag does not pin a profile')
  assert.match((typed.outs[1] as { systemMessage?: string }).systemMessage ?? '', /G502 \[gate:pg\]/)
  assert.equal(typed.outs[2], undefined, 'frontend groups are kept')
})

test('M71: Always rules a later profile enables arrive with the prompt that switches it', () => {
  const c = ctx({ env: { CONTEXT_GATE_MODE: 'auto' } })
  const r = run([ev({ hook_event_name: 'SessionStart', source: 'startup' }), ev({ hook_event_name: 'UserPromptSubmit', prompt: '[gate:backend] add an endpoint' }), ev({ hook_event_name: 'UserPromptSubmit', prompt: 'next' })], c)
  assert.doesNotMatch(ctxText(r.outs[0]), /kebab-case/, 'gated off at start')
  assert.match(ctxText(r.outs[1]), /Cursor rule backend-conv\):\nREST: kebab-case/)
  assert.doesNotMatch(ctxText(r.outs[2]), /kebab-case/, 'once')
  assert.ok(r.state.seen.includes('main:backend-conv'))
})

test('L79: read-before-write without tiers skips premium; builtin is required (mod gatesFor)', () => {
  const cfg = cfgOf()
  const cases: [GateConfig, string, boolean][] = [
    [cfg, 'premium', false],
    [cfg, 'standard', true],
    [cfg, 'quick', true],
    [cfgOf({ gates: [{ name: 'read-before-write', on: 'write', builtin: true, tiers: ['premium'] }] }), 'premium', true],
    [cfgOf({ gates: [{ name: 'read-before-write', on: 'write' }] }), 'standard', false],
  ]
  for (const [c, tier, on] of cases) assert.equal(readBeforeWriteActive(c, tier), on, `${tier} ${JSON.stringify(c.gates)}`)
  assert.equal(run([edit('src/a.ts')], ctx({ env: { CONTEXT_GATE_MODEL: 'claude-opus-4-7' } })).outs[0], undefined)
})

test('L80: a read-before-write block carries data.gate, so report counts it', () => {
  const r = run([edit('src/a.ts')], ctx({ env: { CONTEXT_GATE_MODEL: 'claude-haiku-4-5' } }))
  const failed = r.logs.find((l) => l.kind === 'gate-failed')!
  assert.equal(failed.data?.gate, 'read-before-write')
  assert.equal(gateFailures(r.logs)['read-before-write']?.blocks, 1)
})

test('L77: compaction re-decides the profile only when classify.recheckOn has compact', () => {
  for (const [recheckOn, kept] of [[[], true], [['compact'], false]] as const) {
    const c = ctx({ config: cfgOf({ classify: { mode: 'auto', recheckOn } }) })
    const r = run([
      ev({ hook_event_name: 'UserPromptSubmit', prompt: 'see @apps/api/users.ts' }),
      ev({ hook_event_name: 'UserPromptSubmit', prompt: 'more' }),
    ], c)
    assert.equal(r.state.gate.profile, 'backend')
    const after = handleHook(ev({ hook_event_name: 'SessionStart', source: 'compact' }), c, { ...r.state, paths: [] })
    assert.equal(after.state.gate.profile === 'backend', kept, JSON.stringify(recheckOn))
  }
})

test('L78: machine-injected prompts neither advance the turn nor apply [gate:x]', () => {
  const c = ctx({ env: { CONTEXT_GATE_MODE: 'auto' } })
  for (const source of ['system', 'loop_wakeup', 'schedule_wakeup', 'poll_event']) {
    const r = run([ev({ hook_event_name: 'UserPromptSubmit', prompt: '[gate:off] peer says hi', source })], c)
    assert.equal(r.state.manual, undefined, source)
    assert.equal(r.state.gate.turn, 0, source)
  }
  for (const source of ['user', 'sdk', undefined]) {
    const r = run([ev({ hook_event_name: 'UserPromptSubmit', prompt: '[gate:off] go', ...(source ? { source } : {}) })], c)
    assert.deepEqual(r.state.manual, { off: true }, String(source))
  }
})

test('L75: PostModelSwitch moves the tier (read-before-write, preload) without a new turn', () => {
  const c = ctx({ env: { CONTEXT_GATE_PROFILE: 'frontend' } })
  const r = run([
    ev({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-4-7' }),
    edit('src/a.ts'),
    ev({ hook_event_name: 'PostModelSwitch', from_model: 'claude-opus-4-7', to_model: 'claude-haiku-4-5' }),
    edit('src/a.ts'),
  ], c)
  assert.equal(r.outs[1], undefined, 'premium: no read-before-write')
  assert.match(ctxText(r.outs[2]), /Preloaded skill tdd/)
  assert.ok(denied(r.outs[3]), 'quick after /model haiku')
  assert.equal(r.state.model, 'claude-haiku-4-5')
  assert.equal(r.state.gate.turn, 1)
  assert.ok(r.logs.some((l) => l.kind === 'decision' && l.tier === 'quick'))
})

test('L81: SubagentStart gives each subagent the Always rules once', () => {
  const r = run([
    ev({ hook_event_name: 'SessionStart', source: 'startup' }),
    ev({ hook_event_name: 'SubagentStart', agent_id: 'a1' }),
    ev({ hook_event_name: 'SubagentStart', agent_id: 'a1' }),
  ])
  assert.match(ctxText(r.outs[1]), /Монорепозиторій на pnpm/)
  assert.equal(r.outs[2], undefined)
  assert.ok(r.state.seen.includes('a1:project'))
})

test('M76: plan env carries the ticket Skills adjustments and the hooks adapter decides the same', () => {
  const cfg = cfgOf({ profiles: { feature: { groups: ['core'] }, backend: base.profiles.backend } })
  const plan = planForTicket(cfg, { ticketType: 'feature', model: 'claude:claude-sonnet-4-6', skills: '+pg -core', items })
  assert.equal(plan.env.CONTEXT_GATE_ADD, 'pg')
  assert.equal(plan.env.CONTEXT_GATE_REMOVE, 'core')
  assert.ok(!plan.mcpOff.includes('mcp__pg__query'))
  const c = ctx({ config: cfg, env: plan.env })
  assert.equal(run([mcp('mcp__pg__query')], c).outs[0], undefined, 'shift allows what the plan enabled')
  assert.ok(denied(run([mcp('mcp__postgres__query')], c).outs[0]))
  // Ticket adjustments alone (no profile) still apply.
  const adj = planForTicket(cfg, { skills: '+pg', items })
  assert.deepEqual(adj.env, { CONTEXT_GATE_ADD: 'pg' })
  assert.ok(denied(run([mcp('mcp__postgres__query')], ctx({ config: cfg, env: adj.env })).outs[0]))
})

test('L89/L90: plan settings say "on" for granted skills; preload in the system prompt is not repeated', () => {
  const plan = planForTicket(cfgOf(), { ticketType: 'backend', model: 'claude:claude-haiku-4-5', items })
  assert.equal(plan.settings.skillOverrides.nestjs, 'on')
  assert.equal(plan.settings.skillOverrides.tdd, 'on')
  assert.notEqual(plan.settings.skillOverrides['react-components'], 'on')
  assert.equal(plan.env.CONTEXT_GATE_PRELOAD, 'system')
  const { outs } = run([ev({ hook_event_name: 'SessionStart', source: 'startup' })], ctx({ env: plan.env }))
  assert.doesNotMatch(ctxText(outs[0]), /Preloaded skill/)
})

// ───────────────────────── state merge (R4 / M74) ─────────────────────────

test('R4: mergeStates keeps both sides of concurrent updates', () => {
  const b: SessionState = { ...newState(), read: ['x'], seen: ['main:a'] }
  const cases: { name: string; next: Partial<SessionState>; disk: Partial<SessionState>; read: string[]; seen: string[]; manual?: unknown }[] = [
    { name: 'two reads', next: { read: ['x', 'a'] }, disk: { read: ['x', 'b'] }, read: ['x', 'a', 'b'], seen: ['main:a'] },
    { name: 'other cleared', next: { read: ['x', 'a'] }, disk: { read: [], seen: [] }, read: ['a'], seen: [] },
    { name: 'we cleared', next: { read: [], seen: [] }, disk: { read: ['x', 'b'] }, read: ['b'], seen: [] },
    { name: 'other set manual', next: { read: ['x', 'a'] }, disk: { manual: { off: true } }, read: ['x', 'a'], seen: ['main:a'], manual: { off: true } },
    { name: 'we set manual', next: { manual: { profile: 'backend' } }, disk: { manual: { off: true } }, read: ['x'], seen: ['main:a'], manual: { profile: 'backend' } },
  ]
  for (const c of cases) {
    const m = mergeStates(b, { ...b, ...c.next }, { ...b, ...c.disk })
    assert.deepEqual(m.read, c.read, c.name)
    assert.deepEqual(m.seen, c.seen, c.name)
    assert.deepEqual(m.manual, c.manual, c.name)
  }
})

function tmpRepo(gate: Record<string, unknown> = base): string {
  const root = mkdtempSync(join(tmpdir(), 'cg-fixh-'))
  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true })
  mkdirSync(join(root, '.claude', 'skills', 'tdd'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, '.cursor', 'rules', 'project.mdc'), '---\nalwaysApply: true\n---\nЗавжди pnpm.\n')
  writeFileSync(join(root, '.claude', 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\n---\nТест першим.\n')
  writeFileSync(join(root, '.claude', 'gate.json'), JSON.stringify(gate))
  for (let i = 0; i < 12; i++) writeFileSync(join(root, 'src', `f${i}.ts`), '')
  return root
}

test('R4: parallel PostToolUse processes keep every read path', async () => {
  const root = tmpRepo()
  const cache = mkdtempSync(join(tmpdir(), 'cg-fixh-cache-'))
  const env = { ...process.env, HOME: cache, CONTEXT_GATE_CACHE_DIR: cache }
  try {
    await Promise.all(Array.from({ length: 12 }, (_, i) => {
      const child = pexec(process.execPath, ['--experimental-strip-types', '--no-warnings', MAIN], { env, cwd: root })
      child.child.stdin!.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'par', cwd: root, tool_name: 'Read', tool_input: { file_path: join(root, 'src', `f${i}.ts`) } }))
      return child
    }))
    const state = readState('par', env)
    assert.deepEqual([...state.read].sort(), Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`).sort())
    assert.ok(!existsSync(`${statePath('par', env)}.lock`), 'lock released')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('L84: an unwritable state dir does not swallow the hook output', () => {
  const root = tmpRepo()
  const cache = mkdtempSync(join(tmpdir(), 'cg-fixh-cache-'))
  const asFile = join(cache, 'not-a-dir')
  writeFileSync(asFile, '')
  try {
    const r = runHook({ hook_event_name: 'SessionStart', session_id: 'ro', cwd: root, source: 'startup' }, { HOME: cache, CONTEXT_GATE_CACHE_DIR: asFile })
    assert.match(r.stdout, /Завжди pnpm/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('L76: a fork seeds its state from the parent session named in the transcript', () => {
  const root = tmpRepo()
  const cache = mkdtempSync(join(tmpdir(), 'cg-fixh-cache-'))
  const env = { HOME: cache, CONTEXT_GATE_CACHE_DIR: cache, CONTEXT_GATE_MODEL: 'claude-haiku-4-5' }
  try {
    runHook({ hook_event_name: 'SessionStart', session_id: 'parent', cwd: root, source: 'startup' }, env)
    runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'parent', cwd: root, prompt: '[gate:backend] go' }, env)
    runHook({ hook_event_name: 'PostToolUse', session_id: 'parent', cwd: root, tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'f1.ts') } }, env)
    const transcript = join(cache, 'fork.jsonl')
    // A fork of a fork: the grandparent's copied lines come first, the direct parent's right before the fork point.
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId: 'grandparent' })}\n${JSON.stringify({ type: 'user', sessionId: 'parent' })}\n${JSON.stringify({ type: 'user', sessionId: 'child' })}\n`)
    const start = runHook({ hook_event_name: 'SessionStart', session_id: 'child', cwd: root, source: 'fork', transcript_path: transcript }, env)
    assert.doesNotMatch(start.stdout, /Завжди pnpm/, 'Always rules are already in the forked transcript')
    const child = readState('child', env)
    assert.equal(child.manual?.profile, 'backend')
    assert.ok(child.read.includes('src/f1.ts'))
    const ed = runHook({ hook_event_name: 'PreToolUse', session_id: 'child', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src', 'f1.ts') } }, env)
    assert.equal(ed.stdout, '', 'read before the fork counts')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('O3: with the mod plugin enabled the hook stays quiet (one notice), unless installed --with-mod', () => {
  const root = tmpRepo()
  const cache = mkdtempSync(join(tmpdir(), 'cg-fixh-cache-'))
  mkdirSync(join(cache, '.claude'), { recursive: true })
  writeFileSync(join(cache, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'context-gate@acme': true } }))
  const env = { HOME: cache, CONTEXT_GATE_CACHE_DIR: cache }
  try {
    const start = runHook({ hook_event_name: 'SessionStart', session_id: 'm', cwd: root, source: 'startup' }, env)
    assert.match(JSON.parse(start.stdout).systemMessage, /плагін-mod увімкнено/)
    assert.equal(runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'm', cwd: root, prompt: '@src/f1.ts' }, env).stdout, '')
    assert.match(runHook({ hook_event_name: 'SessionStart', session_id: 'm2', cwd: root, source: 'startup' }, env, 0, { withMod: true }).stdout, /Завжди pnpm/)
    // A project-local `false` beats the user-wide `true`.
    writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'context-gate@acme': false } }))
    assert.match(runHook({ hook_event_name: 'SessionStart', session_id: 'm3', cwd: root, source: 'startup' }, env).stdout, /Завжди pnpm/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

// ───────────────────────── install / entry ─────────────────────────

test('L83: install/uninstall drop only our hook commands, not a user hook sharing the matcher', () => {
  const ours = hookCommand('/opt/cg/dist/hooks-adapter.js')
  const prettier = { type: 'command' as const, command: 'npx prettier --write "$FILE"' }
  const lookalike = { type: 'command' as const, command: 'bash /x/my-hooks-adapter.js.sh' }
  const existing = { hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [prettier, { type: 'command' as const, command: ours }, lookalike] }] } }
  const un = unmergeSettings(existing)
  assert.deepEqual(un.hooks, { PostToolUse: [{ matcher: 'Edit|Write', hooks: [prettier, lookalike] }] })
  const re = mergeSettings(existing, { hooks: hookEntries(ours) })
  assert.deepEqual(re.hooks!.PostToolUse[0].hooks, [prettier, lookalike])
  const cases: [string, boolean][] = [
    [ours, true], [hookCommand('/a b/hooks-adapter.js'), true], [hookCommand('/x/dist/hooks-adapter.js', 'node', ['--with-mod']), true],
    ['node C:\\cg\\dist\\hooks-adapter.js', true], ['echo hooks-adapter.js.bak', false], ['node /x/not-hooks-adapter.js', false],
  ]
  for (const [command, mine] of cases) assert.equal(isOurHook({ type: 'command', command }), mine, command)
  assert.ok(hookEntries(ours).SubagentStart)
  assert.equal(hookEntries(ours).PostModelSwitch, undefined)
  assert.ok(hookEntries(ours, 10, { modelSwitch: true }).PostModelSwitch)
})

function cli(root: string, cache: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', MAIN, ...args], { cwd: root, env: { ...process.env, HOME: cache, CONTEXT_GATE_CACHE_DIR: cache, ...extraEnv }, encoding: 'utf8' })
}

test('install: G502 on an unknown --profile, shadow writes no overrides (M38), user overrides survive (L85), backups leave the repo (L86)', () => {
  const root = tmpRepo()
  const cache = mkdtempSync(join(tmpdir(), 'cg-fixh-cache-'))
  for (const n of ['deploy', 'nestjs']) {
    mkdirSync(join(root, '.claude', 'skills', n), { recursive: true })
    writeFileSync(join(root, '.claude', 'skills', n, 'SKILL.md'), `---\nname: ${n}\n---\n${n}\n`)
  }
  const settings = join(root, '.claude', 'settings.local.json')
  const read = () => JSON.parse(readFileSync(settings, 'utf8'))
  try {
    const typo = cli(root, cache, ['install', '--profile', 'fronted'])
    assert.equal(typo.status, 1)
    assert.match(typo.stderr, /G502: профіль fronted не оголошено.*Відомі: frontend, backend/)
    assert.ok(!existsSync(settings))

    writeFileSync(settings, JSON.stringify({ skillOverrides: { deploy: 'off' }, permissions: { allow: ['Bash(ls)'] } }))
    const shadow = cli(root, cache, ['install'])
    assert.equal(shadow.status, 0, shadow.stderr)
    assert.match(shadow.stdout, /shadow-режим/)
    assert.deepEqual(read().skillOverrides, { deploy: 'off' })

    assert.equal(cli(root, cache, ['install', '--profile', 'frontend']).status, 0)
    assert.equal(read().skillOverrides.deploy, 'off', 'the user key is not ours')
    assert.equal(read().skillOverrides.nestjs, 'user-invocable-only')
    assert.equal(cli(root, cache, ['install', '--profile', 'backend']).status, 0)
    assert.equal(read().skillOverrides.nestjs, undefined, 'our stale key replaced')
    // M38: a later default (shadow) install takes back what the --profile install hid; the user key stays.
    assert.equal(cli(root, cache, ['install', '--profile', 'frontend']).status, 0)
    assert.equal(read().skillOverrides.nestjs, 'user-invocable-only')
    const back = cli(root, cache, ['install'])
    assert.match(back.stdout, /нічого не приховано; прибрано 1/)
    assert.deepEqual(read().skillOverrides, { deploy: 'off' })

    const un = cli(root, cache, ['install', '--uninstall'])
    assert.equal(un.status, 0)
    assert.deepEqual(read().skillOverrides, { deploy: 'off' })
    assert.equal(read().hooks, undefined)
    assert.deepEqual(read().permissions, { allow: ['Bash(ls)'] })
    assert.deepEqual(readdirSync(join(root, '.claude')).filter((f) => f.includes('.bak')), [], 'no backups in the repo')
    assert.ok(readdirSync(join(cache, 'backups')).length >= 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('L85: uninstall of an install made before install records still removes the overrides it wrote', () => {
  const root = tmpRepo()
  const cache = mkdtempSync(join(tmpdir(), 'cg-fixh-cache-'))
  for (const n of ['tdd', 'nestjs']) {
    mkdirSync(join(root, '.claude', 'skills', n), { recursive: true })
    writeFileSync(join(root, '.claude', 'skills', n, 'SKILL.md'), `---\nname: ${n}\n---\n${n}\n`)
  }
  const settings = join(root, '.claude', 'settings.local.json')
  const legacy = mergeSettings({ skillOverrides: { tdd: 'user-invocable-only', nestjs: 'on', other: 'off' } as never }, { hooks: hookEntries(hookCommand('/opt/cg/dist/hooks-adapter.js', 'node', []), 10, {}) })
  writeFileSync(settings, JSON.stringify(legacy))
  try {
    const un = cli(root, cache, ['install', '--uninstall'])
    assert.equal(un.status, 0, un.stderr)
    const after = JSON.parse(readFileSync(settings, 'utf8'))
    assert.equal(after.hooks, undefined)
    // tdd: a managed skill with a value we write → ours; nestjs `on` and the unknown `other` stay the user's.
    assert.deepEqual(after.skillOverrides, { nestjs: 'on', other: 'off' })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('O3 install: refuses next to the mod plugin unless --with-mod; L87: errors exit 1 with a message', () => {
  const root = tmpRepo()
  const cache = mkdtempSync(join(tmpdir(), 'cg-fixh-cache-'))
  try {
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'context-gate@acme': true } }))
    const refused = cli(root, cache, ['install'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /--with-mod/)
    const forced = cli(root, cache, ['install', '--with-mod'])
    assert.equal(forced.status, 0, forced.stderr)
    const cmd = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command as string
    assert.match(cmd, /hooks-adapter\.js --with-mod$/)

    // `.claude` is a regular file: the write fails → stderr + exit 1, not a silent 0.
    const broken = mkdtempSync(join(tmpdir(), 'cg-fixh-broken-'))
    writeFileSync(join(broken, '.claude'), '')
    const r = cli(broken, cache, ['install'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /context-gate hooks install:/)
    rmSync(broken, { recursive: true, force: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('M75: the entry runs through a symlink (npm bin)', () => {
  const root = tmpRepo()
  const cache = mkdtempSync(join(tmpdir(), 'cg-fixh-cache-'))
  const link = join(cache, 'context-gate-hooks.ts')
  try {
    symlinkSync(MAIN, link)
    assert.ok(isMainModule(link, MAIN))
    assert.ok(!isMainModule(join(cache, 'other.ts'), MAIN))
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', link, 'plan', '--type', 'backend', '--root', root], { env: { ...process.env, HOME: cache }, encoding: 'utf8' })
    assert.equal(JSON.parse(out).profile, 'backend')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})
