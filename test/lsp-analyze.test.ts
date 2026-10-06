import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import type { GateConfig } from '../packages/core/src/types.ts'
import { buildModel, parseCtxDts, schemaToShape } from '../packages/lsp/src/model.ts'
import { checkExpr, completeExpr, hoverExpr } from '../packages/lsp/src/exprcheck.ts'
import { analyzeFile, completeAt, compiledDiagnostics, hoverAt, numericCode, placeholderRanges, refactorsAt, scanTsx, sectionSymbols } from '../packages/lsp/src/analyze.ts'
import { createPlugin } from '../packages/lsp/src/plugin.ts'

const config: Partial<GateConfig> = {
  tiers: { premium: {}, standard: {}, quick: {} },
  profiles: { frontend: {}, backend: {} },
  providers: {
    arch: { kind: 'cli', command: ['arch'] },
    tickets: { kind: 'cli', command: ['t'], schema: { type: 'object', properties: { open: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } }, count: { type: 'number' } }, additionalProperties: false } },
    util: { kind: 'module', path: 'scripts/util.js', functions: ['next_version'] },
  },
}
const model = buildModel({ config, trace: { scope: { git: { branch: 'main' }, gate: { profile: 'frontend', tier: 'quick' }, ctx: { percent: 42 } } } })
const codes = (src: string, bound = new Map()) => checkExpr(src, model, bound).map((d) => d.code)

test('checkExpr: parse errors and Ctx checks', () => {
  const cases: [string, string[]][] = [
    ['gate.profile == "frontend"', []],
    ['ctx.percent > budgets.soft', []],
    ['len(cursor.auto) > 0', []],
    ['cursor.auto | map("id") | join(", ")', []],
    ['cursor.always | map("{{ item.body }}")', []],
    ['fs.examples("src/**/*.ts", 1)', []],
    ['tickets.count > 0 && len(tickets.open) > 0', []],
    ['tickets.open | map("title")', []],
    ['util.next_version(1)', []],
    ['data.anything.deep', []],
    ['git.branch ==', ['G101']],
    ['x | nope', ['G104']],
    ['foo.bar', ['G171']],
    ['git.nope', ['G172']],
    ['gate.skills.on.length', []],
    ['arch.deny', ['G170']],
    ['tickets.closed', ['G172']],
    ['fs.nope("x")', ['G158']],
    ['other.fn(1)', ['G157']],
  ]
  for (const [src, want] of cases) assert.deepEqual(codes(src), want, src)
  assert.deepEqual(codes('r.body', new Map([['r', { k: 'any' }]])), [], 'bound names are known')
})

test('checkExpr ranges point at the offending path', () => {
  const src = 'gate.tier == "quick" && git.nope'
  const [d] = checkExpr(src, model)
  assert.equal(src.slice(d!.start, d!.end), 'git.nope')
})

test('completeExpr: roots, members, filters, profile values', () => {
  const names = (src: string, off = src.length) => completeExpr(src, off, model).entries.map((e) => e.name)
  assert.ok(names('').includes('gate') && names('').includes('tickets') && names('').includes('len'))
  assert.deepEqual(names('gate.').filter((n) => ['profile', 'tier', 'groups'].includes(n)).sort(), ['groups', 'profile', 'tier'])
  assert.ok(names('tickets.open | ').includes('take'))
  assert.ok(names('tickets.open | ta').includes('take'))
  assert.ok(!names('a || ').includes('take'), '|| is not a pipe')
  const prof = completeExpr('gate.profile == "fr', 19, model)
  assert.deepEqual(prof.entries.map((e) => e.insert), ['frontend', 'backend'])
  assert.equal(prof.start, 17)
  assert.deepEqual(completeExpr('gate.tier == ', 13, model).entries.map((e) => e.insert), ['"premium"', '"standard"', '"quick"'])
  assert.deepEqual(names('gate.profile in ["frontend", "'), ['frontend', 'backend'])
  assert.deepEqual(names('"some text '), [], 'no completions inside an unrelated string literal')
  assert.ok(names('ctx.').includes('percent'))
})

test('hoverExpr: type, doc and value from the last trace', () => {
  const h = hoverExpr('git.branch == "x"', 6, model)!
  assert.equal(h.text, 'git.branch')
  assert.equal(h.type, 'string')
  assert.equal(h.value, '"main"')
  assert.equal(hoverExpr('x | take(3)', 6, model)!.type, 'filter')
  assert.equal(hoverExpr('ctx.percent', 2, model)!.text, 'ctx')
})

