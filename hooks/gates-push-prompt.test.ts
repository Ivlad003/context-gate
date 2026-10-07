// `push` / `publish` gates on Bash commands, `prompt` gates that read the prompt (stdin, `prompt` in expressions) and
// may drop it, and gates decided by `pass` alone.
import { describe, expect } from 'claude-code/testing'

import { mountRepo, test } from './testkit.ts'
import { bashTriggers } from './layers/gates.ts'

const BASE = {
  groups: {},
  tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [] } },
  profiles: {},
}
const SLOW = { timeoutMs: 20_000 }
const TRUSTED = { ...SLOW, options: { trustBuild: 'always', allowScripts: true } }
const BASH = (command: string, id = 't1') => ({ tool: 'Bash', tool_use_id: id, command }) as const
const OK = { result: { stdout: '', stderr: '', interrupted: false } }
const ORIGIN = { kind: 'composer' } as const

describe('bashTriggers', () => {
  test('finds commit, push and package publishes in any spelling, and nothing else', async () => {
    const cases: [string, string[]][] = [
      ['git push', ['push']],
      ['git -C sub push origin main', ['push']],
      ['npm test && git commit -am x && git push', ['commit', 'push']],
      ['bash -lc "git push --tags"', ['push']],
      ['npm publish', ['publish']],
      ['npm --workspace pkg publish --access public', ['publish']],
      ['pnpm publish -r', ['publish']],
      ['yarn npm publish', ['publish']],
      ['yarn publish', ['publish']],
      ['bun publish', ['publish']],
      ['cargo publish --dry-run', ['publish']],
      ['python -m build && twine upload dist/*', ['publish']],
      ['poetry publish --build', ['publish']],
      ['git push-hooks', []],
      ['npm view context-gate version', []],
      ['yarn npm whoami', []],
      ['npm run publish-docs', []],
      ['echo "npm publish"', []],
      ['git status', []],
    ]
    for (const [cmd, want] of cases) expect([cmd, [...bashTriggers(cmd)].sort()]).toEqual([cmd, want])
  })
})

describe('push and publish gates', () => {
  test('a push gate runs on `git push` only', TRUSTED, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'checks', on: 'push', run: ['npm', 'test'], message: 'Перевірки червоні — push заблоковано.' }] }
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg) }, allowBinaries: ['npm'], run: () => ({ exitCode: 1, stdout: 'FAIL', stderr: '' }) })
    on('tool.call', () => OK as never)
    expect((await $.tool.call(BASH('git status'))).deny).toBeUndefined()
    expect((await $.tool.call(BASH('git commit -m x', 't2'))).deny).toBeUndefined()
    expect((await $.tool.call(BASH('git push origin main', 't3'))).deny).toBe('Перевірки червоні — push заблоковано.')
    expect(repo.runs).toEqual([['npm', 'test']])
  })

  test('a publish gate with `pass` only blocks without starting anything, even in an untrusted repo', SLOW, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'people-publish', on: 'publish', pass: 'false', message: 'Публікує людина: дай мені команду {{ command }}.' }] }
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg) } })
    on('tool.call', () => OK as never)
    expect((await $.tool.call(BASH('npm publish --access public'))).deny).toBe('Публікує людина: дай мені команду npm publish --access public.')
    expect((await $.tool.call(BASH('npm pack', 't2'))).deny).toBeUndefined()
    expect(repo.runs).toHaveLength(0)
  })

  test('`pass` sees the command: a push gate that only refuses force pushes', SLOW, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'no-force', on: 'push', pass: '!(command | grep("--force"))', message: 'Force push заборонено.' }] }
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg) } })
    on('tool.call', () => OK as never)
    expect((await $.tool.call(BASH('git push origin main'))).deny).toBeUndefined()
    expect((await $.tool.call(BASH('git push --force origin main', 't2'))).deny).toBe('Force push заборонено.')
  })
})

describe('prompt gates', () => {
  const secrets = (extra: Record<string, unknown> = {}) => ({ ...BASE, gates: [{ name: 'no-secrets', on: 'prompt', run: ['grep', '-qiE', 'password|token'], pass: 'exitCode != 0', message: 'У промпті схоже на пароль. Прибери його.', ...extra }] })

  test('`run` gets the prompt text on stdin, and a failure becomes context', TRUSTED, async ($, on) => {
    const stdins: (string | undefined)[] = []
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(secrets()) }, allowBinaries: ['grep'], run: (argv, stdin) => { stdins.push(stdin); return { exitCode: /password/i.test(stdin ?? '') ? 0 : 1, stdout: '', stderr: '' } } })
    let ctx: readonly string[] = []
    on('prompt.submit', ($, e) => { ctx = e.context ?? []; return { text: e.text } })
    await $.prompt.submit({ text: 'налаштуй пошту, password: hunter2', wait: false, origin: ORIGIN })
    expect(stdins).toEqual(['налаштуй пошту, password: hunter2'])
    expect(ctx).toContain('У промпті схоже на пароль. Прибери його.')
    ctx = []
    await $.prompt.submit({ text: 'додай тест', wait: false, origin: ORIGIN })
    expect(ctx).not.toContain('У промпті схоже на пароль. Прибери його.')
  })

  test('with `drop: true` the prompt never reaches the model', TRUSTED, async ($, on) => {
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(secrets({ drop: true })) }, allowBinaries: ['grep'], run: (argv, stdin) => ({ exitCode: /password/i.test(stdin ?? '') ? 0 : 1, stdout: '', stderr: '' }) })
    let reached = 0
    on('prompt.submit', ($, e) => { reached++; return { text: e.text } })
    const r = await $.prompt.submit({ text: 'password: hunter2', wait: false, origin: ORIGIN })
    expect(r.drop).toBe('У промпті схоже на пароль. Прибери його.')
    expect(reached).toBe(0)
  })

  test('a prompt gate with `pass` only reads `prompt` and needs no trust', SLOW, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'no-key', on: 'prompt', pass: '!(prompt | grep("sk-[A-Za-z0-9]{8}"))', message: 'Схоже на API-ключ.', drop: true }] }
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg) } })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    expect((await $.prompt.submit({ text: 'ключ sk-abcdefgh123', wait: false, origin: ORIGIN })).drop).toBe('Схоже на API-ключ.')
    expect((await $.prompt.submit({ text: 'звичайне прохання', wait: false, origin: ORIGIN })).drop).toBeUndefined()
    expect(repo.runs).toHaveLength(0)
  })
})
