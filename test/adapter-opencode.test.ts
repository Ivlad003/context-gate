import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOpencodePlugin } from '../packages/adapters/opencode/index.ts'
import { canonicalToolName, mcpServersFromConfig, skillPermissionRules } from '../packages/adapters/opencode/plan.ts'
import type { OcContextEvent, OcPermissionEvent, OcPluginContext, OcPromptEvent, OcToolAfterEvent } from '../packages/adapters/opencode/types.ts'
import type { DecisionLogEntry, Gate } from '../packages/core/src/types.ts'
import { fromJsonl } from '../packages/core/src/journal.ts'
import { tmpRepo } from './adapter-fixture.ts'

type Cb = (e: unknown) => unknown

/** A fake OpenCode V2 plugin ctx: records `<domain>.hook(name, cb)` and lets the test trigger them. */
function fakeCtx(directory: string) {
  const hooks = new Map<string, Cb[]>()
  const hook = (domain: string) => (name: string, cb: Cb) => { hooks.set(`${domain}.${name}`, [...(hooks.get(`${domain}.${name}`) ?? []), cb]) }
  const ctx = { location: { directory }, session: { hook: hook('session') }, tool: { hook: hook('tool') }, permission: { hook: hook('permission') } } as unknown as OcPluginContext
  const trigger = <E>(name: string, e: E): E => { for (const cb of hooks.get(name) ?? []) cb(e); return e }
  return { ctx, trigger, hooks }
}

function setup(env: Record<string, string>, opts: { journal?: boolean } = {}) {
  const { root, home } = tmpRepo('cg-oc-')
  writeFileSync(join(root, 'opencode.json'), '{\n  // servers\n  "mcp": { "postgres": {}, "figma": {} }\n}\n')
  const log: DecisionLogEntry[] = []
  const plugin = createOpencodePlugin({ env: { HOME: home, ...env }, home, now: () => 2000, ...(opts.journal === false ? {} : { journal: (_r, e) => { log.push(...e) } }) })
  const f = fakeCtx(root)
  plugin.setup(f.ctx)
  const prompt = (text: string, sessionID = 's1') => f.trigger<OcPromptEvent>('session.prompt', { sessionID, prompt: { text } })
  const context = (model = 'claude-haiku-4-5', sessionID = 's1') => f.trigger<OcContextEvent>('session.context', { sessionID, model: { id: model, providerID: 'anthropic' }, system: ['base'], tools: { read: {}, postgres_query: {}, figma_get: {}, mcp__postgres__exec: {} } })
  const permission = (action: string, resources: string[]) => f.trigger<OcPermissionEvent>('permission.evaluate', { sessionID: 's1', action, resources, effect: 'allow' })
  const after = (tool: string, path: string, content: unknown = 'file body') => f.trigger<OcToolAfterEvent>('tool.execute.after', { tool, sessionID: 's1', input: { path }, status: 'completed', result: { content } })
  return { root, f, log, prompt, context, permission, after }
}

test('opencode plan helpers: tool names, opencode.json servers, skill permission rules', () => {
  const servers = ['postgres', 'figma', 'pg']
  const cases: [string, string][] = [
    ['mcp__postgres__query', 'mcp__postgres__query'],
    ['postgres_query', 'mcp__postgres__query'],
    ['figma.get_file', 'mcp__figma__get_file'],
    ['pg_x', 'mcp__pg__x'],
    ['read', 'read'],
    ['postgres', 'postgres'],
  ]
  for (const [i, o] of cases) assert.equal(canonicalToolName(i, servers), o, i)
  assert.deepEqual(mcpServersFromConfig('{\n // c\n "mcp": {"a": {}, "b": {}}}'), ['a', 'b'])
  assert.deepEqual(mcpServersFromConfig('nope'), [])
  assert.deepEqual(mcpServersFromConfig(undefined), [])
  const gate = { skills: { on: [], nameOnly: [], off: ['nestjs'], preload: [] }, off: false } as unknown as Gate
  assert.deepEqual(skillPermissionRules(gate), [{ action: 'skill', resource: 'nestjs', effect: 'deny' }])
  assert.deepEqual(skillPermissionRules({ ...gate, shadow: true }), [])
})

test('opencode prompt: [gate:x] stripped, preload attached once via prompt.skills, decision journaled', () => {
  const t = setup({ CONTEXT_GATE_MODEL: 'claude-haiku-4-5', CONTEXT_GATE_MODE: 'auto' })
  const e = t.prompt('[gate:frontend] fix the button')
  assert.equal(e.prompt.text, 'fix the button')
  assert.deepEqual(e.prompt.skills, [{ id: 'tdd' }])
  const d = t.log.find((x) => x.kind === 'decision')!
  assert.equal(d.profile, 'frontend')
  assert.equal(d.tier, 'quick')
  assert.equal(d.data?.adapter, 'opencode')
  const e2 = t.prompt('next')
  assert.equal(e2.prompt.skills, undefined, 'preload only once per context')
  t.f.trigger('session.compaction', { sessionID: 's1', system: [], tools: {} })
  assert.deepEqual(t.prompt('after compaction').prompt.skills, [{ id: 'tdd' }])
})

test('opencode context: Always rules + status pushed to system, off MCP tools hidden', () => {
  const t = setup({ CONTEXT_GATE_PROFILE: 'frontend', CONTEXT_GATE_MODEL: 'claude-haiku-4-5' })
  t.prompt('go')
  const e = t.context()
  assert.equal(e.system[0], 'base')
  const text = String(e.system[1])
  assert.match(text, /^context-gate: gate frontend · tier quick/)
  assert.match(text, /Cursor rule project\):\nЗавжди pnpm\./)
  assert.doesNotMatch(text, /Preloaded skill/, 'preload went through prompt.skills')
  assert.deepEqual(Object.keys(e.tools).sort(), ['figma_get', 'read'])
  assert.equal(t.log.filter((x) => x.kind === 'rule-delivered').length, 1)
  t.context()
  assert.equal(t.log.filter((x) => x.kind === 'rule-delivered').length, 1, 'Always delivery journaled once')
})

