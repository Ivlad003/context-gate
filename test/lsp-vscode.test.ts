import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRunArgs, cliArgv, parseRunOutput, previewOptions, renderPreviewHtml, runCli, sectionIdAt } from '../editors/vscode/src/preview.ts'

const repo = new URL('..', import.meta.url).pathname

test('cliArgv and buildRunArgs', () => {
  assert.deepEqual(cliArgv(undefined), ['npx', 'context-gate'])
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
  assert.equal(pkg.contributes.configuration.properties['contextGate.cliPath'].default, 'npx context-gate')
  assert.equal(pkg.main, './dist/extension.cjs')
})
