// Core shims.ts (executors, language shims, scripts provider, G158 helpers), sha256.ts (the CLI cache dir name
// without node:crypto), toolheader `parseToolHeaders` (function tools) and the builtin `plan-then-act` section.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DEFAULT_EXECUTORS, executorFor, executorInvocation, missingExports, parseShimOutput, scriptArgv, scriptFnName, scriptLang, scriptStdin, shimCommand, shimLang, usedFunctions } from '../packages/core/src/shims.ts'
import { repoCacheName, sha256Hex } from '../packages/core/src/sha256.ts'
import { parseToolHeaders } from '../packages/core/src/toolheader.ts'
import { PLAN_THEN_ACT_ID, assemblePrompts, planThenAct } from '../packages/core/src/assemble.ts'
import { repoHash } from '../packages/cli/src/settings.ts'
import { DEFAULT_EXECUTORS as CLI_EXECUTORS } from '../packages/cli/src/host-node.ts'
import type { CompiledPrompt } from '../packages/core/src/types.ts'

test('sha256Hex equals node:crypto; repoCacheName equals the CLI repoHash', () => {
  for (const s of ['', 'abc', 'x'.repeat(1000), 'привіт 😀 /home/u/repo|git@github.com:a/b.git']) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'))
  }
  for (const [root, remote] of [['/home/u/my repo', 'git@x:y.git'], ['/r', '']] as const) {
    assert.equal(repoCacheName(root, remote), repoHash(root, remote))
  }
})

test('executors: one default set for both hosts; aliases; {code} in argv or stdin', () => {
  assert.deepEqual(CLI_EXECUTORS, DEFAULT_EXECUTORS)
  assert.equal(executorFor(DEFAULT_EXECUTORS, 'sh'), DEFAULT_EXECUTORS.bash)
  assert.equal(executorFor(DEFAULT_EXECUTORS, 'py'), DEFAULT_EXECUTORS.python)
  assert.equal(executorFor(DEFAULT_EXECUTORS, 'cobol'), undefined)
  assert.deepEqual(executorInvocation(DEFAULT_EXECUTORS.bash!, 'echo 1', 'IN'), { argv: ['bash', '-euo', 'pipefail', '-c', 'echo 1'], stdin: 'IN' })
  assert.deepEqual(executorInvocation(DEFAULT_EXECUTORS.deno!, 'console.log(1)', 'IN'), { argv: ['deno', 'run', '--no-prompt', '--allow-read=.', '-'], stdin: 'console.log(1)' })
})

test('shimCommand: node / python / bash / callTemplate; parseShimOutput', () => {
  const calls = [{ fn: 'f', args: [1], kwargs: { k: 'v' } }]
  const node = shimCommand('lib/m.ts', '/r/lib/m.ts', calls, DEFAULT_EXECUTORS)
  assert.ok(node.ok && node.lang === 'node' && node.argv[0] === 'node' && JSON.parse(node.stdin).file === '/r/lib/m.ts')
  const py = shimCommand('u.py', '/r/u.py', calls, DEFAULT_EXECUTORS)
  assert.ok(py.ok && py.argv[0] === 'python3' && /dataclasses\.asdict/.test(py.argv[2]!))
  const sh = shimCommand('s.sh', '/r/s.sh', calls, DEFAULT_EXECUTORS)
  assert.ok(sh.ok && sh.stdin === '')
  assert.deepEqual(sh.ok && sh.argv.slice(3), ['cg-shim', '/r/s.sh', 'f', '2', '1', '--k=v'])
  const tpl = shimCommand('x.rb', '/r/x.rb', calls, { ...DEFAULT_EXECUTORS, rb: { command: ['ruby', '-e', '{code}'], callTemplate: ['ruby', 'shim.rb', '{file}'] } })
  assert.deepEqual(tpl.ok && tpl.argv, ['ruby', 'shim.rb', '/r/x.rb'])
  const none = shimCommand('x.go', '/r/x.go', calls, DEFAULT_EXECUTORS)
  assert.ok(!none.ok && /callTemplate/.test(none.error))
  assert.deepEqual(parseShimOutput({ lang: 'node' }, { exitCode: 0, stdout: 'log\n{"results":[3],"errors":[null]}', stderr: '' }, calls), { results: [3], errors: [null] })
  assert.deepEqual(parseShimOutput({ lang: 'node' }, { exitCode: 0, stdout: '[1]', stderr: '' }, calls), { results: [1], errors: [null] })
  assert.match(parseShimOutput({ lang: 'node' }, { exitCode: 2, stdout: '', stderr: 'boom' }, calls).errors[0]!, /exit 2: boom/)
  assert.match(parseShimOutput({ lang: 'node' }, { exitCode: 0, stdout: 'nope', stderr: '' }, calls).errors[0]!, /не JSON/)
  assert.deepEqual(parseShimOutput({ lang: 'bash' }, { exitCode: 0, stdout: 'O\x1f{"a":1}\0', stderr: '' }, calls), { results: [{ a: 1 }], errors: [null] })
  assert.equal(shimLang('a.mts'), 'node')
  assert.equal(shimLang('a.txt'), undefined)
})

