// Layer 2 (skill-gate), budgets, gates, trust, /gate and the band, through `claude plugin test`.
import { describe, expect, test } from 'claude-code/testing'

import { BAND_PROPS, ROOT, RUN, mountRepo } from './testkit.ts'

const CONFIG = {
  groups: {
    frontend: ['skill:react-*', 'tool:mcp__figma__*', 'agent:ui-reviewer'],
    backend: ['skill:prisma', 'tool:mcp__postgres__*', 'agent:db-agent'],
  },
  tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [] } },
  profiles: {
    frontend: { groups: ['frontend'], when: { paths: ['apps/web/**'] } },
    backend: { groups: ['backend'] },
  },
  budgets: { default: { softContextPct: 50, hardContextPct: 80 } },
  gates: [
    { name: 'read-before-write', on: 'write', builtin: true },
    { name: 'tests', on: 'commit', run: ['npm', 'test'] },
  ],
}

const FILES = { '.claude/gate.json': JSON.stringify(CONFIG), 'apps/web/x.tsx': 'x', 'src/a.ts': 'x' }
const TOOLS = ['mcp__postgres__query', 'mcp__figma__get_file']
const LISTING = 'The following skills are available:\n- react-hooks: React hooks\n- prisma: Prisma ORM\n- tdd: Test-driven development'
const ORIGIN = { kind: 'composer' } as const
const ENGINE = { kind: 'engine' } as const
const PROVIDER = { plugin: 'mcp:postgres', tier: 'user' } as const

