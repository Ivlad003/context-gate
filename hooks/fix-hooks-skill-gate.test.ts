// Regressions of the 2026-10-06 review for layer 2 (hooks/layers/skill-gate.ts, commands.ts, ui.ts): turns vs
// recomputes (M21), shadow and `+g` (M20), prompt flags (M23), compaction (M24), invalid gate.json (M18),
// ungrouped MCP (O1), the context-window tier (M22), `when.expr` data (M19), skill invocations (M06, M07, M13),
// `/gate why <item>` (O7), the cost of classifier and brief (P5).
import { describe, expect } from 'claude-code/testing'

import { ROOT, RUN, mountRepo, sleep, test } from './testkit.ts'
import { refineGate } from './layers/skill-gate.ts'
import { CONFIG_MARK, bandProps } from './layers/ui.ts'
import { newRuntime, readOptions } from './ctx.ts'
import type { Gate, GateConfig, Item } from '../packages/core/src/types.ts'

const CONFIG = {
  groups: {
    frontend: ['skill:react-*', 'tool:mcp__figma__*', 'agent:ui-reviewer'],
    backend: ['skill:prisma', 'tool:mcp__postgres__*', 'agent:db-agent'],
    docs: ['skill:tdd'],
  },
  tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [] } },
  profiles: {
    frontend: { groups: ['frontend'], when: { paths: ['apps/web/**'] } },
    backend: { groups: ['backend'] },
  },
}

const FILES = { '.claude/gate.json': JSON.stringify(CONFIG), 'apps/web/x.tsx': 'x', 'src/a.ts': 'x' }
const TOOLS = ['mcp__postgres__query', 'mcp__figma__get_file', 'mcp__notion__search', 'mcp__ide__getDiagnostics']
const LISTING = 'The following skills are available:\n- react-hooks: React hooks\n- prisma: Prisma ORM\n- tdd: Test-driven development'
const ORIGIN = { kind: 'composer' } as const
const ENGINE = { kind: 'engine' } as const
const SLOW = { timeoutMs: 60_000 } as const
const call = (tool: string, id: string, extra: Record<string, unknown> = {}) => ({ tool, tool_use_id: id, ...extra }) as never

