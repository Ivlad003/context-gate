// Regressions of the 2026-10-06 review in the LSP (M83, M84, L98, L99) and the VS Code helpers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import type { GateConfig } from '../packages/core/src/types.ts'
import { buildModel, dtsToJsonSchema, schemaToShape } from '../packages/lsp/src/model.ts'
import { analyzeFile, completeAt, quickVariantCommand, scanTsx } from '../packages/lsp/src/analyze.ts'
import { analyzeMarkdown } from '../packages/lsp/src/markdown.ts'
import { checkExpr } from '../packages/lsp/src/exprcheck.ts'
import { loadModel, repoFileReader } from '../packages/lsp/src/load.ts'
import { DEFAULT_CLI, cliArgv, invalidRunState, spawnPlan } from '../packages/lsp/src/runcli.ts'
import { shellLine } from '../editors/vscode/src/compiler-core.ts'
import { renderPreviewHtml } from '../editors/vscode/src/preview.ts'

const config: Partial<GateConfig> = { tiers: { quick: {}, standard: {} }, profiles: { frontend: {} } }
const model = buildModel({ config })
const live = (src: string) => analyzeFile(ts, 'a.prompt.tsx', src, model).map((d) => [d.code, src.slice(d.start, d.start + d.length)])

test('M83: CRLF template literals and escapes map back to the exact source range', () => {
  const crlf = '<Prompt>\r\n<Section id="s" scope="profile">{`line one\r\n  line two\r\n  {{ git.nope }}`}</Section>\r\n</Prompt>'
  const cases: [string, string, string][] = [
    ['CRLF template', crlf, 'git.nope'],
    ['escaped quote before', `<Section id="s" scope="profile">{"a \\"q\\" {{ git.nope }}"}</Section>`, 'git.nope'],
    ['unicode escape before', `<Section id="s" scope="profile">{'\\u00e9 {{ git.nope }}'}</Section>`, 'git.nope'],
  ]
  for (const [name, src, want] of cases) {
    const d = live(src)
    assert.deepEqual(d.map((x) => x[0]), ['G172'], name)
    assert.equal(d[0]![1], want, name)
  }
  const pos = crlf.indexOf('git.nope') + 4
  const c = completeAt(ts, 'a.prompt.tsx', crlf, pos, model)!
  assert.equal(c.start, pos)
})

test('L98: JSX attribute strings decode entities, no backslash escapes', () => {
  const cases: [string, string, string[]][] = [
    ['entities are clean', `<If test="gate.profile == &quot;frontend&quot;">x</If>`, []],
    ['backslash keeps ranges', `<If test="git.branch ~ 'feat\\/x' && gate.bogus">x</If>`, ['gate.bogus']],
  ]
  for (const [name, src, want] of cases) assert.deepEqual(live(src).map((d) => d[1]), want, name)
})

test('L98: positions that are never expressions or interpolated are not checked', () => {
  const cases: [string, string][] = [
    ['build-time Each array', `<Each of={['frontend', 'backend', 'src/app']}>{(p) => p}</Each>`],
    ['Run code with Go templates', '<Run lang="bash">{`docker inspect -f \'{{ .State.Status }}\' web`}</Run>'],
    ['Include text', `<Include text="Use {{ name }} in Handlebars" />`],
    ['unclosed {{ in prose', `<Section id="s" scope="profile">{"Write {{ to start a template"}</Section>`],
    ['scripts sugar', `<Let name="s" value="scripts.summarize(git.changed)" />`],
  ]
  for (const [name, src] of cases) assert.deepEqual(live(src), [], name)
})

test('L98: loop bindings are scoped to their body', () => {
  const src = `<Section id="s" scope="profile">
  <Each of="cursor.always">{'{{ it.body }}'}</Each>
  <Each of="git.log(3)">{'{{ it.subject }}'}</Each>
  {'{{ it.body }}'}
</Section>`
  // File-global bindings typed the first loop's `it` as a commit (the last binding): false G172 on `it.body`.
  assert.deepEqual(analyzeFile(ts, 'a.prompt.tsx', src, model).map((x) => x.code), [])
  assert.deepEqual(analyzeFile(ts, 'a.prompt.tsx', src.replace('it.subject', 'it.body'), model).map((x) => [x.code, x.start > src.indexOf('git.log')]), [['G172', true]])
})

