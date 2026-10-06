import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CompiledPrompt, GateConfig } from '../packages/core/src/types.ts'
import { buildPrompts, checkStale, isStaleByMtime, generateCtxTypes, jsonSchemaToTs, splitFrontmatter, readLock, renderSkillMd, validatePrompt, defaultArgs, COMPILER, type BuildResult } from '../packages/cli/src/build.ts'
import { sandbox } from './cli-helpers.ts'
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

// ───────────────────────── WP4: imports, limits, G170, schema files, packages, static skills ─────────────────────────

function miniRepo(files: Record<string, string>): string {
  const root = sandbox()
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text) }
  return root
}
const JSX = "import { Prompt, Section, If, Each, Let, Set, Repeat, Run, Call, ctx } from '@context-gate/jsx'\n"

test('imports: .yaml and .toml are parsed at build into data (hash in sources); a broken file is G164 with its line', async () => {
  const root = miniRepo({
    '.claude/prompt/data/terms.yaml': '# terms\nterms:\n  - name: API\n    type: tech\n  - name: UI\n    type: design\n',
    '.claude/prompt/data/cfg.toml': '[release]\nchannel = "beta"\nlimits = [1, 2]\n',
    '.claude/prompt/main.prompt.tsx': `${JSX}import data from './data/terms.yaml'\nimport cfg from './data/cfg.toml'\nexport default <Prompt><Section id="g" scope="static">{data.terms.map((t: { name: string }) => t.name).join(', ')}; {cfg.release.channel} {cfg.release.limits.length}</Section></Prompt>\n`,
  })
  const r = await buildPrompts({ root })
  assert.deepEqual(r.diagnostics, [])
  const cp = r.compiled[0]!
  assert.deepEqual(cp.sections[0]!.children, [{ t: 'text', value: 'API, UI; beta 2' }])
  assert.deepEqual(cp.sources.map((s) => s.path), ['.claude/prompt/main.prompt.tsx', '.claude/prompt/data/cfg.toml', '.claude/prompt/data/terms.yaml'])
  writeFileSync(join(root, '.claude/prompt/data/terms.yaml'), 'terms:\n  - a\n bad: 1\n')
  const bad = await buildPrompts({ root, write: false })
  assert.deepEqual(bad.diagnostics.map((d) => [d.code, d.path, d.line]), [['G164', '.claude/prompt/data/terms.yaml', 3]])
  assert.match(bad.diagnostics[0]!.message, /terms\.yaml: /)
})

test('language limits for TSX: G153 (Let redefined), G156 (If > 3, Each/Repeat > 2)', async () => {
  const deepIf = '<If test="a"><If test="b"><If test="c"><If test="d">x</If></If></If></If>'
  const okIf = '<If test="a"><If test="b"><If test="c">x</If></If></If>'
  const deepLoop = '<Each of="xs" as="x"><Each of="x.ys" as="y"><Repeat n={2}>z</Repeat></Each></Each>'
  const root = miniRepo({
    '.claude/prompt/a.prompt.tsx': `${JSX}export default <Prompt><Section id="a" scope="profile"><Let name="n" value="1" /><Let name="n" value="2" /><Set name="n" value="3" /><Let name="m" value="1" />${okIf}</Section><Section id="b" scope="profile">${deepIf}${deepLoop}<Each of="xs" as="x"><Repeat n={2}>ok</Repeat></Each></Section></Prompt>\n`,
  })
  const r = await buildPrompts({ root, write: false })
  const got = r.diagnostics.map((d) => [d.code, d.severity, /секції "(\w)"|«(\w)»/.exec(d.message)?.slice(1).find(Boolean)])
  assert.deepEqual(got, [['G153', 'error', 'n'], ['G153', 'error', 'n'], ['G156', 'error', 'b'], ['G156', 'error', 'b']])
  assert.match(r.diagnostics[1]!.message, /<Set name="n">/)
  assert.match(r.diagnostics[2]!.message, /<If> глибше за 3/)
  assert.match(r.diagnostics[3]!.message, /циклів .* глибше за 2/)
  assert.equal(r.diagnostics[0]!.path, '.claude/prompt/a.prompt.tsx')
})

