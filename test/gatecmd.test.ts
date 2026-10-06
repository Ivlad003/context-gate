import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGateCommand, extractPromptFlag, extractMentions } from '../packages/core/src/gatecmd.ts'

test('parseGateCommand table', () => {
  const rows: [string, unknown][] = [
    ['/gate', { cmd: 'status' }],
    ['', { cmd: 'status' }],
    ['/gate frontend', { cmd: 'profile', profile: 'frontend' }],
    ['frontend', { cmd: 'profile', profile: 'frontend' }],
    ['/gate +docs -git', { cmd: 'groups', add: ['docs'], remove: ['git'] }],
    ['/gate +a,b', { cmd: 'groups', add: ['a', 'b'], remove: [] }],
    ['/gate off', { cmd: 'off' }],
    ['/gate auto', { cmd: 'auto' }],
    ['/gate new', { cmd: 'new' }],
    ['/gate why', { cmd: 'why' }],
    ['/gate why off', { cmd: 'why', close: true }],
    ['/gate shadow', { cmd: 'shadow' }],
    ['/gate apply', { cmd: 'apply' }],
    ['/gate rules', { cmd: 'rules' }],
    ['/gate health', { cmd: 'health' }],
    ['/gate build', { cmd: 'build' }],
    ['/gate render prompt://workflow', { cmd: 'render', id: 'workflow' }],
    ['/gate render workflow', { cmd: 'render', id: 'workflow' }],
    ['/gate trust revoke', { cmd: 'trust', action: 'revoke' }],
    ['/gate collect kind=skill | where group=frontend | off', {
      cmd: 'pipe',
      stages: [
        { stage: 'collect', args: { kind: 'skill' }, positional: [] },
        { stage: 'where', args: {}, positional: [], expr: 'group=frontend' },
        { stage: 'off', args: {}, positional: [] },
      ],
    }],
    ['/gate why | where status=unverified', { cmd: 'pipe', stages: [{ stage: 'why', args: {}, positional: [] }, { stage: 'where', args: {}, positional: [], expr: 'status=unverified' }] }],
    ['decide --profile frontend --model haiku --dry | tokens', { cmd: 'pipe', stages: [{ stage: 'decide', args: { profile: 'frontend', model: 'haiku', dry: 'true' }, positional: [] }, { stage: 'tokens', args: {}, positional: [] }] }],
    ['collect --kind rule', { cmd: 'pipe', stages: [{ stage: 'collect', args: { kind: 'rule' }, positional: [] }] }],
    ['collect | take 3', { cmd: 'pipe', stages: [{ stage: 'collect', args: {}, positional: [] }, { stage: 'take', args: {}, positional: ['3'] }] }],
  ]
  for (const [input, want] of rows) assert.deepEqual(parseGateCommand(input), want, input)
})

test('parseGateCommand errors', () => {
  const rows: [string, string, { profiles?: string[] }?][] = [
    ['/gate collect | frobnicate', 'G501'],
    ['/gate collect || off', 'G503'],
    ['/gate collect | where', 'G508'],
    ['/gate +a b', 'G506'],
    ['/gate +', 'G506'],
    ['/gate render', 'G505'],
    ['/gate render prompt://', 'G505'],
    ['/gate trust me', 'G507'],
    ['/gate why now', 'G504'],
    ['/gate off now', 'G504'],
    ['/gate nope', 'G502', { profiles: ['frontend'] }],
    ['/gate two words', 'G502'],
    ['/gate collect =x', 'G504'],
  ]
  for (const [input, code, opts] of rows) {
    const r = parseGateCommand(input, opts)
    assert.ok('error' in r && r.error.startsWith(code), `${input} → ${JSON.stringify(r)}`)
  }
})

test('extractPromptFlag', () => {
  assert.deepEqual(extractPromptFlag('[gate:frontend] fix it'), { profile: 'frontend', text: 'fix it' })
  assert.deepEqual(extractPromptFlag('  [gate: off]\nfix'), { profile: 'off', text: 'fix' })
  assert.deepEqual(extractPromptFlag('fix [gate:x]'), { text: 'fix [gate:x]' })
})

test('extractMentions', () => {
  const r = extractMentions('@security-review check @apps/web/src/Button.tsx and @README.md, mail me@x.com. `@code.ts` (@./lib/a.ts)\n```\n@fenced.ts\n```\n@"with space/a b.ts"')
  assert.deepEqual(r.files, ['apps/web/src/Button.tsx', 'README.md', 'lib/a.ts', 'with space/a b.ts'])
  assert.deepEqual(r.rules, ['security-review'])
})
