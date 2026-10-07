// `/gate` UI through `claude plugin test`: provenance in `/gate`, `/gate a | b` pipes in-mod, the health and
// section panes, `/gate edit` (browser editor via $.process.spawn), the `prompt ⚠ build` marker and the
// mod's `.claude/gate.index.json`.
import { describe, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

import { BAND_PROPS, ROOT, RUN, mountRepo, test } from './testkit.ts'

const CONFIG = {
  groups: { frontend: ['skill:react-*', 'tool:mcp__figma__*'], backend: ['skill:prisma', 'tool:mcp__postgres__*'], base: ['skill:tdd'] },
  tiers: { premium: { groups: [] }, standard: { groups: ['base'] }, quick: { groups: [] } },
  profiles: { frontend: { groups: ['frontend'], when: { paths: ['apps/web/**'] } }, backend: { groups: ['backend'] } },
}
const FILES = {
  '.claude/gate.json': JSON.stringify(CONFIG),
  '.claude/prompt/workflow.md': '---\nid: workflow\nscope: profile\n---\nПрацюй малими кроками на tier {{ gate.tier }}.\n',
  'apps/web/x.tsx': 'x',
}
const TOOLS = ['mcp__postgres__query', 'mcp__figma__get_file']
const LISTING = 'The following skills are available:\n- react-hooks: React hooks\n- prisma: Prisma ORM\n- tdd: Test-driven development'
const ENGINE = { kind: 'engine' } as const
const SLOW = { timeoutMs: 20_000 }
const PANE = { title: 'x', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }
const URL = 'http://127.0.0.1:43123/?t=abc'

/** The editor sources exist in the plugin folder (`mountRepo`'s `exists`). */
const EDITOR = (p: string): boolean | undefined => (p.endsWith('packages/editor-web/src/main.ts') ? true : undefined)

/** `$.process.spawn` prints the `{url}` line. */
function mountEditor(on: On): { spawned: (readonly string[])[] } {
  const spawned: (readonly string[])[] = []
  on('process.spawn', async function* (_$: unknown, e: { argv: readonly string[] }) {
    spawned.push(e.argv)
    yield { stream: 'stderr', text: 'starting\n' }
    yield { stream: 'stdout', text: JSON.stringify({ url: URL, port: 43123 }) + '\n' }
    // A `$` call answered by a test hook: the result is wrapped in `{ value }`, like `process.run` in testkit.
    return { value: { code: 0, signal: null } }
  } as never)
  return { spawned }
}

describe('/gate', () => {
  test('/gate shows where each enabled item comes from: manual, tier, the profile trigger', SLOW, async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS })
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    const s = await $.command.run({ command: 'gate', args: '+backend', ...RUN })
    expect(s.text).toContain('звідки:')
    expect(s.text).toContain('- manual frontend: frontend: skill:react-hooks, tool:mcp__figma__get_file')
    expect(s.text).toContain('- manual +backend: skill:prisma, tool:mcp__postgres__query')
    expect(s.text).toContain('- tier standard: base: skill:tdd')
  })

  test('/gate pipes run in the mod over the session items, live gate and journal', SLOW, async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS })
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    const front = await $.command.run({ command: 'gate', args: 'collect kind=skill | where group=frontend', ...RUN })
    expect(front.text).toMatch(/^1 запис:\n- skill:react-hooks — React hooks \(\d+ симв\.\)$/)
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    const off = await $.command.run({ command: 'gate', args: 'collect kind=skill | off', ...RUN })
    expect(off.text).toContain('- skill:prisma [off]')
    expect(off.text).not.toContain('react-hooks')
    const decided = await $.command.run({ command: 'gate', args: 'collect kind=tool | decide --profile backend | on', ...RUN })
    expect(decided.text).toContain('tool:mcp__postgres__query [on]')
    expect(decided.text).not.toContain('figma')
    const why = await $.command.run({ command: 'gate', args: 'why | where trigger=manual | take 1', ...RUN })
    expect(why.text).toContain('"trigger":"manual"')
    const section = await $.command.run({ command: 'gate', args: 'collect kind=section | render | preview', ...RUN })
    expect(section.text).toContain('Працюй малими кроками на tier standard.')
    const bad = await $.command.run({ command: 'gate', args: 'collect | frobnicate', ...RUN })
    expect(bad.text).toContain('G501')
  })

  test('/gate health opens the health pane: the table with «що зробити», and a re-render button', SLOW, async ($, on) => {
    mountRepo(on, { files: FILES })
    on('prompt.compose', () => ({ sections: [] }))
    const before = await $.command.run({ command: 'gate', args: 'health', ...RUN })
    expect(before.text).toContain('Відкрито pane «gate health».')
    expect(before.text).toContain('Рендера промпту ще не було')
    const ui = await $.ui.mount({ plugin: 'context-gate', surface: 'terminal', component: 'Pane', requestId: 'gate-health', props: PANE as never })
    expect(await ui.find({ key: 'rerender' })).toBeDefined()
    await ui.press({ key: 'rerender' })
    expect(await ui.find({ type: 'Markdown', text: /Що зробити/ })).toBeDefined()
    const after = await $.command.run({ command: 'gate', args: 'health', ...RUN })
    expect(after.text).toContain('| Код | Метрика |')
    await ui.unmount()
  })

  test('/gate render prompt://<id> opens the section pane; «перерендерити» and «відкрити в редакторі» work', SLOW, async ($, on) => {
    const ed = mountEditor(on)
    mountRepo(on, { files: FILES, exists: EDITOR })
    const r = await $.command.run({ command: 'gate', args: 'render prompt://workflow', ...RUN })
    expect(r.text).toContain('Відкрито pane секції.')
    expect(r.text).toContain('Працюй малими кроками на tier standard.')
    const ui = await $.ui.mount({ plugin: 'context-gate', surface: 'terminal', component: 'Pane', requestId: 'gate-section', props: PANE as never })
    expect(await ui.find({ type: 'Text', text: /^prompt:\/\/workflow · profile · tier standard · \d+ ток\./ })).toBeDefined()
    await ui.press({ key: 'rerender' })
    expect(await ui.find({ type: 'Markdown', text: /малими кроками/ })).toBeDefined()
    await ui.press({ key: 'edit' })
    expect(await ui.find({ type: 'Text', text: `Редактор: ${URL}` })).toBeDefined()
    expect(ed.spawned).toHaveLength(1)
    await ui.unmount()
    const missing = await $.command.run({ command: 'gate', args: 'render prompt://nope', ...RUN })
    expect(missing.text).toContain('Секцію nope не знайдено')
  })

  test('/gate edit <id> spawns the browser editor once and shows its URL', SLOW, async ($, on) => {
    const ed = mountEditor(on)
    mountRepo(on, { files: FILES, exists: EDITOR })
    const a = await $.command.run({ command: 'gate', args: 'edit workflow', ...RUN })
    expect(a.text).toBe(`Редактор workflow: ${URL}`)
    expect((await $.command.run({ command: 'gate', args: 'edit workflow', ...RUN })).text).toBe(`Редактор workflow: ${URL}`)
    const argv = ed.spawned[0] ?? []
    expect(argv[0]).toBe('node')
    expect(argv.slice(-5)).toEqual(['workflow', '--root', ROOT, '--json', '--no-stdin-watch'])
    const bad = await $.command.run({ command: 'gate', args: 'edit ../x', ...RUN })
    expect(bad.text).toContain('G505')
  })

  test('/gate edit without the editor in the plugin folder explains why', SLOW, async ($, on) => {
    mountRepo(on, { files: FILES })
    const r = await $.command.run({ command: 'gate', args: 'edit workflow', ...RUN })
    expect(r.text).toContain('Редактор не знайдено')
  })

  test('a failed prompt build marks the band and the status line `prompt ⚠ build`', { ...SLOW, options: { trustBuild: 'always' } }, async ($, on) => {
    const repo = mountRepo(on, { files: FILES, exists: (p) => (p.endsWith('dist/cli.js') ? true : undefined), run: () => ({ exitCode: 1, stdout: '', stderr: 'G001 main.prompt.tsx: syntax error' }) })
    const r = await $.command.run({ command: 'gate', args: 'build', ...RUN })
    expect(r.text).toContain('H013')
    expect(repo.statuses.some((s) => (s ?? '').includes('prompt ⚠ build'))).toBe(true)
    const ui = await $.ui.mount({ plugin: 'context-gate', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: /· prompt ⚠ build$/ })).toBeDefined()
    await ui.unmount()
    const h = await $.command.run({ command: 'gate', args: 'health', ...RUN })
    expect(h.text).toContain('prompt ⚠ build: G001')
  })
})

