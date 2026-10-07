// Regressions for the 2026-10-06 review, pi / opencode adapters (packages/adapters): M03, M27, M28, M73, M76, L11, L12.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPiAdapter } from '../packages/adapters/pi/index.ts'
import { createOpencodePlugin } from '../packages/adapters/opencode/index.ts'
import { mcpServersFromConfig, mcpServersFromConfigChecked, stripJsonc } from '../packages/adapters/opencode/plan.ts'
import { applyFlag, decideTurn, newSession, rulesForFile, systemParts, toolDeny, type GateData } from '../packages/adapters/common/session.ts'
import { loadGateData, loadSkillDirs } from '../packages/adapters/common/load.ts'
import type { OcContextEvent, OcPermissionEvent, OcPluginContext, OcPromptEvent } from '../packages/adapters/opencode/types.ts'
import type { PiContext, PiExtensionAPI } from '../packages/adapters/pi/types.ts'
import type { DecisionLogEntry } from '../packages/core/src/types.ts'
import { GATE_JSON, tmpRepo } from './adapter-fixture.ts'

function data(env: Record<string, string> = {}, gate: Record<string, unknown> = GATE_JSON): GateData {
  const { root } = tmpRepo('cg-fixa-')
  writeFileSync(join(root, '.claude', 'gate.json'), JSON.stringify(gate))
  return loadGateData(root, loadSkillDirs(root, [join(root, '.claude', 'skills')]), { ...env })
}

test('M03: common systemParts preloads only for the applied gate and not when the runner did (CONTEXT_GATE_PRELOAD=system)', () => {
  const cases: { env: Record<string, string>; preload: boolean }[] = [
    { env: {}, preload: false },
    { env: { CONTEXT_GATE_PROFILE: 'frontend' }, preload: true },
    { env: { CONTEXT_GATE_MODE: 'auto' }, preload: true },
    { env: { CONTEXT_GATE_PROFILE: 'frontend', CONTEXT_GATE_PRELOAD: 'system' }, preload: false },
  ]
  for (const c of cases) {
    const d = data(c.env)
    const s = newSession()
    const turn = decideTurn(d, s, 'pi', { model: 'anthropic/claude-haiku-4-5', now: 1 })
    const parts = systemParts(d, s, turn.gate, turn.applied, 'pi', 1, () => 'Тест першим.')
    assert.equal(!!parts.preload, c.preload, JSON.stringify(c.env))
  }
})

test('M73: [gate:<undeclared>] is ignored (G502) and the deny hint names a declared profile', () => {
  const gate = { ...GATE_JSON, groups: { ...GATE_JSON.groups, pg: ['tool:mcp__pg__*'] }, profiles: { ...GATE_JSON.profiles, backend: { groups: ['backend', 'pg'] } } }
  const d = data({}, gate)
  const s = newSession()
  applyFlag(s, '[gate:frontend] go', d.config)
  const f = applyFlag(s, '[gate:pg] list', d.config)
  assert.equal(f.text, 'list')
  assert.match(f.ignored ?? '', /G502 \[gate:pg\]/)
  assert.deepEqual(s.manual, { profile: 'frontend' })
  decideTurn(d, s, 'pi', { now: 1 })
  const r = toolDeny(d, s, 'mcp__pg__query', 'pi', 1)
  assert.match(r.deny ?? '', /\[gate:backend\] на початку промпту/)
  assert.doesNotMatch(r.deny ?? '', /\[gate:pg\]/)
})

test('M76: CONTEXT_GATE_ADD / REMOVE from the shiftwork plan apply in pi and opencode', () => {
  const d = data({ CONTEXT_GATE_ADD: 'backend' })
  const s = newSession()
  const t = decideTurn(d, s, 'opencode', { now: 1 })
  assert.equal(t.applied, true)
  assert.equal(toolDeny(d, s, 'mcp__postgres__query', 'opencode', 1).deny, undefined)
  assert.ok(toolDeny(d, s, 'mcp__figma__get', 'opencode', 1).deny)
})

test('L11: an edit of a .mdc does not count as delivering the rule; a full read does', () => {
  for (const [via, delivered] of [['tool:edit', false], ['tool:write', false], ['tool:read', true]] as const) {
    const d = data({ CONTEXT_GATE_PROFILE: 'frontend' })
    const s = newSession()
    rulesForFile(d, s, '.cursor/rules/react.mdc', via, 'pi', 1, { path: '.cursor/rules/react.mdc', oldText: 'a', newText: 'b' })
    assert.equal(s.seen.includes('react'), delivered, via)
    const r = rulesForFile(d, s, 'apps/web/A.tsx', 'tool:read', 'pi', 1, { path: 'apps/web/A.tsx' })
    assert.equal(!!r.text, !delivered, `${via}: rule attached on the next .tsx read`)
  }
})

test('L12: opencode.jsonc with comments and trailing commas still yields the MCP servers', () => {
  const cases: [string, string[] | undefined][] = [
    ['{ "mcp": { "postgres": { "type": "local" }, } }', ['postgres']],
    ['{ "mcp": { "postgres": {}, // db\n "figma": {} } }', ['postgres', 'figma']],
    ['{ /* block */ "mcp": { "a": { "url": "http://x//y,}" }, }, }', ['a']],
    ['{ "mcp": { "a": {} }, // trailing\n}', ['a']],
    ['not json', undefined],
  ]
  for (const [text, want] of cases) assert.deepEqual(mcpServersFromConfigChecked(text), want, text)
  assert.deepEqual(mcpServersFromConfig('nope'), [])
  assert.equal(stripJsonc('{"s": "a // b /* c */, ]"}'), '{"s": "a // b /* c */, ]"}')
})

