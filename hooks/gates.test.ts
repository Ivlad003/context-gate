// gates[].provider (SPEC "Провайдери — Гейти"): a gate that reads a provider instead of (or next to) `run`.
import { describe, expect } from 'claude-code/testing'

import { mountRepo, test } from './testkit.ts'

const BASE = {
  groups: {},
  tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [] } },
  profiles: {},
  providers: { arch: { kind: 'file', path: '.keylang/report.json' } },
}

/** Cold module loads under a busy machine exceed the 5 s default. */
const SLOW = { timeoutMs: 20_000 }

const BASH = { tool: 'Bash', tool_use_id: 't1', command: 'git commit -m wip' } as const

describe('gates[].provider', () => {
  test('a provider-only gate denies from the provider data, without trust', SLOW, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'architecture', on: 'commit', provider: 'arch', pass: 'len(result.violations) == 0', message: '{{ result.violations[0].code }}: {{ result.violations[0].explain }}' }] }
    const report = { violations: [{ code: 'K101', explain: 'domain не імпортує infra' }] }
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), '.keylang/report.json': JSON.stringify(report) } })
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    const r = await $.tool.call(BASH)
    expect(r.deny).toBe('K101: domain не імпортує infra')
    expect(repo.runs).toHaveLength(0)
  })

  test('a provider-only gate passes when the data is clean, and never blocks when the provider is missing', SLOW, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'architecture', on: 'commit', provider: 'arch', pass: 'len(result.violations) == 0' }] }
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), '.keylang/report.json': '{"violations":[]}' } })
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    expect((await $.tool.call(BASH)).deny).toBeUndefined()
  })

  test('a missing provider file skips the gate (unverified, not a block)', SLOW, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'architecture', on: 'commit', provider: 'arch', pass: 'len(result.violations) == 0' }] }
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg) } })
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    expect((await $.tool.call(BASH)).deny).toBeUndefined()
  })

  test('with `run`, the provider data is in the pass scope under its name', { ...SLOW, options: { trustBuild: 'always', allowScripts: true } }, async ($, on) => {
    const cfg = { ...BASE, gates: [{ name: 'architecture', on: 'commit', provider: 'arch', run: ['keylang', 'check', '--json'], pass: 'len(result.violations) <= arch.allowed', message: 'нових порушень: {{ len(result.violations) }}' }] }
    const repo = mountRepo(on, {
      files: { '.claude/gate.json': JSON.stringify(cfg), '.keylang/report.json': '{"allowed":1}' },
      allowBinaries: ['keylang'],
      run: () => ({ exitCode: 0, stdout: '{"violations":[1,2]}', stderr: '' }),
    })
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    const r = await $.tool.call(BASH)
    expect(repo.runs).toEqual([['keylang', 'check', '--json']])
    expect(r.deny).toBe('нових порушень: 2')
  })

  test('a cli provider with parseOnError: exit 1 with JSON still yields data (core providerResultOk); without it, no data', { ...SLOW, options: { trustBuild: 'always', allowScripts: true } }, async ($, on) => {
    const lint = (extra: Record<string, unknown>) => ({ ...BASE, providers: { lint: { kind: 'cli', command: ['node', 'lint.js'], ...extra } }, gates: [{ name: 'lint', on: 'commit', provider: 'lint', pass: 'len(result) == 0', message: 'lint: {{ result[0].rule }}' }] })
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(lint({ parseOnError: true })) }, run: () => ({ exitCode: 1, stdout: '[{"rule":"no-default-export"}]', stderr: '' }) })
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    on('classic.FileChanged', () => ({}) as never)
    expect((await $.tool.call(BASH)).deny).toBe('lint: no-default-export')
    expect(repo.runs).toEqual([['node', 'lint.js']])
    repo.files.set('.claude/gate.json', { text: JSON.stringify(lint({})), mtimeMs: 7000 })
    await $.classic.FileChanged({ file_path: '/repo/.claude/gate.json', event: 'change' } as never)
    expect((await $.tool.call({ ...BASH, tool_use_id: 't2' })).deny).toBeUndefined() // exit 1 → unverified → never blocks
  })
})