test('L98: compiled diagnostics stay when the live scan does not cover their line', () => {
  const src = `<Prompt>\n  <Section id="s" scope="profile" when="gate.tier">x</Section>\n  <Comp />\n</Prompt>`
  const compiled = { diagnostics: [
    { code: 'G102' as const, severity: 'error' as const, message: 'з компонента', line: 3 },
    { code: 'G101' as const, severity: 'error' as const, message: 'стара копія', line: 2 },
  ] }
  const got = analyzeFile(ts, 'a.prompt.tsx', src, model, compiled).map((d) => d.code)
  assert.deepEqual(got, ['G102'])
})

test('L98: schema reader, index samples, data keys, model cache', () => {
  const s = dtsToJsonSchema('export interface Arch { onChange: (x: number) => void\n layers: string[]\n deny: {from:string; to:string}[] }')!
  assert.deepEqual(Object.keys(s.properties as object), ['onChange', 'layers', 'deny'])
  const m = buildModel({ index: { vars: { arch: { value: { layers: { ui: { rules: '{…}' } }, modules: '[3]' } } }, data: ['api-endpoints', 'counter'] } })
  const bound = new Map()
  assert.deepEqual(checkExpr('arch.layers.ui.rules.strict', m, bound).map((d) => d.code), [])
  assert.deepEqual(checkExpr('len(arch.modules)', m, bound).map((d) => d.code), [])
  assert.deepEqual(Object.keys((m.roots.data as { props: object }).props), ['api-endpoints', 'counter'])
  assert.equal(schemaToShape({ type: 'object' }).k, 'object')
  // Edits of a provider schema file reach the cached model.
  const root = mkdtempSync(join(tmpdir(), 'cg-lsp-fix-'))
  mkdirSync(join(root, '.claude/prompt'), { recursive: true })
  writeFileSync(join(root, '.claude/gate.json'), JSON.stringify({ providers: { arch: { kind: 'cli', command: ['a'], schema: 'types/arch.d.ts' } } }))
  mkdirSync(join(root, 'types'))
  writeFileSync(join(root, 'types/arch.d.ts'), 'export interface Arch { layers: string[] }')
  assert.deepEqual(Object.keys((loadModel(root).model.roots.arch as { props: object }).props), ['layers'])
  writeFileSync(join(root, 'types/arch.d.ts'), 'export interface Arch { layers: string[]; owners: string[] }')
  const later = new Date(Date.now() + 5000)
  utimesSync(join(root, 'types/arch.d.ts'), later, later)
  assert.deepEqual(Object.keys((loadModel(root).model.roots.arch as { props: object }).props), ['layers', 'owners'])
  // Schema paths outside the repo are not read.
  symlinkSync(tmpdir(), join(root, 'out'))
  const read = repoFileReader(root)
  for (const bad of ['../x', '/etc/passwd', 'out/x', 'a\0b']) assert.equal(read(bad), undefined, bad)
  assert.equal(read('types/arch.d.ts')?.includes('owners'), true)
})

test('L98: Markdown: use: namespaces bound, uncovered syntax errors kept, unclosed {{ is text', () => {
  const md = '---\nid: n\nuse:\n  gitx: scripts/git-extra.js\n---\n{{ gitx.summary(git.changed) }}\nWrite {{ to start\n'
  assert.deepEqual(analyzeMarkdown(md, 'n.md', model).map((d) => d.code), [])
  const bad = '---\nid: n\n---\n```sh\necho {{ git.branch + }}\n```\n'
  assert.ok(analyzeMarkdown(bad, 'n.md', model).some((d) => /^G10\d$/.test(d.code)), 'fenced syntax error from the core')
})