test('schema → shape and ctx.d.ts fallback', () => {
  const s = schemaToShape({ type: 'object', properties: { a: { enum: ['x', 'y'] } }, additionalProperties: false })
  assert.equal(s.k, 'object')
  const dts = parseCtxDts('declare module "@context-gate/jsx" {\n  interface CtxOverrides {\n    gate: GateCtx<"a" | "b", "quick">\n    arch: unknown\n  }\n}\nexport type ProfileName = "a" | "b"\nexport type TierName = "quick"\n')
  assert.deepEqual(dts, { profiles: ['a', 'b'], tiers: ['quick'], providers: ['arch'] })
  const m = buildModel({ ctxDts: 'interface CtxOverrides {\n    arch: unknown\n  }\nexport type ProfileName = "a"' })
  assert.deepEqual(m.profiles, ['a'])
  assert.equal(m.roots.arch?.k, 'unknown')
})

const TSX = `import { Prompt, Section, Each, If, V, Run, Include, Skill, Let } from '@context-gate/jsx'
export default (
  <Prompt>
    <Section id="rules" scope="profile" when='gate.profile == "frontend"'>
      <Each of="cursor.always" as="r"><li><V expr="r.body" /></li></Each>
      <If test="len(cursor.auto) > 0">Ще {'{{ cursor.auto | map("id") | join(", ") }}'}.</If>
      <Include path="docs/api.md" />
      <Skill name="tdd" mode="ref" />
    </Section>
    <Section id="stable" scope="static">
      <Run lang="bash" as="log">git log -1</Run>
      <Let name="x" value="log.stdout" />
      {'{{ x }} та {{ git.nope }}'}
    </Section>
  </Prompt>
)
`

test('scanTsx: sites map back to source text exactly', () => {
  const facts = scanTsx(ts, 'a.prompt.tsx', TSX)
  for (const s of facts.sites) assert.equal(TSX.slice(s.start, s.end), s.text)
  assert.deepEqual(facts.sites.map((s) => `${s.component}.${s.prop}`), ['Section.when', 'Each.of', 'V.expr', 'If.test', 'text.children', 'Let.value', 'text.children', 'text.children'])
  assert.deepEqual(facts.sites.map((s) => s.section), ['rules', 'rules', 'rules', 'rules', 'rules', 'stable', 'stable', 'stable'])
  assert.deepEqual(sectionSymbols(ts, 'a.prompt.tsx', TSX).map((s) => [s.id, s.scope, s.line]), [['rules', 'profile', 4], ['stable', 'static', 10]])
  assert.deepEqual(placeholderRanges('a {{ x }} b {{y}} {{ open'), [[5, 6], [14, 15], [21, 25]])
})

test('analyzeFile: live diagnostics incl. G163 and compiled G151', () => {
  const diags = analyzeFile(ts, 'a.prompt.tsx', TSX, model, { diagnostics: [{ code: 'G151', severity: 'error', message: 'Рекурсія компонентів: A → A.', path: '.claude/prompt/a.prompt.tsx', line: 3 }, { code: 'G101', severity: 'error', message: 'dup', line: 3 }], relPath: '.claude/prompt/a.prompt.tsx' })
  const got = diags.map((d) => [d.code, TSX.slice(d.start, d.start + d.length).slice(0, 20)])
  assert.deepEqual(got, [['G172', 'git.nope'], ['G163', '<Run lang="bash" as='], ['G151', '<Prompt>']])
  assert.equal(numericCode('G151'), 90151)
  assert.equal(compiledDiagnostics([{ code: 'G160', severity: 'error', message: 'm', path: 'other.tsx', line: 1 }], TSX, 'a.prompt.tsx').length, 0)
})

test('completeAt / hoverAt in TSX: Each item typed from `of`', () => {
  const src = TSX.replace('<V expr="r.body" />', '<V expr="r." />')
  const pos = src.indexOf('r."') + 2
  const c = completeAt(ts, 'a.prompt.tsx', src, pos, model)!
  assert.ok(c.entries.some((e) => e.name === 'body'), 'RuleRef members')
  assert.equal(c.start, pos)
  assert.equal(completeAt(ts, 'a.prompt.tsx', src, src.indexOf('id="rules"') + 5, model), undefined, 'id is not an expression')
  const hpos = TSX.indexOf('cursor.auto) > 0') + 9
  const h = hoverAt(ts, 'a.prompt.tsx', TSX, hpos, model)!
  assert.equal(h.text, 'cursor.auto')
  assert.match(h.type, /\[\]$/)
})

