import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompiledPrompt, Node } from '../packages/core/src/types.ts'
import { loadTypescript, transformLevel2, wantsLevel2 } from '../packages/cli/src/transform.ts'
import { buildPrompts } from '../packages/cli/src/build.ts'

const repo = new URL('..', import.meta.url).pathname
const ts = loadTypescript(repo).mod!
const HEAD = "import { Prompt, Section, If, Each, Skill, Debug, Let, Fence, ctx, e } from '@context-gate/jsx'\n"
const tr = (body: string) => transformLevel2(ts, HEAD + body, { path: 'p.prompt.tsx' })
/** The rewritten body (without the import line we prepend). */
const body = (src: string) => { const r = tr(src); assert.deepEqual(r.diagnostics, [], src); return r.code.slice(r.code.indexOf('\n') + 1) }

test('level 2: native expressions in runtime props → expression strings', () => {
  const cases: [string, string, string][] = [
    ['in([...])', `<Section id="a" scope="profile" when={ctx.gate.profile.in(['frontend', 'backend'])} />`, 'when={`gate.profile in ["frontend", "backend"]`}'],
    ['!== and ===', `<Section id="a" scope="profile" when={ctx.gate.profile !== 'docs' && ctx.gate.tier === "quick"} />`, 'when={`gate.profile != "docs" && gate.tier == "quick"`}'],
    ['ctx.ctx root', `<If test={ctx.ctx.percent > ctx.budgets.soft}>x</If>`, 'test={`ctx.percent > budgets.soft`}'],
    ['arithmetic and parens', `<If test={(ctx.ctx.tokens + 10) * 2 >= ctx.ctx.limit / 2}>x</If>`, 'test={`(ctx.tokens + 10) * 2 >= ctx.limit / 2`}'],
    ['not, ??, optional chain', `<If test={!ctx.git.dirty || (ctx.data.x?.count ?? 0) > 1}>x</If>`, 'test={`!git.dirty || (data.x?.count ?? 0) > 1`}'],
    ['ternary in value', `<Let name="n" value={ctx.gate.tier === 'quick' ? 3 : 6} />`, 'value={`gate.tier == "quick" ? 3 : 6`}'],
    ['provider call', `<Each of={ctx.fs.examples('src/**/*.ts', 1)}>{ex => <Fence title={ex.path}>{ex.body}</Fence>}</Each>`, 'of={`fs.examples("src/**/*.ts", 1)`}'],
    ['includes → in', `<If test={ctx.gate.groups.includes('git')}>x</If>`, 'test={`"git" in gate.groups`}'],
    ['Math builtins and .at', `<If test={Math.max(ctx.git.ahead, 1) > ctx.git.log(5).at(0).date.length}>x</If>`, 'test={`max(git.ahead, 1) > git.log(5).at(0).date.length`}'],
    ['negated in', `<If test={!ctx.gate.profile.in(['a'])}>x</If>`, 'test={`!(gate.profile in ["a"])`}'],
    ['element access', `<If test={ctx.data['api-endpoints'] != null}>x</If>`, 'test={`data["api-endpoints"] != null`}'],
    ['template literal', '<Let name="t" value={`v${ctx.git.ahead}!`} />', 'value={`"v" + git.ahead + "!"`}'],
  ]
  for (const [name, src, want] of cases) assert.ok(body(src).includes(want), `${name}: ${body(src)}`)
})

