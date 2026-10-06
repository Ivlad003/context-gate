import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Node, SectionNode } from '../packages/core/src/types.ts'
import {
  h, Fragment, Prompt, Section, If, Else, Each, Let, Set, Store, Repeat, Break, Continue, Run, Use, Call, Include, Skill, Rule, Mcp, Lazy,
  Tier, Fence, List, Table, V, Debug, Assert, Log, Trace, CursorRules, Examples, HealthWarning, arg, ctx, e, takeDiagnostics, compilePrompt,
  type PromptMarker, type SectionMarker,
} from '../packages/jsx/src/index.ts'

const node = (v: unknown) => v as Node
const codes = () => takeDiagnostics().map((d) => d.code)
const section = (...children: unknown[]) => (h(Section, { id: 's', scope: 'profile' }, ...children) as SectionMarker).section

test('components → canonical AST nodes', () => {
  const cases: [string, unknown, Node | Node[]][] = [
    ['V', h(V, { expr: 'r.body' }), { t: 'expr', expr: 'r.body' }],
    ['Let', h(Let, { name: 'limit', value: 'gate.tier == "quick" ? 3 : 6' }), { t: 'let', name: 'limit', value: 'gate.tier == "quick" ? 3 : 6' }],
    ['Set number', h(Set, { name: 'n', value: 0 }), { t: 'set', name: 'n', value: '0' }],
    ['Store', h(Store, { name: 'counter' }), { t: 'store', name: 'counter' }],
    ['Repeat', h(Repeat, { n: 'min(attempts, 3)' }, h(Break, null), h(Continue, null)), { t: 'repeat', n: 'min(attempts, 3)', children: [{ t: 'break' }, { t: 'continue' }] }],
    ['Run', h(Run, { lang: 'bash', cache: '5m', as: 'log', needs: ['diff'] }, 'git log --oneline -5'), { t: 'run', lang: 'bash', code: 'git log --oneline -5', as: 'log', cache: '5m', needs: ['diff'] }],
    ['Run store kept', h(Run, { lang: 'python', as: 'api', store: 'api-endpoints', cache: '1h' }, 'print(1)'), { t: 'run', lang: 'python', code: 'print(1)', as: 'api', cache: '1h', store: 'api-endpoints' }],
    ['Use', h(Use, { name: 'gitx', path: 'scripts/git-extra.js' }), { t: 'use', name: 'gitx', path: 'scripts/git-extra.js' }],
    ['Call', h(Call, { fn: 'util.summarize', args: ['commits'], kwargs: { tier: 'gate.tier' }, as: 'summary', cache: '1h' }), { t: 'call', fn: 'util.summarize', args: ['commits'], as: 'summary', kwargs: { tier: 'gate.tier' }, cache: '1h' }],
    ['Call default as', h(Call, { fn: 'util.next_version', args: ['pkg.version', '"minor"'] }), { t: 'call', fn: 'util.next_version', args: ['pkg.version', '"minor"'], as: 'next_version' }],
    ['Include file', h(Include, { path: 'docs/api.md', mode: 'ref' }), { t: 'include', source: 'file', ref: 'docs/api.md', mode: 'ref' }],
    ['Include text', h(Include, { text: '\n  # T\n  body\n', budget: 100 }), { t: 'include', source: 'text', ref: 'text', mode: 'inline', text: '# T\nbody', budget: 100 }],
    ['Include section', h(Include, { section: 'glossary', mode: 'ref' }), { t: 'include', source: 'section', ref: 'glossary', mode: 'ref' }],
    ['Skill', h(Skill, { name: 'tdd', mode: 'inline' }), { t: 'include', source: 'skill', ref: 'tdd', mode: 'inline' }],
    ['Skill default ref', h(Skill, { name: 'deploy' }), { t: 'include', source: 'skill', ref: 'deploy', mode: 'ref' }],
    ['Rule', h(Rule, { id: 'api-conventions', mode: 'lazy' }), { t: 'include', source: 'rule', ref: 'api-conventions', mode: 'lazy' }],
    ['Mcp', h(Mcp, { server: 'github', tool: 'list_prs', args: { state: 'open', limit: 5, pr: '{{ args.pr }}', who: ctx.session.id }, as: 'prs' }),
      { t: 'include', source: 'mcp', ref: 'github.list_prs', mode: 'inline', as: 'prs', args: { state: '"open"', limit: '5', pr: 'args.pr', who: 'session.id' } }],
    ['Tier list', h(Tier, { is: ['quick', 'standard'] }, 'x'), { t: 'tier', is: ['quick', 'standard'], children: [{ t: 'text', value: 'x' }] }],
    ['Tier string', h(Tier, { is: 'quick' }), { t: 'tier', is: ['quick'], children: [] }],
    ['Tier default', h(Tier, null, 'y'), { t: 'tier', is: 'non-premium', children: [{ t: 'text', value: 'y' }] }],
    ['Fence', h(Fence, { lang: 'ts', title: 'a.ts' }, '{{ ex.body }}'), { t: 'fence', children: [{ t: 'expr', expr: 'ex.body' }], lang: 'ts', title: 'a.ts' }],
    ['List', h(List, { ordered: true }, h('li', null, 'a')), { t: 'list', children: [{ t: 'el', tag: 'li', children: [{ t: 'text', value: 'a' }] }], ordered: true }],
    ['Table', h(Table, { columns: ['id', 'chars'], rows: 'cursor.auto', cells: ['row.id', 'row.cost.chars'] }), { t: 'table', columns: ['id', 'chars'], rows: 'cursor.auto', cells: ['row.id', 'row.cost.chars'] }],
    ['Debug', h(Debug, { message: 'commits' }, ['prs', ctx.data.prs]), { t: 'debug', exprs: ['prs', 'data.prs'], message: 'commits' }],
    ['Assert', h(Assert, { test: 'len(commits) < 500', message: 'багато' }), { t: 'assert', test: 'len(commits) < 500', message: 'багато' }],
    ['Log', h(Log, { level: 'warn' }, 'увага {{ x }}'), { t: 'log', level: 'warn', message: 'увага {{ x }}' }],
    ['Trace', h(Trace, { on: false }), { t: 'trace', on: false }],
    ['intrinsic', h('code', { class: 'x' }, 'pnpm test'), { t: 'el', tag: 'code', children: [{ t: 'text', value: 'pnpm test' }], attrs: { class: 'x' } }],
    ['br', h('br', null), { t: 'el', tag: 'br', children: [] }],
  ]
  for (const [name, got, want] of cases) assert.deepEqual(got, want, name)
  // Р5: `store=` on Run is the legacy form of <Store> (G180), the only diagnostic of the table.
  assert.deepEqual(codes(), ['G180'])
})

