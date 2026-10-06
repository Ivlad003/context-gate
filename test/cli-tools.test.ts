// G-36 CLI side: `context-gate tools` lists whole-script tools and function-level `# gate-tool:` exports of the
// tool modules (lib/*, module providers, `use` paths), as the mod registers them; `--call` serves one.
// Also `--no-user-skills` / CONTEXT_GATE_NO_USER_SKILLS (machine-independent collect / bench).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cli, jsonl, sandbox } from './cli-helpers.ts'

function write(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), text)
  }
}

const compiled = (id: string, extra: Record<string, unknown>) => JSON.stringify({ version: 1, compiler: 'test', id, sourceHash: '', sources: [], diagnostics: [], ...extra })

function repoWithTools(): string {
  const root = join(sandbox(), 'repo')
  write(root, {
    '.claude/gate.json': JSON.stringify({ providers: { ver: { kind: 'module', path: 'tools/ver.mjs' } } }),
    '.claude/prompt/scripts/count.sh': '#!/usr/bin/env bash\n# gate-tool: count_files\n# description: Count files\n# input: { "dir": "string" }\n# tiers: quick\necho 3\n',
    '.claude/prompt/scripts/plain.sh': 'echo no header\n',
    '.claude/prompt/lib/util.mjs': '// gate-tool: add\n// description: Add two numbers\n// input: { "a": "number", "b": "number" }\nexport function add({ a, b }) { return a + b }\nexport function hidden() { return 1 }\n',
    'tools/ver.mjs': '// gate-tool: next_version\n// input: { "bump": "patch|minor|major" }\nexport function next_version({ bump }) { return { version: bump === "minor" ? "1.1.0" : "1.0.1" } }\nexport default function () { return {} }\n',
    'tools/py.py': 'x = 1\n# gate-tool: py_sum\n# input: { "a": "number", "b": "number" }\ndef py_sum(a, b):\n    return {"sum": a + b}\n',
    '.claude/prompt/.compiled/main.json': compiled('main', { uses: { py: 'tools/py.py' }, sections: [{ id: 's', scope: 'static', children: [{ t: 'text', value: 'x' }] }] }),
  })
  return root
}

test('tools: script headers plus function tools of lib/*, module providers and use paths (core parseToolHeaders)', async () => {
  const root = repoWithTools()
  const r = await cli(root, ['tools', '--json'])
  assert.equal(r.code, 0, r.err)
  const tools = JSON.parse(r.out) as { name: string; path: string; fn?: string; tiers?: string[]; inputSchema: Record<string, unknown> }[]
  assert.deepEqual(tools.map((t) => `${t.name}@${t.path}${t.fn ? `#${t.fn}` : ''}`), [
    'count_files@.claude/prompt/scripts/count.sh',
    'add@.claude/prompt/lib/util.mjs#add',
    'py_sum@tools/py.py#py_sum',
    'next_version@tools/ver.mjs#next_version',
  ])
  assert.deepEqual(tools[0]!.tiers, ['quick'])
  assert.deepEqual((tools[1]!.inputSchema as { required: string[] }).required, ['a', 'b'])
  const text = await cli(root, ['tools'])
  assert.match(text.out, /add — Add two numbers \(\.claude\/prompt\/lib\/util\.mjs#add\)/)
  // The function tools are items too (collect), like the mod's script tools.
  const items = jsonl((await cli(root, ['collect'])).out).filter((i) => i.kind === 'tool').map((i) => i.name)
  assert.deepEqual(items.sort(), ['add', 'count_files', 'next_version', 'py_sum'])
  const ix = JSON.parse((await cli(root, ['index', '--print'])).out)
  assert.deepEqual(ix.tools.map((t: { name: string }) => t.name).sort(), ['add', 'count_files', 'next_version', 'py_sum'])
})

test('tools --call: trust, tiers and the shim (input as kwargs) / the script (args on stdin)', async () => {
  const root = repoWithTools()
  const untrusted = await cli(root, ['tools', '--call', 'add', '--input', '{"a":2,"b":3}'])
  assert.equal(untrusted.code, 1)
  assert.match(untrusted.err, /не довірений/)
  const add = await cli(root, ['tools', '--call', 'add', '--input', '{"a":2,"b":3}', '--trust-repo'])
  assert.equal(add.code, 0, add.err)
  assert.equal(add.out.trim(), '5')
  const ver = await cli(root, ['tools', '--call', 'next_version', '--input', '{"bump":"minor"}', '--trust-repo'])
  assert.deepEqual(JSON.parse(ver.out), { version: '1.1.0' })
  const tier = await cli(root, ['tools', '--call', 'count_files', '--input', '{"dir":"."}', '--trust-repo', '--tier', 'standard'])
  assert.match(tier.err, /недоступний для tier standard/)
  const script = await cli(root, ['tools', '--call', 'count_files', '--input', '{"dir":"."}', '--trust-repo', '--tier', 'quick'])
  assert.equal(script.code, 0, script.err)
  assert.equal(script.out.trim(), '3')
  const missing = await cli(root, ['tools', '--call', 'nope', '--trust-repo'])
  assert.equal(missing.code, 1)
  assert.equal((await cli(root, ['tools', '--call', 'add', '--input', '[1]'])).code, 2)
})

test('--no-user-skills and CONTEXT_GATE_NO_USER_SKILLS=1: ~/.claude/skills stay out of collect', async () => {
  const root = join(sandbox(), 'repo')
  write(root, { '.claude/skills/proj/SKILL.md': '---\nname: proj\ndescription: p\n---\nP', '.claude/gate.json': '{}' })
  write(process.env.HOME!, { '.claude/skills/mine/SKILL.md': `---\nname: mine\ndescription: ${'my own skill '.repeat(40)}\n---\n${'M'.repeat(800)}` })
  const names = (out: string) => jsonl(out).filter((i) => i.kind === 'skill').map((i) => i.name).sort()
  assert.deepEqual(names((await cli(root, ['collect'])).out), ['mine', 'proj'])
  assert.deepEqual(names((await cli(root, ['collect', '--no-user-skills'])).out), ['proj'])
  assert.deepEqual(names((await cli(root, ['pipe', 'collect | where kind=skill', '--no-user-skills'])).out), ['proj'])
  assert.deepEqual(names((await cli(root, ['collect'])).out), ['mine', 'proj'], 'the flag does not leak into the next run')
  process.env.CONTEXT_GATE_NO_USER_SKILLS = '1'
  try {
    assert.deepEqual(names((await cli(root, ['collect'])).out), ['proj'])
  } finally {
    delete process.env.CONTEXT_GATE_NO_USER_SKILLS
  }
  // `bench` ignores user skills unless --user-skills.
  const bench = (args: string[]) => cli(root, ['bench', root, '--json', ...args]).then((r) => JSON.parse(r.out)[0].itemsBefore as number)
  const without = await bench([])
  const withUser = await bench(['--user-skills'])
  assert.ok(withUser > without, `${withUser} > ${without}`)
  const { benchEnv } = await import('../bench/run.ts')
  assert.equal(benchEnv({}).CONTEXT_GATE_NO_USER_SKILLS, '1')
  assert.equal(benchEnv({}, true).CONTEXT_GATE_NO_USER_SKILLS, undefined)
})
