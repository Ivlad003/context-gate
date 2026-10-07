// Regressions of the 2026-10-06 review for layers 1 and 3 (hooks/layers/dsl.ts, cursor-rules.ts): the CLI cache
// dir (M02), prompt and rule dirs outside the root (M05), secrets in the trace (M04), skill args and agents (M06,
// M07), a moved session root (M01), Manual rules in subfolders (L05), the first prompt's dedup (L06), volatile
// sections through prompt.submit (P1).
import { describe, expect } from 'claude-code/testing'

import { HOME, ROOT, RUN, mountRepo, test } from './testkit.ts'
import { argsFromText, remoteSpellings } from './layers/dsl.ts'
import { addSeen, findRule } from './layers/cursor-rules.ts'
import { repoCacheName } from '../packages/core/src/sha256.ts'
import type { MdcRule } from '../packages/core/src/types.ts'

const compiled = (id: string, extra: Record<string, unknown>) => JSON.stringify({ version: 1, compiler: 'test', id, sourceHash: `h-${id}`, sources: [], diagnostics: [], sections: [], ...extra })
const text = (value: string) => ({ t: 'text', value })
const COMPOSE = (model: string) => ({ model, promptModel: model, surfaces: [], tools: [], outputStyle: null, traits: [] }) as never
const ORIGIN = { kind: 'composer' } as const
const ENGINE = { kind: 'engine' } as const
const SLOW = { timeoutMs: 60_000 } as const
const READ_RESULT = { type: 'text', file: { filePath: `${ROOT}/src/a.ts`, content: 'x', numLines: 1, startLine: 1, totalLines: 1 } }
const CACHE = `${HOME}/.cache/context-gate`

const HELLO = compiled('hello', {
  skill: {
    name: 'hello', description: 'Привітання', invoke: { user: true, model: 'skill' },
    args: { name: { type: 'string', positional: 0, required: true } },
    body: [text('Привіт, '), { t: 'expr', expr: 'args.name' }],
  },
})

