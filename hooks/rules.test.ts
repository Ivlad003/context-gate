// Layer 1 (cursor-rules) through the engine's own host: `claude plugin test` (npm run test:mod).
import { describe, expect, test } from 'claude-code/testing'

import { ROOT, RULES, RUN, mountRepo } from './testkit.ts'

const READ_RESULT = { type: 'text', file: { filePath: `${ROOT}/src/a.ts`, content: 'x', numLines: 1, startLine: 1, totalLines: 1 } }

describe('cursor-rules', () => {
  test('Always rule lands in prompt.context instruction files after CLAUDE.md', { timeoutMs: 20_000 }, async ($, on) => {
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

const SLOW = { timeoutMs: 20_000 }

/** Journal lines from `.claude/gate.log.jsonl` (written with `log.file: true`, flushed on session.end). */
async function journalOf($: { session: { end(e: never): Promise<unknown> } }, files: Map<string, { text: string }>): Promise<Record<string, unknown>[]> {
  await $.session.end({ reason: 'other', sessionId: 's', resume: false } as never)
  const text = files.get('.claude/gate.log.jsonl')?.text ?? ''
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('rule sources and delivery journal (G-04, G-05, G-06, G-51)', () => {
  test('every delivery is journaled: Always, Auto per agent, @file, @mention, /rule', SLOW, async ($, on) => {
    const repo = mountRepo(on, { files: { ...RULES, 'src/a.ts': 'x', '.claude/gate.json': JSON.stringify({ log: { file: true } }) } })
    on('tool.call', () => ({ result: READ_RESULT }) as never)
    on('prompt.context', ($, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
    await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'C' }], instructionFiles: [] })
    await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/src/a.ts`, agentId: 'agent-7' } as never)
    await $.prompt.submit({ text: 'глянь @src/b.ts і @style', wait: false, origin: { kind: 'composer' } })
    await $.command.run({ command: 'rule', args: 'api', ...RUN })
    const delivered = (await journalOf($ as never, repo.files)).filter((e) => e.kind === 'rule-delivered').map((e) => {
      const d = e.data as { ruleId: string; agent: string }
      return `${e.trigger}:${d.ruleId}:${d.agent}`
    })
    expect(delivered).toEqual(['prompt.context:base:main', 'tool.call:ts:agent-7', '@file:ts:main', '@mention:style:main', '/rule:api:main'])
  })

  test('/gate rules: one row per rule with type, globs and delivered yes/no per agent', SLOW, async ($, on) => {
    mountRepo(on, { files: { ...RULES, 'src/a.ts': 'x' } })
    on('tool.call', () => ({ result: READ_RESULT }) as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/src/a.ts`, agentId: 'sub-1' } as never)
    const r = await $.command.run({ command: 'gate', args: 'rules', ...RUN })
    expect(r.text).toContain('- `ts` · Auto Attached · globs src/**/*.ts · доставлено: main — ні, sub-1 — так')
    expect(r.text).toContain('- `base` · Always · доставлено: main — ні, sub-1 — ні')
    expect(r.text).toContain('- `style` · Manual')
  })

  test('custom cursor-mdc dir and a markdown-dir source deliver like .cursor/rules', SLOW, async ($, on) => {
    const cfg = { itemSources: [{ kind: 'cursor-mdc', dir: 'rules/cursor' }, { kind: 'markdown-dir', dir: 'docs/rules', frontmatter: { paths: 'globs' } }] }
    mountRepo(on, {
      files: {
        '.claude/gate.json': JSON.stringify(cfg),
        'rules/cursor/py.mdc': '---\nglobs: "*.py"\n---\nPython: типи всюди.',
        'docs/rules/api.md': '---\ntitle: API\npaths: src/api/**\n---\nREST: множина в URL.',
        'src/api/x.ts': 'x',
      },
    })
    on('tool.call', () => ({ result: READ_RESULT }) as never)
    const py = await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/tools/a.py` })
    expect(py.context?.join('\n')).toContain('Contents of rules/cursor/py.mdc (Cursor rule py):')
    const api = await $.tool.call({ tool: 'Read', tool_use_id: 't2', file_path: `${ROOT}/src/api/x.ts` })
    expect(api.context?.join('\n')).toContain('Contents of docs/rules/api.md (rule api):\nREST: множина в URL.')
    const rules = await $.command.run({ command: 'gate', args: 'rules', ...RUN })
    expect(rules.text).toContain('`api` · Auto Attached · globs src/api/** · джерело markdown-dir')
  })

  test('a provider source turns provider data into Always rules (cursorRules block, not instruction files)', SLOW, async ($, on) => {
    const cfg = {
      providers: { arch: { kind: 'file', path: 'arch.json' } },
      itemSources: [{ kind: 'provider', name: 'arch', field: 'deny', as: 'always', template: '{{ item.from }} не імпортує {{ item.to }}' }],
    }
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), 'arch.json': JSON.stringify({ deny: [{ from: 'domain', to: 'infra' }] }) } })
    on('prompt.context', ($, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
    const r = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'C' }], instructionFiles: [] })
    expect(r.instructionFiles ?? []).toEqual([])
    expect(r.blocks.map((b) => b.name)).toEqual(['claudeMd', 'cursorRules'])
    expect(r.blocks[1]?.text).toBe('Contents of provider:arch (rule arch/0):\ndomain не імпортує infra')
  })
})