test('G170 at build: field access on a provider without schema; schema inline, .schema.json or .d.ts silences it', async () => {
  const prompt = `${JSX}export default <Prompt><Section id="s" scope="profile" when="arch.available"><Each of="arch.deny" as="d">{'{{ d.from }}'}</Each>{'{{ lint.count }} {{ typed.n }} {{ dts.deny }}'}<Run lang="bash" as="arch2" cache="1m">x</Run>{'{{ arch2.stdout }}'}</Section></Prompt>\n`
  const gate = {
    providers: {
      arch: { kind: 'cli', command: ['arch'] },
      lint: { kind: 'cli', command: ['lint'], schema: { type: 'object', properties: { count: { type: 'number' } } } },
      typed: { kind: 'cli', command: ['t'], schema: 'schemas/typed.schema.json' },
      dts: { kind: 'cli', command: ['d'], schema: 'types/arch.d.ts' },
    },
  }
  const root = miniRepo({
    '.claude/prompt/a.prompt.tsx': prompt,
    '.claude/gate.json': JSON.stringify(gate),
    'schemas/typed.schema.json': JSON.stringify({ type: 'object', properties: { n: { type: 'integer' } } }),
    'types/arch.d.ts': 'export interface Rule { from: string; to: string }\nexport interface Arch { available: boolean; deny: Rule[] }\n',
  })
  const r = await buildPrompts({ root, write: false })
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.severity, /Поле «([\w.]+)»/.exec(d.message)?.[1]]), [['G170', 'warning', 'arch.available'], ['G170', 'warning', 'arch.deny']])
  assert.equal(r.diagnostics[0]!.path, '.claude/prompt/a.prompt.tsx')
  // checkCtx: false turns it off; warnings never block the write.
  assert.deepEqual((await buildPrompts({ root, write: false, checkCtx: false })).diagnostics, [])
  assert.ok((await buildPrompts({ root })).written.includes('.claude/prompt/.compiled/a.json'))

  // ctx.d.ts: .schema.json is converted, .d.ts re-exported, a missing file is unknown.
  const text = generateCtxTypes({ root, config: { ...gate, providers: { ...gate.providers, gone: { kind: 'cli', schema: 'nope.schema.json' }, named: { kind: 'cli', schema: 'types/arch.d.ts#Rule' } } } as unknown as GateConfig, write: false })
  assert.match(text, /typed: \{\n {6}n\?: number\n {4}\}/)
  assert.match(text, /dts: import\("\.\.\/\.\.\/\.\.\/types\/arch\.js"\)\.Arch/)
  assert.match(text, /named: import\("\.\.\/\.\.\/\.\.\/types\/arch\.js"\)\.Rule/)
  assert.match(text, /gone: unknown/)
})

test('prompt.packages: exported skills of an npm prompt package → .claude/skills with provenance', async () => {
  const pkgSrc = "import { Prompt, Section, arg } from '@context-gate/jsx'\n" +
    "export const ReleaseNotes = <Prompt as=\"skill\" name=\"acme-release\" description=\"Release notes\" args={{ since: arg.string({ positional: 0 }) }}>\n  Нотатки від {'{{ args.since }}'}.\n</Prompt>\n" +
    "export const Explain = <Prompt as=\"skill\" name=\"acme-explain\" description=\"Explain\">Поясни.</Prompt>\n" +
    "export const Identity = () => <Section id=\"identity\" scope=\"static\">x</Section>\n"
  const root = miniRepo({
    'node_modules/@acme/prompts/package.json': JSON.stringify({ name: '@acme/prompts', version: '1.2.0', exports: { '.': './index.tsx' } }),
    'node_modules/@acme/prompts/index.tsx': pkgSrc,
    'node_modules/@acme/listed/package.json': JSON.stringify({ name: '@acme/listed', version: '0.1.0', 'context-gate': { skills: ['skills/hello.prompt.tsx'] } }),
    'node_modules/@acme/listed/skills/hello.prompt.tsx': "import { Prompt } from '@context-gate/jsx'\nexport default <Prompt as=\"skill\" name=\"hello\" description=\"Hi\">\n  Привіт.\n\n  Другий абзац.\n</Prompt>\n",
    '.claude/gate.json': JSON.stringify({ prompt: { packages: ['@acme/prompts', '@acme/listed', '@acme/missing'] } }),
  })
  const r = await buildPrompts({ root })
  assert.deepEqual(r.diagnostics.map((d) => d.code), ['G164'])
  assert.match(r.diagnostics[0]!.message, /@acme\/missing/)
  assert.deepEqual(r.compiled.map((c) => c.id).sort(), ['acme-explain', 'acme-release', 'hello'])
  const md = readFileSync(join(root, '.claude/skills/acme-release/SKILL.md'), 'utf8')
  assert.match(md, /\nsource: "npm:@acme\/prompts@1\.2\.0"\n/)
  assert.match(md, /\ngenerated-by: context-gate\n/)
  assert.match(readFileSync(join(root, '.claude/skills/hello/SKILL.md'), 'utf8'), /\nsource: "npm:@acme\/listed@0\.1\.0"\n/)
  // Package .prompt.tsx keeps Markdown text rules (blank lines survive).
  const hello = readJson<CompiledPrompt>(join(root, '.claude/prompt/.compiled/hello.json'))
  assert.deepEqual(hello.skill!.body, [{ t: 'text', value: 'Привіт.\n\nДругий абзац.' }])
  assert.equal(readLock(root)!.prompts['acme-release']!.package, '@acme/prompts@1.2.0')
  assert.equal(readLock(root)!.prompts['acme-release']!.entry, 'node_modules/@acme/prompts/index.tsx')
})

