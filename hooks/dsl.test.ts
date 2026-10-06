// Layer 3 (prompt DSL): prompt.compose sections, Markdown tier variants, budget sections, prompt skills.
import { describe, expect, test } from 'claude-code/testing'

import { RUN, mountRepo } from './testkit.ts'

const compiled = (id: string, extra: Record<string, unknown>) => JSON.stringify({ version: 1, compiler: 'test', id, sourceHash: `h-${id}`, sources: [], diagnostics: [], sections: [], ...extra })

const MAIN = compiled('main', {
  sections: [
    { id: 'repo-state', scope: 'volatile', children: [{ t: 'text', value: 'Гілка ' }, { t: 'expr', expr: 'git.branch' }, { t: 'text', value: '.' }] },
    { id: 'identity', scope: 'static', children: [{ t: 'text', value: 'Ти senior TypeScript-інженер.' }] },
    { id: 'frontend-only', scope: 'profile', when: "gate.profile == 'frontend'", children: [{ t: 'text', value: 'Фронтенд-правила.' }] },
    { id: 'script', scope: 'volatile', children: [{ t: 'run', lang: 'bash', code: 'echo hi', as: 'out' }, { t: 'expr', expr: 'out' }] },
  ],
})

const HELLO = compiled('hello', {
  skill: {
    name: 'hello', description: 'Привітання', invoke: { user: true, model: 'skill' },
    args: { name: { type: 'string', positional: 0, required: true }, loud: { type: 'flag' } },
    body: [{ t: 'text', value: 'Привіт, ' }, { t: 'expr', expr: 'args.name' }, { t: 'if', test: 'args.loud', then: [{ t: 'text', value: '!!!' }] }],
  },
})

const GREET = compiled('greet', {
  skill: {
    name: 'greet', description: 'Привітання як інструмент', invoke: { user: false, model: 'tool' },
    args: { name: { type: 'string', required: true } },
    body: [{ t: 'text', value: 'Вітаю, ' }, { t: 'expr', expr: 'args.name' }],
  },
})

const CONFIG = {
  groups: { frontend: ['skill:react-*'] },
  profiles: { frontend: { groups: ['frontend'] } },
  budgets: { default: { softContextPct: 50, hardContextPct: 90 } },
  onExceed: { softContextPct: { do: 'section', section: 'budget-warning' } },
}

const FILES = {
  '.claude/gate.json': JSON.stringify(CONFIG),
  '.git/HEAD': 'ref: refs/heads/feat/ui-kit\n',
  '.claude/prompt/.compiled/main.json': MAIN,
  '.claude/prompt/.compiled/hello.json': HELLO,
  '.claude/prompt/.compiled/greet.json': GREET,
  '.claude/prompt/workflow.md': '---\nid: workflow\nscope: profile\n---\nПрацюй малими кроками.\n',
  '.claude/prompt/workflow.quick.md': '---\nid: workflow\n---\nКрок 1: прочитай файли, названі в задачі.\n',
  '.claude/prompt/budget-warning.md': '---\nid: budget-warning\nscope: volatile\n---\nКонтекст майже повний: відповідай стисло.\n',
}

const COMPOSE = (model: string) => ({ model, promptModel: model, surfaces: [], tools: [], outputStyle: null, traits: [] }) as never

