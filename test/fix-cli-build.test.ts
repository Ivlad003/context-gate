// Regression tests (review 2026-10-06, package cli): the TSX build and its consumers.
// M29/M30 the SKILL.md live line, M31 output after the sentinel, M32 orphans, M33 hand-written SKILL.md,
// M34 checkStale with a renamed skill, M35 run renders the fresh build, M36 sync rebuilds or reports H013.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CompiledPrompt } from '../packages/core/src/types.ts'
import { buildPrompts, checkStale, isGeneratedSkillMd, readLock, renderSkillMd, skillCommand } from '../packages/cli/src/build.ts'
import { syncCommand } from '../packages/cli/src/cmd-sync.ts'
import { cli, sandbox } from './cli-helpers.ts'

function miniRepo(files: Record<string, string>): string {
  const root = sandbox()
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text) }
  return root
}

const skill = (name: string, text: string) => `import { Prompt } from '@context-gate/jsx'\nexport default <Prompt as="skill" name="${name}" description="d">\n  ${text}\n</Prompt>\n`
const main = (text: string) => `import { Prompt, Section } from '@context-gate/jsx'\nexport default <Prompt>\n  <Section id="rules">${text}</Section>\n</Prompt>\n`
const errors = <T extends { severity: string }>(ds: T[]): T[] => ds.filter((d) => d.severity === 'error')