describe('prompt DSL review fixes', () => {
  test("M02: another repo's cache dir that merely shares the basename is never loaded", SLOW, async ($, on) => {
    mountRepo(on, { files: {
      '.claude/gate.json': '{}',
      [`${CACHE}/repo-0123456789ab/compiled/main.json`]: compiled('main', { sections: [{ id: 'foreign', scope: 'static', children: [text('ЧУЖИЙ')] }] }),
    } })
    on('prompt.compose', () => ({ sections: [] }))
    const r = await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    expect(r.sections.map((s) => s.text).join('\n')).not.toContain('ЧУЖИЙ')
  })

  test('M02: the cache dir of this root is loaded', SLOW, async ($, on) => {
    mountRepo(on, { files: {
      '.claude/gate.json': '{}',
      [`${CACHE}/${repoCacheName(ROOT, '')}/compiled/main.json`]: compiled('main', { sections: [{ id: 'own', scope: 'static', children: [text('СВІЙ')] }] }),
    } })
    on('prompt.compose', () => ({ sections: [] }))
    const r = await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    expect(r.sections.map((s) => s.text).join('\n')).toContain('СВІЙ')
  })

  test('M05: prompt.dir and rule source dirs outside the root are never read or written', SLOW, async ($, on) => {
    const cfg = { prompt: { dir: '/outside' }, itemSources: [{ kind: 'markdown-dir', dir: '/rules-out' }, { kind: 'prompt-dir', dir: '/sections-out', as: 'section' }] }
    const repo = mountRepo(on, { files: {
      '.claude/gate.json': JSON.stringify(cfg),
      '.claude/prompt/good.md': '---\nid: good\n---\nДОБРЕ\n',
      '/outside/evil.md': '---\nid: evil\n---\nПОЗА РЕПО\n',
      '/sections-out/evil2.md': '---\nid: evil2\n---\nПОЗА РЕПО 2\n',
      '/rules-out/secret.md': 'Секрет поза репо.',
    } })
    on('prompt.compose', () => ({ sections: [] }))
    const r = await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    const all = r.sections.map((s) => s.text).join('\n')
    expect(all).toContain('ДОБРЕ')
    expect(all).not.toContain('ПОЗА РЕПО')
    expect([...repo.files.keys()].some((k) => k.startsWith('/outside/') && k.includes('.trace'))).toBe(false)
    expect((await $.command.run({ command: 'gate', args: 'rules', ...RUN })).text).not.toContain('secret')
  })

  test('M04: an env secret with a quote and a backslash never reaches .trace/last.json, and the JSON stays valid', SLOW, async ($, on) => {
    const secret = 'se"cr\\et-123'
    const repo = mountRepo(on, {
      files: { '.claude/gate.json': JSON.stringify({ env: ['TOKEN'] }), '.claude/prompt/a.md': '---\nid: a\n---\nT {{ env.TOKEN }}\n' },
      settingsEnv: { TOKEN: secret },
    })
    on('prompt.compose', () => ({ sections: [] }))
    await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    const trace = repo.files.get('.claude/prompt/.trace/last.json')?.text ?? ''
    expect(trace).not.toBe('')
    expect(trace).not.toContain(secret)
    expect(trace).not.toContain(JSON.stringify(secret).slice(1, -1))
    const parsed = JSON.parse(trace) as { scope: { env: Record<string, string> } }
    expect(parsed.scope.env.TOKEN).toBe('***')
  })

  test('M07: concurrent calls of one prompt skill keep their own args (by the render line, else in call order)', SLOW, async ($, on) => {
    mountRepo(on, { files: { '.claude/gate.json': '{}', '.claude/prompt/.compiled/hello.json': HELLO } })
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('skill.prompt', ($, e) => ({ text: e.text }))
    await $.tool.call({ tool: 'Skill', tool_use_id: 'a', skill: 'hello', args: 'alice', agentId: 'sub-a' } as never)
    await $.tool.call({ tool: 'Skill', tool_use_id: 'b', skill: 'hello', args: 'bob', agentId: 'sub-b' } as never)
    expect((await $.skill.prompt({ skill: 'hello', text: "x run hello --args 'bob' --ctx-from live" })).text).toBe('Привіт, bob')
    expect((await $.skill.prompt({ skill: 'hello', text: '' })).text).toBe('Привіт, alice')
    await $.tool.call({ tool: 'Skill', tool_use_id: 'c', skill: 'hello', args: 'carol' } as never)
    await $.tool.call({ tool: 'Skill', tool_use_id: 'd', skill: 'hello', args: 'dan' } as never)
    expect((await $.skill.prompt({ skill: 'hello', text: '' })).text).toBe('Привіт, carol')
    expect((await $.skill.prompt({ skill: 'hello', text: '' })).text).toBe('Привіт, dan')
  })

  test('M07: the generated body (with its `--args "<аргументи>"` comment) renders the queued args', SLOW, async ($, on) => {
    mountRepo(on, { files: { '.claude/gate.json': '{}', '.claude/prompt/.compiled/hello.json': HELLO } })
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('skill.prompt', ($, e) => ({ text: e.text }))
    await $.tool.call({ tool: 'Skill', tool_use_id: 'a', skill: 'hello', args: 'bob' } as never)
    expect((await $.skill.prompt({ skill: 'hello', text: LIVE('bob') })).text).toBe('Привіт, bob')
    // Nothing queued: the render line is the fallback.
    expect((await $.skill.prompt({ skill: 'hello', text: LIVE('eve') })).text).toBe('Привіт, eve')
  })

  test("M06: a subagent whose tier enables a skill gets its body, not the main loop's off text", SLOW, async ($, on) => {
    const cfg = {
      groups: { frontend: ['skill:react-*'], docs: ['skill:tdd'] },
      tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: ['docs'] } },
      profiles: { frontend: { groups: ['frontend'] } },
    }
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg) } })
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('skill.prompt', ($, e) => ({ text: e.text }))
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' } as never
    })
    await $.prompt.attachment({ type: 'skill_listing', text: 'The following skills are available:\n- react-hooks: R\n- tdd: T', origin: ENGINE } as never)
    await $.command.run({ command: 'gate', args: 'frontend', ...RUN })
    const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'sub-1' } as never)
    for await (const _ of s) { /* drain */ }
    await s.result
    expect((await $.tool.call({ tool: 'Skill', tool_use_id: 's1', skill: 'tdd', agentId: 'sub-1' } as never)).deny).toBeUndefined()
    expect((await $.skill.prompt({ skill: 'tdd', text: 'TDD body' })).text).toBe('TDD body')
    expect((await $.tool.call({ tool: 'Skill', tool_use_id: 's2', skill: 'tdd' } as never)).deny).toContain('Skill tdd вимкнено')
  })

  test('P1: prompt.volatile "context" moves volatile sections from the system prompt to the prompt context', SLOW, async ($, on) => {
    const main = compiled('main', { sections: [
      { id: 'identity', scope: 'static', children: [text('Ти інженер.')] },
      { id: 'state', scope: 'volatile', children: [text('Стан: '), { t: 'expr', expr: 'git.branch' }] },
    ] })
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify({ prompt: { volatile: 'context' } }), '.git/HEAD': 'ref: refs/heads/main\n', '.claude/prompt/.compiled/main.json': main } })
    on('prompt.compose', () => ({ sections: [] }))
    let ctx: readonly string[] = []
    on('prompt.submit', ($, e) => { ctx = e.context ?? []; return { text: e.text } })
    const r = await $.prompt.compose(COMPOSE('claude-sonnet-4-5'))
    const ids = r.sections.map((s) => s.id)
    expect(ids).toContain('context-gate:identity')
    expect(ids).not.toContain('context-gate:state')
    await $.prompt.submit({ text: 'зроби', wait: false, origin: ORIGIN })
    expect(ctx.join('\n')).toContain('Стан: main')
  })
})