test('level 2: children, Each params, Debug, build-time folding', () => {
  assert.equal(body('<Section id="a" scope="static">Гілка {ctx.git.branch}.</Section>'), '<Section id="a" scope="static">Гілка {`{{ git.branch }}`}.</Section>')
  // Each over a runtime list: the parameter is a runtime local, pinned with as= (bundlers may rename it).
  assert.equal(body('<Each of={ctx.cursor.always}>{(r, k) => <li>{r.body} {k + 1}</li>}</Each>'), '<Each as="r" index="k" of={`cursor.always`}>{(r, k) => <li>{`{{ r.body }}`} {`{{ k + 1 }}`}</li>}</Each>')
  // Each over build-time data: parameters stay build-time values.
  assert.equal(body('<Each of={[1, 2]}>{(n) => <li>{n * 2}</li>}</Each>'), '<Each of={[1, 2]}>{(n) => <li>{n * 2}</li>}</Each>')
  assert.equal(body("<Debug>{['prs', ctx.prs?.length]}</Debug>"), '<Debug>{`{{ ["prs", prs?.length] }}`}</Debug>')
  // A build-time operand is folded in at build time.
  const r = tr('const LIMIT = 5\nexport default <If test={ctx.git.ahead > LIMIT}>x</If>')
  assert.deepEqual(r.diagnostics, [])
  assert.match(r.code, /test=\{`git\.ahead > \$\{__cgLit\(LIMIT\)\}`\}/)
  assert.match(r.code, /^import \{ exprLiteral as __cgLit \} from '@context-gate\/jsx';import \{ Prompt/)
  // Level-1 forms are left alone.
  for (const src of ['<If test="ctx.percent > 50">x</If>', '<If test={e`${ctx.ctx.percent} > ${50}`}>x</If>', "<Section id=\"a\" scope=\"profile\">{'{{ cursor.auto | len }}'}</Section>"]) assert.equal(body(src), src)
})

test('level 2: runtime conditionals lift into If/Else', () => {
  const lifted = body("<Skill name=\"tdd\" mode={ctx.gate.tier === 'quick' ? 'inline' : 'ref'} />")
  assert.equal(lifted, '<__cgIf test={`gate.tier == "quick"`}><Skill name="tdd" mode={\'inline\'} /><__cgElse><Skill name="tdd" mode={\'ref\'} /></__cgElse></__cgIf>')
  assert.equal(body('<Section id="a" scope="profile">{ctx.git.dirty ? <b>грязно {ctx.git.branch}</b> : \'чисто\'}</Section>'),
    '<Section id="a" scope="profile"><__cgIf test={`git.dirty`}><b>грязно {`{{ git.branch }}`}</b><__cgElse>{\'чисто\'}</__cgElse></__cgIf></Section>')
  assert.equal(body('<Section id="a" scope="profile">{ctx.git.dirty && <b>!</b>}</Section>'), '<Section id="a" scope="profile"><__cgIf test={`git.dirty`}><b>!</b></__cgIf></Section>')
  assert.match(tr('<Skill name="x" mode={ctx.gate.tier === "q" ? "inline" : "ref"} />').code, /^import \{ If as __cgIf, Else as __cgElse \}/)
})

test('level 2: everything outside the subset is G160 with a location', () => {
  const cases: [string, string, RegExp][] = [
    ['JS array method', '<If test={ctx.git.changed.filter((f) => f.endsWith(".ts")).length > 0}>x</If>', /\.filter\(\)/],
    ['build-time lib over ctx', 'const sortBy = (x: unknown) => x\nexport default <Each of={sortBy(ctx.git.changed)}>{(f) => <li>{f}</li>}</Each>', /змішування/],
    ['object literal', '<Let name="o" value={ctx.git.ahead > 0 ? { a: ctx.git.ahead } : null} />', /об'єкт/],
    ['assignment operator', '<If test={(ctx.git.ahead += 1) > 0}>x</If>', /оператор/],
    ['typeof', '<If test={typeof ctx.git.ahead === "number"}>x</If>', /конструкція/],
    ['bare ctx', '<If test={ctx}>x</If>', /без поля/],
    ['destructuring a runtime item', '<Each of={ctx.cursor.always}>{({ body }) => <li>{body}</li>}</Each>', /деструктуризація/],
    ['non-expression prop', '<Skill name="x" mode={ctx.gate.tier + "x"} />', /не є рантайм-виразом/],
  ]
  for (const [name, src, re] of cases) {
    const r = tr(src)
    const d = r.diagnostics.find((x) => x.code === 'G160')
    assert.ok(d, `${name}: ${JSON.stringify(r.diagnostics)}`)
    assert.match(d!.message, re, name)
    assert.equal(d!.severity, 'error')
    assert.equal(d!.path, 'p.prompt.tsx')
    assert.ok(d!.line! >= 2, name)
  }
  assert.match(tr('<If test={ctx.git.changed.map((f) => f).length > 0}>x</If>').diagnostics[0]!.hint!, /map\("поле"\)/)
})

test('level 2: line numbers are preserved and opt-in is explicit', () => {
  const src = HEAD + '<Section id="a" scope="profile"\n  when={\n    ctx.gate.profile !== "docs"\n  }>\n  {ctx.git.dirty\n    ? <b>x</b>\n    : null}\n</Section>\n'
  const r = transformLevel2(ts, src, { path: 'p.prompt.tsx' })
  assert.deepEqual(r.diagnostics, [])
  assert.equal(r.code.split('\n').length, src.split('\n').length)
  assert.ok(r.changed)
  assert.equal(wantsLevel2('// @context-gate level2\nimport x', undefined), true)
  assert.equal(wantsLevel2('import x', 'level2'), true)
  assert.equal(wantsLevel2('import x // @context-gate level2', 'level1'), false)
  // No `ctx` import: nothing to do.
  assert.equal(transformLevel2(ts, '<If test={a > b}>x</If>', { path: 'x' }).changed, false)
})

// The big TSX example of SPEC «Шар 3» (with `Fence` added to the import list) compiles as is.
const SPEC_EXAMPLE = `// @context-gate level2
import { Prompt, Section, If, Each, Let, Set, Repeat, Run, Call, Use, Include, Skill, Rule, Mcp, Lazy, Tier, Debug, Assert, Fence, ctx } from '@context-gate/jsx'

export default (
  <Prompt>
    <Section id="identity" scope="static">
      Ти senior TypeScript-інженер у проєкті {ctx.repo.name}.
    </Section>

    <Section id="project-rules" scope="profile" budget={4000}
             when={ctx.gate.profile.in(['frontend', 'backend'])}>
      <Each of={ctx.cursor.always}>{r => <li>{r.body}</li>}</Each>
      <If test={ctx.arch.available}>
        Межі архітектури:
        <Each of={ctx.arch.deny}>{d => <li>{d.from} не імпортує {d.to}</li>}</Each>
      </If>
    </Section>

    <Section id="workflow" scope="profile">
      Зміни малими кроками, тести перед комітом.
      <Tier is={['quick', 'standard']}>
        <ol>
          <li>Прочитай файли з задачі і тести поряд.</li>
          <li>Покажи план із 3–6 кроків до першої правки.</li>
          <li>Після кожної правки: <code>pnpm test -- {'<шлях>'}</code>.</li>
        </ol>
      </Tier>
      <Tier is="quick">
        <Each of={ctx.fs.examples('src/**/*.service.ts', 1)}>{ex => <Fence lang="ts" title={ex.path}>{ex.body}</Fence>}</Each>
      </Tier>
    </Section>

    <Section id="repo-state" scope="volatile" when={ctx.gate.profile !== 'docs'}>
      Гілка {ctx.git.branch}.
      <Run lang="bash" cache="5m" as="log">git log --oneline -5</Run>
      <pre>{ctx.log}</pre>
    </Section>

    <Section id="references" scope="profile">
      <Lazy name="api-conventions" path="docs/api.md">Умовності REST API</Lazy>
      <Include path="CONVENTIONS.md" mode="ref" />
      <Skill name="tdd" mode={ctx.gate.tier === 'quick' ? 'inline' : 'ref'} />
      <Mcp server="github" tool="list_prs" args={{ state: 'open' }} as="prs" />
      <If test={ctx.ctx.percent > ctx.budgets.soft}>Контекст {ctx.ctx.percent}% — відповідай стисло.</If>
      <Debug>{['prs', ctx.prs?.length]}</Debug>
    </Section>
  </Prompt>
)
`

function tmpRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cg-l2-'))
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), text) }
  return root
}