describe('skill-gate', () => {
  test('shadow computes the profile but filters nothing; /gate apply filters the listing', { timeoutMs: 20_000 }, async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS })
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    await $.prompt.submit({ text: 'поправ @apps/web/x.tsx', wait: false, origin: ORIGIN })
    const status = await $.command.run({ command: 'gate', args: '', ...RUN })
    expect(status.text).toContain('gate (frontend?)')
    // Shadow filters nothing, so the band counts everything as on (SPEC scenario 1: skills N/N).
    expect(status.text).toMatch(/skills (\d+)\/\1 · mcp (\d+)\/\2/)
    expect(status.text).toContain('(пропозиція, не застосовано)')
    const shadow = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    expect(shadow.text).toBe(LISTING)
    const applied = await $.command.run({ command: 'gate', args: 'apply', ...RUN })
    expect(applied.text).toContain('gate frontend ·')
    const filtered = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    expect(filtered.text).toBe('The following skills are available:\n- react-hooks: React hooks\n- tdd')
  })

  test('manual /gate <profile> applies in shadow mode: MCP deny, short description, agent hidden, skill off', async ($, on) => {
    const repo = mountRepo(on, { files: FILES, tools: TOOLS })
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('tool.describe', ($, e) => ({ description: e.description }))
    on('agent.offer', () => ({ isOffered: true }))
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    expect(repo.invalidated).toContain('prompt.attachment')
    const pg = await $.tool.call({ tool: 'mcp__postgres__query', tool_use_id: 't1' } as never)
    expect(pg.deny).toBe('postgres вимкнено профілем frontend. Користувач може увімкнути: /gate +backend')
    const figma = await $.tool.call({ tool: 'mcp__figma__get_file', tool_use_id: 't2' } as never)
    expect(figma.deny).toBeUndefined()
    const d = await $.tool.describe({ tool: 'mcp__postgres__query', description: 'Run SQL against the database …', provider: PROVIDER } as never)
    expect(d.isDeferred).toBe(true)
    expect(d.description).toContain('вимкнено профілем frontend')
    const db = await $.agent.offer({ agent: 'db-agent', description: '', source: 'project', provider: PROVIDER } as never)
    expect(db.isOffered).toBe(false)
    const ui = await $.agent.offer({ agent: 'ui-reviewer', description: '', source: 'project', provider: PROVIDER } as never)
    expect(ui.isOffered).toBe(true)
    const skill = await $.tool.call({ tool: 'Skill', tool_use_id: 't3', skill: 'prisma' } as never)
    expect(skill.deny).toContain('Skill prisma вимкнено профілем frontend')
    const off = await $.skill.prompt({ skill: 'prisma', text: 'body' })
    expect(off.text).toContain('Увімкни: /gate +backend')
  })

  test('/gate +group, -group, off and auto', async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS })
    on('tool.call', () => ({ result: 'ok' }) as never)
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    await $.command.run({ command: 'gate', args: '+backend', ...RUN })
    expect((await $.tool.call({ tool: 'mcp__postgres__query', tool_use_id: 't1' } as never)).deny).toBeUndefined()
    await $.command.run({ command: 'gate', args: '-backend', ...RUN })
    expect((await $.tool.call({ tool: 'mcp__postgres__query', tool_use_id: 't2' } as never)).deny).toBeDefined()
    const off = await $.command.run({ command: 'gate', args: 'off', ...RUN })
    expect(off.text).toContain('gate off')
    expect((await $.tool.call({ tool: 'mcp__postgres__query', tool_use_id: 't3' } as never)).deny).toBeUndefined()
    const auto = await $.command.run({ command: 'gate', args: 'auto', ...RUN })
    expect(auto.text).toContain('shadow')
    const bad = await $.command.run({ command: 'gate', args: 'nosuch', ...RUN })
    expect(bad.text).toContain('G502')
  })

  test('/gate why lists decisions; [gate:x] prefix is stripped and fixes the profile', async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS })
    let text = ''
    on('prompt.submit', ($, e) => {
      text = e.text
      return { text: e.text }
    })
    await $.prompt.submit({ text: '[gate:backend] міграція', wait: false, origin: ORIGIN })
    expect(text).toBe('міграція')
    const why = await $.command.run({ command: 'gate', args: 'why', ...RUN })
    expect(why.text).toContain('| хід | тригер | профіль |')
    expect(why.text).toContain('| 1 | manual | backend |')
  })

  test('classifier: JSON proposal journaled in shadow, applied with mode auto', async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS, complete: () => '{"profile":"backend","confidence":0.9}' })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.prompt.submit({ text: 'додай таблицю в базу', wait: false, origin: ORIGIN })
    const s = await $.command.run({ command: 'gate', args: '', ...RUN })
    expect(s.text).toContain('gate (backend?)')
  })

  test('classifier in auto mode applies a confident proposal', { options: { mode: 'auto' } }, async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS, complete: () => '{"profile":"backend","confidence":0.9}' })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: 'ok' }) as never)
    await $.prompt.submit({ text: 'додай таблицю в базу', wait: false, origin: ORIGIN })
    const s = await $.command.run({ command: 'gate', args: '', ...RUN })
    expect(s.text).toContain('gate backend ·')
    expect((await $.tool.call({ tool: 'mcp__figma__get_file', tool_use_id: 't1' } as never)).deny).toContain('figma вимкнено')
  })

  test('brief for a non-premium tier on the first prompt, as prompt context', async ($, on) => {
    const cfg = { ...CONFIG, brief: { enabled: true, model: 'opus', tiers: ['standard'] } }
    mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg) }, complete: (r) => (r.model === 'opus' ? 'Мета: X' : undefined) })
    let ctx: readonly string[] = []
    on('prompt.submit', ($, e) => {
      ctx = e.context ?? []
      return { text: e.text }
    })
    await $.prompt.submit({ text: 'зроби X', wait: false, origin: ORIGIN })
    expect(ctx.join('\n')).toContain('Бриф задачі (context-gate, opus):\nМета: X')
  })

  test('the band shows the gate line on terminal and desktop', async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS })
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'context-gate', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ type: 'Text', text: /^gate frontend · tier standard · skills \d+\/\d+ · mcp 1\/2 · rules 0 · ctx —%$/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the /gate why pane draws the table and the reset button', async ($, on) => {
    mountRepo(on, { files: FILES, tools: TOOLS })
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    const ui = await $.ui.mount({ plugin: 'context-gate', surface: 'terminal', component: 'Pane', requestId: 'gate-why', props: { title: 'gate why', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as never })
    expect(await ui.find({ key: 'auto' })).toBeDefined()
    await ui.press({ key: 'auto' })
    const s = await $.command.run({ command: 'gate', args: '', ...RUN })
    expect(s.text).not.toContain('вручну:')
    await ui.unmount()
  })
})

