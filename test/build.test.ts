import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompiledPrompt, GateConfig } from '../packages/core/src/types.ts'
import { buildPrompts, checkStale, isStaleByMtime, generateCtxTypes, jsonSchemaToTs, splitFrontmatter, readLock, COMPILER, type BuildResult } from '../packages/cli/src/build.ts'
import { preserveJsxText } from '../packages/cli/src/jsx-text.ts'

const repo = new URL('..', import.meta.url).pathname

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cg-build-test-'))
  cpSync(join(repo, 'examples/basic'), dir, { recursive: true })
  rmSync(join(dir, '.claude/prompt/.compiled'), { recursive: true, force: true })
  rmSync(join(dir, '.claude/prompt/prompt.lock.json'), { force: true })
  for (const f of ['release-notes', 'pr-review', 'explain']) cpSync(join(repo, `examples/skills/${f}.prompt.tsx`), join(dir, `.claude/prompt/${f}.prompt.tsx`))
  return dir
}

const errors = (r: BuildResult) => r.diagnostics.filter((d) => d.severity === 'error')
const readJson = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T

test('preserveJsxText keeps text runs as authored', () => {
  const cases: [string, string, string][] = [
    ['multiline text', 'const a = (\n  <S>\n    a\n\n    b\n  </S>\n)', 'const a = (\n  <S>{"\\n    a\\n\\n    b\\n  "\n\n\n\n}</S>\n)'],
    ['expressions and entities', 'x = <p>a &amp; {b} c</p>', 'x = <p>{"a & "}{b}{" c"}</p>'],
    ['nested arrow JSX', 'f = <E>{r => <li>{r.x} y</li>}</E>', 'f = <E>{r => <li>{r.x}{" y"}</li>}</E>'],
    ['attributes, generics, comparisons untouched', 'const m: Record<string, number> = {}; if (a < b) x = <A b="1" c={d > 2}/>', 'const m: Record<string, number> = {}; if (a < b) x = <A b="1" c={d > 2}/>'],
    ['strings, templates, comments, regex', "const s = '<a>'; const t = `<b>${1}`; // <c>\nconst r = /<d>/g; y = <q>z</q>", "const s = '<a>'; const t = `<b>${1}`; // <c>\nconst r = /<d>/g; y = <q>{\"z\"}</q>"],
    ['fragment and return', 'function F() { return <>t</> }', 'function F() { return <>{"t"}</> }'],
  ]
  for (const [name, src, want] of cases) {
    const r = preserveJsxText(src)
    assert.ok(r.ok, `${name}: ${r.error}`)
    assert.equal(r.code, want, name)
  }
  assert.equal(preserveJsxText('x = <A>unclosed').ok, false)
})

test('splitFrontmatter: lenient, globs: *.ts survives', () => {
  assert.deepEqual(splitFrontmatter('---\ndescription: TS\nglobs: *.ts\nalwaysApply: false\ntags:\n  - a\n  - b\nlist: [x, "y"]\n---\nbody\n'), {
    meta: { description: 'TS', globs: '*.ts', alwaysApply: false, tags: ['a', 'b'], list: ['x', 'y'] }, body: 'body\n',
  })
  assert.deepEqual(splitFrontmatter('no frontmatter'), { meta: {}, body: 'no frontmatter' })
})