describe('gate.index.json', () => {
  test('session.start writes the index with the session fields; the skill listing and /gate refresh it', SLOW, async ($, on) => {
    const repo = mountRepo(on, { files: FILES, tools: [...TOOLS, 'Read'] })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const read = (): Record<string, unknown> => JSON.parse(repo.files.get('.claude/gate.index.json')?.text ?? '{}') as Record<string, unknown>
    const ix = read()
    expect(ix.generatedBy).toBe('context-gate mod')
    expect(Object.keys(ix.profiles as object)).toEqual(['frontend', 'backend'])
    expect((ix.sections as { id: string }[]).map((s) => s.id)).toContain('workflow')
    const session = ix.session as { tools: { name: string }[]; mcpServers: string[]; skills: unknown[]; tier: string }
    expect(session.mcpServers).toEqual(['figma', 'postgres'])
    expect(session.tools.map((t) => t.name)).toContain('Read')
    expect(session.skills).toEqual([])
    expect((ix.vars as Record<string, { type: string }>).gate.type).toBe('object')
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    await $.command.run({ command: 'gate', args: 'backend', ...RUN })
    const after = read()
    expect((after.session as { skills: { name: string }[]; profile?: string }).skills.map((s) => s.name)).toEqual(['react-hooks', 'prisma', 'tdd'])
    expect((after.session as { profile?: string }).profile).toBe('backend')
    expect((after.items as { id: string }[]).map((i) => i.id)).toContain('skill:prisma')
    expect(JSON.stringify(after)).not.toContain('Працюй малими кроками')
  })

  test('no index in a repo without gate.json or a prompt dir', SLOW, async ($, on) => {
    const repo = mountRepo(on, { files: { 'src/a.ts': 'x' } })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'gate', args: '', ...RUN })
    expect(repo.files.has('.claude/gate.index.json')).toBe(false)
  })
})
