// Lifecycle events through `claude plugin test` (SPEC "Тести": one test per event of the map):
// classic.SessionStart, session.end {clear}, session.compact, classic.FileChanged, turn.step.
import { describe, expect, test, type Engine } from 'claude-code/testing'

import { ROOT, RULES, RUN, mountRepo } from './testkit.ts'

const CONFIG = {
  groups: { frontend: ['skill:react-*', 'tool:mcp__figma__*'], backend: ['skill:prisma', 'tool:mcp__postgres__*'] },
  tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [] } },
  profiles: { frontend: { groups: ['frontend'] }, backend: { groups: ['backend'] } },
  classify: { mode: 'shadow', recheckOn: ['/gate new', 'compact'] },
}
const FILES = { '.claude/gate.json': JSON.stringify(CONFIG), 'src/a.ts': 'x', ...RULES }
const ORIGIN = { kind: 'composer' } as const
/** The first test of a file also pays the module load; a loaded machine needs more than the default 5 s. */
const SLOW = { timeoutMs: 20_000 }
const MSGS = [{ role: 'user', text: 'привіт', toolUses: [] }]
const USAGE = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 300, cache_creation_input_tokens: 100, model: 'claude-sonnet-4-5' }

async function readAts($: Engine, id: string): Promise<readonly string[]> {
  const r = await $.tool.call({ tool: 'Read', tool_use_id: id, file_path: `${ROOT}/src/a.ts` })
  return 'context' in r ? (r.context ?? []) : []
}