test('build examples/basic: compiled shape, lock, SKILL.md, staleness', async () => {
  const root = fixture()
  try {
    const r = await buildPrompts({ root })
    assert.deepEqual(errors(r), [])
    assert.deepEqual(r.compiled.map((c) => c.id).sort(), ['explain', 'main', 'pr-review', 'release-notes'])
    assert.deepEqual(r.diagnostics.map((d) => d.code), ['G180']) // <Lazy> in main
    for (const w of ['.claude/prompt/.compiled/main.json', '.claude/prompt/prompt.lock.json', '.claude/skills/release-notes/SKILL.md']) assert.ok(r.written.includes(w), w)

    const main = readJson<CompiledPrompt>(join(root, '.claude/prompt/.compiled/main.json'))
    assert.equal(main.version, 1)
    assert.equal(main.compiler, COMPILER)
    assert.match(main.sourceHash, /^[0-9a-f]{64}$/)
    assert.deepEqual(main.sources.map((s) => s.path), ['.claude/prompt/main.prompt.tsx', '.claude/prompt/data/glossary.json', '.claude/prompt/shared/base.prompt.tsx', 'CONVENTIONS.md'])
    assert.deepEqual(main.sections.map((s) => [s.id, s.scope]), [['identity', 'static'], ['safety', 'static'], ['glossary', 'static'], ['project-rules', 'profile'], ['workflow', 'profile'], ['repo-state', 'volatile'], ['references', 'profile']])
    const byId = Object.fromEntries(main.sections.map((s) => [s.id, s]))
    // Imported component keeps its own source; text keeps the authored blank line.
    assert.deepEqual(byId.identity!.source, { path: '.claude/prompt/shared/base.prompt.tsx', line: 12 })
    assert.deepEqual(byId.identity!.children, [{ t: 'text', value: 'Ти senior TypeScript-інженер у проєкті context-gate-example.\n\nВідповідай українською, код і ідентифікатори — англійською.' }])
    assert.equal(byId['project-rules']!.when, 'gate.profile in ["frontend", "backend"]')
    assert.equal(byId['repo-state']!.when, 'gate.profile != "docs"')
    assert.deepEqual(byId['repo-state']!.children.find((n) => n.t === 'run'), { t: 'run', lang: 'bash', code: 'git log --oneline -5', as: 'log', cache: '5m' })
    const refs = byId.references!.children.filter((n) => n.t === 'include')
    assert.deepEqual(refs.map((n) => n.t === 'include' && [n.source, n.ref, n.mode]), [['text', 'text', 'inline'], ['file', 'CONVENTIONS.md', 'ref'], ['skill', 'tdd', 'ref'], ['file', 'docs/api.md', 'lazy']])
    const conv = refs[0]!
    assert.ok(conv.t === 'include' && conv.text!.startsWith('# Умовності') && !conv.text!.includes('owner: platform'), 'frontmatter split off')

    const lock = readLock(root)!
    assert.equal(lock.compiler, COMPILER)
    assert.deepEqual(Object.keys(lock.prompts), ['explain', 'main', 'pr-review', 'release-notes'])
    assert.equal(lock.prompts.main!.sourceHash, main.sourceHash)
    assert.deepEqual(lock.prompts.main!.sources, main.sources)

    const rn = readJson<CompiledPrompt>(join(root, '.claude/prompt/.compiled/release-notes.json'))
    assert.deepEqual(rn.sections, [])
    assert.deepEqual(rn.uses, { gitx: 'scripts/git-extra.js' })
    assert.deepEqual(rn.skill!.invoke, { user: true, model: 'tool' })
    assert.deepEqual(rn.skill!.args.format, { type: 'enum', default: 'md', values: ['md', 'slack', 'github'] })
    const md = readFileSync(join(root, '.claude/skills/release-notes/SKILL.md'), 'utf8')
    assert.match(md, /^---\nname: release-notes\ndescription: "Чернетка release notes/)
    assert.match(md, /\nargument-hint: "<tag\|sha> \[--format md\|slack\|github\] \[--scope <scope>\] \[--dry\]"\n/)
    assert.match(md, /\ngenerated-by: context-gate\n/)
    assert.doesNotMatch(md, /disable-model-invocation/)
    assert.ok(md.includes('!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" run release-notes --args "$ARGUMENTS" --ctx-from live`'))
    assert.match(readFileSync(join(root, '.claude/skills/pr-review/SKILL.md'), 'utf8'), /\ndisable-model-invocation: true\n/)

    // Staleness without building.
    assert.deepEqual(checkStale({ root }), { stale: [], missing: [] })
    writeFileSync(join(root, 'CONVENTIONS.md'), '# changed\n')
    unlinkSync(join(root, '.claude/prompt/.compiled/explain.json'))
    assert.deepEqual(checkStale({ root }), { stale: ['.claude/prompt/main.prompt.tsx'], missing: ['.claude/prompt/explain.prompt.tsx'] })
    // Incremental rebuild of one prompt keeps the other lock entries.
    const r2 = await buildPrompts({ root, only: ['main'] })
    assert.deepEqual(r2.compiled.map((c) => c.id), ['main'])
    assert.deepEqual(Object.keys(readLock(root)!.prompts), ['explain', 'main', 'pr-review', 'release-notes'])
    assert.deepEqual(checkStale({ root }), { stale: [], missing: ['.claude/prompt/explain.prompt.tsx'] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isStaleByMtime', () => {
  const cases: [number, number | undefined, boolean][] = [[10, 20, false], [20, 10, true], [10, 10, false], [10, undefined, true]]
  for (const [tsx, compiled, want] of cases) assert.equal(isStaleByMtime(tsx, compiled), want, `${tsx} vs ${compiled}`)
})

test('build errors: G161, G163, G1xx, G160, G164, G162; failed prompts are not written', async () => {
  const root = fixture()
  const p = (name: string, src: string) => writeFileSync(join(root, `.claude/prompt/${name}.prompt.tsx`), src)
  try {
    p('dup', `import { Prompt, Section } from '@context-gate/jsx'\nimport { Identity } from './shared/base.prompt.tsx'\nexport default (\n  <Prompt>\n    <Identity repo="x" />\n    <Section id="identity" scope="static">again</Section>\n  </Prompt>\n)\n`)
    p('nocache', `import { Prompt, Section, Run } from '@context-gate/jsx'\nexport default <Prompt><Section id="s" scope="static"><Run lang="bash">date</Run></Section></Prompt>\n`)
    p('badexpr', `import { Prompt, Section, If } from '@context-gate/jsx'\nexport default <Prompt><Section id="b" scope="profile" when="gate.profile ==">x<If test={'a' + 1 > 0 ? 'y' : 'z'}>q</If></Section></Prompt>\n`)
    p('leak', `import { Prompt, Section, ctx } from '@context-gate/jsx'\nexport default <Prompt><Section id="l" scope="profile" when={(ctx.ctx.percent as any) > 50}>x</Section></Prompt>\n`)
    p('throws', `import { Prompt } from '@context-gate/jsx'\nthrow new Error('boom at build')\nexport default <Prompt />\n`)
    p('big', `import { Prompt, Section } from '@context-gate/jsx'\nconst big = 'x'.repeat(2_200_000)\nexport default <Prompt><Section id="big" scope="static">{big}</Section></Prompt>\n`)
    p('missing', `import { Prompt } from '@context-gate/jsx'\nimport x from './nope.json' with { type: 'json' }\nexport default <Prompt>{x}</Prompt>\n`)
    const r = await buildPrompts({ root })
    const by = (file: string) => r.diagnostics.filter((d) => d.path?.includes(file) || (file === 'dup' && d.code === 'G161')).map((d) => d.code)
    const g161 = r.diagnostics.find((d) => d.code === 'G161')!
    assert.match(g161.message, /shared\/base\.prompt\.tsx:12 і \.claude\/prompt\/dup\.prompt\.tsx:6/)
    assert.ok(by('dup').includes('G161'))
    assert.deepEqual(by('nocache'), ['G163'])
    assert.ok(by('badexpr').some((c) => /^G1\d\d$/.test(c) && c !== 'G160'), 'parseExpr diagnostics')
    assert.ok(by('leak').includes('G160'))
    const thrown = r.diagnostics.find((d) => d.path?.includes('throws'))!
    assert.equal(thrown.code, 'G164')
    assert.match(thrown.message, /boom at build/)
    assert.ok(by('big').includes('G162'))
    assert.ok(by('nope').includes('G164') || by('missing').includes('G164'))
    for (const id of ['dup', 'nocache', 'badexpr', 'leak', 'throws', 'big', 'missing']) assert.ok(!existsSync(join(root, `.claude/prompt/.compiled/${id}.json`)), id)
    assert.ok(existsSync(join(root, '.claude/prompt/.compiled/main.json')), 'healthy prompts still built')
    assert.ok(!('dup' in readLock(root)!.prompts))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validateExpr is injectable; child timeout is G164', async () => {
  const root = fixture()
  try {
    const seen: string[] = []
    const r = await buildPrompts({ root, only: ['main'], write: false, validateExpr: (s) => { seen.push(s); return s === 'git.dirty' ? [{ code: 'G101', severity: 'error', message: 'x' }] : [] } })
    assert.ok(seen.includes('cursor.always') && seen.includes('ctx.percent > budgets.soft') && seen.includes('ex.path'))
    assert.deepEqual(errors(r).map((d) => [d.code, d.path]), [['G101', '.claude/prompt/shared/base.prompt.tsx']])
    assert.deepEqual(r.written, [])
    writeFileSync(join(root, '.claude/prompt/loop.prompt.tsx'), `import { Prompt } from '@context-gate/jsx'\nwhile (true) {}\nexport default <Prompt />\n`)
    const t = await buildPrompts({ root, only: ['loop'], timeoutMs: 1000, write: false })
    assert.equal(t.diagnostics[0]!.code, 'G164')
    assert.match(t.diagnostics[0]!.message, /таймаут/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generateCtxTypes: unions from gate.json, provider schemas', () => {
  const root = mkdtempSync(join(tmpdir(), 'cg-types-'))
  try {
    const config = {
      tiers: { premium: {}, quick: {} }, models: {}, profiles: { frontend: {}, docs: {} },
      providers: {
        git: { kind: 'module', builtin: true },
        arch: { kind: 'cli', schema: { type: 'object', required: ['deny'], properties: { deny: { type: 'array', items: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } } }, available: { type: 'boolean' } } } },
        pkg: { kind: 'file', path: 'package.json' },
        scripts: { kind: 'module', functions: ['open_todos'] },
      },
    } as unknown as GateConfig
    const text = generateCtxTypes({ root, config, index: { items: [{ id: 'skill:tdd' }, { id: 'rule:react' }] } })
    assert.match(text, /gate: GateCtx<"frontend" \| "docs", "premium" \| "quick">/)
    assert.match(text, /arch: \{\n {6}deny: Array<\{\n {8}from: string\n {8}to: string\n {6}\}>\n {6}available\?: boolean\n {4}\}/)
    assert.match(text, /pkg: unknown/)
    assert.match(text, /open_todos\(\.\.\.args: unknown\[\]\): unknown/)
    assert.doesNotMatch(text, /\bgit:/)
    assert.match(text, /export type ItemId = "rule:react" \| "skill:tdd"/)
    assert.equal(readFileSync(join(root, '.claude/prompt/.types/ctx.d.ts'), 'utf8'), text)
    assert.ok(existsSync(join(root, '.claude/prompt/.types/assets.d.ts')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  const cases: [unknown, string][] = [
    [{ type: 'string' }, 'string'], [{ type: 'integer' }, 'number'], [{ enum: ['a', 1] }, '"a" | 1'], [{ const: true }, 'true'],
    [{ type: ['string', 'null'] }, 'string | null'], [{ anyOf: [{ type: 'number' }, { type: 'boolean' }] }, 'number | boolean'],
    [{ type: 'array', items: { type: 'string' } }, 'string[]'], [{ type: 'object' }, '{\n  [key: string]: unknown\n}'], [undefined, 'unknown'],
  ]
  for (const [s, want] of cases) assert.equal(jsonSchemaToTs(s), want, JSON.stringify(s))
})
