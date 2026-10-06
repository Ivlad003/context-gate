// Layer 3 (prompt DSL): prompt.compose sections, Markdown tier variants, budget sections, prompt skills.
import { describe, expect } from 'claude-code/testing'

import { RUN, mountRepo, test } from './testkit.ts'

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

describe('prompt DSL: build state, builtins, function tools (WP1)', () => {
  test('plan-then-act joins prompt.compose below premium (G-54)', async ($, on) => {
    mountRepo(on, { files: FILES })
    on('prompt.compose', () => ({ sections: [] }))
    const std = await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    expect(std.sections.find((s) => s.id === 'context-gate:plan-then-act')?.text).toContain('план → правка → перевірка')
  })

  test('an edited import makes the entry stale; the failed build shows `prompt ⚠ build` in /gate health (G-11, G-14)', { options: { trustBuild: 'always' } }, async ($, on) => {
    const entry = compiled('main', {
      sources: [{ path: '.claude/prompt/main.prompt.tsx', hash: 'a' }, { path: '.claude/prompt/shared/base.prompt.tsx', hash: 'b' }],
      sections: [{ id: 'identity', scope: 'static', children: [{ t: 'text', value: 'Стара збірка.' }] }],
    })
    // mtimes follow insertion order: the import is newer than the compiled JSON.
    const repo = mountRepo(on, {
      files: { '.claude/prompt/main.prompt.tsx': 'x', '.claude/prompt/.compiled/main.json': entry, '.claude/prompt/shared/base.prompt.tsx': 'y' },
      exists: (p) => (p.endsWith('/dist/cli.js') ? true : undefined),
      run: (argv) => (argv.includes('build') ? { exitCode: 1, stdout: '', stderr: 'G164 Збірка: shared/base.prompt.tsx: unexpected token' } : undefined) ?? { exitCode: 0, stdout: '', stderr: '' },
    })
    on('prompt.compose', () => ({ sections: [] }))
    const r = await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    expect(repo.runs.some((a) => a.includes('--only') && a.includes('.claude/prompt/main.prompt.tsx'))).toBe(true)
    expect(r.sections.find((s) => s.id === 'context-gate:identity')?.text).toBe('Стара збірка.')
    const h = await $.command.run({ command: 'gate', args: 'health', ...RUN })
    expect(h.text).toContain('prompt ⚠ build: G164')
  })

  test('`# gate-tool: <fn>` over a module export registers a tool and calls it through the shim (G-36)', { options: { trustBuild: 'always' } }, async ($, on) => {
    const repo = mountRepo(on, {
      files: { ...FILES, '.claude/prompt/lib/ver.mjs': '// gate-tool: next_version\n// input: { "bump": "string" }\nexport function next_version({ bump }) { return bump }\n' },
      run: (argv) => (argv[0] === 'node' && argv.includes('-e') ? { exitCode: 0, stdout: '{"results":["2.0.0"],"errors":[null]}', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }),
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(repo.tools).toContain('next_version')
    const r = await $.tool.call({ tool: 'mcp__context-gate__next_version', tool_use_id: 't1', bump: 'major' } as never)
    expect(r.result).toBe('2.0.0')
  })

  test('tiers[*].preload: core generates the `preload` section from the applied gate (Р5), after the static sections', async ($, on) => {
    const cfg = {
      groups: { core: ['skill:tdd', 'skill:prisma'] },
      tiers: { premium: { groups: ['core'] }, standard: { groups: ['core'] }, quick: { groups: ['core'], preload: ['tdd'] } },
      models: { 'claude-haiku-*': 'quick' },
      profiles: { backend: { groups: ['core'] } },
    }
    mountRepo(on, { model: 'claude-haiku-4-5', files: {
      '.claude/gate.json': JSON.stringify(cfg),
      '.claude/skills/tdd/SKILL.md': '---\nname: tdd\ndescription: TDD\n---\nЧервоний, зелений, рефакторинг.',
      '.claude/prompt/.compiled/main.json': compiled('main', { sections: [{ id: 'identity', scope: 'static', children: [{ t: 'text', value: 'Ти інженер.' }] }, { id: 'state', scope: 'volatile', children: [{ t: 'text', value: 'Стан.' }] }] }),
    } })
    on('prompt.compose', () => ({ sections: [] }))
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    await $.prompt.attachment({ type: 'skill_listing', text: 'The following skills are available:\n- prisma: Prisma ORM\n- tdd: Test-driven development', origin: { kind: 'engine' } } as never)
    const shadow = await $.prompt.compose(COMPOSE('claude-haiku-4-5'))
    expect(shadow.sections.map((s) => s.id)).not.toContain('context-gate:preload')
    await $.command.run({ command: 'gate', args: 'backend', ...RUN })
    const r = await $.prompt.compose(COMPOSE('claude-haiku-4-5'))
    const ids = r.sections.map((s) => s.id).filter((id) => id !== 'context-gate:plan-then-act') // builtin below premium
    expect(ids).toEqual(['context-gate:identity', 'context-gate:preload', 'context-gate:state'])
    const text = r.sections.find((s) => s.id === 'context-gate:preload')?.text ?? ''
    expect(text).toContain('Skills, вбудовані для tier quick')
    expect(text).toContain('## tdd')
    expect(text).toContain('Червоний, зелений, рефакторинг.')
  })

  test('itemSources prompt-dir (as section): its Markdown files are sections too, re-read on FileChanged', async ($, on) => {
    const cfg = { ...CONFIG, itemSources: [{ kind: 'prompt-dir', dir: 'docs/prompts', as: 'section' }, { kind: 'prompt-dir', dir: 'docs/other', as: 'skill' }] }
    const repo = mountRepo(on, { files: {
      '.claude/gate.json': JSON.stringify(cfg),
      '.claude/prompt/a.md': '---\nid: a\n---\nСекція A.',
      'docs/prompts/team.md': '---\nid: team\n---\nКоманда: бекенд.',
      'docs/prompts/README.md': 'не секція',
      'docs/other/x.md': '---\nid: x\n---\nНе секція.',
    } })
    on('prompt.compose', () => ({ sections: [] }))
    on('classic.FileChanged', () => ({}) as never)
    const r = await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    const ids = r.sections.map((s) => s.id)
    expect(ids).toContain('context-gate:a')
    expect(ids).toContain('context-gate:team')
    expect(ids).not.toContain('context-gate:x')
    repo.files.set('docs/prompts/team.md', { text: '---\nid: team\n---\nКоманда: фронтенд.', mtimeMs: 8000 })
    await $.classic.FileChanged({ file_path: '/repo/docs/prompts/team.md', event: 'change' } as never)
    const after = await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    expect(after.sections.find((s) => s.id === 'context-gate:team')?.text).toContain('Команда: фронтенд.')
  })

  test('G-03: whitelisted env values are masked in .trace/last.json; G-43/G-44: health lists compactions, the decision and skills without a description', async ($, on) => {
    const cfg = { ...CONFIG, env: ['API_TOKEN'], debug: true }
    const repo = mountRepo(on, { settingsEnv: { API_TOKEN: 'sekret-token-123', OTHER: 'x' }, files: {
      '.claude/gate.json': JSON.stringify(cfg),
      '.claude/prompt/env.md': '---\nid: env\n---\nТокен: {{ env.API_TOKEN }}\n@debug env.API_TOKEN',
    } })
    on('prompt.compose', () => ({ sections: [] }))
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    on('session.compact', ($, e) => ({ messages: e.messages }) as never)
    await $.prompt.attachment({ type: 'skill_listing', text: 'The following skills are available:\n- tdd: Test-driven development\n- bare', origin: { kind: 'engine' } } as never)
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'привіт', toolUses: [] }] } as never)
    const r = await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    expect(r.sections.find((s) => s.id === 'context-gate:env')?.text).toContain('sekret-token-123') // the model gets the value
    const trace = repo.files.get('.claude/prompt/.trace/last.json')?.text ?? ''
    expect(trace).not.toBe('')
    expect(trace).not.toContain('sekret-token-123')
    expect(trace).toContain('***')
    expect(repo.files.get('.claude/gate.debug.log')?.text ?? '').not.toContain('sekret-token-123')
    const h = await $.command.run({ command: 'gate', args: 'health', ...RUN })
    expect(h.text).toContain('Компакції за сесію')
    expect(h.text).toContain('профіль frontend')
    expect(h.text).toContain('ручних перевизначень 1')
    expect(h.text).toContain('Skills без опису в листингу')
  })
})