// ───────────────────────── journal (M28) ─────────────────────────

test('M28: pi and opencode write gate.log.jsonl only with log.file', () => {
  for (const file of [false, true]) {
    const { root, home } = tmpRepo('cg-fixa-log-')
    writeFileSync(join(root, '.claude', 'gate.json'), JSON.stringify({ ...GATE_JSON, log: { file } }))
    const handlers = new Map<string, (e: unknown, c: PiContext) => unknown>()
    createPiAdapter({ env: { HOME: home, CONTEXT_GATE_PROFILE: 'frontend' }, home, now: () => 1 })({ on: (n: string, h: (e: unknown, c: PiContext) => unknown) => { handlers.set(n, h) } } as unknown as PiExtensionAPI)
    const ctx: PiContext = { cwd: root, hasUI: false, model: { provider: 'anthropic', id: 'claude-haiku-4-5' }, ui: { notify: () => {} } }
    handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'go', systemPromptOptions: { cwd: root, appendSystemPrompt: '', sections: {}, skills: [] } }, ctx)
    assert.equal(existsSync(join(root, '.claude', 'gate.log.jsonl')), file, `pi log.file=${file}`)

    const oc = tmpRepo('cg-fixa-log-oc-')
    writeFileSync(join(oc.root, '.claude', 'gate.json'), JSON.stringify({ ...GATE_JSON, log: { file } }))
    const f = fakeOc(oc.root)
    createOpencodePlugin({ env: { HOME: oc.home, CONTEXT_GATE_PROFILE: 'frontend' }, home: oc.home, now: () => 1 }).setup(f.ctx)
    f.trigger<OcPromptEvent>('session.prompt', { sessionID: 's', prompt: { text: 'go' } })
    assert.equal(existsSync(join(oc.root, '.claude', 'gate.log.jsonl')), file, `opencode log.file=${file}`)
  }
})

// ───────────────────────── opencode child sessions (M27) ─────────────────────────

type Cb = (e: unknown) => unknown
function fakeOc(directory: string) {
  const hooks = new Map<string, Cb[]>()
  const hook = (domain: string) => (name: string, cb: Cb) => { hooks.set(`${domain}.${name}`, [...(hooks.get(`${domain}.${name}`) ?? []), cb]) }
  const ctx = { location: { directory }, session: { hook: hook('session') }, tool: { hook: hook('tool') }, permission: { hook: hook('permission') } } as unknown as OcPluginContext
  const trigger = <E>(name: string, e: E): E => { for (const cb of hooks.get(name) ?? []) cb(e); return e }
  return { ctx, trigger }
}

test('M27: an opencode subagent (child session) inherits the parent [gate:x] / [gate:off]', () => {
  const { root, home } = tmpRepo('cg-fixa-oc-')
  writeFileSync(join(root, 'opencode.json'), '{ "mcp": { "postgres": {}, "figma": {} } }')
  const log: DecisionLogEntry[] = []
  const f = fakeOc(root)
  createOpencodePlugin({ env: { HOME: home, CONTEXT_GATE_MODE: 'shadow' }, home, now: () => 1, journal: (_r, e) => { log.push(...e) } }).setup(f.ctx)
  const perm = (sessionID: string, action: string, parentID?: string) => f.trigger<OcPermissionEvent>('permission.evaluate', { sessionID, action, resources: ['*'], effect: 'allow', ...(parentID ? { parentID } : {}) } as OcPermissionEvent).effect
  f.trigger<OcPromptEvent>('session.prompt', { sessionID: 'parent', prompt: { text: '[gate:frontend] fix the form' } })
  assert.equal(perm('parent', 'postgres_query'), 'deny')
  // The task tool creates the child and prompts it while the parent's `task` call runs.
  assert.equal(perm('parent', 'task'), 'allow')
  f.trigger<OcPromptEvent>('session.prompt', { sessionID: 'child', prompt: { text: 'subtask' } })
  assert.equal(perm('child', 'postgres_query'), 'deny', 'child keeps the parent profile')
  const ctxEv = f.trigger<OcContextEvent>('session.context', { sessionID: 'child', system: [], tools: { postgres_query: {}, figma_get: {} } })
  assert.deepEqual(Object.keys(ctxEv.tools), ['figma_get'])
  f.trigger('tool.execute.after', { tool: 'task', sessionID: 'parent', result: { content: '' } })
  // After the task call: a new top-level session (`/new`, another client) starts fresh, not with the parent's
  // [gate:frontend]; nor does one created after an unrelated session's [gate:off].
  f.trigger<OcPromptEvent>('session.prompt', { sessionID: 'B', prompt: { text: 'query the db' } })
  assert.equal(perm('B', 'postgres_query'), 'allow', 'no leak into an unrelated session')
  f.trigger<OcPromptEvent>('session.prompt', { sessionID: 'other', prompt: { text: '[gate:off] anything' } })
  f.trigger<OcPromptEvent>('session.prompt', { sessionID: 'C', prompt: { text: '[gate:frontend] x' } })
  assert.equal(perm('C', 'postgres_query'), 'deny', '[gate:off] of another session does not leak')
  // An explicit parentID always links.
  assert.equal(perm('child2', 'postgres_query', 'parent'), 'deny')
})
