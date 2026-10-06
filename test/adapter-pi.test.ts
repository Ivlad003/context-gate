import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPiAdapter } from '../packages/adapters/pi/index.ts'
import { onInput, piModelRef, skillItems } from '../packages/adapters/pi/plan.ts'
import { newSession } from '../packages/adapters/common/session.ts'
import type { PiBeforeAgentStartEvent, PiContext, PiExtensionAPI, PiSkill, PiToolResultEvent } from '../packages/adapters/pi/types.ts'
import type { DecisionLogEntry } from '../packages/core/src/types.ts'
import { fromJsonl } from '../packages/core/src/journal.ts'
import { tmpRepo } from './adapter-fixture.ts'

type AnyHandler = (event: unknown, ctx: PiContext) => unknown

/** A fake pi: records `pi.on` handlers and lets the test emit events. */
function fakePi() {
  const handlers = new Map<string, AnyHandler[]>()
  const api = { on: (name: string, h: AnyHandler) => { handlers.set(name, [...(handlers.get(name) ?? []), h]) } } as unknown as PiExtensionAPI
  const emit = (name: string, event: unknown, ctx: PiContext): unknown => {
    let out: unknown
    for (const h of handlers.get(name) ?? []) out = h(event, ctx) ?? out
    return out
  }
  return { api, emit, handlers }
}

function setup(env: Record<string, string>, opts: { journal?: boolean } = {}) {
  const { root, home } = tmpRepo('cg-pi-')
  const log: DecisionLogEntry[] = []
  const factory = createPiAdapter({ env: { HOME: home, ...env }, home, now: () => 1000, ...(opts.journal === false ? {} : { journal: (_r, e) => { log.push(...e) } }) })
  const pi = fakePi()
  factory(pi.api)
  const ctx: PiContext = { cwd: root, hasUI: false, model: { provider: 'anthropic', id: 'claude-haiku-4-5' }, ui: { notify: () => {} } }
  const skills: PiSkill[] = ['tdd', 'react-components', 'nestjs', 'misc'].map((n) => ({ name: n, description: `${n} skill`, filePath: join(root, '.claude', 'skills', n, 'SKILL.md') }))
  const agentStart = (prompt: string): { event: PiBeforeAgentStartEvent; result: unknown } => {
    const event: PiBeforeAgentStartEvent = { type: 'before_agent_start', prompt, systemPromptOptions: { cwd: root, appendSystemPrompt: '', sections: {}, skills: skills.map((s) => ({ ...s })) } }
    const result = pi.emit('before_agent_start', event, ctx)
    return { event, result }
  }
  const read = (path: string): unknown => {
    const event: PiToolResultEvent = { type: 'tool_result', toolCallId: 't1', toolName: 'read', input: { path }, content: [{ type: 'text', text: 'file body' }], isError: false }
    return pi.emit('tool_result', event, ctx)
  }
  const call = (toolName: string): unknown => pi.emit('tool_call', { type: 'tool_call', toolCallId: 't2', toolName, input: {} }, ctx)
  return { root, pi, ctx, log, agentStart, read, call }
}

test('pi plan helpers: skill items and model ref', () => {
  const items = skillItems([{ name: 'tdd', description: 'd', filePath: '/r/.claude/skills/tdd/SKILL.md' }])
  assert.equal(items[0].id, 'skill:tdd')
  assert.equal(items[0].provenance.path, '/r/.claude/skills/tdd/SKILL.md')
  assert.equal(piModelRef({ model: { provider: 'anthropic', id: 'claude-haiku-4-5' } }), 'anthropic/claude-haiku-4-5')
  assert.equal(piModelRef({ model: undefined }), undefined)
  const s = newSession()
  assert.equal(onInput(s, 'just text'), undefined)
  assert.equal(onInput(s, '[gate:backend] do it'), 'do it')
  assert.deepEqual(s.manual, { profile: 'backend' })
})

test('pi before_agent_start: skills filtered, Always rules + status + preload in the context-gate section', () => {
  const t = setup({ CONTEXT_GATE_PROFILE: 'frontend' })
  const { event, result } = t.agentStart('fix the button')
  const names = event.systemPromptOptions.skills.map((s) => s.name)
  assert.deepEqual(names, ['tdd', 'react-components', 'misc'], 'nestjs (backend group) removed, ungrouped misc kept')
  const section = event.systemPromptOptions.sections['context-gate']
  assert.match(section, /^context-gate: gate frontend · tier quick/)
  assert.match(section, /Contents of \.cursor\/rules\/project\.mdc \(Cursor rule project\):\nЗавжди pnpm\./)
  assert.match(section, /<!-- Preloaded skill: \.claude\/skills\/tdd\/SKILL\.md -->\nТест першим\./)
  assert.equal(result, undefined)
  const decision = t.log.find((e) => e.kind === 'decision')!
  assert.equal(decision.profile, 'frontend')
  assert.equal(decision.tier, 'quick')
  assert.equal(decision.data?.adapter, 'pi')
  assert.deepEqual(t.log.find((e) => e.kind === 'rule-delivered')?.data?.rules, ['project'])

  // Next turn: same text in the system prompt, nothing new journaled.
  t.log.length = 0
  const again = t.agentStart('and the label')
  assert.equal(again.event.systemPromptOptions.sections['context-gate'], section)
  assert.deepEqual(t.log, [])
})