describe('skill-gate review fixes', () => {
  test('M21: /gate apply before the first prompt still classifies and briefs the task', SLOW, async ($, on) => {
    const cfg = { ...CONFIG, brief: { enabled: true, model: 'opus', tiers: ['standard'] } }
    const repo = mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg) }, tools: TOOLS, complete: (r) => (r.model === 'opus' ? 'Мета: Z' : '{"profile":"backend","confidence":0.9}') })
    let ctx: readonly string[] = []
    on('prompt.submit', ($, e) => { ctx = e.context ?? []; return { text: e.text } })
    await $.command.run({ command: 'gate', args: 'apply', ...RUN })
    await $.command.run({ command: 'gate', args: 'shadow', ...RUN })
    await $.command.run({ command: 'gate', args: 'apply', ...RUN })
    await $.prompt.submit({ text: 'додай таблицю', wait: false, origin: ORIGIN })
    expect(repo.completes.filter((m) => m === 'haiku')).toHaveLength(1)
    expect(ctx.join('\n')).toContain('Бриф задачі (context-gate, opus):\nМета: Z')
    expect((await $.command.run({ command: 'gate', args: '', ...RUN })).text).toContain('gate backend ·')
    // The classifier's and the brief's cost are journaled (tokens per tier in /gate why).
    expect((await $.command.run({ command: 'gate', args: 'why', ...RUN })).text).toContain('| сесія |')
  })

  test('P5: in shadow a slow classifier and brief land late: their own `classify` decision, the brief in the next prompt', SLOW, async ($, on) => {
    const cfg = { ...CONFIG, brief: { enabled: true, model: 'opus', tiers: ['standard'] }, classify: { mode: 'shadow' } }
    const gates: Record<string, (v: string) => void> = {}
    const late = (model: string) => new Promise<string>((resolve) => { gates[model] = resolve })
    mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg) }, realClock: true, complete: (r) => late(r.model) })
    let ctx: readonly string[] = []
    on('prompt.submit', ($, e) => { ctx = e.context ?? []; return { text: e.text } })
    await $.prompt.submit({ text: 'додай таблицю', wait: false, origin: ORIGIN })
    expect(ctx.join('\n')).not.toContain('Бриф задачі')
    gates.haiku?.('{"profile":"backend","confidence":0.9}')
    gates.opus?.('Мета: L')
    await sleep(200)
    const why = (await $.command.run({ command: 'gate', args: 'why', ...RUN })).text
    expect(why).toContain('classify')
    expect(why).toContain('backend')
    await $.prompt.submit({ text: 'продовжуй', wait: false, origin: ORIGIN })
    expect(ctx.join('\n')).toContain('Мета: L')
  })

  test('M21: a non-prompt recompute does not count as the second hysteresis turn', SLOW, async ($, on) => {
    const cfg = { ...CONFIG, profiles: { frontend: { groups: ['frontend'], when: { paths: ['apps/web/**'] } }, backend: { groups: ['backend'], when: { paths: ['src/**'] } } } }
    mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg) }, tools: TOOLS })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.command.run({ command: 'gate', args: 'apply', ...RUN })
    await $.prompt.submit({ text: 'поправ @apps/web/x.tsx', wait: false, origin: ORIGIN })
    expect((await $.command.run({ command: 'gate', args: '', ...RUN })).text).toContain('gate frontend ·')
    // A different `when` candidate on one prompt, then two recomputes that are not prompts: still frontend.
    await $.prompt.submit({ text: 'і @src/a.ts', wait: false, origin: ORIGIN })
    await $.command.run({ command: 'gate', args: 'apply', ...RUN })
    await $.command.run({ command: 'gate', args: '+docs', ...RUN })
    expect((await $.command.run({ command: 'gate', args: '', ...RUN })).text).toContain('gate frontend ·')
    await $.prompt.submit({ text: 'далі', wait: false, origin: ORIGIN })
    expect((await $.command.run({ command: 'gate', args: '', ...RUN })).text).toContain('gate frontend+backend ·')
  })

  test('M20: /gate +group in shadow keeps shadow: nothing is denied', async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS })
    on('tool.call', () => ({ result: 'ok' }) as never)
    const r = await $.command.run({ command: 'gate', args: '+docs', ...RUN })
    expect(r.text).toContain('shadow: групи записано в пропозицію')
    for (const tool of ['mcp__postgres__query', 'mcp__figma__get_file']) expect((await $.tool.call(call(tool, tool))).deny).toBeUndefined()
  })

  const FLAGS: { flag: string; postgres: 'deny' | 'allow'; toast?: string }[] = [
    { flag: '[gate:off]', postgres: 'allow' },
    { flag: '[gate:new]', postgres: 'allow' },
    { flag: '[gate:auto]', postgres: 'allow' },
    { flag: '[gate:nope]', postgres: 'allow', toast: 'G502 [gate:nope]' },
    { flag: '[gate:frontend]', postgres: 'deny' },
  ]
  for (const c of FLAGS) {
    test(`M23: ${c.flag} is a command or a declared profile, never an undeclared profile`, SLOW, async ($, on) => {
      const repo = mountRepo(on, { files: FILES, tools: TOOLS })
      let text = ''
      on('prompt.submit', ($, e) => { text = e.text; return { text: e.text } })
      on('tool.call', () => ({ result: 'ok' }) as never)
      await $.prompt.submit({ text: `${c.flag} запусти запит`, wait: false, origin: ORIGIN })
      expect(text).toBe('запусти запит')
      const deny = (await $.tool.call(call('mcp__postgres__query', 'p'))).deny
      if (c.postgres === 'deny') expect(deny).toContain('postgres вимкнено')
      else expect(deny).toBeUndefined()
      if (c.toast) expect(repo.toasts.some((t) => t.includes(c.toast!))).toBe(true)
      const status = (await $.command.run({ command: 'gate', args: '', ...RUN })).text
      expect(status).not.toContain('gate nope')
      expect(status).not.toContain('gate new ·')
    })
  }

  test('M24: a compaction reclassifies but is no new task: no second brief', SLOW, async ($, on) => {
    const cfg = { ...CONFIG, brief: { enabled: true, model: 'opus', tiers: ['standard'] }, classify: { mode: 'shadow', recheckOn: ['compact'] } }
    const repo = mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg) }, complete: (r) => (r.model === 'opus' ? 'Мета: X' : '{"profile":"backend","confidence":0.9}') })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('classic.SessionStart', () => ({}) as never)
    await $.prompt.submit({ text: 'додай таблицю', wait: false, origin: ORIGIN })
    expect(repo.completes.filter((m) => m === 'opus')).toHaveLength(1)
    await $.classic.SessionStart({ source: 'compact' } as never)
    await $.prompt.submit({ text: 'продовжуй', wait: false, origin: ORIGIN })
    expect(repo.completes.filter((m) => m === 'haiku')).toHaveLength(2)
    expect(repo.completes.filter((m) => m === 'opus')).toHaveLength(1)
  })

  test('M18: an invalid gate.json stops the stored applied gate from filtering', SLOW, async ($, on) => {
    const repo = mountRepo(on, { files: FILES, tools: TOOLS })
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    on('agent.offer', () => ({ isOffered: true }))
    on('classic.FileChanged', () => ({}) as never)
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    await $.command.run({ command: 'gate', args: 'backend', ...RUN })
    expect((await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)).text).not.toContain('React hooks')
    repo.files.set('.claude/gate.json', { text: JSON.stringify({ ...CONFIG, cursorRules: { maxCharsPerInjection: '30000' } }), mtimeMs: 5000 })
    await $.classic.FileChanged({ file_path: `${ROOT}/.claude/gate.json`, event: 'change' } as never)
    expect((await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)).text).toBe(LISTING)
    expect((await $.agent.offer({ agent: 'ui-reviewer', description: '', source: 'project', provider: { plugin: 'x', tier: 'user' } } as never)).isOffered).toBe(true)
    expect((await $.command.run({ command: 'gate', args: 'why ui-reviewer', ...RUN })).text).toContain('skill-gate вимкнено')
  })

  test('O1: applied gate denies grouped MCP only; ungrouped servers and mcp__ide__ pass with one notice', SLOW, async ($, on) => {
    const repo = mountRepo(on, { files: FILES, tools: TOOLS })
    on('tool.call', () => ({ result: 'ok' }) as never)
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    expect((await $.tool.call(call('mcp__postgres__query', 'a'))).deny).toContain('postgres вимкнено')
    expect((await $.tool.call(call('mcp__notion__search', 'b'))).deny).toBeUndefined()
    expect((await $.tool.call(call('mcp__ide__getDiagnostics', 'c'))).deny).toBeUndefined()
    expect(repo.toasts.filter((t) => t.includes('MCP без групи'))).toHaveLength(1)
    await $.command.run({ command: 'gate', args: 'backend', ...RUN })
    expect(repo.toasts.filter((t) => t.includes('MCP без групи'))).toHaveLength(1)
  })

  test('M22: a tier inferred from the context window survives the first prompt', SLOW, async ($, on) => {
    const cfg = { ...CONFIG, models: { 'claude-*': 'standard' }, tiers: { ...CONFIG.tiers, premium: { groups: [], thresholds: { minContextWindow: 150000 } } } }
    mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg) }, model: 'local-llama' })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.prompt.submit({ text: 'щось', wait: false, origin: ORIGIN })
    expect((await $.command.run({ command: 'gate', args: '', ...RUN })).text).toContain('tier premium')
  })

  test('M19: when.expr sees git.branch', SLOW, async ($, on) => {
    const cfg = { ...CONFIG, profiles: { ...CONFIG.profiles, ui: { groups: ['frontend'], when: { expr: "git.branch ~ '^feat/ui'" } } } }
    mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg), '.git/HEAD': 'ref: refs/heads/feat/ui-button\n' } })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.prompt.submit({ text: 'кнопка', wait: false, origin: ORIGIN })
    expect((await $.command.run({ command: 'gate', args: '', ...RUN })).text).toContain('gate (ui?)')
  })

  test('M07: concurrent Skill calls keep their own args; M13: a typed /skill is never replaced by the off text', SLOW, async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS })
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('skill.prompt', ($, e) => ({ text: e.text }))
    on('command.run', ($, e) => ({ text: e.args }) as never)
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    // The model's call of a skill off for its profile is denied before it loads.
    expect((await $.tool.call(call('Skill', 's0', { skill: 'prisma' }))).deny).toContain('Skill prisma вимкнено')
    expect((await $.skill.prompt({ skill: 'prisma', text: 'body' })).text).toContain('Увімкни: /gate +backend')
    // The user typing `/prisma` is an explicit ask: the body stays.
    await $.command.run({ command: 'prisma', args: 'migrate', ...RUN })
    expect((await $.skill.prompt({ skill: 'prisma', text: 'body' })).text).toBe('body')
  })

  test('O7: /gate why <item> explains a decision and a missing item', SLOW, async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS })
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    const pg = (await $.command.run({ command: 'gate', args: 'why postgres', ...RUN })).text
    expect(pg).toContain('`tool:mcp__postgres__query`: вимкнено')
    expect(pg).toContain('увімкнути: /gate +backend')
    const notion = (await $.command.run({ command: 'gate', args: 'why notion', ...RUN })).text
    expect(notion).toContain('жодна група не згадує → не фільтрується')
    expect((await $.command.run({ command: 'gate', args: 'why nothing-here', ...RUN })).text).toContain('немає серед елементів сесії')
    expect((await $.command.run({ command: 'gate', args: 'why off', ...RUN })).text).toContain('Pane /gate why закрито')
  })

  test('O7: an invalid gate.json is marked in the band', async () => {
    const rt = newRuntime(readOptions(undefined))
    rt.disabled.gate = '.claude/gate.json: G303 … — skill-gate вимкнено'
    const band = bandProps(rt, null, 'standard', 10)
    expect(band.text).toContain(CONFIG_MARK)
    expect(band.hot).toBe(true)
  })
})