describe('cursor-rules review fixes', () => {
  test('M01: a moved root does not carry the old repo\'s read evidence or journal lines into the new one', SLOW, async ($, on) => {
    const WT = '/wt'
    const cfg = { log: { file: true }, groups: {}, profiles: { a: {} }, gates: [{ name: 'read-before-write', on: 'write', builtin: true }] }
    const repo = mountRepo(on, { files: {
      '.claude/gate.json': JSON.stringify(cfg), 'src/a.ts': 'x',
      [`${WT}/.claude/gate.json`]: JSON.stringify({ ...cfg, profiles: { b: {} } }), [`${WT}/src/a.ts`]: 'x',
      [`${WT}/.claude/gate.log.jsonl`]: '{"marker":"B"}\n',
    } })
    on('tool.call', () => ({ result: READ_RESULT }) as never)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/src/a.ts` } as never)
    await $.command.run({ command: 'gate', args: 'a', ...RUN })
    repo.root = WT
    const edit = await $.tool.call({ tool: 'Edit', tool_use_id: 't2', file_path: `${WT}/src/a.ts`, old_string: 'x', new_string: 'y' } as never)
    expect(edit.deny).toContain('спочатку прочитай')
    await $.command.run({ command: 'gate', args: 'b', ...RUN })
    await $.session.end({ reason: 'other', sessionId: 's', resume: false } as never)
    const b = repo.files.get(`${WT}/.claude/gate.log.jsonl`)?.text ?? ''
    expect(b).toContain('"marker":"B"')
    expect(b).toContain('"profile":"b"')
    expect(b).not.toContain('"profile":"a"')
    expect(repo.files.get('.claude/gate.log.jsonl')?.text ?? '').toContain('"profile":"a"')
  })

  test('M01: after a root move the next prompt is a new task there: classified again, the old profile not kept', SLOW, async ($, on) => {
    const WT = '/wt'
    const groups = { fe: ['skill:react-*'], be: ['skill:prisma'] }
    const cfg = { groups, tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [] } }, classify: { mode: 'auto' } }
    let answer = 'frontend'
    const repo = mountRepo(on, {
      files: {
        '.claude/gate.json': JSON.stringify({ ...cfg, profiles: { frontend: { groups: ['fe'] }, backend: { groups: ['be'] } } }),
        [`${WT}/.claude/gate.json`]: JSON.stringify({ ...cfg, profiles: { backend: { groups: ['be'] } } }),
      },
      complete: () => `{"profile":"${answer}","confidence":0.9}`,
    })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.prompt.submit({ text: 'зроби форму', wait: false, origin: ORIGIN })
    expect((await $.command.run({ command: 'gate', args: '', ...RUN })).text).toContain('gate frontend')
    repo.root = WT
    answer = 'backend'
    await $.prompt.submit({ text: 'додай таблицю', wait: false, origin: ORIGIN })
    expect(repo.completes.filter((m) => m === 'haiku')).toHaveLength(2)
    expect((await $.command.run({ command: 'gate', args: '', ...RUN })).text).toContain('gate backend')
  })

  for (const mention of ['@migrations', '@db/migrations']) {
    test(`L05: ${mention} applies a Manual rule from a .cursor/rules subfolder`, async ($, on) => {
      mountRepo(on, { files: { '.cursor/rules/db/migrations.mdc': 'Міграції: лише вперед.' } })
      let ctx: readonly string[] = []
      on('prompt.submit', ($, e) => { ctx = e.context ?? []; return { text: e.text } })
      await $.prompt.submit({ text: `${mention} додай колонку`, wait: false, origin: ORIGIN })
      expect(ctx.join('\n')).toContain('Міграції: лише вперед.')
    })
  }

  test("L06: prompt.context keeps the first prompt's own @file delivery", async ($, on) => {
    mountRepo(on, { files: { '.cursor/rules/ts.mdc': '---\nglobs: src/**/*.ts\n---\nTypeScript: strict.', 'src/a.ts': 'x' } })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    on('tool.call', () => ({ result: READ_RESULT }) as never)
    await $.prompt.submit({ text: 'поправ @src/a.ts', wait: false, origin: ORIGIN })
    await $.prompt.context({ blocks: [] })
    const r = await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: `${ROOT}/src/a.ts` } as never)
    expect(r.context ?? []).toEqual([])
  })
})

/** The live body `build` generates for skill `hello`, as the engine expands it (`$ARGUMENTS` substituted raw). */
const LIVE = (args: string) => [
  '---', 'name: hello', 'description: d', 'generated-by: context-gate', '---',
  '!`if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then set -- node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"; else set -- npx --no-install context-gate; fi; "$@" run hello --args \'' + args + '\' --ctx-from live`',
  '',
  '<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/hello.json. Якщо рядок вище не виконався (harness без підтримки !`…`), виконай: npx context-gate run hello --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->',
].join('\n')

describe('pure helpers', () => {
  const ARGS: [string, string | undefined][] = [
    ['run hello --args "Світ --loud"', 'Світ --loud'],
    ["run hello --args 'bob' --ctx-from live", 'bob'],
    ["run hello --args 'it'\\''s' --ctx-from live", "it's"],
    ["run hello --args '$ARGUMENTS'", undefined],
    ['native body', undefined],
    // A full generated SKILL.md body (packages/cli/src/build.ts renderSkillMd) with the args substituted: the
    // trailing comment's `--args "<аргументи>"` placeholder never wins, and a quote in the args stays.
    [LIVE('bob'), 'bob'],
    [LIVE("it's"), "it's"],
    [LIVE('$ARGUMENTS'), undefined],
  ]
  for (const [input, want] of ARGS) test(`argsFromText ${JSON.stringify(input)}`, async () => { expect(argsFromText(input)).toBe(want) })

  test('remoteSpellings: https and scp forms meet', async () => {
    expect(remoteSpellings('https://x/y')).toContain('git@x:y.git')
    expect(remoteSpellings('git@github.com:o/r.git')).toContain('https://github.com/o/r')
    expect(remoteSpellings('')).toEqual([''])
  })

  test('addSeen keeps main and the 16 most recent subagents', async () => {
    let seen: string[] = ['main:a']
    for (let i = 0; i < 40; i++) seen = addSeen(seen, [`agent-${i}:a`])
    expect(seen).toContain('main:a')
    expect(seen).toContain('agent-39:a')
    expect(seen).not.toContain('agent-0:a')
    expect(seen.length).toBe(17)
  })

  test('findRule: exact, else a unique /-suffix', async () => {
    const r = (id: string) => ({ id }) as MdcRule
    expect(findRule([r('db/migrations')], 'migrations')?.id).toBe('db/migrations')
    expect(findRule([r('a/x'), r('b/x')], 'x')).toBeUndefined()
    expect(findRule([r('x'), r('b/x')], 'x')?.id).toBe('x')
  })
})