test('pi tool_result: Auto Attached rule appended once per context, again after compaction', () => {
  const t = setup({ CONTEXT_GATE_PROFILE: 'frontend' })
  t.agentStart('go')
  const r1 = t.read(join(t.root, 'apps/web/Button.tsx')) as { content: { text: string }[] }
  assert.equal(r1.content.length, 2)
  assert.equal(r1.content[0].text, 'file body')
  assert.match(r1.content[1].text, /Cursor rule react\):\nКомпоненти — функції\./)
  assert.equal(t.read('apps/web/Other.tsx'), undefined, 'dedup')
  assert.equal(t.read('README.md'), undefined, 'no match')
  const delivered = t.log.filter((e) => e.kind === 'rule-delivered' && e.trigger === 'tool:read')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].data?.path, 'apps/web/Button.tsx')
  t.pi.emit('session_compact', { type: 'session_compact' }, t.ctx)
  assert.ok(t.read('apps/web/Other.tsx'), 'redelivered after compaction')
})

test('pi tool_call: MCP outside the profile is blocked when applied, only logged in shadow', () => {
  const cases: { env: Record<string, string>; tool: string; blocked: boolean; shadow?: boolean }[] = [
    { env: { CONTEXT_GATE_PROFILE: 'frontend' }, tool: 'mcp__postgres__query', blocked: true },
    { env: { CONTEXT_GATE_PROFILE: 'frontend' }, tool: 'mcp__figma__get', blocked: false },
    { env: { CONTEXT_GATE_PROFILE: 'frontend' }, tool: 'bash', blocked: false },
    { env: {}, tool: 'mcp__postgres__query', blocked: false, shadow: true },
    { env: { CONTEXT_GATE_PROFILE: 'frontend', CONTEXT_GATE_OFF: '1' }, tool: 'mcp__postgres__query', blocked: false },
  ]
  for (const c of cases) {
    const t = setup(c.env)
    t.agentStart('go')
    const r = t.call(c.tool) as { block?: boolean; reason?: string } | undefined
    assert.equal(!!r?.block, c.blocked, `${c.tool} ${JSON.stringify(c.env)}`)
    if (c.blocked) {
      assert.match(r!.reason!, /postgres вимкнено профілем frontend/)
      assert.match(r!.reason!, /\[gate:backend\]/)
    }
    const deny = t.log.find((e) => e.kind === 'deny')
    if (c.blocked || c.shadow) assert.equal(deny?.data?.shadow, !!c.shadow, c.tool)
    else assert.equal(deny, undefined)
  }
})

test('pi shadow mode filters nothing but still delivers rules', () => {
  const t = setup({})
  const { event } = t.agentStart('go')
  assert.equal(event.systemPromptOptions.skills.length, 4)
  const section = event.systemPromptOptions.sections['context-gate']
  assert.ok(!section.startsWith('context-gate:'), 'no status line in shadow')
  assert.match(section, /Завжди pnpm\./)
  assert.equal(t.log.find((e) => e.kind === 'decision')?.data?.shadow, true)
})

test('pi input [gate:x] switches the profile; @file mentions bring their Auto rules as a hidden message', () => {
  const t = setup({ CONTEXT_GATE_MODE: 'auto' })
  const tr = t.pi.emit('input', { type: 'input', text: '[gate:backend] add an endpoint' }, t.ctx)
  assert.deepEqual(tr, { action: 'transform', text: 'add an endpoint' })
  assert.deepEqual(t.pi.emit('input', { type: 'input', text: 'plain' }, t.ctx), { action: 'continue' })
  const { event } = t.agentStart('add an endpoint, see @apps/web/Form.tsx')
  assert.deepEqual(event.systemPromptOptions.skills.map((s) => s.name), ['tdd', 'nestjs', 'misc'])
  assert.match(event.systemPromptOptions.sections['context-gate'], /gate backend/)
  const { result } = t.agentStart('again @apps/web/Form.tsx')
  assert.equal(result, undefined, 'mention rule delivered once')
})

test('pi @file mention on the first turn returns a hidden custom message', () => {
  const t = setup({ CONTEXT_GATE_PROFILE: 'frontend' })
  const { result } = t.agentStart('look at @apps/web/Form.tsx')
  const m = (result as { message: { customType: string; content: string; display: boolean } }).message
  assert.equal(m.customType, 'context-gate')
  assert.equal(m.display, false)
  assert.match(m.content, /Компоненти — функції\./)
})

test('pi default journal appends JSONL to .claude/gate.log.jsonl', () => {
  const t = setup({ CONTEXT_GATE_PROFILE: 'frontend' }, { journal: false })
  t.agentStart('go')
  t.call('mcp__postgres__query')
  const { items, bad } = fromJsonl<DecisionLogEntry>(readFileSync(join(t.root, '.claude', 'gate.log.jsonl'), 'utf8'))
  assert.equal(bad, 0)
  assert.deepEqual(items.map((e) => e.kind), ['decision', 'rule-delivered', 'deny'])
  assert.ok(items.every((e) => e.data?.adapter === 'pi'))
})
