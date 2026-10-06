import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Node, SectionNode } from '../packages/core/src/types.ts'
import { parseMarkdownPrompt, resolveTierVariant, splitTopLevel, tierVariantOf } from '../packages/core/src/mddsl.ts'

const parse = (text: string, path = '.claude/prompt/x.md') => parseMarkdownPrompt(text, { path })
const codes = (text: string): string[] => parse(text).diagnostics.map(d => d.code)

test('frontmatter: id, scope, when, budget, after, tier, use, source-hash', () => {
  const r = parse([
    '---',
    'id: release-notes',
    'scope: volatile',
    'when: gate.profile == "backend"',
    'budget: 4000',
    'after: identity',
    'tier: quick, standard',
    'source-hash: abc123',
    'use:',
    '  util: scripts/util.py',
    '  gitx: scripts/git-extra.js',
    '---',
    'Hello',
  ].join('\n'))
  assert.deepEqual(r.diagnostics, [])
  assert.equal(r.section.id, 'release-notes')
  assert.equal(r.section.scope, 'volatile')
  assert.equal(r.section.when, 'gate.profile == "backend"')
  assert.equal(r.section.budget, 4000)
  assert.equal(r.section.after, 'identity')
  assert.deepEqual(r.section.tier, ['quick', 'standard'])
  assert.equal(r.sourceHash, 'abc123')
  assert.deepEqual(r.uses, { util: 'scripts/util.py', gitx: 'scripts/git-extra.js' })
  assert.deepEqual(r.section.children, [
    { t: 'use', name: 'util', path: 'scripts/util.py' },
    { t: 'use', name: 'gitx', path: 'scripts/git-extra.js' },
    { t: 'text', value: 'Hello\n' },
  ])
})

test('id defaults to the file name, tier variant file name strips tier', () => {
  assert.equal(parse('x', 'p/workflow.md').section.id, 'workflow')
  assert.equal(parse('x', 'p/workflow.quick.md').section.id, 'workflow')
  assert.deepEqual(tierVariantOf('p/workflow.quick.md'), { id: 'workflow', tier: 'quick' })
  assert.equal(tierVariantOf('p/workflow.md'), undefined)
  assert.equal(tierVariantOf('p/a.b.md', ['quick']), undefined)
})

test('spec example: @let/@set/@each/@if with interpolation', () => {
  const r = parse([
    '@let limit = gate.tier == "quick" ? 3 : 6',
    '@set shown = 0',
    '@each r in cursor.auto | sort("cost.chars")',
    '  @if shown < limit',
    '- {{ r.id }} ({{ r.cost.chars / 1000 | round(1) }}k)',
    '    @set shown = shown + 1',
    '  @end',
    '@end',
    'Показано {{ shown }}.',
  ].join('\n'))
  assert.deepEqual(r.diagnostics, [])
  const ch = r.section.children
  assert.deepEqual(ch[0], { t: 'let', name: 'limit', value: 'gate.tier == "quick" ? 3 : 6' })
  assert.equal(ch[2].t, 'each')
  const each = ch[2] as Extract<Node, { t: 'each' }>
  assert.equal(each.as, 'r')
  assert.equal(each.of, 'cursor.auto | sort("cost.chars")')
  const iff = each.children[0] as Extract<Node, { t: 'if' }>
  assert.equal(iff.t, 'if')
  assert.deepEqual(iff.then.slice(0, 5), [
    { t: 'text', value: '- ' },
    { t: 'expr', expr: 'r.id' },
    { t: 'text', value: ' (' },
    { t: 'expr', expr: 'r.cost.chars / 1000 | round(1)' },
    { t: 'text', value: 'k)\n' },
  ])
})

test('@if/@else, @repeat/@break/@continue, @store, @tier', () => {
  const r = parse([
    '@if a',
    'A',
    '@else',
    'B',
    '@end',
    '@repeat min(attempts, 3)',
    '@if i == 1',
    '@continue',
    '@end',
    '@break',
    '@end',
    '@set counter = (data.counter ?? 0) + 1',
    '@store counter',
    '@tier quick, standard',
    'steps',
    '@end',
    '@tier',
    'non-premium',
    '@end',
  ].join('\n'))
  assert.deepEqual(r.diagnostics, [])
  const [iff, rep, , store, t1, t2] = r.section.children as any[]
  assert.deepEqual(iff, { t: 'if', test: 'a', then: [{ t: 'text', value: 'A\n' }], else: [{ t: 'text', value: 'B\n' }] })
  assert.equal(rep.t, 'repeat')
  assert.equal(rep.n, 'min(attempts, 3)')
  assert.deepEqual(rep.children[1], { t: 'break' })
  assert.deepEqual(store, { t: 'store', name: 'counter' })
  assert.deepEqual(t1.is, ['quick', 'standard'])
  assert.equal(t2.is, 'non-premium')
})

