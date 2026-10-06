import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMarkdownPrompt } from '../packages/core/src/mddsl.ts'
import { formatPrompt } from '../packages/cli/src/fmt.ts'
import { scriptLang } from '../packages/cli/src/scripts.ts'
import { parseToolHeader } from '../packages/core/src/toolheader.ts'
import { inferSchema } from '../packages/cli/src/cmd-expand.ts'
import { buildReport } from '../packages/cli/src/cmd-report.ts'
import { selectExamples as pickExamples } from '../packages/core/src/examples.ts'
import { parseArgv } from '../packages/cli/src/argv.ts'
import { REPO, cli, copyFixture, sandbox } from './cli-helpers.ts'

test('data set / get / list: stdin JSON → .claude/prompt/data/<key>.json, visible as data.* in render', async () => {
  const root = copyFixture()
  const s = await cli(root, ['data', 'set', 'release', '--ttl', '1h'], '{"tag":"v2.0.0","count":3}')
  assert.equal(s.code, 0, s.err)
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude/prompt/data/release.json'), 'utf8')), { tag: 'v2.0.0', count: 3 })
  const g = await cli(root, ['data', 'get', 'release'])
  assert.deepEqual(JSON.parse(g.out), { tag: 'v2.0.0', count: 3 })
  assert.equal((await cli(root, ['data', 'list'])).out, 'release\n')
  const r = JSON.parse((await cli(root, ['run', 'data', '--json'])).out)
  assert.match(r.text, /Реліз: v2\.0\.0\./)
  assert.equal(r.scope.data.release.__cgData, 1, 'scope carries a core data envelope')
  assert.equal((await cli(root, ['data', 'get', 'nope'])).code, 1)
  assert.equal((await cli(root, ['data', 'set', 'bad'], 'not json')).code, 2)
  assert.equal((await cli(root, ['data', 'set', '../x'], '{}')).code, 2)
})

test('explain: core codes, CLI G2xx codes, unknown codes', async () => {
  const root = sandbox()
  const a = await cli(root, ['explain', 'G158'])
  assert.equal(a.code, 0)
  assert.match(a.out, /^G158 — Функції немає в модулі/)
  const b = await cli(root, ['explain', 'g204'])
  assert.match(b.out, /^G204 — Репозиторій не довірений/)
  const c = await cli(root, ['explain', 'G599'])
  assert.equal(c.code, 1)
  assert.match(c.out, /Невідомий код G599\. Родина: G5xx/)
})

const MESSY = [
  '---',
  'id: fmt',
  '---',
  'Текст   з пробілами  ',
  '@if   gate.tier == "quick"',
  '@each x in [1, 2]',
  '    - {{ x }}',
  '@if x > 1',
  'великий',
  '@else',
  'малий',
  '@end',
  '@end',
  '      @let y = 1',
  '```md',
  '@if not-a-directive-in-fence',
  '```',
  '@run bash as=r',
  '  echo hi',
  '@end',
  '@someone mentioned here',
  '@end',
  '',
].join('\n')

test('fmt: re-indents directives only, is idempotent and keeps the parsed AST', () => {
  const r = formatPrompt(MESSY)
  assert.equal(r.refused, undefined)
  assert.ok(r.changed)
  assert.equal(r.text, [
    '---', 'id: fmt', '---', 'Текст   з пробілами  ',
    '@if gate.tier == "quick"', '  @each x in [1, 2]', '    - {{ x }}', '    @if x > 1', 'великий', '    @else', 'малий', '    @end', '  @end',
    '  @let y = 1', '```md', '@if not-a-directive-in-fence', '```', '  @run bash as=r', '  echo hi', '  @end', '@someone mentioned here', '@end', '',
  ].join('\n'))
  const again = formatPrompt(r.text)
  assert.equal(again.changed, false)
  assert.equal(again.text, r.text)
  const strip = (t: string) => JSON.stringify(parseMarkdownPrompt(t, { path: 'p/fmt.md' }).section, (k, v) => (k === 'source' || k === 'line' ? undefined : v))
  assert.equal(strip(r.text), strip(MESSY))
})

