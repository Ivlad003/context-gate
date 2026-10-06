// Layer 1 (cursor-rules) through the engine's own host: `claude plugin test` (npm run test:mod).
import { describe, expect, test } from 'claude-code/testing'

import { ROOT, RULES, RUN, mountRepo } from './testkit.ts'

const READ_RESULT = { type: 'text', file: { filePath: `${ROOT}/src/a.ts`, content: 'x', numLines: 1, startLine: 1, totalLines: 1 } }

describe('cursor-rules', () => {
  test('Always rule lands in prompt.context instruction files after CLAUDE.md', async ($, on) => {
    mountRepo(on, { files: RULES })
    on('prompt.context', ($, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
    const r = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'CLAUDE' }], instructionFiles: [] })
    expect(r.instructionFiles?.map((f) => f.path)).toEqual([`${ROOT}/.cursor/rules/base.mdc`])
    expect(r.instructionFiles?.[0]?.content).toBe('Завжди пиши тести.')
  })

  test('Always rule falls back to a cursorRules block right after claudeMd', async ($, on) => {
    mountRepo(on, { files: RULES })
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    const r = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'CLAUDE' }, { name: 'currentDate', text: 'today' }] })
    expect(r.blocks.map((b) => b.name)).toEqual(['claudeMd', 'cursorRules', 'currentDate'])
    expect(r.blocks[1]?.text).toContain('Contents of .cursor/rules/base.mdc (Cursor rule base):')
  })

  test('glob rule arrives as context after Read, once per agent', async ($, on) => {
    mountRepo(on, { files: { ...RULES, 'src/a.ts': 'x' } })
    on('tool.call', () => ({ result: READ_RESULT }) as never)
    const first = await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/src/a.ts` })
    expect(first.context?.join('\n')).toContain('Contents of .cursor/rules/ts.mdc (Cursor rule ts):')
    const again = await $.tool.call({ tool: 'Read', tool_use_id: 't2', file_path: `${ROOT}/src/a.ts` })
    expect(again.context ?? []).toEqual([])
    const sub = await $.tool.call({ tool: 'Read', tool_use_id: 't3', file_path: `${ROOT}/src/a.ts`, agentId: 'agent-1' } as never)
    expect(sub.context?.join('\n')).toContain('Cursor rule ts')
  })

  test('a file outside the globs gets no rule; NotebookEdit matches by notebook_path', async ($, on) => {
    mountRepo(on, { files: { ...RULES, '.cursor/rules/nb.mdc': '---\nglobs: "*.ipynb"\n---\nНоутбуки: чисті виходи.', 'docs/x.md': 'x' } })
    on('tool.call', () => ({ result: READ_RESULT }) as never)
    const md = await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/docs/x.md` })
    expect(md.context ?? []).toEqual([])
    const nb = await $.tool.call({ tool: 'NotebookEdit', tool_use_id: 't2', notebook_path: `${ROOT}/nb/a.ipynb`, new_source: 'x' })
    expect(nb.context?.join('\n')).toContain('Cursor rule nb')
  })

  test('a partial Read of the .mdc is no delivery; a full one is', async ($, on) => {
    mountRepo(on, { files: { ...RULES, 'src/a.ts': 'x' } })
    on('tool.call', () => ({ result: READ_RESULT }) as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/.cursor/rules/ts.mdc`, limit: 2 })
    const afterPartial = await $.tool.call({ tool: 'Read', tool_use_id: 't2', file_path: `${ROOT}/src/a.ts`, agentId: 'a' } as never)
    expect(afterPartial.context?.join('\n')).toContain('Cursor rule ts')
    await $.tool.call({ tool: 'Read', tool_use_id: 't3', file_path: `${ROOT}/.cursor/rules/ts.mdc`, agentId: 'b' } as never)
    const afterFull = await $.tool.call({ tool: 'Read', tool_use_id: 't4', file_path: `${ROOT}/src/a.ts`, agentId: 'b' } as never)
    expect(afterFull.context ?? []).toEqual([])
  })

  test('prompt.context resets the dedup so rules are delivered again', async ($, on) => {
    mountRepo(on, { files: { ...RULES, 'src/a.ts': 'x' } })
    on('tool.call', () => ({ result: READ_RESULT }) as never)
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/src/a.ts` })
    await $.prompt.context({ blocks: [] })
    const r = await $.tool.call({ tool: 'Read', tool_use_id: 't2', file_path: `${ROOT}/src/a.ts` })
    expect(r.context?.join('\n')).toContain('Cursor rule ts')
  })

  test('@rule and @file mentions become prompt context', async ($, on) => {
    mountRepo(on, { files: RULES })
    let seen: readonly string[] = []
    on('prompt.submit', ($, e) => {
      seen = e.context ?? []
      return { text: e.text }
    })
    await $.prompt.submit({ text: 'глянь @src/b.ts і застосуй @style', wait: false, origin: { kind: 'composer' } })
    const all = seen.join('\n')
    expect(all).toContain('Cursor rule ts')
    expect(all).toContain('Contents of .cursor/rules/style.mdc (Cursor rule style):')
  })

  test('/rule <id> returns the rule as context; unknown ids list Manual rules', async ($) => {
    const r = await $.command.run({ command: 'rule', args: 'style', ...RUN })
    expect(r.text).toBe('Правило «style» не знайдено. Використання: /rule <id>')
  })

  test('/rule style with rules on disk', async ($, on) => {
    mountRepo(on, { files: RULES })
    const r = await $.command.run({ command: 'rule', args: 'style', ...RUN })
    expect(r.text).toBe('Застосовано правило style')
    expect(r.context?.[0]).toContain('Стиль коміту: conventional commits.')
    const u = await $.command.run({ command: 'rule', args: 'nope', ...RUN })
    expect(u.text).toContain('Manual/Agent-правила: api, style')
  })

  test('strictWrite denies a Write of a new file with an undelivered rule', async ($, on) => {
    mountRepo(on, { files: { ...RULES, '.claude/gate.json': JSON.stringify({ cursorRules: { strictWrite: true } }) } })
    on('tool.call', () => ({ result: { type: 'create', filePath: `${ROOT}/src/new.ts`, content: 'x' } }) as never)
    const r = await $.tool.call({ tool: 'Write', tool_use_id: 't1', file_path: `${ROOT}/src/new.ts`, content: 'x' })
    expect(r.deny).toContain('Повтори запис з урахуванням правила')
    expect(r.deny).toContain('Cursor rule ts')
    const again = await $.tool.call({ tool: 'Write', tool_use_id: 't2', file_path: `${ROOT}/src/new.ts`, content: 'x' })
    expect(again.deny).toBeUndefined()
  })

  test('.claude/rules/cursor present → layer off, noted for /gate why', async ($, on) => {
    mountRepo(on, { files: { ...RULES, '.claude/rules/cursor/base.md': 'x', 'src/a.ts': 'x' } })
    on('tool.call', () => ({ result: READ_RESULT }) as never)
    const r = await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/src/a.ts` })
    expect(r.context ?? []).toEqual([])
    const why = await $.command.run({ command: 'gate', args: 'why', ...RUN })
    expect(why.text).toContain('.claude/rules/cursor/ існує')
  })
})
