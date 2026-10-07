import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRunArgs, cliArgv, parseRunOutput, previewOptions, renderPreviewHtml, runCli, sectionIdAt } from '../editors/vscode/src/preview.ts'
import { buildTargetFor, diagnosticsByFile, filesOfPrompts, lineRange, parseBuildJson, resolveCli, shellLine, statusText } from '../editors/vscode/src/compiler-core.ts'
import { DIRECTIVES, directiveAt, directiveDoc, directivePrefixAt, frontmatterLines, markdownSymbols, mdcDiagnostics, mdcHover, tierListAt } from '../editors/vscode/src/dsl-core.ts'

const repo = new URL('..', import.meta.url).pathname

test('cliArgv and buildRunArgs', () => {
  assert.deepEqual(cliArgv(undefined), ['npx', '--no', 'context-gate'])
  assert.deepEqual(cliArgv('node "/a b/cli.js"'), ['node', '/a b/cli.js'])
  assert.deepEqual(buildRunArgs({ section: 'workflow' }, { dryScripts: true }), ['run', '--only', 'workflow', '--json', '--dry-scripts'])
  assert.deepEqual(buildRunArgs({ section: 'w', tier: 'quick', profile: 'backend', ctxFrom: 'session:latest' }, { dryScripts: false }), ['run', '--only', 'w', '--json', '--tier', 'quick', '--profile', 'backend', '--ctx-from', 'session:latest'])
})

test('parseRunOutput reads the RunJson shape (log lines before it tolerated); other shapes are errors', () => {
  const v = parseRunOutput('building…\n{"sections":[{"id":"a","text":"hi","tokens":1}],"text":"hi","trace":[{"section":"a","kind":"if","detail":"x"}],"diagnostics":[],"ms":3,"scope":{}}')
  assert.equal(v.text, 'hi')
  assert.equal(v.trace.length, 1)
  assert.equal(v.ms, 3)
  assert.match(parseRunOutput('{"result":{"sections":[{"id":"a","text":"t"}]}}').error!, /run --json/)
  assert.match(parseRunOutput('', 'boom', 2).error!, /boom/)
  assert.match(parseRunOutput('{oops').error!, /JSON/)
})

test('runCli runs a real process and parses its JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-vsc-'))
  const cli = join(dir, 'fake-cli.mjs')
  writeFileSync(cli, 'console.log(JSON.stringify({ text: process.argv.slice(2).join(" "), sections: [], trace: [], diagnostics: [], ms: 0, scope: {} }))\n')
  const v = await runCli(['node', cli, ...buildRunArgs({ section: 's' }, { dryScripts: true })], dir)
  assert.equal(v.text, 'run --only s --json --dry-scripts')
  const bad = await runCli(['node', join(dir, 'missing.mjs')], dir)
  assert.ok(bad.error)
})

test('sectionIdAt: enclosing Section in TSX, frontmatter id in Markdown', () => {
  const tsx = '<Prompt>\n<Section id="a" scope="static">\nA\n</Section>\n<Section id=\'b\' scope="profile">\nB\n</Section>\n</Prompt>'
  assert.equal(sectionIdAt(tsx, tsx.indexOf('A'), 'x.prompt.tsx'), 'a')
  assert.equal(sectionIdAt(tsx, tsx.indexOf('B'), 'x.prompt.tsx'), 'b')
  assert.equal(sectionIdAt(tsx, 0, 'x.prompt.tsx'), 'a', 'before any section → first')
  assert.equal(sectionIdAt('---\nid: notes\n---\nx', 10, 'a/foo.md'), 'notes')
  assert.equal(sectionIdAt('plain', 1, 'a/workflow.quick.md'), 'workflow')
})

test('renderPreviewHtml escapes content and wires the controls', () => {
  const html = renderPreviewHtml(
    { text: '<script>x</script>', sections: [{ id: 's', text: '<b>hi</b>', tokens: 2 }], trace: [{ section: 's', kind: 'if', detail: 'a < b', line: 7 }], diagnostics: [{ code: 'G170', severity: 'warning', message: 'm & n' }] },
    { section: 's', tier: 'quick' },
    previewOptions({ tiers: { quick: {}, standard: {} }, profiles: { fe: {} } }, ['fixtures/a.json']),
    { nonce: 'N0', cspSource: 'vscode-resource:' },
  )
  assert.ok(html.includes("script-src 'nonce-N0'"))
  assert.ok(html.includes('&lt;b&gt;hi&lt;/b&gt;'))
  assert.ok(!html.includes('<b>hi</b>'))
  assert.ok(html.includes('a &lt; b'))
  assert.ok(html.includes('data-line="7"'))
  assert.ok(html.includes('<option value="quick" selected>'))
  assert.ok(html.includes('fixtures/a.json'))
  assert.ok(html.includes('виконати скрипти'))
})