test('G180: store= on Run and Call is legacy, the node keeps it', () => {
  assert.deepEqual(h(Call, { fn: 'util.sum', as: 'sum', store: 'total' }), { t: 'call', fn: 'util.sum', args: [], as: 'sum', store: 'total' })
  const ds = takeDiagnostics()
  assert.deepEqual(ds.map((d) => [d.code, d.severity]), [['G180', 'warning']])
  assert.match(ds[0]!.hint!, /<Store name="sum"/)
  h(Run, { lang: 'bash', as: 'log' }, 'git log')
  assert.deepEqual(codes(), [])
})

test('Section and Prompt markers', () => {
  const p = h(Prompt, null,
    h(Section, { id: 'identity', scope: 'static' }, 'Hi'),
    '\n  ',
    h(Section, { id: 'rules', scope: 'profile', when: 'gate.profile == "backend"', budget: 4000, after: 'identity', tier: ['quick'] }, 'R'),
  ) as PromptMarker
  assert.equal(p.$cg, 'prompt')
  const strip = (s: SectionNode) => { const { source: _s, ...rest } = s; return rest }
  assert.deepEqual(p.sections.map(strip), [
    { id: 'identity', scope: 'static', children: [{ t: 'text', value: 'Hi' }] },
    { id: 'rules', scope: 'profile', children: [{ t: 'text', value: 'R' }], when: 'gate.profile == "backend"', budget: 4000, after: 'identity', tier: ['quick'] },
  ])
  assert.match(p.sections[0]!.source!.path, /jsx\.test\.ts$/)
  assert.deepEqual(codes(), [])
})