test('fmt: refuses nesting it cannot trust (unbalanced, @else outside @if, fence across blocks, too deep)', () => {
  for (const [src, why] of [
    ['@if a\nx\n', /@if без @end/],
    ['x\n@end\n', /зайвий @end/],
    ['@each x in xs\n@else\n@end\n', /@else поза @if/],
    ['@if a\n```\n@end\n```\n', /@if без @end/],
    ['@if a\n```\nx\n@end\n', /незакритий блок коду/],
    ['@if a\n@if b\n@if c\n@if d\n@end\n@end\n@end\n@end\n', /G156/],
  ] as const) {
    const r = formatPrompt(src)
    assert.match(r.refused ?? '', why, src)
    assert.equal(r.text, src, 'refused files are untouched')
  }
})

test('fmt command: --check exits 1, then formats, then --check passes', async () => {
  const root = copyFixture()
  writeFileSync(join(root, '.claude/prompt/messy.md'), MESSY)
  const c = await cli(root, ['fmt', '--check'])
  assert.equal(c.code, 1)
  assert.match(c.out, /потребує fmt: \.claude\/prompt\/messy\.md/)
  assert.equal((await cli(root, ['fmt'])).code, 0)
  assert.equal((await cli(root, ['fmt', '--check'])).code, 0)
  writeFileSync(join(root, '.claude/prompt/broken.md'), '@if a\n')
  const b = await cli(root, ['fmt'])
  assert.equal(b.code, 1)
  assert.match(b.err, /broken\.md:1: не форматую/)
})

test('report: counts when vs classifier vs manual, denies per tool, rules never delivered, escalations', async () => {
  const root = copyFixture()
  const r = JSON.parse((await cli(root, ['report', '--json'])).out)
  assert.equal(r.decisions, 4)
  assert.equal(r.triggers.when, 2)
  assert.equal(r.triggers.classify, 1)
  assert.equal(r.triggers.manual, 1)
  assert.deepEqual(r.denies, { mcp__postgres__query: 2, mcp__figma__get: 1 })
  assert.deepEqual(r.rulesNeverDelivered, ['api', 'react'])
  assert.deepEqual(r.rulesDelivered, { always: 1 })
  assert.deepEqual(r.escalations, { count: 1, byTier: { quick: 1 } })
  assert.deepEqual(r.shadow, { proposed: 2, matched: 1, differed: 1 })
  const md = (await cli(root, ['report'])).out
  assert.match(md, /\| mcp__postgres__query \| 2 \|/)
  assert.match(md, /- api\n- react/)
  // --since filters by ts (all fixture entries are from 1970).
  assert.equal(JSON.parse((await cli(root, ['report', '--since', '7d', '--json'])).out).entries, 0)
  // Pure function, table-driven.
  assert.equal(buildReport([], ['x']).rulesNeverDelivered[0], 'x')
})

test('parseToolHeader: name, description, input shorthand → JSON Schema, tiers; no header; bad input', () => {
  const cases: [string, unknown][] = [
    ['#!/usr/bin/env python3\n# gate-tool: parse_openapi\n# description: Ендпоінти з openapi.yaml\n# input: { "path": "string" }\n# tiers: quick, standard\nimport x\n',
      { name: 'parse_openapi', description: 'Ендпоінти з openapi.yaml', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, tiers: ['quick', 'standard'], line: 2 }],
    ['// gate-tool: gen\n// input: { "n": "number?", "tags": "string[]", "mode": "a|b" }\n',
      { name: 'gen', inputSchema: { type: 'object', properties: { n: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } }, mode: { enum: ['a', 'b'] } }, required: ['tags', 'mode'], additionalProperties: false }, line: 1 }],
    ['# just a script\necho hi\n', undefined],
  ]
  for (const [src, want] of cases) assert.deepEqual(parseToolHeader(src).header, want)
  const bad = parseToolHeader('# gate-tool: x\n# input: {oops}\n')
  assert.equal(bad.diagnostics[0]?.code, 'G221')
  assert.equal(parseToolHeader('# gate-tool: bad name!\n').diagnostics[0]?.code, 'G220')
  assert.equal(scriptLang('a.sh', '#!/usr/bin/env python3\n'), 'python')
  assert.equal(scriptLang('a.mjs'), 'node')
})