test('refactorsAt: extract to Lazy and quick variant', () => {
  const pos = TSX.indexOf('<Include') + 3
  const rs = refactorsAt(ts, 'a.prompt.tsx', TSX, pos)
  const lazy = rs.find((r) => r.name === 'extract-lazy')
  assert.ok(lazy && lazy.name === 'extract-lazy')
  const e = lazy.edits[0]!
  assert.equal(TSX.slice(0, e.start) + e.newText + TSX.slice(e.end), TSX.replace('<Include path', '<Include mode="lazy" path'))
  const sk = refactorsAt(ts, 'a.prompt.tsx', TSX, TSX.indexOf('<Skill') + 2).find((r) => r.name === 'extract-lazy')
  assert.ok(sk && sk.name === 'extract-lazy')
  assert.equal(TSX.slice(sk.edits[0]!.start, sk.edits[0]!.end), '"ref"')
  const q = rs.find((r) => r.name === 'quick-variant')
  assert.ok(q && q.name === 'quick-variant')
  assert.deepEqual(q.command, ['context-gate', 'expand', '--only', 'rules'])
})

test('tsserver plugin decorates a real language service', () => {
  const root = mkdtempSync(join(tmpdir(), 'cg-lsp-'))
  mkdirSync(join(root, '.claude/prompt'), { recursive: true })
  writeFileSync(join(root, '.claude/gate.json'), JSON.stringify(config))
  const file = join(root, '.claude/prompt/a.prompt.tsx')
  writeFileSync(file, TSX)
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [file],
    getScriptVersion: () => '1',
    getScriptSnapshot: (f) => { try { return ts.ScriptSnapshot.fromString(ts.sys.readFile(f) ?? '') } catch { return undefined } },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({ jsx: ts.JsxEmit.Preserve, noLib: true, noResolve: true, types: [] }),
    getDefaultLibFileName: () => 'lib.d.ts',
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
  }
  const base = ts.createLanguageService(host)
  const info = { languageService: base, languageServiceHost: host, project: { projectService: { logger: { info() {} } } }, config: {} } as unknown as ts.server.PluginCreateInfo
  const ls = createPlugin(ts, info)
  const ours = ls.getSemanticDiagnostics(file).filter((d) => d.source === 'context-gate')
  assert.deepEqual(ours.map((d) => d.code), [90172, 90163])
  const comp = ls.getCompletionsAtPosition(file, TSX.indexOf('gate.profile ==') + 5, undefined)!
  assert.ok(comp.entries.some((e) => e.name === 'tier'))
  const nav = ls.getNavigationTree(file)
  assert.deepEqual(nav.childItems!.slice(0, 2).map((c) => c.text), ['Section rules (profile)', 'Section stable (static)'])
  const qi = ls.getQuickInfoAtPosition(file, TSX.indexOf('cursor.always') + 2)!
  assert.match(qi.displayParts![0]!.text, /^cursor/)
  const refs = ls.getApplicableRefactors(file, TSX.indexOf('<Include') + 2, {})
  assert.ok(refs.some((r) => r.name === 'context-gate'))
  const edits = ls.getEditsForRefactor(file, {}, TSX.indexOf('<Include') + 2, 'context-gate', 'extract-lazy', {})!
  assert.equal(edits.edits[0]!.textChanges[0]!.newText, ' mode="lazy"')
})

test('Markdown prompts: directive expressions, typed @each items, parser codes', async () => {
  const { analyzeMarkdown, completeMarkdown, scanMarkdown } = await import('../packages/lsp/src/markdown.ts')
  const md = '---\nid: notes\n---\n@each r in cursor.always\n- {{ r.body }} {{ r.nope }}\n@end\n@if gate.tier == "quick"\n@let n = len(cursor.auto)\n{{ n + 1 }}\n@end\n@bogus\n'
  const facts = scanMarkdown(md)
  for (const s of facts.sites) assert.equal(md.slice(s.start, s.end), s.text)
  assert.deepEqual(facts.sites.map((s) => s.text), ['cursor.always', 'r.body', 'r.nope', 'gate.tier == "quick"', 'len(cursor.auto)', 'n + 1'])
  const diags = analyzeMarkdown(md, '.claude/prompt/notes.md', model)
  assert.deepEqual(diags.map((d) => d.code), ['G172', 'G001'])
  const pos = md.indexOf('r.body') + 2
  assert.ok(completeMarkdown(md, pos, model)!.entries.some((e) => e.name === 'globs'))
})