test('prompt.skillBody static | both: SKILL.md with a pre-rendered body (default args) marked static', async () => {
  const skill = "import { Prompt, arg } from '@context-gate/jsx'\nexport default <Prompt as=\"skill\" name=\"notes\" description=\"Notes\" args={{ since: arg.string({ positional: 0, required: true }), format: arg.enum(['md', 'slack'], { default: 'md' }), dry: arg.flag() }}>\n  Формат {'{{ args.format }}'}, від {'{{ args.since ?? \"останнього тегу\" }}'}.\n</Prompt>\n"
  const root = miniRepo({ '.claude/prompt/notes.prompt.tsx': skill, '.claude/gate.json': JSON.stringify({ prompt: { skillBody: 'static' } }) })
  const r = await buildPrompts({ root })
  assert.deepEqual(r.diagnostics, [])
  const md = readFileSync(join(root, '.claude/skills/notes/SKILL.md'), 'utf8')
  assert.match(md, /\ncontext-gate-body: static\n---\n<!-- context-gate: static — тіло попередньо відрендерено на збірці з дефолтними аргументами \(format=md, dry=false\)/)
  assert.match(md, /\n\nФормат md, від останнього тегу\.\n$/)
  assert.doesNotMatch(md, /!`node/)
  writeFileSync(join(root, '.claude/gate.json'), JSON.stringify({ prompt: { skillBody: 'both' } }))
  await buildPrompts({ root })
  const both = readFileSync(join(root, '.claude/skills/notes/SKILL.md'), 'utf8')
  assert.match(both, /\ncontext-gate-body: live\+static\n---\n!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" run notes/)
  assert.match(both, /статичний варіант[\s\S]*Формат md, від останнього тегу\.\n$/)
  // Default stays live.
  writeFileSync(join(root, '.claude/gate.json'), '{}')
  await buildPrompts({ root })
  assert.doesNotMatch(readFileSync(join(root, '.claude/skills/notes/SKILL.md'), 'utf8'), /static/)
  assert.deepEqual(defaultArgs({ a: { type: 'flag' }, b: { type: 'string', default: 'x' }, c: { type: 'list' }, d: { type: 'number' } }), { a: false, b: 'x', c: [], d: null })
})

test('renderSkillMd options and validatePrompt on a skill body', () => {
  const cp = { version: 1, compiler: COMPILER, id: 's', sourceHash: 'a'.repeat(64), sources: [], sections: [], diagnostics: [], skill: { name: 's', description: 'd', args: {}, invoke: { user: true, model: false }, body: [] } } as CompiledPrompt
  assert.match(renderSkillMd(cp), /disable-model-invocation: true[\s\S]*!`node/)
  // `static` without a rendered text falls back to live.
  assert.match(renderSkillMd(cp, { body: 'static' }), /!`node/)
  assert.match(renderSkillMd(cp, { body: 'static', staticText: 'T', source: 'npm:x@1' }), /source: "npm:x@1"\ncontext-gate-body: static\n---\n<!--[^\n]*без аргументів[^\n]*-->\n\nT\n$/)
  const body = [{ t: 'let', name: 'x', value: '1' }, { t: 'let', name: 'x', value: '2' }] as CompiledPrompt['sections'][0]['children']
  assert.deepEqual(validatePrompt({ sections: [], skill: { ...cp.skill!, body } }).map((d) => d.code), ['G153'])
})

test('checkStale: prompt.packages versions recorded in prompt.lock.json (npm:<name> stale / missing; only rebuilds it)', async () => {
  const skill = "import { Prompt } from '@context-gate/jsx'\nexport default <Prompt as=\"skill\" name=\"hello\" description=\"Hi\">Привіт.</Prompt>\n"
  const manifest = (version: string) => JSON.stringify({ name: '@acme/listed', version, 'context-gate': { skills: ['skills/hello.prompt.tsx'] } })
  const root = miniRepo({
    'node_modules/@acme/listed/package.json': manifest('0.1.0'),
    'node_modules/@acme/listed/skills/hello.prompt.tsx': skill,
    '.claude/gate.json': JSON.stringify({ prompt: { packages: ['@acme/listed'] } }),
  })
  assert.deepEqual(checkStale({ root }), { stale: [], missing: ['npm:@acme/listed'] })
  await buildPrompts({ root })
  const lock = readLock(root)!
  assert.equal(lock.packages!['@acme/listed']!.version, '0.1.0')
  assert.match(lock.packages!['@acme/listed']!.hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(checkStale({ root }), { stale: [], missing: [] })
  writeFileSync(join(root, 'node_modules/@acme/listed/package.json'), manifest('0.2.0'))
  assert.deepEqual(checkStale({ root }), { stale: ['npm:@acme/listed'], missing: [] })
  // `only: ['npm:<name>']` rebuilds just that package and refreshes its lock entry.
  const r = await buildPrompts({ root, only: ['npm:@acme/listed'] })
  assert.deepEqual(r.compiled.map((c) => c.id), ['hello'])
  assert.equal(readLock(root)!.packages!['@acme/listed']!.version, '0.2.0')
  assert.match(readFileSync(join(root, '.claude/skills/hello/SKILL.md'), 'utf8'), /npm:@acme\/listed@0\.2\.0/)
  assert.deepEqual(checkStale({ root }), { stale: [], missing: [] })
  // An unrelated `only` keeps the package entries.
  await buildPrompts({ root, only: ['nothing'] })
  assert.ok(readLock(root)!.packages!['@acme/listed'])
})