test('schema infer <provider>: runs the provider and writes proposals/<p>.schema.json; inferSchema merges arrays', async () => {
  const root = copyFixture()
  const u = await cli(root, ['schema', 'infer', 'info'])
  assert.equal(u.code, 1, 'untrusted cli provider yields no data')
  const r = await cli(root, ['schema', 'infer', 'info', '--trust-repo'])
  assert.equal(r.code, 0, r.err)
  const s = JSON.parse(readFileSync(join(root, '.claude/prompt/proposals/info.schema.json'), 'utf8'))
  assert.equal(s['generated-by'], 'context-gate schema infer')
  assert.ok(s['generated-at'] && s['source-hash'])
  assert.deepEqual(s.properties.services, { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, port: { type: 'integer' } }, required: ['name', 'port'] } })
  assert.deepEqual(inferSchema([{ a: 1 }, { a: 1.5, b: 'x' }]), { type: 'array', items: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'string' } }, required: ['a'] } })
  assert.deepEqual(inferSchema([1, 'x']), { type: 'array', items: { type: ['integer', 'string'] } })
  assert.equal((await cli(root, ['schema', 'infer', 'nope'])).code, 1)
})

test('expand: --dry-run prints instructions; claude -p output → proposals with generated-by/at and source-hash; unchanged source is skipped', async () => {
  const root = copyFixture()
  const dry = await cli(root, ['expand', '--dry-run', '--only', 'intro'])
  assert.equal(dry.code, 0)
  assert.match(dry.out, /# intro\.quick → \.claude\/prompt\/proposals\/intro\.quick\.md \(claude -p --model opus\)/)
  assert.match(dry.out, /--- оригінал ---\nПроєкт \{\{ pkg\.name \}\}/)
  assert.match(dry.out, /# workflow|^# intro\.standard/m)
  const fake = join(root, 'fake-claude.sh')
  writeFileSync(fake, '#!/usr/bin/env bash\ncat >/dev/null\necho "1. Крок один. ($*)"\n')
  chmodSync(fake, 0o755)
  process.env.CONTEXT_GATE_CLAUDE = fake
  try {
    const r = await cli(root, ['expand', '--only', 'intro', '--tiers', 'quick', '--model', 'sonnet'])
    assert.equal(r.code, 0, r.err)
    const p = readFileSync(join(root, '.claude/prompt/proposals/intro.quick.md'), 'utf8')
    assert.match(p, /^---\nid: intro\ngenerated-by: context-gate expand \(sonnet\)\ngenerated-at: \d{4}-.+\nsource-hash: [0-9a-f]{16}\nsource: \.claude\/prompt\/intro\.md\n---\n1\. Крок один\. \(-p --model sonnet\)\n$/)
    const again = await cli(root, ['expand', '--only', 'intro', '--tiers', 'quick'])
    assert.match(again.out, /пропущено intro\.quick: пропозиція актуальна/)
    // Workflow already has @tier directives: skipped.
    assert.match((await cli(root, ['expand', '--only', 'workflow', '--tiers', 'quick'])).out, /секція вже має @tier-варіанти/)
  } finally {
    delete process.env.CONTEXT_GATE_CLAUDE
  }
})

test('index: .claude/gate.index.json with profiles, groups, tiers, sections, rules, tools — no file contents', async () => {
  const root = copyFixture()
  const r = await cli(root, ['index'])
  assert.equal(r.code, 0, r.err)
  const ix = JSON.parse(readFileSync(join(root, '.claude/gate.index.json'), 'utf8'))
  assert.deepEqual(Object.keys(ix.profiles), ['frontend', 'backend'])
  assert.ok(ix.groups.frontend.includes('rule:react'))
  assert.deepEqual(ix.sections.map((s: { id: string }) => s.id).sort(), ['data', 'intro', 'plan-then-act', 'workflow'])
  assert.ok(ix.sections.every((s: { tokens: number }) => typeof s.tokens === 'number'))
  assert.deepEqual(ix.rules.map((x: { id: string; type: string }) => `${x.id}:${x.type}`), ['always:always', 'api:agent', 'react:auto'])
  assert.equal(ix.tools[0].name, 'count_files')
  const text = JSON.stringify(ix)
  assert.doesNotMatch(text, /Пиши тести поряд/, 'no rule bodies')
  assert.doesNotMatch(text, /export const A = 1/, 'no file contents')
})

test('argv, help, version, exit codes', async () => {
  const root = sandbox()
  const p = parseArgv(['x', '--tier=quick', '--no-markers', '--only', 'a,b', '--', 'rest', 'tail'], { tier: { type: 'string', desc: '' }, markers: { type: 'bool', desc: '' }, only: { type: 'list', desc: '' } })
  assert.deepEqual(p, { flags: { tier: 'quick', markers: false, only: ['a', 'b'] }, positional: ['x'], tail: ['rest', 'tail'], errors: [] })
  assert.equal((await cli(root, ['frobnicate'])).code, 2)
  const bad = await cli(root, ['run', '--frob'])
  assert.equal(bad.code, 2)
  assert.match(bad.err, /невідомий прапорець --frob/)
  const h = await cli(root, ['run', '--help'])
  assert.equal(h.code, 0)
  assert.match(h.out, /^context-gate run — /)
  assert.match(h.out, /--ctx-from <src>/)
  assert.match((await cli(root, ['--help'])).out, /Конвеєр \(JSONL\):/)
  assert.match((await cli(root, ['version'])).out, /^context-gate \d+\.\d+\.\d+\n$/)
  assert.ok(!existsSync(join(root, '.claude')), 'help/version write nothing')
})

test('fs.examples: n smallest files by size, then path', () => {
  const files = [{ path: 'src/b.service.ts', size: 10 }, { path: 'src/a.service.ts', size: 10 }, { path: 'src/c.service.ts', size: 5 }, { path: 'src/x.ts', size: 1 }]
  assert.deepEqual(pickExamples(files, 'src/**/*.service.ts', 2).map((f) => f.path), ['src/c.service.ts', 'src/a.service.ts'])
  assert.deepEqual(pickExamples(files, '*.service.ts', 0), [])
})

test('bench: bench/repos.json is the repo list (examples + bench/repos/*); dirs override it', async () => {
  sandbox()
  const { benchTargets, readBenchRepos } = await import('../packages/cli/src/cmd-report.ts')
  const listed = readBenchRepos(join(REPO, 'bench', 'repos.json'))
  assert.equal(listed[0]?.dir, 'examples/basic')
  assert.ok(listed.length >= 6, 'SPEC «bench/ на 5–8 репозиторіях»')
  assert.ok(listed.filter((r) => r.dir.startsWith('bench/repos/')).length >= 5)
  assert.deepEqual(benchTargets(REPO, []).slice(0, 1).map((t) => [t.name, t.dir, t.profile]), [['basic', join(REPO, 'examples/basic'), 'frontend']])
  assert.deepEqual(benchTargets(REPO, ['examples/basic']).map((t) => t.dir), [join(REPO, 'examples/basic')])
  const r = await cli(REPO, ['bench', '--json'])
  assert.equal(r.code, 0, r.err)
  const rows = JSON.parse(r.out)
  assert.equal(rows.length, listed.length)
  assert.equal(rows[0].repo, 'basic')
  assert.ok(rows[0].promptTokens > 0)
})