describe('prompt DSL', () => {
  test('prompt.compose adds compiled + Markdown sections as session sections, static → profile → volatile', async ($, on) => {
    const repo = mountRepo(on, { files: FILES })
    on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'engine', scope: 'shared' }] }))
    const r = await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    const ids = r.sections.map((s) => s.id)
    expect(ids[0]).toBe('core')
    expect(ids).toContain('context-gate:identity')
    expect(ids).not.toContain('context-gate:frontend-only')
    expect(ids).not.toContain('context-gate:budget-warning')
    expect(ids.indexOf('context-gate:identity')).toBeLessThan(ids.indexOf('context-gate:workflow'))
    expect(ids.indexOf('context-gate:workflow')).toBeLessThan(ids.indexOf('context-gate:repo-state'))
    expect(r.sections.filter((s) => s.id.startsWith('context-gate:')).every((s) => s.scope === 'session')).toBe(true)
    expect(r.sections.find((s) => s.id === 'context-gate:repo-state')?.text).toBe('Гілка feat/ui-kit.')
    expect(r.sections.find((s) => s.id === 'context-gate:workflow')?.text).toBe('Працюй малими кроками.')
    // Untrusted repository: @run renders as an unverified stub, nothing runs.
    expect(r.sections.find((s) => s.id === 'context-gate:script')?.text).toContain('[run: bash, unverified]')
    expect(repo.runs).toHaveLength(0)
    // Skill bodies are not system-prompt sections.
    expect(ids).not.toContain('context-gate:hello')
  })

  test('a tier variant file wins for its tier; a profile section follows the gate', async ($, on) => {
    mountRepo(on, { files: FILES, model: 'claude-haiku-4-5' })
    on('prompt.compose', () => ({ sections: [] }))
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    const r = await $.prompt.compose(COMPOSE('claude-haiku-4-5'))
    expect(r.sections.find((s) => s.id === 'context-gate:workflow')?.text).toBe('Крок 1: прочитай файли, названі в задачі.')
    expect(r.sections.find((s) => s.id === 'context-gate:frontend-only')?.text).toBe('Фронтенд-правила.')
  })

  test('onExceed section: budget-warning appears once the soft threshold is crossed', async ($, on) => {
    mountRepo(on, { files: FILES })
    on('prompt.compose', () => ({ sections: [] }))
    on('session.measure', ($, e) => ({ changed: e.changed }))
    await $.session.measure({ context: { window: 200_000, percent: 60 }, rateLimits: [], changed: ['context'] } as never)
    const r = await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    expect(r.sections.find((s) => s.id === 'context-gate:budget-warning')?.text).toBe('Контекст майже повний: відповідай стисло.')
  })

  test('/gate health reports the last render', async ($, on) => {
    mountRepo(on, { files: FILES })
    on('prompt.compose', () => ({ sections: [] }))
    await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    const h = await $.command.run({ command: 'gate', args: 'health', ...RUN })
    expect(h.text).toContain('| H001 |')
    expect(h.text).toContain('| identity | static |')
  })

  test('/gate render prompt://<id> renders one section', async ($, on) => {
    mountRepo(on, { files: FILES })
    const r = await $.command.run({ command: 'gate', args: 'render prompt://repo-state', ...RUN })
    expect(r.text).toContain('Гілка feat/ui-kit.')
  })

  test('a prompt skill renders at invocation with args from the Skill call; bad args give usage', async ($, on) => {
    mountRepo(on, { files: FILES })
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('skill.prompt', ($, e) => ({ text: e.text }))
    await $.tool.call({ tool: 'Skill', tool_use_id: 't1', skill: 'hello', args: 'Світ --loud' } as never)
    const r = await $.skill.prompt({ skill: 'hello', text: '!`node cli.js run hello --args "Світ --loud"`' })
    expect(r.text).toBe('Привіт, Світ!!!')
    const fromText = await $.skill.prompt({ skill: 'hello', text: '!`node cli.js run hello --args "Олено"`' })
    expect(fromText.text).toBe('Привіт, Олено')
    const bad = await $.skill.prompt({ skill: 'hello', text: '' })
    expect(bad.text).toContain('Невірні аргументи')
    const other = await $.skill.prompt({ skill: 'tdd', text: 'native body' })
    expect(other.text).toBe('native body')
  })

  test("invoke.model 'tool' registers a tool and serves it with structured args", async ($, on) => {
    const repo = mountRepo(on, { files: FILES })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(repo.tools).toContain('greet')
    const r = await $.tool.call({ tool: 'mcp__context-gate__greet', tool_use_id: 't1', name: 'Світ' } as never)
    expect(r.result).toBe('Вітаю, Світ')
  })
})