test('extension manifest contributes the tsserver plugin and the preview command', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'editors/vscode/package.json'), 'utf8'))
  assert.equal(pkg.contributes.typescriptServerPlugins[0].name, '@context-gate/lsp')
  assert.ok(pkg.contributes.commands.some((c: { command: string; title: string }) => c.command === 'contextGate.preview' && c.title === 'context-gate: Preview section'))
  assert.equal(pkg.contributes.configuration.properties['contextGate.cliPath'].default, '')
  assert.equal(pkg.main, './dist/extension.cjs')
  for (const c of ['contextGate.build', 'contextGate.buildFile', 'contextGate.health']) assert.ok(pkg.contributes.commands.some((x: { command: string }) => x.command === c), c)
  assert.deepEqual(pkg.contributes.jsonValidation, [{ fileMatch: ['**/.claude/gate.json'], url: './schema/context-gate.schema.json' }])
  assert.equal(pkg.contributes.grammars[0].injectTo[0], 'text.html.markdown')
  assert.ok(pkg.dependencies.esbuild, 'esbuild ships with the extension for the bundled CLI')
  for (const f of ['syntaxes/markdown-injection.tmLanguage.json', 'snippets/tsx.json', 'snippets/markdown.json']) JSON.parse(readFileSync(join(repo, 'editors/vscode', f), 'utf8'))
  const tsx = JSON.parse(readFileSync(join(repo, 'editors/vscode/snippets/tsx.json'), 'utf8'))
  for (const k of ['Section', 'If', 'Each', 'Run', 'Include', 'Tier', 'context-gate skill prompt']) assert.ok(tsx[k], k)
})

test('resolveCli: setting → workspace node_modules/.bin → bundled (Electron as Node, typescript of VS Code on NODE_PATH)', () => {
  const ext = '/ext'
  const base = { extensionPath: ext, execPath: '/vsc/code', appRoot: '/vsc/app', electron: true }
  assert.deepEqual(resolveCli({ ...base, setting: 'node "/a b/cli.js"', exists: () => true }), { argv: ['node', '/a b/cli.js'], env: {}, source: 'setting' })
  assert.deepEqual(resolveCli({ ...base, setting: ' ', root: '/r', exists: (p) => p === '/r/node_modules/.bin/context-gate' }).argv, ['/r/node_modules/.bin/context-gate'])
  const b = resolveCli({ ...base, root: '/r', exists: (p) => p === '/vsc/app/extensions/node_modules/typescript' })
  assert.deepEqual(b, { argv: ['/vsc/code', '/ext/cli/dist/cli.js'], env: { ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '/vsc/app/extensions/node_modules' }, source: 'bundled' })
  assert.equal(shellLine(b, ['expand', '--only', 'a b']), '/vsc/code /ext/cli/dist/cli.js expand --only "a b"')
})

test('buildTargetFor: entry alone, imported files via the lock, gate.json full, generated files ignored', () => {
  const root = '/r'
  const lock = { prompts: { main: { entry: '.claude/prompt/main.prompt.tsx', sources: [{ path: '.claude/prompt/main.prompt.tsx' }, { path: '.claude/prompt/shared/base.prompt.tsx' }, { path: 'CONVENTIONS.md' }] }, other: { entry: '.claude/prompt/other.prompt.tsx', sources: [{ path: 'CONVENTIONS.md' }] } } }
  const rows: [string, ReturnType<typeof buildTargetFor>][] = [
    ['/r/.claude/prompt/main.prompt.tsx', { only: ['.claude/prompt/main.prompt.tsx'] }],
    ['/r/.claude/prompt/shared/base.prompt.tsx', { only: ['main'] }],
    ['/r/CONVENTIONS.md', { only: ['main', 'other'] }],
    ['/r/.claude/gate.json', 'full'],
    ['/r/.claude/prompt/shared/new.prompt.tsx', 'full'],
    ['/r/.claude/prompt/.compiled/main.json', undefined],
    ['/r/.claude/prompt/.types/ctx.d.ts', undefined],
    ['/r/.claude/prompt/tsconfig.json', undefined],
    ['/r/src/app.ts', undefined],
    ['/elsewhere/x.prompt.tsx', undefined],
  ]
  for (const [f, want] of rows) assert.deepEqual(buildTargetFor(f, root, '.claude/prompt', lock), want, f)
  assert.deepEqual(filesOfPrompts(root, lock, ['main']).sort(), ['/r/.claude/prompt/main.prompt.tsx', '/r/.claude/prompt/shared/base.prompt.tsx', '/r/CONVENTIONS.md'])
})

