import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Node } from '../packages/core/src/types.ts'
import { parseMarkdownPrompt, printMarkdownNodes, hasTierNodes } from '../packages/core/src/mddsl.ts'
import { cli, copyFixture } from './cli-helpers.ts'

test('printMarkdownNodes: AST → Markdown DSL that parses back into the same nodes', () => {
  const src = [
    'Вступ {{ repo.name }}.',
    '@if gate.tier == "quick"',
    'Коротко.',
    '@else',
    'Детально.',
    '@end',
    '@each r, i in cursor.always',
    '- {{ i }}: {{ r.body }}',
    '@end',
    '@let n = len(git.changed)',
    '@run bash as=log cache=5m',
    'git log --oneline -5',
    '@end',
    '@use util scripts/util.py',
    '@call util.sum(n, k=2) as total cache=1h',
    '@include docs/api.md ref budget=200 "Умовності"',
    '@section prompt://glossary inline',
    '@skill tdd inline',
    '@mcp github.list_prs(state="open") as prs',
    '@tier quick, standard',
    '1. Крок.',
    '@end',
    '@debug n, total',
    '@assert n < 10, "забагато"',
    '\\@не директива',
  ].join('\n')
  const a = parseMarkdownPrompt(src, { path: 'x.md' })
  assert.deepEqual(a.diagnostics, [])
  const printed = printMarkdownNodes(a.section.children)
  const b = parseMarkdownPrompt(printed, { path: 'x.md' })
  assert.deepEqual(b.diagnostics, [])
  const norm = (ns: Node[]) => JSON.parse(JSON.stringify(ns, (_k, v) => (typeof v === 'string' ? v.replace(/\n+$/, '') : v)))
  assert.deepEqual(norm(b.section.children), norm(a.section.children))
  // JSX-only shapes print as Markdown.
  const jsx: Node[] = [
    { t: 'el', tag: 'ol', children: [{ t: 'el', tag: 'li', children: [{ t: 'text', value: 'a' }] }, { t: 'el', tag: 'li', children: [{ t: 'el', tag: 'code', children: [{ t: 'text', value: 'x' }] }] }] },
    { t: 'fence', lang: 'ts', title: '{{ ex.path }}', children: [{ t: 'expr', expr: 'ex.body' }] },
    { t: 'table', columns: ['id', 'n'], rows: 'cursor.auto', cells: ['row.id', 'row.cost.chars'] },
  ]
  assert.equal(printMarkdownNodes(jsx), '1. a\n1. `x`\n```ts {{ ex.path }}\n{{ ex.body }}\n```\n| id | n |\n| --- | --- |\n@each row in cursor.auto\n| {{ row.id }} | {{ row.cost.chars }} |\n@end')
  assert.equal(hasTierNodes(jsx), false)
  assert.equal(hasTierNodes([{ t: 'if', test: 'x', then: [{ t: 'tier', is: ['quick'], children: [] }] }]), true)
})

const TSX = `import { Prompt, Section, If, Tier } from '@context-gate/jsx'
export default (
  <Prompt>
    <Section id="tsx-rules" scope="profile">
      Працюй малими кроками.
      <If test="git.dirty">Є незакомічені зміни.</If>
    </Section>
    <Section id="tsx-tiered" scope="profile">
      База.
      <Tier is="quick">Коротко.</Tier>
    </Section>
  </Prompt>
)
`

test('expand: TSX sections from .compiled (Markdown form as canonical text, <Tier> proposal), unbuilt hint', async () => {
  const root = copyFixture()
  writeFileSync(join(root, '.claude/prompt/main.prompt.tsx'), TSX)
  const before = await cli(root, ['expand', '--dry-run', '--only', 'tsx-rules'])
  assert.match(before.out, /Не зібрано: .*main\.prompt\.tsx.*context-gate build/)
  assert.equal((await cli(root, ['build'])).code, 0)
  const dry = await cli(root, ['expand', '--dry-run', '--only', 'tsx-rules,tsx-tiered', '--tiers', 'quick'])
  assert.equal(dry.code, 0, dry.err)
  assert.match(dry.out, /# tsx-rules\.quick → \.claude\/prompt\/proposals\/tsx-rules\.quick\.md \(claude -p --model opus\) \[TSX \.claude\/prompt\/main\.prompt\.tsx:4\]/)
  assert.match(dry.out, /--- оригінал ---\nПрацюй малими кроками\.\n@if git\.dirty\nЄ незакомічені зміни\.\n@end\n--- кінець ---/)
  assert.match(dry.out, /<Tier is="…">/)
  assert.match(dry.out, /# tsx-tiered\.quick: пропущено — секція вже має <Tier>-варіанти/)
  const fake = join(root, 'fake-claude.sh')
  writeFileSync(fake, '#!/usr/bin/env bash\ncat >/dev/null\necho "1. Зроби крок."\n')
  chmodSync(fake, 0o755)
  process.env.CONTEXT_GATE_CLAUDE = fake
  try {
    const r = await cli(root, ['expand', '--only', 'tsx-rules', '--tiers', 'quick'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /записано \.claude\/prompt\/proposals\/tsx-rules\.quick\.md \(TSX: встав як <Tier is="quick">…<\/Tier> у \.claude\/prompt\/main\.prompt\.tsx:4/)
    const p = readFileSync(join(root, '.claude/prompt/proposals/tsx-rules.quick.md'), 'utf8')
    assert.match(p, /^---\nid: tsx-rules\ngenerated-by: context-gate expand \(opus\)\ngenerated-at: .+\nsource-hash: [0-9a-f]{16}\nsource: \.claude\/prompt\/main\.prompt\.tsx:4\napply: "<Tier is=\\"quick\\"> у \.claude\/prompt\/main\.prompt\.tsx"\n---\n1\. Зроби крок\.\n$/)
    assert.match((await cli(root, ['expand', '--only', 'tsx-rules', '--tiers', 'quick'])).out, /пропущено tsx-rules\.quick: пропозиція актуальна/)
  } finally {
    delete process.env.CONTEXT_GATE_CLAUDE
  }
})