test('text is kept as authored with Markdown dedent', () => {
  const s = section('\n      Перший рядок\n      другий рядок.\n\n      Абзац 2 з ', ctx.git.branch, '.\n        вкладений відступ\n    ')
  assert.deepEqual(s.children, [
    { t: 'text', value: 'Перший рядок\nдругий рядок.\n\nАбзац 2 з ' },
    { t: 'expr', expr: 'git.branch' },
    { t: 'text', value: '.\n  вкладений відступ' },
  ])
  // Whitespace between blocks collapses to one newline (or a blank line).
  const s2 = section('Вступ\n\n\n\n  ', h('ol', null, '\n  ', h('li', null, 'a'), '\n  ', h('li', null, 'b'), '\n'), '\n  ')
  assert.deepEqual(s2.children, [
    { t: 'text', value: 'Вступ\n\n' },
    { t: 'el', tag: 'ol', children: [{ t: 'el', tag: 'li', children: [{ t: 'text', value: 'a' }] }, { t: 'text', value: '\n' }, { t: 'el', tag: 'li', children: [{ t: 'text', value: 'b' }] }] },
  ])
  // Fragments normalize their own text, so mixed indentation across components does not leak.
  const frag = h(Fragment, null, '\n        deep\n        text\n      ')
  assert.deepEqual(section('\n  top\n  ', frag).children, [{ t: 'text', value: 'top\ndeep\ntext' }])
  // `{{ }}` in strings becomes interpolation.
  assert.deepEqual(section('{{ a }} і {{ b | len }}'), { id: 's', scope: 'profile', children: [{ t: 'expr', expr: 'a' }, { t: 'text', value: ' і ' }, { t: 'expr', expr: 'b | len' }], source: section('').source })
  // Run code is dedented as a block, braces from template literals are untouched.
  assert.equal((h(Run, { lang: 'python', cache: '1h' }, '\n    ', `import json\nprint(json.dumps({"a": 1}))`, '\n  ') as { code: string }).code, 'import json\nprint(json.dumps({"a": 1}))')
  assert.deepEqual(codes(), [])
})

test('If / Else', () => {
  assert.deepEqual(h(If, { test: 'ctx.percent > budgets.soft' }, 'Стисло.\n  ', h(Else, null, 'Детально.')), {
    t: 'if', test: 'ctx.percent > budgets.soft', then: [{ t: 'text', value: 'Стисло.' }], else: [{ t: 'text', value: 'Детально.' }],
  })
  assert.deepEqual(h(If, { test: ctx.git.dirty }, 'x'), { t: 'if', test: 'git.dirty', then: [{ t: 'text', value: 'x' }] })
  h(Section, { id: 'a', scope: 'static' }, h(Else, null, 'x'))
  assert.deepEqual(codes(), ['G001'])
})

test('Each: string children, function child proxy, build-time arrays', () => {
  assert.deepEqual(h(Each, { of: 'cursor.always', as: 'r' }, h('li', null, h(V, { expr: 'r.body' }))), {
    t: 'each', of: 'cursor.always', as: 'r', children: [{ t: 'el', tag: 'li', children: [{ t: 'expr', expr: 'r.body' }] }],
  })
  // `{r => <li>{r.body}</li>}` → `<li>{{ r.body }}</li>`; `as` comes from the parameter name.
  assert.deepEqual(h(Each, { of: 'cursor.always' }, (r: any) => h('li', null, r.body)), {
    t: 'each', of: 'cursor.always', as: 'r', children: [{ t: 'el', tag: 'li', children: [{ t: 'expr', expr: 'r.body' }] }],
  })
  // Template literals, nested paths, calls, indexes, index parameter, formatting whitespace around the function.
  assert.deepEqual(h(Each, { of: 'commits' }, '\n  ', (c: any, n: any) => h('li', null, `${c.type}(${c.scope}): `, c.subject, ' #', n, ' ', c.files.at(0), ' ', c.tags[0], ' ', c.items.join(', ')), '\n'), {
    t: 'each', of: 'commits', as: 'c', index: 'n',
    children: [{ t: 'el', tag: 'li', children: [
      { t: 'expr', expr: 'c.type' }, { t: 'text', value: '(' }, { t: 'expr', expr: 'c.scope' }, { t: 'text', value: '): ' }, { t: 'expr', expr: 'c.subject' },
      { t: 'text', value: ' #' }, { t: 'expr', expr: 'n' }, { t: 'text', value: ' ' }, { t: 'expr', expr: 'c.files.at(0)' }, { t: 'text', value: ' ' },
      { t: 'expr', expr: 'c.tags.at(0)' }, { t: 'text', value: ' ' }, { t: 'expr', expr: 'c.items.join(", ")' },
    ] }],
  })
  // Destructured parameter: falls back to `it`, properties still resolve.
  assert.deepEqual(h(Each, { of: 'fs.examples("src/*.ts", 1)' }, ({ path }: any) => h(Fence, { title: path }, 'x')), {
    t: 'each', of: 'fs.examples("src/*.ts", 1)', as: 'it', children: [{ t: 'fence', children: [{ t: 'text', value: 'x' }], title: '{{ it.path }}' }],
  })
  // Build-time data is unrolled into constants.
  assert.deepEqual(h('ul', null, h(Each, { of: ['a', 'b'] }, (x: string, i: number) => h('li', null, `${i}:${x}`))), {
    t: 'el', tag: 'ul', children: [{ t: 'el', tag: 'li', children: [{ t: 'text', value: '0:a' }] }, { t: 'el', tag: 'li', children: [{ t: 'text', value: '1:b' }] }],
  })
  assert.deepEqual(codes(), [])
})