describe('lifecycle', () => {
  test('classic.SessionStart: watchPaths list gate.json, the .mdc files and the prompt dir', SLOW, async ($, on) => {
    mountRepo(on, { files: { ...FILES, '.claude/prompt/main.md': '---\nid: main\n---\nhi' } })
    on('classic.SessionStart', () => ({ watchPaths: ['/other'] }) as never)
    const r = await $.classic.SessionStart({ source: 'startup' } as never)
    const watch = (r as { watchPaths?: string[] }).watchPaths ?? []
    expect(watch[0]).toBe('/other')
    expect(watch).toContain(`${ROOT}/.claude/gate.json`)
    expect(watch).toContain(`${ROOT}/.cursor/rules/ts.mdc`)
    expect(watch).toContain(`${ROOT}/.claude/prompt/main.md`)
  })

  test('classic.SessionStart {source: clear} resets the dedup: a rule is delivered again', SLOW, async ($, on) => {
    mountRepo(on, { files: FILES })
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('classic.SessionStart', () => ({}) as never)
    expect((await readAts($, 't1')).join()).toContain('TypeScript: strict')
    expect(await readAts($, 't2')).toHaveLength(0)
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect((await readAts($, 't3')).join()).toContain('TypeScript: strict')
  })

  test('classic.SessionStart {source: compact} with recheckOn compact reclassifies on the next prompt', SLOW, async ($, on) => {
    const repo = mountRepo(on, { files: FILES, complete: () => '{"profile":"backend","confidence":0.9}' })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('classic.SessionStart', () => ({}) as never)
    await $.prompt.submit({ text: 'додай таблицю', wait: false, origin: ORIGIN })
    await $.prompt.submit({ text: 'ще одна', wait: false, origin: ORIGIN })
    const before = repo.completes.length
    await $.classic.SessionStart({ source: 'compact' } as never)
    await $.prompt.submit({ text: 'після компакції', wait: false, origin: ORIGIN })
    expect(repo.completes.length).toBe(before + 1)
  })

  test('session.end {reason: clear} resets the dedup', SLOW, async ($, on) => {
    mountRepo(on, { files: FILES })
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
    await readAts($, 't1')
    expect(await readAts($, 't2')).toHaveLength(0)
    await $.session.end({ reason: 'clear', sessionId: 's', resume: false } as never)
    expect((await readAts($, 't3')).join()).toContain('TypeScript: strict')
    const rules = await $.command.run({ command: 'gate', args: 'rules', ...RUN })
    expect(rules.text).toContain('ts')
  })

  test('session.end with another reason keeps the dedup', SLOW, async ($, on) => {
    mountRepo(on, { files: FILES })
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
    await readAts($, 't1')
    await $.session.end({ reason: 'other', sessionId: 's', resume: false } as never)
    expect(await readAts($, 't2')).toHaveLength(0)
  })

  test('session.compact: the instructions keep the profile, tier and delivered rules; precompute passes through', SLOW, async ($, on) => {
    mountRepo(on, { files: FILES })
    on('tool.call', () => ({ result: 'ok' }) as never)
    const seen: (string | undefined)[] = []
    on('session.compact', ($, e) => {
      seen.push(e.instructions)
      return { messages: e.messages } as never
    })
    await $.command.run({ command: 'gate', args: 'backend', ...RUN })
    await readAts($, 't1')
    await $.session.compact({ trigger: 'manual', instructions: 'стисло', messages: MSGS } as never)
    expect(seen[0]).toContain('стисло')
    expect(seen[0]).toContain('активний профіль backend')
    expect(seen[0]).toContain('tier standard')
    expect(seen[0]).toContain('ts')
    await $.session.compact({ trigger: 'precompute', instructions: 'x', messages: MSGS } as never)
    expect(seen[1]).toBe('x')
  })

  test('classic.FileChanged on a .mdc drops the rules cache: the new body is delivered', SLOW, async ($, on) => {
    const repo = mountRepo(on, { files: FILES })
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('classic.FileChanged', () => ({}) as never)
    expect((await $.command.run({ command: 'gate', args: 'rules', ...RUN })).text).toContain('ts')
    repo.files.set('.cursor/rules/ts.mdc', { text: '---\nglobs: src/**/*.ts\nalwaysApply: false\n---\nНове правило TS.', mtimeMs: 5000 })
    await $.classic.FileChanged({ file_path: `${ROOT}/.cursor/rules/ts.mdc`, event: 'change' } as never)
    expect((await readAts($, 't1')).join()).toContain('Нове правило TS.')
  })

  test('classic.FileChanged on gate.json reloads the config (a new profile is accepted) and rewrites the index', SLOW, async ($, on) => {
    const repo = mountRepo(on, { files: FILES })
    on('classic.FileChanged', () => ({}) as never)
    expect((await $.command.run({ command: 'gate', args: 'docs', ...RUN })).text).toContain('G502')
    const cfg = { ...CONFIG, groups: { ...CONFIG.groups, docs: ['skill:docs-*'] }, profiles: { ...CONFIG.profiles, docs: { groups: ['docs'] } } }
    repo.files.set('.claude/gate.json', { text: JSON.stringify(cfg), mtimeMs: 6000 })
    await $.classic.FileChanged({ file_path: `${ROOT}/.claude/gate.json`, event: 'change' } as never)
    const ix = JSON.parse(repo.files.get('.claude/gate.index.json')?.text ?? '{}') as { profiles?: Record<string, unknown> }
    expect(Object.keys(ix.profiles ?? {})).toContain('docs')
    expect((await $.command.run({ command: 'gate', args: 'docs', ...RUN })).text).toContain('gate docs ·')
  })

  test('turn.step: a model change → tier quick → recompute (journal model-change); a subagent gets its own tier', SLOW, async ($, on) => {
    const cfg = { ...CONFIG, gates: [{ name: 'read-before-write', on: 'write', builtin: true }] }
    mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg) } })
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE } as never
    })
    const step = async (model: string, agentId?: string): Promise<void> => {
      const s = $.turn.step({ turnId: 't', index: 0, model, messageCount: 1, ...(agentId ? { agentId } : {}) })
      for await (const _ of s) { /* drain */ }
      await s.result
    }
    await step('claude-sonnet-4-5')
    await step('claude-haiku-4-5')
    const status = await $.command.run({ command: 'gate', args: '', ...RUN })
    expect(status.text).toContain('tier quick')
    const why = await $.command.run({ command: 'gate', args: 'why', ...RUN })
    expect(why.text).toContain('model-change')
    await step('claude-opus-4-5', 'agent-1')
    // read-before-write is off on premium: the opus subagent may edit an unread file, the quick main loop may not.
    const edit = (agentId?: string) => $.tool.call({ tool: 'Edit', tool_use_id: `e${agentId ?? 'main'}`, file_path: `${ROOT}/src/a.ts`, old_string: 'x', new_string: 'y', ...(agentId ? { agentId } : {}) } as never)
    expect((await edit('agent-1')).deny).toBeUndefined()
    expect((await edit()).deny).toContain('read-before-write')
    const after = await $.command.run({ command: 'gate', args: '', ...RUN })
    expect(after.text).toContain('tier quick')
    // turn.step usage (main loop only) reaches /gate health: 300 of 500 input tokens from the cache.
    const health = await $.command.run({ command: 'gate', args: 'health', ...RUN })
    expect(health.text).toContain('кроків 2, кеш промпту 60%')
  })
})