test('opencode context: a preload the first prompt missed (model unknown) is inlined until a prompt attaches it', () => {
  const t = setup({ CONTEXT_GATE_PROFILE: 'frontend' })
  assert.equal(t.prompt('go').prompt.skills, undefined, 'tier standard: no preload yet')
  const e = t.context('claude-haiku-4-5')
  assert.match(String(e.system[1]), /<!-- Preloaded skill: \.claude\/skills\/tdd\/SKILL\.md -->\nТест першим\./)
  assert.deepEqual(t.prompt('next').prompt.skills, [{ id: 'tdd' }])
  assert.doesNotMatch(String(t.context('claude-haiku-4-5').system[1]), /Preloaded skill/)
})

test('opencode context: a model change re-decides the tier', () => {
  const t = setup({ CONTEXT_GATE_PROFILE: 'frontend' })
  t.prompt('go')
  t.context('claude-haiku-4-5')
  const e = t.context('claude-opus-4-7')
  assert.match(String(e.system[1]), /tier premium/)
  const decisions = t.log.filter((x) => x.kind === 'decision')
  assert.equal(decisions.at(-1)?.tier, 'premium')
})

test('opencode shadow: nothing hidden or denied, decision marked shadow', () => {
  const t = setup({})
  t.prompt('go')
  const e = t.context()
  assert.equal(Object.keys(e.tools).length, 4)
  assert.ok(!String(e.system[1]).startsWith('context-gate:'))
  assert.equal(t.permission('skill', ['nestjs']).effect, 'allow')
  assert.equal(t.log.find((x) => x.kind === 'decision')?.data?.shadow, true)
  assert.equal(t.log.find((x) => x.kind === 'deny')?.data?.shadow, true)
})

test('opencode permission.evaluate: skills and MCP tools outside the profile are denied', () => {
  const t = setup({ CONTEXT_GATE_PROFILE: 'frontend' })
  t.prompt('go')
  const cases: { action: string; resources: string[]; effect: string; message?: RegExp }[] = [
    { action: 'skill', resources: ['nestjs'], effect: 'deny', message: /Skill nestjs вимкнено профілем frontend\. Увімкни: \[gate:backend\]/ },
    { action: 'skill', resources: ['react-components'], effect: 'allow' },
    { action: 'skill', resources: ['misc'], effect: 'allow' },
    { action: 'postgres_query', resources: ['*'], effect: 'deny', message: /postgres вимкнено профілем frontend/ },
    { action: 'figma_get', resources: ['*'], effect: 'allow' },
    { action: 'edit', resources: ['a.ts'], effect: 'allow' },
  ]
  for (const c of cases) {
    const e = t.permission(c.action, c.resources)
    assert.equal(e.effect, c.effect, `${c.action} ${c.resources}`)
    if (c.message) assert.match(e.message!, c.message)
  }
  assert.equal(t.log.filter((x) => x.kind === 'deny').length, 2)
})

test('opencode tool.execute.after: Auto rules appended to string and array content, once', () => {
  const t = setup({ CONTEXT_GATE_PROFILE: 'frontend' })
  t.prompt('go')
  const e1 = t.after('read', join(t.root, 'apps/web/A.tsx'))
  assert.match(String(e1.result!.content), /^file body\n\nContents of \.cursor\/rules\/react\.mdc \(Cursor rule react\):/)
  const e2 = t.after('write', 'apps/web/B.tsx', [{ type: 'text', text: 'ok' }])
  assert.deepEqual(e2.result!.content, [{ type: 'text', text: 'ok' }], 'already delivered')
  t.f.trigger('session.compaction', { sessionID: 's1', system: [], tools: {} })
  const e3 = t.after('edit', 'apps/web/B.tsx', [{ type: 'text', text: 'ok' }])
  assert.equal((e3.result!.content as unknown[]).length, 2)
  assert.equal(t.after('bash', 'apps/web/C.tsx').result!.content, 'file body', 'non-file tools untouched')
})

test('opencode sessions are independent', () => {
  const t = setup({ CONTEXT_GATE_PROFILE: 'frontend' })
  t.prompt('go', 's1')
  t.prompt('go', 's2')
  assert.match(String(t.after('read', 'apps/web/A.tsx').result!.content), /Cursor rule react/)
  const other = t.f.trigger<OcToolAfterEvent>('tool.execute.after', { tool: 'read', sessionID: 's2', input: { path: 'apps/web/A.tsx' }, status: 'completed', result: { content: '' } })
  assert.match(String(other.result!.content), /Cursor rule react/)
})

test('opencode default journal appends JSONL to .claude/gate.log.jsonl', () => {
  const t = setup({ CONTEXT_GATE_PROFILE: 'frontend' }, { journal: false })
  t.prompt('go')
  t.context()
  t.permission('skill', ['nestjs'])
  const { items } = fromJsonl<DecisionLogEntry>(readFileSync(join(t.root, '.claude', 'gate.log.jsonl'), 'utf8'))
  // The prompt hook has no model: tier standard until the first context hook reports claude-haiku (quick).
  assert.deepEqual(items.map((e) => [e.kind, e.tier]), [['decision', 'standard'], ['decision', 'quick'], ['rule-delivered', 'quick'], ['deny', 'quick']])
  assert.ok(items.every((e) => e.data?.adapter === 'opencode'))
})