test('build: the SPEC «Шар 3» TSX example compiles with level 2 (pragma)', async () => {
  const root = tmpRepo({ '.claude/prompt/main.prompt.tsx': SPEC_EXAMPLE })
  try {
    const r = await buildPrompts({ root })
    assert.deepEqual(r.diagnostics.map((d) => d.code), ['G180'], JSON.stringify(r.diagnostics)) // <Lazy>
    const cp = JSON.parse(readFileSync(join(root, '.claude/prompt/.compiled/main.json'), 'utf8')) as CompiledPrompt
    const by = Object.fromEntries(cp.sections.map((s) => [s.id, s]))
    assert.equal(by['project-rules']!.when, 'gate.profile in ["frontend", "backend"]')
    assert.equal(by['repo-state']!.when, 'gate.profile != "docs"')
    assert.deepEqual(by.identity!.children, [{ t: 'text', value: 'Ти senior TypeScript-інженер у проєкті ' }, { t: 'expr', expr: 'repo.name' }, { t: 'text', value: '.' }])
    assert.deepEqual(by.identity!.source, { path: '.claude/prompt/main.prompt.tsx', line: 6 })
    const each = by['project-rules']!.children[0] as Extract<Node, { t: 'each' }>
    assert.deepEqual(each, { t: 'each', of: 'cursor.always', as: 'r', children: [{ t: 'el', tag: 'li', children: [{ t: 'expr', expr: 'r.body' }] }] })
    const refs = by.references!.children.filter((n) => n.t !== 'text')
    const skillIf = refs.find((n) => n.t === 'if' && n.test === 'gate.tier == "quick"') as Extract<Node, { t: 'if' }>
    assert.deepEqual(skillIf.then, [{ t: 'include', source: 'skill', ref: 'tdd', mode: 'inline' }])
    assert.deepEqual(skillIf.else, [{ t: 'include', source: 'skill', ref: 'tdd', mode: 'ref' }])
    assert.ok(refs.some((n) => n.t === 'if' && n.test === 'ctx.percent > budgets.soft'))
    assert.deepEqual(refs.find((n) => n.t === 'debug'), { t: 'debug', exprs: ['["prs", prs?.length]'] })
    const quick = by.workflow!.children.filter((n) => n.t === 'tier')[1] as Extract<Node, { t: 'tier' }>
    assert.deepEqual((quick.children[0] as Extract<Node, { t: 'each' }>).of, 'fs.examples("src/**/*.service.ts", 1)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('build: prompt.transform level2 in gate.json; G160 stops the write; level 1 untouched without opt-in', async () => {
  const prompt = "import { Prompt, Section, If, ctx } from '@context-gate/jsx'\nexport default <Prompt><Section id=\"a\" scope=\"profile\"><If test={ctx.ctx.percent > 50}>стисло</If></Section></Prompt>\n"
  const root = tmpRepo({ '.claude/prompt/a.prompt.tsx': prompt, '.claude/gate.json': JSON.stringify({ prompt: { transform: 'level2' } }) })
  try {
    const r = await buildPrompts({ root, write: false })
    assert.deepEqual(r.diagnostics, [])
    assert.deepEqual((r.compiled[0]!.sections[0]!.children[0] as Extract<Node, { t: 'if' }>).test, 'ctx.percent > 50')
    writeFileSync(join(root, '.claude/prompt/a.prompt.tsx'), prompt.replace('ctx.ctx.percent > 50', 'ctx.git.changed.filter(Boolean).length > 0'))
    const bad = await buildPrompts({ root })
    assert.deepEqual(bad.diagnostics.map((d) => [d.code, d.path, d.line]), [['G160', '.claude/prompt/a.prompt.tsx', 2]])
    assert.ok(!bad.written.some((w) => w.includes('.compiled/')), 'a prompt with errors is not written')
    // Without opt-in the operator is evaluated at build time by JS: the level-1 G160 guard reports it.
    writeFileSync(join(root, '.claude/gate.json'), '{}')
    writeFileSync(join(root, '.claude/prompt/a.prompt.tsx'), prompt)
    const l1 = await buildPrompts({ root, write: false })
    assert.ok(l1.diagnostics.some((d) => d.code === 'G160'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