test('@run block keeps raw code and options; @call, @use, @mcp', () => {
  const r = parse([
    '---',
    'scope: volatile',
    '---',
    '@run python as=diff cache=10m store=api needs=a,b',
    '  import json',
    '  print(json.dumps({"x": "{{ not interpolated }}"}))',
    '@end',
    '@run',
    'git log --oneline -5',
    '@end',
    '@use util scripts/util.py',
    '@call util.summarize(commits, tier=gate.tier) as summary cache=1h store=sum',
    '@mcp github.list_prs(state="open") as prs',
  ].join('\n'))
  assert.deepEqual(r.diagnostics, [])
  const [run1, run2, use, call, mcp] = r.section.children
  assert.deepEqual(run1, { t: 'run', lang: 'python', code: 'import json\nprint(json.dumps({"x": "{{ not interpolated }}"}))', as: 'diff', cache: '10m', store: 'api', needs: ['a', 'b'] })
  assert.deepEqual(run2, { t: 'run', lang: 'bash', code: 'git log --oneline -5' })
  assert.deepEqual(use, { t: 'use', name: 'util', path: 'scripts/util.py' })
  assert.deepEqual(call, { t: 'call', fn: 'util.summarize', args: ['commits'], kwargs: { tier: 'gate.tier' }, as: 'summary', cache: '1h', store: 'sum' })
  assert.deepEqual(mcp, { t: 'include', source: 'mcp', ref: 'github.list_prs', mode: 'inline', args: { state: '"open"' }, as: 'prs' })
  assert.deepEqual(r.uses, { util: 'scripts/util.py' })
})

test('includes: @include, @section, @skill, @rule, @lazy (G180 → canonical include lazy)', () => {
  const r = parse([
    '@include docs/api.md ref',
    '@include CONVENTIONS.md inline budget=1500',
    '@section prompt://safety-rules inline',
    '@skill tdd inline',
    '@rule api-conventions lazy',
    '@lazy api-conventions docs/api.md "Умовності REST API"',
  ].join('\n'))
  assert.deepEqual(r.diagnostics.map(d => d.code), ['G180'])
  assert.deepEqual(r.section.children, [
    { t: 'include', source: 'file', ref: 'docs/api.md', mode: 'ref' },
    { t: 'include', source: 'file', ref: 'CONVENTIONS.md', mode: 'inline', budget: 1500 },
    { t: 'include', source: 'section', ref: 'safety-rules', mode: 'inline' },
    { t: 'include', source: 'skill', ref: 'tdd', mode: 'inline' },
    { t: 'include', source: 'rule', ref: 'api-conventions', mode: 'lazy' },
    { t: 'include', source: 'file', ref: 'docs/api.md', mode: 'lazy', as: 'api-conventions', description: 'Умовності REST API' },
  ])
})

test('debug, assert, log, trace directives', () => {
  const r = parse([
    '@debug "commits", len(commits), gate.tier',
    '@debug "повідомлення" {{ x }}',
    '@assert len(commits) < 500, "підозріло багато комітів"',
    '@log level=warn "увага"',
    '@trace on',
  ].join('\n'))
  assert.deepEqual(r.diagnostics, [])
  assert.deepEqual(r.section.children, [
    { t: 'debug', exprs: ['"commits"', 'len(commits)', 'gate.tier'] },
    { t: 'debug', exprs: [], message: 'повідомлення {{ x }}' },
    { t: 'assert', test: 'len(commits) < 500', message: 'підозріло багато комітів' },
    { t: 'log', level: 'warn', message: 'увага' },
    { t: 'trace', on: true },
  ])
})

test('@fn is inlined at call sites with params bound by let', () => {
  const r = parse([
    '@fn item(name, n)',
    '- {{ name }}: {{ n }}',
    '@end',
    '@item("a", 1)',
    '@item("b", 2)',
  ].join('\n'))
  assert.deepEqual(r.diagnostics, [])
  assert.equal(r.section.children.length, 2)
  assert.deepEqual(r.section.children[0], {
    t: 'if', test: 'true', then: [
      { t: 'let', name: 'name', value: '"a"' },
      { t: 'let', name: 'n', value: '1' },
      { t: 'text', value: '- ' }, { t: 'expr', expr: 'name' }, { t: 'text', value: ': ' }, { t: 'expr', expr: 'n' }, { t: 'text', value: '\n' },
    ],
  })
})