describe('budgets', () => {
  test('hard threshold: notice once per crossing (toast + transcript notice)', async ($, on) => {
    const repo = mountRepo(on, { files: FILES })
    on('session.measure', ($, e) => ({ changed: e.changed }))
    const measure = (percent: number) => $.session.measure({ context: { window: 200_000, percent }, rateLimits: [], changed: ['context'] } as never)
    await measure(90)
    await measure(91)
    expect(repo.toasts.filter((t) => t.startsWith('Контекст 90%'))).toHaveLength(1)
    await measure(20)
    await measure(85)
    expect(repo.toasts.filter((t) => t.startsWith('Контекст'))).toHaveLength(2)
  })

  test('the band highlights past the soft threshold', async ($, on) => {
    mountRepo(on, { files: FILES })
    on('session.measure', ($, e) => ({ changed: e.changed }))
    await $.session.measure({ context: { window: 200_000, percent: 60 }, rateLimits: [], changed: ['context'] } as never)
    const ui = await $.ui.mount({ plugin: 'context-gate', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    const t = await ui.find({ type: 'Text', text: /ctx 60%/ })
    expect(t).toBeDefined()
    await ui.unmount()
  })
})

describe('gates', () => {
  test('read-before-write denies Edit of an unread file, allows it after Read', async ($, on) => {
    mountRepo(on, { files: FILES })
    on('tool.call', () => ({ result: 'ok' }) as never)
    const denied = await $.tool.call({ tool: 'Edit', tool_use_id: 't1', file_path: `${ROOT}/src/a.ts`, old_string: 'x', new_string: 'y' })
    expect(denied.deny).toContain('Гейт read-before-write: спочатку прочитай src/a.ts')
    await $.tool.call({ tool: 'Read', tool_use_id: 't2', file_path: `${ROOT}/src/a.ts` })
    const ok = await $.tool.call({ tool: 'Edit', tool_use_id: 't3', file_path: `${ROOT}/src/a.ts`, old_string: 'x', new_string: 'y' })
    expect(ok.deny).toBeUndefined()
  })

  test('read-before-write does not apply on premium', async ($, on) => {
    mountRepo(on, { files: FILES, model: 'claude-opus-4-5' })
    on('tool.call', () => ({ result: 'ok' }) as never)
    const r = await $.tool.call({ tool: 'Edit', tool_use_id: 't1', file_path: `${ROOT}/src/a.ts`, old_string: 'x', new_string: 'y' })
    expect(r.deny).toBeUndefined()
  })

  test('an untrusted repo never runs a command gate', async ($, on) => {
    const repo = mountRepo(on, { files: FILES })
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    const r = await $.tool.call({ tool: 'Bash', tool_use_id: 't1', command: 'git commit -m wip' })
    expect(r.deny).toBeUndefined()
    expect(repo.runs).toHaveLength(0)
  })

  test('a trusted repo runs the commit gate and denies on failure', { options: { trustBuild: 'always' } }, async ($, on) => {
    const repo = mountRepo(on, { files: FILES, run: () => ({ exitCode: 1, stdout: 'FAIL a.test.ts', stderr: '' }) })
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    const r = await $.tool.call({ tool: 'Bash', tool_use_id: 't1', command: 'git commit -m wip' })
    expect(repo.runs).toEqual([['npm', 'test']])
    expect(r.deny).toContain('Гейт tests не пройдено (exit 1).')
    const log = await $.command.run({ command: 'gate', args: 'why', ...RUN })
    expect(log.text).toContain('| хід |')
  })

  test('a stored trust decision for the repo key is honoured; /gate trust revoke drops it', async ($, on) => {
    const repo = mountRepo(on, { files: FILES })
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    const t = await $.command.run({ command: 'gate', args: 'trust revoke', ...RUN })
    expect(t.text).toContain(`Довіру до ${ROOT}| скасовано`)
    await $.tool.call({ tool: 'Bash', tool_use_id: 't1', command: 'git commit -m wip' })
    expect(repo.runs).toHaveLength(0)
  })

  test('a turn gate with onlyNew blocks only violations beyond the baseline', { options: { trustBuild: 'always' } }, async ($, on) => {
    const cfg = { ...CONFIG, gates: [{ name: 'typecheck', on: 'turn', run: ['tsc', '--noEmit'], onlyNew: true, baseline: '.claude/gate.baseline.json' }] }
    let out = 'a.ts(1,1): error TS1'
    const repo = mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg) }, run: () => ({ exitCode: 2, stdout: out, stderr: '' }) })
    on('turn.complete', ($, e) => ({ text: e.answer }))
    const turn = () => $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer' } as never)
    await turn()
    expect(repo.files.get('.claude/gate.baseline.json')?.text).toContain('a.ts(1,1): error TS1')
    expect(repo.toasts.some((t) => t.includes('typecheck'))).toBe(false)
    out = 'a.ts(1,1): error TS1\nb.ts(2,2): error TS2'
    await turn()
    expect(repo.toasts.some((t) => t.includes('Гейт typecheck не пройдено'))).toBe(true)
  })
})