test('M29/M30 live line: $ARGUMENTS single-quoted (no shell expansion), CLI from the plugin or the installed package', () => {
  const dir = sandbox()
  const md = renderSkillMd({ version: 1, compiler: 'x', id: 'notes', sourceHash: 'a'.repeat(64), sources: [], sections: [], diagnostics: [], skill: { name: 'notes', description: 'd', args: {}, invoke: {}, body: [] } } as unknown as CompiledPrompt)
  const line = md.split('\n').find((l) => l.startsWith('!`'))!
  assert.equal(line, '!`' + skillCommand('notes') + '`')
  // Claude Code substitutes $ARGUMENTS as raw text; bash then runs the line.
  const plugin = join(dir, 'plugin')
  mkdirSync(join(plugin, 'dist'), { recursive: true })
  writeFileSync(join(plugin, 'dist/cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  const pwned = join(dir, 'pwned')
  const args = `--title "v1.4 notes" $(touch ${pwned}) \`touch ${pwned}\` $HOME --format md`
  const cmd = line.slice(2, -1).split('$ARGUMENTS').join(args)
  const out = execFileSync('bash', ['-c', cmd], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin }, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(out), ['run', 'notes', '--args', args, '--ctx-from', 'live'])
  assert.ok(!existsSync(pwned), 'no command substitution from the arguments')
  // Without the plugin: the repo's installed context-gate (npx --no-install), never `node "/dist/cli.js"`.
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho "npx $*"\n')
  chmodSync(join(bin, 'npx'), 0o755)
  const out2 = execFileSync('bash', ['-c', line.slice(2, -1).split('$ARGUMENTS').join('v1')], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: '', PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' })
  assert.equal(out2.trim(), 'npx --no-install context-gate run notes --args v1 --ctx-from live')
})

test('M31 a prompt that prints after the result builds; M33 a hand-written SKILL.md is never overwritten (only --force)', async () => {
  const late = `import { Prompt, Section } from '@context-gate/jsx'\nsetTimeout(() => console.log('late log'), 0)\nprocess.on('exit', () => console.log('{"broken'))\nexport default <Prompt><Section id="a">A</Section></Prompt>\n`
  const root = miniRepo({ '.claude/prompt/late.prompt.tsx': late, '.claude/prompt/mine.prompt.tsx': skill('mine', 'generated'), '.claude/skills/mine/SKILL.md': '---\nname: mine\n---\nmy own text\n' })
  const r = await buildPrompts({ root })
  assert.deepEqual(r.compiled.map((c) => c.id).sort(), ['late', 'mine'])
  const e = errors(r.diagnostics)
  assert.equal(e.length, 1)
  assert.match(e[0]!.message, /написано вручну/)
  assert.equal(readFileSync(join(root, '.claude/skills/mine/SKILL.md'), 'utf8'), '---\nname: mine\n---\nmy own text\n')
  const f = await buildPrompts({ root, force: true })
  assert.deepEqual(errors(f.diagnostics), [])
  assert.ok(isGeneratedSkillMd(readFileSync(join(root, '.claude/skills/mine/SKILL.md'), 'utf8')))
})

test('M32/M34 rename a skill: the old .compiled and generated SKILL.md go, checkStale stays fresh, run uses the new one', async () => {
  const root = miniRepo({ '.claude/prompt/hi.prompt.tsx': skill('hello-old', 'OLD') })
  assert.deepEqual(errors((await buildPrompts({ root })).diagnostics), [])
  assert.ok(existsSync(join(root, '.claude/skills/hello-old/SKILL.md')))
  writeFileSync(join(root, '.claude/prompt/hi.prompt.tsx'), skill('hello-new', 'NEW'))
  const r = await buildPrompts({ root })
  assert.deepEqual(errors(r.diagnostics), [])
  assert.deepEqual(r.removed?.sort(), ['.claude/prompt/.compiled/hello-old.json', '.claude/skills/hello-old/SKILL.md'])
  assert.ok(!existsSync(join(root, '.claude/skills/hello-old')))
  assert.deepEqual(Object.keys(readLock(root)!.prompts), ['hello-new'])
  assert.deepEqual(checkStale({ root }), { stale: [], missing: [] })
  // An orphan left behind by an older build (not in the lock) neither renders nor makes the entry stale.
  const orphan = JSON.parse(readFileSync(join(root, '.claude/prompt/.compiled/hello-new.json'), 'utf8')) as CompiledPrompt
  writeFileSync(join(root, '.claude/prompt/.compiled/zz-orphan.json'), JSON.stringify({ ...orphan, id: 'zz-orphan', sourceHash: 'stale', skill: { ...orphan.skill!, name: 'zz-orphan' } }))
  assert.deepEqual(checkStale({ root }), { stale: [], missing: [] })
  assert.equal((await cli(root, ['run', 'zz-orphan', '--no-build'])).out.includes('NEW'), false)
})

test('M35 run after an edit renders the rebuilt prompt, not the old .compiled', async () => {
  const root = miniRepo({ '.claude/prompt/main.prompt.tsx': main('OLD RULE TEXT') })
  assert.equal((await cli(root, ['build'])).code, 0)
  writeFileSync(join(root, '.claude/prompt/main.prompt.tsx'), main('NEW RULE TEXT'))
  const r = await cli(root, ['run', '--trust-repo', '--no-markers'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /NEW RULE TEXT/)
  assert.doesNotMatch(r.out, /OLD RULE TEXT/)
})

test('M36 sync: trusted → rebuilds stale TSX before prompt.generated.md; untrusted → H013 instead of silence', async () => {
  const root = miniRepo({ '.claude/prompt/main.prompt.tsx': main('OLD RULE TEXT'), '.claude/gate.json': '{}' })
  assert.equal((await cli(root, ['build'])).code, 0)
  writeFileSync(join(root, '.claude/prompt/main.prompt.tsx'), main('NEW RULE TEXT'))
  const untrusted = await syncCommand({ root, noOverrides: true, noRules: true })
  assert.ok(untrusted.diagnostics?.some((d) => d.code === 'H013'))
  const hook = await cli(root, ['sync', '--hook', '--no-overrides'])
  assert.match(hook.err, /H013/, 'the SessionStart hook says so on stderr')
  const trusted = await syncCommand({ root, noOverrides: true, noRules: true, trustRepo: true })
  assert.deepEqual(trusted.diagnostics, [])
  assert.match(readFileSync(join(root, '.claude/prompt.generated.md'), 'utf8'), /NEW RULE TEXT/)
})