const diagCases: [string, string, string[]][] = [
  ['direct recursion G151', '@fn a()\n@a()\n@end\n@a()', ['G151']],
  ['mutual recursion G151', '@fn a()\n@b()\n@end\n@fn b()\n@a()\n@end\n@a()', ['G151']],
  ['if nesting > 3 G156', '@if a\n@if b\n@if c\n@if d\nx\n@end\n@end\n@end\n@end', ['G156']],
  ['each nesting > 2 G156', '@each a in x\n@each b in a\n@each c in b\nx\n@end\n@end\n@end', ['G156']],
  ['repeat constant > 1000 G152', '@repeat 5000\nx\n@end', ['G152']],
  ['repeat data bound is fine', '@repeat min(attempts, 3)\nx\n@end', []],
  ['re-assigning @let G153', '@let a = 1\n@set a = 2', ['G153']],
  ['re-declaring @let G153', '@let a = 1\n@let a = 2', ['G153']],
  ['bad expression G1xx keeps parsing', '@if 1 +\nx\n@end\n{{ foo( }}\nok', ['G101', 'G101']],
  ['unknown filter', '{{ x | evil }}', ['G104']],
  ['provider in pipe G154', '{{ x | util.fn }}', ['G154']],
  ['unclosed block', '@if a\nx', ['G002']],
  ['stray @end', '@end', ['G003']],
  ['break outside loop', '@break', ['G005']],
  ['unknown directive stays text', '@Override\nx', ['G001']],
  ['run without cache in static', '---\nscope: static\n---\n@run\nls\n@end', ['G201']],
]
for (const [name, text, want] of diagCases) {
  test(`diagnostics: ${name}`, () => assert.deepEqual(codes(text), want))
}

test('bad line → diagnostic with line number, parsing continues', () => {
  const r = parse('a\n@each nope\nb')
  assert.equal(r.diagnostics[0].code, 'G004')
  assert.equal(r.diagnostics[0].line, 2)
  assert.deepEqual(r.section.children, [{ t: 'text', value: 'a\nb\n' }])
})

test('fenced code is not parsed for directives but is interpolated', () => {
  const r = parse('```java\n@Override\n{{ ex.body }}\n```')
  assert.deepEqual(r.diagnostics, [])
  assert.deepEqual(r.section.children, [
    { t: 'text', value: '```java\n@Override\n' },
    { t: 'expr', expr: 'ex.body' },
    { t: 'text', value: '\n```\n' },
  ])
})

test('spec tier example parses into tier/each nodes', () => {
  const r = parse([
    '---', 'id: workflow', 'scope: profile', '---',
    'Працюй за процесом проєкту.',
    '',
    '@tier quick, standard',
    '1. Прочитай файли.',
    '@end',
    '',
    '@tier quick',
    '@each ex in fs.examples("src/**/*.service.ts", 1)',
    'Зразок ({{ ex.path }}):',
    '```ts',
    '{{ ex.body }}',
    '```',
    '@end',
    '@end',
  ].join('\n'))
  assert.deepEqual(r.diagnostics, [])
  const tiers = r.section.children.filter(n => n.t === 'tier') as Extract<Node, { t: 'tier' }>[]
  assert.equal(tiers.length, 2)
  assert.equal(tiers[1].children[0].t, 'each')
})

test('resolveTierVariant: variant file overrides fully', () => {
  const base: SectionNode = { id: 'workflow', scope: 'profile', children: [{ t: 'text', value: 'base' }] }
  const quick = parseMarkdownPrompt('quick text', { path: 'p/workflow.quick.md', inherit: base }).section
  assert.equal(quick.scope, 'profile')
  assert.equal(resolveTierVariant(base, { quick }, 'quick').children[0].t, 'text')
  assert.deepEqual(resolveTierVariant(base, { quick }, 'quick').children, [{ t: 'text', value: 'quick text\n' }])
  assert.equal(resolveTierVariant(base, { quick }, 'premium'), base)
})

test('splitTopLevel respects quotes and parentheses', () => {
  assert.deepEqual(splitTopLevel('a, f(b, c), "d, e", [1, 2]'), ['a', 'f(b, c)', '"d, e"', '[1, 2]'])
})

test('@elif and @else if nest into else; one @end closes the chain; chain does not count toward G156', () => {
  const r = parse('@if a\nA\n@elif b\nB\n@else if c\nC\n@else\nD\n@end\nafter')
  assert.deepEqual(r.diagnostics, [])
  assert.deepEqual(r.section.children, [
    { t: 'if', test: 'a', then: [{ t: 'text', value: 'A\n' }], else: [
      { t: 'if', test: 'b', then: [{ t: 'text', value: 'B\n' }], else: [
        { t: 'if', test: 'c', then: [{ t: 'text', value: 'C\n' }], else: [{ t: 'text', value: 'D\n' }] },
      ] },
    ] },
    { t: 'text', value: 'after\n' },
  ])
  assert.deepEqual(codes('@if a\n@elif b\n@elif c\n@elif d\n@if e\nx\n@end\n@end'), [])
  assert.deepEqual(codes('@elif x'), ['G003'])
})