test('parseBuildJson, diagnosticsByFile, lineRange, statusText', () => {
  const ok = parseBuildJson('log\n{"ok":false,"compiled":[],"written":[],"diagnostics":[{"code":"G164","severity":"error","message":"m","path":".claude/prompt/a.prompt.tsx","line":2},{"code":"G172","severity":"error","message":"x","path":".claude/prompt/a.prompt.tsx","line":3},{"code":"G301","severity":"error","message":"cfg"}],"ms":5}\n')
  assert.ok(!('error' in ok))
  if ('error' in ok) return
  assert.equal(ok.ok, false)
  const by = diagnosticsByFile(ok.diagnostics, '/r', '/r/.claude/gate.json')
  assert.deepEqual(by.get('/r/.claude/prompt/a.prompt.tsx')!.map((d) => d.code), ['G164'], 'live TSX codes are left to the tsserver plugin')
  assert.deepEqual(by.get('/r/.claude/gate.json')!.map((d) => d.code), ['G301'])
  assert.match((parseBuildJson('nothing') as { error: string }).error, /JSON/)
  assert.deepEqual(lineRange('a\n    <Section x>  \nb', 2), [1, 4, 15])
  assert.deepEqual(lineRange(undefined, 3), [2, 0, 0])
  assert.equal(statusText({ kind: 'done', errors: 0, warnings: 0 }), '$(check) context-gate: ✓ built')
  assert.equal(statusText({ kind: 'done', errors: 1, warnings: 2 }), '$(warning) context-gate: ⚠ 3')
  assert.match(statusText({ kind: 'building' }), /building…/)
})

test('Markdown DSL helpers: directive completion/hover positions, symbols; .mdc diagnostics and hover', () => {
  assert.deepEqual(directivePrefixAt('  @ea', 5), { start: 3, prefix: 'ea' })
  assert.equal(directivePrefixAt('text @if', 8), undefined)
  assert.ok(tierListAt('@tier quick, ', 13))
  assert.deepEqual(directiveAt('@each r in x', 2), { name: 'each', start: 0, end: 5 })
  assert.ok(directiveDoc('if'))
  assert.ok(DIRECTIVES.some((d) => d.name === 'run' && d.snippet.includes('@end')))
  const syms = markdownSymbols('---\nid: notes\nscope: volatile\n---\n@let x = 1\n@if a\n@each r in b\n@end\n@end\n@fn hi(n)\n@end\n', '/x/notes.md')
  assert.equal(syms[0]!.name, 'notes')
  assert.equal(syms[0]!.detail, 'секція (volatile)')
  assert.deepEqual(syms[0]!.children.map((c) => [c.name, c.kind, c.line, c.endLine]), [['x', 'variable', 4, 4], ['@if a', 'block', 5, 8], ['hi', 'function', 9, 10]])
  assert.deepEqual(syms[0]!.children[1]!.children.map((c) => c.name), ['@each r in b'])
  assert.deepEqual(mdcDiagnostics('---\ndescription: x\n', '.cursor/rules/a.mdc').map((d) => d.code), ['G010'])
  assert.deepEqual(mdcDiagnostics('---\nalwaysApply: maybe\nfoo: 1\n---\nb', '.cursor/rules/a.mdc').map((d) => d.code).sort(), ['G011', 'G012'])
  assert.match(mdcHover('---\nglobs: src/**/*.ts\n---\nb', '.cursor/rules/a.mdc'), /Auto Attached[\s\S]*src\/\*\*\/\*\.ts/)
  assert.deepEqual(frontmatterLines('---\na: 1\n---\nx'), [0, 2])
})