describe('script tools', () => {
  test('a `# gate-tool:` script registers when trusted and runs through the executor with JSON stdin', { options: { trustBuild: 'always' } }, async ($, on) => {
    const script = '#!/usr/bin/env python3\n# gate-tool: parse_openapi\n# description: Ендпоінти з openapi.yaml\n# input: { "path": "string" }\nprint("[]")\n'
    const repo = mountRepo(on, { files: { ...FILES, '.claude/prompt/scripts/parse.py': script }, run: () => ({ exitCode: 0, stdout: '["GET /a"]', stderr: '' }) })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    expect(repo.tools).toContain('parse_openapi')
    const r = await $.tool.call({ tool: 'mcp__context-gate__parse_openapi', tool_use_id: 't1', path: 'openapi.yaml' } as never)
    expect(r.result).toBe('["GET /a"]')
    expect(repo.runs).toEqual([['python3', `${ROOT}/.claude/prompt/scripts/parse.py`]])
  })

  test('an untrusted repo registers no script tools', async ($, on) => {
    const script = '# gate-tool: danger\necho hi\n'
    const repo = mountRepo(on, { files: { ...FILES, '.claude/prompt/scripts/x.sh': script } })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    expect(repo.tools).not.toContain('danger')
  })
})


const SLOW = { timeoutMs: 20_000 }

