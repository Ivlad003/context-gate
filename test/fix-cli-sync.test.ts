// Regression tests (review 2026-10-06, package cli): the static adapter `sync`.
// M37 markdown-dir on .claude/rules never re-reads sync's output, M38 shadow mode hides no skill,
// M39 an unparseable settings.local.json is never overwritten.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installSyncHook, syncCommand } from '../packages/cli/src/cmd-sync.ts'
import { cli, sandbox } from './cli-helpers.ts'

function repo(files: Record<string, string>): string {
  const root = sandbox()
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text) }
  return root
}

const GATE = {
  groups: { core: ['skill:tdd'], web: ['skill:react-*'] },
  tiers: { premium: { groups: ['core'] }, standard: { groups: ['core'] }, quick: { groups: ['core'] } },
  profiles: { web: { groups: ['web'] } },
}
const SKILLS = { '.claude/skills/misc/SKILL.md': '---\nname: misc\ndescription: misc\n---\nbody\n', '.claude/skills/react-forms/SKILL.md': '---\nname: react-forms\ndescription: forms\n---\nbody\n', '.claude/skills/tdd/SKILL.md': '---\nname: tdd\ndescription: tdd\n---\nbody\n' }

test('M37 markdown-dir on .claude/rules: repeated syncs do not nest cursor/cursor/… copies', async () => {
  const root = repo({
    '.claude/gate.json': JSON.stringify({ itemSources: [{ kind: 'markdown-dir', dir: '.claude/rules', frontmatter: { paths: 'globs' } }] }),
    '.claude/rules/ts.md': '---\npaths: "**/*.ts"\n---\nUse strict TS.\n',
  })
  for (let i = 0; i < 3; i++) await syncCommand({ root, noPrompt: true, noOverrides: true })
  assert.ok(existsSync(join(root, '.claude/rules/cursor/ts.md')))
  assert.ok(!existsSync(join(root, '.claude/rules/cursor/cursor')), 'no nested copy')
})

test('M38 classify.mode shadow: sync writes no skillOverrides unless --profile/--tier is explicit', async () => {
  const table: [string, Record<string, unknown>, { profile?: string }, boolean][] = [
    ['shadow, no profile → nothing hidden', { ...GATE, classify: { mode: 'shadow' } }, {}, false],
    ['shadow, explicit --profile → applied', { ...GATE, classify: { mode: 'shadow' } }, { profile: 'web' }, true],
    ['auto → applied', { ...GATE, classify: { mode: 'auto' } }, {}, true],
  ]
  for (const [name, gate, flags, hides] of table) {
    const root = repo({ '.claude/gate.json': JSON.stringify(gate), ...SKILLS })
    const r = await syncCommand({ root, noPrompt: true, noRules: true, ...flags })
    assert.equal(Object.keys(r.overrides).length > 0, hides, name)
  }
})

test('M39 an unparseable settings.local.json is reported and left byte-for-byte as it was', async () => {
  const bad = '{\n  "permissions": { "allow": ["Bash(npm test)"] },\n}\n'
  const root = repo({ '.claude/gate.json': JSON.stringify({ ...GATE, classify: { mode: 'auto' } }), '.claude/settings.local.json': bad, ...SKILLS })
  const r = await syncCommand({ root, noPrompt: true, noRules: true })
  assert.ok(r.diagnostics?.some((d) => d.code === 'G301'))
  assert.equal(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'), bad)
  assert.equal(installSyncHook(root).invalid, true)
  const inst = await cli(root, ['sync', '--install-hook'])
  assert.equal(inst.code, 1)
  assert.match(inst.err, /G301/)
  assert.equal(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'), bad)
  // A missing file is still created.
  const fresh = repo({})
  assert.equal(installSyncHook(fresh, { command: 'x sync --hook' }).changed, true)
  assert.ok(existsSync(join(fresh, '.claude/settings.local.json')))
})