test('L99: quick-variant command generates only the quick tier', () => {
  assert.deepEqual(quickVariantCommand('health'), ['context-gate', 'expand', '--only', 'health', '--tiers', 'quick'])
})

test('M84/S12: spawn without a shell; Windows .cmd shims quoted or refused; ids validated', () => {
  const cases: [string, string[], string, ReturnType<typeof spawnPlan>][] = [
    ['posix', ['npx', 'context-gate', 'run', '--ctx-from', 'a b & c'], 'linux', { file: 'npx', args: ['context-gate', 'run', '--ctx-from', 'a b & c'] }],
    ['win exe', ['node', 'C:\\cli.js', 'x y'], 'win32', { file: 'node', args: ['C:\\cli.js', 'x y'] }],
    ['win npx', ['npx', '--no', 'context-gate', 'run', '--ctx-from', 'C:\\Users\\Jane Doe\\fx.json', 'x & calc'], 'win32',
      { file: 'cmd.exe', args: ['/d', '/s', '/c', '"npx.cmd --no context-gate run --ctx-from "C:\\Users\\Jane Doe\\fx.json" "x & calc""'], windowsVerbatimArguments: true }],
  ]
  for (const [name, argv, platform, want] of cases) assert.deepEqual(spawnPlan(argv, platform, 'cmd.exe'), want, name)
  for (const bad of ['%PATH%', 'a"b', '!x!', 'a^b', 'a\nb']) assert.ok('error' in spawnPlan(['npx', 'context-gate', bad], 'win32'), bad)
  assert.deepEqual(cliArgv(undefined), DEFAULT_CLI.split(' '))
  assert.ok(DEFAULT_CLI.includes('--no '), 'npx never installs a package on its own')
  const states: [Parameters<typeof invalidRunState>[0], boolean][] = [
    [{ section: 'health', tier: 'quick', profile: 'frontend', ctxFrom: 'session:latest' }, true],
    [{ section: 'a-b.c', ctxFrom: 'fixtures/x y.json' }, true],
    [{ section: '--help' }, false],
    [{ section: 'x & calc' }, false],
    [{ section: 's', tier: '-t' }, false],
    [{ section: 's', ctxFrom: '--trust-repo' }, false],
    // Core accepts non-ASCII ids (`id: правила`); so does the preview.
    [{ section: 'правила', profile: 'фронт' }, true],
    [{ section: '-правила' }, false],
  ]
  for (const [st, ok] of states) assert.equal(invalidRunState(st) === undefined, ok, JSON.stringify(st))
  assert.equal(invalidRunState({ section: 'a b' }), 'Невірний id секції: «a b»')
})

test('VS Code helpers: shell quoting and escaped preview fields', () => {
  if (process.platform !== 'win32') {
    const cmd = { argv: ['/vsc/code', '/ext/cli.js'], env: {}, source: 'bundled' as const }
    assert.equal(shellLine(cmd, ['expand', '--only', 'a b']), '/vsc/code /ext/cli.js expand --only "a b"')
    assert.equal(shellLine(cmd, ['$(id)`x`']), '/vsc/code /ext/cli.js "\\$(id)\\`x\\`"')
  }
  const html = renderPreviewHtml({ text: '', sections: [], trace: [{ section: 's', kind: 'run', detail: 'd', ms: '<img>' as unknown as number, line: '1"><script>' as unknown as number }], diagnostics: [{ code: 'G1' as never, severity: '"><x' as never, message: 'm', line: 2 }] }, { section: 's' }, { tiers: [], profiles: [], ctxFrom: [] }, { nonce: 'n', cspSource: 'c' })
  assert.ok(!html.includes('<img>') && !html.includes('"><script>') && !html.includes('"><x'))
})

test('scanTsx: Each items keep their scope range', () => {
  const f = scanTsx(ts, 'a.prompt.tsx', `<Each of="xs">{(x) => x}</Each>`)
  assert.ok(f.bindings.every((b) => b.scope))
})