test('G160: build-time values and JS operators in expression positions', () => {
  const cases: [string, () => unknown][] = [
    ['boolean when', () => h(Section, { id: 'x', scope: 'profile', when: (ctx.ctx.percent as unknown as number) > 50 }, 'x')],
    ['operator inside Each fn', () => h(Each, { of: 'xs' }, (r: any) => h(If, { test: r.n > 1 }, 'x'))],
    ['object in text', () => section({ a: 1 })],
    ['array of with node children', () => h(Each, { of: [1, 2] }, 'x')],
  ]
  for (const [name, fn] of cases) {
    fn()
    assert.ok(codes().includes('G160'), name)
  }
  // Template literal over ctx in an expression position is fine: placeholders are unwrapped.
  assert.equal((h(If, { test: `${ctx.ctx.percent} > 50` }, 'x') as { test: string }).test, 'ctx.percent > 50')
  assert.deepEqual(codes(), [])
})

test('ctx references and the e template', () => {
  assert.equal(e`${ctx.ctx.percent} > ${50}`, 'ctx.percent > 50')
  assert.equal(e`${ctx.gate.profile} != ${'docs'} && ${ctx.git.branch} ~ ${'^feat/'}`, 'gate.profile != "docs" && git.branch ~ "^feat/"')
  assert.equal(e`${ctx.fs.examples('src/**/*.ts', 1)} | take(1)`, 'fs.examples("src/**/*.ts", 1) | take(1)')
  assert.equal(String(ctx.git.branch), '{{ git.branch }}')
  assert.equal(`${ctx.data['api-endpoints'].count}`, '{{ data.api-endpoints.count }}')
  assert.deepEqual(codes(), [])
})

test('arg builders → ArgSpec', () => {
  const cases: [unknown, unknown][] = [
    [arg.string({ positional: 0, required: true, hint: '<tag|sha>' }), { type: 'string', positional: 0, required: true, hint: '<tag|sha>' }],
    [arg.enum(['md', 'slack', 'github'], { default: 'md' }), { type: 'enum', default: 'md', values: ['md', 'slack', 'github'] }],
    [arg.string({ default: null }), { type: 'string', default: null }],
    [arg.flag(), { type: 'flag' }],
    [arg.number({ description: 'PR' }), { type: 'number', description: 'PR' }],
    [arg.path(), { type: 'path' }],
    [arg.list(), { type: 'list' }],
    [arg.json(), { type: 'json' }],
    [arg.rest({ hint: '<args>' }), { type: 'rest', hint: '<args>' }],
  ]
  for (const [got, want] of cases) assert.deepEqual(got, want)
})

test('custom components inline; recursion is G151', () => {
  const Item = ({ label }: { label: string }) => h('li', null, label)
  assert.deepEqual(h('ul', null, h(Item, { label: 'a' }), h(Item, { label: 'b' })), {
    t: 'el', tag: 'ul', children: [{ t: 'el', tag: 'li', children: [{ t: 'text', value: 'a' }] }, { t: 'el', tag: 'li', children: [{ t: 'text', value: 'b' }] }],
  })
  const Self = (): unknown => h('p', null, h(Self, null))
  h(Self, null)
  const d = takeDiagnostics()
  assert.deepEqual(d.map((x) => x.code), ['G151'])
  assert.match(d[0]!.message, /Self → Self/)
  const A = (): unknown => h(B, null)
  const B = (): unknown => h(A, null)
  h(A, null)
  assert.deepEqual(codes(), ['G151'])
  // Nested builtin Each is not recursion.
  h(Each, { of: 'a' }, (x: any) => h(Each, { of: 'x.b' }, (y: any) => y.c))
  assert.deepEqual(codes(), [])
})