describe('per-agent tiers, providers, models attributes (G-01, G-02, G-08, G-35)', () => {
  const TIERED = {
    groups: { frontend: ['skill:react-*'], docs: ['skill:tdd'], db: ['tool:mcp__postgres__*'] },
    tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: ['docs', 'db'] } },
    profiles: { frontend: { groups: ['frontend'] } },
  }

  test('a subagent on a quick model gets its own tier: listing and MCP deny follow it', SLOW, async ($, on) => {
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(TIERED) }, tools: ['mcp__postgres__query'] })
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' } as never
    })
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'sub-1' } as never)
    for await (const _ of s) { /* drain */ }
    await s.result
    const main = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    expect(main.text).not.toContain('- tdd')
    const sub = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE, agentId: 'sub-1' } as never)
    expect(sub.text).toContain('- tdd')
    expect((await $.tool.call({ tool: 'mcp__postgres__query', tool_use_id: 'm1' } as never)).deny).toContain('postgres вимкнено')
    expect((await $.tool.call({ tool: 'mcp__postgres__query', tool_use_id: 'm2', agentId: 'sub-1' } as never)).deny).toBeUndefined()
  })

  test('models attributes: a model without a tier infers it from thresholds', SLOW, async ($, on) => {
    const cfg = { ...TIERED, models: { 'local-*': { contextWindow: 32000, costPer1k: 0 } }, tiers: { ...TIERED.tiers, quick: { groups: ['docs'], thresholds: { maxCostPer1k: 0.001 } } } }
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg) }, model: 'local-llama' })
    const s = await $.command.run({ command: 'gate', args: '', ...RUN })
    expect(s.text).toContain('tier quick')
  })

  test('classify.provider cli: stdin JSON, stdout {profile, confidence} (trusted repo)', { ...SLOW, options: { mode: 'auto', trustBuild: 'always' } }, async ($, on) => {
    const cfg = { ...CONFIG, classify: { mode: 'auto', provider: { kind: 'cli', command: ['node', 'scripts/classify.js'] } } }
    const repo = mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg) }, tools: TOOLS, run: () => ({ exitCode: 0, stdout: '{"profile":"backend","confidence":0.95}', stderr: '' }) })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.prompt.submit({ text: 'додай таблицю в базу', wait: false, origin: ORIGIN })
    expect(repo.runs).toContainEqual(['node', 'scripts/classify.js'])
    expect(repo.completes).toEqual([])
    const s = await $.command.run({ command: 'gate', args: '', ...RUN })
    expect(s.text).toContain('gate backend ·')
  })

  test('brief.provider cli writes the brief; an untrusted repo runs nothing', SLOW, async ($, on) => {
    const cfg = { ...CONFIG, brief: { enabled: true, tiers: ['standard'], provider: { kind: 'cli', command: ['node', 'brief.js'] } } }
    const repo = mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg) }, run: () => ({ exitCode: 0, stdout: '{"text":"Мета: Y"}', stderr: '' }) })
    let ctx: readonly string[] = []
    on('prompt.submit', ($, e) => {
      ctx = e.context ?? []
      return { text: e.text }
    })
    await $.prompt.submit({ text: 'зроби Y', wait: false, origin: ORIGIN })
    expect(repo.runs).toEqual([])
    expect(ctx.join('\n')).not.toContain('Бриф задачі')
  })

  test('brief.provider cli in a trusted repo', { ...SLOW, options: { trustBuild: 'always' } }, async ($, on) => {
    const cfg = { ...CONFIG, brief: { enabled: true, tiers: ['standard'], provider: { kind: 'cli', command: ['node', 'brief.js'] } } }
    const repo = mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg) }, run: () => ({ exitCode: 0, stdout: '{"text":"Мета: Y"}', stderr: '' }) })
    let ctx: readonly string[] = []
    on('prompt.submit', ($, e) => {
      ctx = e.context ?? []
      return { text: e.text }
    })
    await $.prompt.submit({ text: 'зроби Y', wait: false, origin: ORIGIN })
    expect(repo.runs).toContainEqual(['node', 'brief.js'])
    expect(ctx.join('\n')).toContain('Мета: Y')
    expect(repo.completes).not.toContain('opus')
  })

  test('a script tool outside the profile is denied (groups apply to `# gate-tool:` items)', { ...SLOW, options: { trustBuild: 'always' } }, async ($, on) => {
    const cfg = { ...CONFIG, groups: { ...CONFIG.groups, api: ['tool:parse_openapi'] } }
    const script = '#!/usr/bin/env python3\n# gate-tool: parse_openapi\n# description: Ендпоінти\nprint("[]")\n'
    const repo = mountRepo(on, { files: { ...FILES, '.claude/gate.json': JSON.stringify(cfg), '.claude/prompt/scripts/parse.py': script }, run: () => ({ exitCode: 0, stdout: '[]', stderr: '' }) })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    const r = await $.tool.call({ tool: 'mcp__context-gate__parse_openapi', tool_use_id: 't1' } as never)
    expect(r.deny).toContain('parse_openapi вимкнено профілем frontend')
    expect(repo.runs).toEqual([])
  })
})

describe('env whitelist (G-03)', () => {
  test('env.* in the render scope holds only gate.json `env` names, read from the settings env block', { timeoutMs: 20_000 }, async ($, on) => {
    const cfg = { env: ['CG_REGION'] }
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), '.claude/prompt/env.md': '---\nid: env\n---\nРегіон: {{ env.CG_REGION }}; секрет: [{{ env.CG_SECRET }}]\n' } })
    on('settings.read', () => ({ value: { env: { CG_REGION: 'eu-1', CG_SECRET: 'nope' } } }) as never)
    on('prompt.compose', () => ({ sections: [] }))
    const r = await $.prompt.compose({ model: 'claude-sonnet-4-5', promptModel: 'claude-sonnet-4-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(r.sections.find((s) => s.id === 'context-gate:env')?.text).toBe('Регіон: eu-1; секрет: []')
  })
})