test('scripts provider helpers: language by shebang/extension, fn name, argv, stdin', () => {
  assert.equal(scriptLang('x', '#!/usr/bin/env python3\n'), 'python')
  assert.equal(scriptLang('x.sh'), 'bash')
  assert.equal(scriptFnName('.claude/prompt/scripts/changed-files.sh'), 'changed_files')
  assert.deepEqual(scriptArgv('/r/s.py', 'python'), ['python3', '/r/s.py'])
  assert.deepEqual(scriptArgv('/r/s', undefined), ['sh', '/r/s'])
  assert.deepEqual(JSON.parse(scriptStdin(['src'], { deep: true })), { ctx: {}, args: ['src', { deep: true }] })
})

test('usedFunctions / missingExports (G158)', () => {
  const cp = { uses: { util: 'lib/u.py' }, sections: [{ children: [{ t: 'expr' as const, expr: 'util.fmt(x)' }, { t: 'use' as const, name: 'sh', path: 'lib/s.sh' }, { t: 'call' as const, fn: 'sh.build', args: [], as: 'b' }] }] }
  const m = usedFunctions([cp])
  assert.deepEqual([...m.get('lib/u.py')!], ['fmt'])
  assert.deepEqual([...m.get('lib/s.sh')!], ['build'])
  assert.deepEqual(missingExports('lib/u.py', ['fmt', 'gone'], ['fmt']).map((d) => [d.code, d.message]), [['G158', 'Функції gone немає в модулі lib/u.py (експорти: fmt)']])
})

test('parseToolHeaders: every gate-tool comment block of a module, with lines', () => {
  const src = [
    'import x from "y"',
    '',
    '// gate-tool: next_version',
    '// description: Наступна версія',
    '// input: { "bump": "major|minor|patch" }',
    'export function next_version() {}',
    '',
    '// a plain comment',
    'export function helper() {}',
    '# gate-tool: py_tool',
    '# tiers: quick',
    'def py_tool(): pass',
    '// gate-tool: bad name!',
  ].join('\n')
  const r = parseToolHeaders(src)
  assert.deepEqual(r.headers.map((h) => [h.name, h.line, h.description ?? null, h.tiers ?? null]), [['next_version', 3, 'Наступна версія', null], ['py_tool', 10, null, ['quick']]])
  assert.deepEqual(r.headers[0]!.inputSchema, { type: 'object', properties: { bump: { enum: ['major', 'minor', 'patch'] } }, required: ['bump'], additionalProperties: false })
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line]), [['G220', 13]])
  assert.deepEqual(parseToolHeaders('#!/usr/bin/env node\n// nothing\n').headers, [])
})

test('plan-then-act: builtin below premium next to repo prompts; own section or premium or no prompts → none', () => {
  const sys = (id: string, sid = id): CompiledPrompt => ({ version: 1, compiler: 't', id, sourceHash: '', sources: [], sections: [{ id: sid, scope: 'static', children: [] }], diagnostics: [] })
  assert.equal(planThenAct([sys('a')], 'standard')?.sections[0]?.id, PLAN_THEN_ACT_ID)
  assert.equal(planThenAct([sys('a')], 'quick')?.sections[0]?.scope, 'static')
  assert.equal(planThenAct([sys('a')], 'premium'), undefined)
  assert.equal(planThenAct([], 'standard'), undefined)
  assert.equal(planThenAct([sys('a', PLAN_THEN_ACT_ID)], 'standard'), undefined)
  const md = [{ path: '.claude/prompt/a.md', text: '---\nid: a\n---\nA\n' }]
  assert.deepEqual(assemblePrompts([], md, 'standard').system.map((p) => p.id), ['a', PLAN_THEN_ACT_ID])
  assert.deepEqual(assemblePrompts([], md, 'standard', undefined, { builtins: false }).system.map((p) => p.id), ['a'])
})