describe('refineGate (O1, M10)', () => {
  const cfg = { groups: { db: ['tool:mcp__postgres__*'], ui: ['skill:react-*'] }, tiers: {}, models: {}, profiles: {} } as unknown as GateConfig
  const item = (kind: Item['kind'], name: string): Item => ({ kind, id: `${kind}:${name}`, name, attach: { when: 'on-demand' }, cost: { chars: 0 }, provenance: { source: 'unknown' } }) as Item
  const items = [item('tool', 'mcp__postgres__q'), item('tool', 'mcp__notion__s'), item('tool', 'mcp__ide__d'), item('skill', 'acme:react-hooks'), item('skill', 'acme:other')]
  const gate = (groups: string[]): Gate => ({
    tier: 'standard', trigger: 'tier', off: false, groups, reason: ['MCP поза профілем вимкнено: postgres, notion, ide'],
    skills: { on: [], nameOnly: ['acme:react-hooks', 'acme:other'], off: [], preload: [] }, mcp: { on: [], off: ['mcp__postgres__q', 'mcp__notion__s', 'mcp__ide__d'] },
    agents: { on: [], off: [] }, rules: { on: [], off: [] },
    items: { 'tool:mcp__postgres__q': 'off', 'tool:mcp__notion__s': 'off', 'tool:mcp__ide__d': 'off', 'skill:acme:react-hooks': 'nameOnly', 'skill:acme:other': 'nameOnly' },
  }) as unknown as Gate
  const CASES: { groups: string[]; want: Record<string, string>; passthrough: string[] }[] = [
    { groups: [], want: { 'tool:mcp__postgres__q': 'off', 'tool:mcp__notion__s': 'on', 'tool:mcp__ide__d': 'on', 'skill:acme:react-hooks': 'off', 'skill:acme:other': 'nameOnly' }, passthrough: ['ide', 'notion'] },
    { groups: ['ui'], want: { 'skill:acme:react-hooks': 'on' }, passthrough: ['ide', 'notion'] },
  ]
  for (const c of CASES) {
    test(`groups [${c.groups.join(',')}]`, async () => {
      const r = refineGate(cfg, items, gate(c.groups))
      for (const [id, d] of Object.entries(c.want)) expect(r.gate.items[id]).toBe(d)
      expect(r.passthrough).toEqual(c.passthrough)
      expect(r.gate.mcp.off).toEqual(['mcp__postgres__q'])
      expect(r.gate.reason).toContain('MCP поза профілем вимкнено: postgres')
    })
  }
})