test('Lazy → include lazy + G180; structure errors', () => {
  assert.deepEqual(h(Lazy, { name: 'api-conventions', path: 'docs/api.md' }, 'Умовності REST API'), {
    t: 'include', source: 'file', ref: 'docs/api.md', mode: 'lazy', as: 'api-conventions', description: 'Умовності REST API',
  })
  assert.deepEqual(codes(), ['G180'])
  h(Section, { id: 'outer', scope: 'static' }, h(Section, { id: 'inner', scope: 'static' }))
  h('blink', null)
  h(Prompt, null, 'stray text')
  h(Repeat, { n: 5000 })
  assert.deepEqual(codes(), ['G001', 'G001', 'G001', 'G152'])
})

test('library components', () => {
  assert.deepEqual(h(CursorRules, null), [{ t: 'each', of: 'cursor.always', as: 'r', children: [{ t: 'el', tag: 'li', children: [{ t: 'expr', expr: 'r.body' }] }] }])
  assert.equal((h(CursorRules, { match: 'session.file' }) as Node[])[0]!.t === 'each' && ((h(CursorRules, { match: 'session.file' }) as { of: string }[])[0]!.of), 'cursor.match(session.file)')
  assert.deepEqual(h(Examples, { glob: 'src/**/*.service.ts', n: 2 }), {
    t: 'each', of: 'fs.examples("src/**/*.service.ts", 2)', as: 'ex', children: [{ t: 'fence', title: '{{ ex.path }}', children: [{ t: 'expr', expr: 'ex.body' }], lang: 'ts' }],
  })
  const hw = node(h(HealthWarning, null))
  assert.equal(hw.t === 'if' && hw.test, 'ctx.percent > budgets.soft')
  assert.deepEqual(codes(), [])
})

test('compilePrompt: skill prompt and invalid default export', () => {
  const p = h(Prompt, {
    as: 'skill', name: 'release-notes', description: 'd', args: { since: arg.string({ positional: 0, required: true }) }, invoke: { model: 'tool' }, tiers: ['standard'],
  }, '\n  ', h(Use, { name: 'gitx', path: 'scripts/git-extra.js' }), '\n  ', h(Let, { name: 'c', value: 'gitx.commitsSince(args.since)' }), '\n  Склади з {{ args.since }}.\n')
  const c = compilePrompt(p, { root: '/nowhere' })
  assert.deepEqual(c.uses, { gitx: 'scripts/git-extra.js' })
  assert.deepEqual(c.skill, {
    name: 'release-notes', description: 'd', args: { since: { type: 'string', positional: 0, required: true } }, invoke: { user: true, model: 'tool' }, tiers: ['standard'],
    body: [{ t: 'let', name: 'c', value: 'gitx.commitsSince(args.since)' }, { t: 'text', value: '\nСклади з ' }, { t: 'expr', expr: 'args.since' }, { t: 'text', value: '.' }],
  })
  assert.equal(c.id, 'release-notes')
  assert.deepEqual(c.diagnostics, [])
  const bad = compilePrompt(h('p', null, 'x'), { file: 'a.prompt.tsx' })
  assert.deepEqual(bad.diagnostics.map((d) => [d.code, d.path]), [['G001', 'a.prompt.tsx']])
})

test('compilePrompt: canonical nodes only (store= → Store with key, scripts let → Call, skill body too); Store to=', () => {
  assert.deepEqual(h(Store, { name: 'api', to: 'api-endpoints' }), { t: 'store', name: 'api', key: 'api-endpoints' })
  const p = h(Prompt, { id: 'p' },
    h(Section, { id: 's', scope: 'volatile' },
      h(Run, { lang: 'python', as: 'api', store: 'api-endpoints', cache: '1h' }, 'print(1)'),
      h(Let, { name: 'todos', value: 'scripts.open_todos("src")' })))
  const c = compilePrompt(p, { root: '/nowhere' })
  assert.deepEqual(c.sections[0]!.children, [
    { t: 'run', lang: 'python', code: 'print(1)', as: 'api', cache: '1h' },
    { t: 'store', name: 'api', key: 'api-endpoints' },
    { t: 'call', fn: 'scripts.open_todos', args: ['"src"'], as: 'todos' },
  ])
  assert.deepEqual(c.diagnostics.map((d) => d.code), ['G180'])
  const sk = h(Prompt, { as: 'skill', name: 'x', description: 'd' }, h(Call, { fn: 'u.f', as: 'r', store: 'r' }))
  const cs = compilePrompt(sk, { root: '/nowhere' })
  assert.deepEqual(cs.skill!.body, [{ t: 'call', fn: 'u.f', args: [], as: 'r' }, { t: 'store', name: 'r' }])
})
