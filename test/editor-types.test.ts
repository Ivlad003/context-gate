import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { TSCONFIG_MARK, jsxTypesDir, promptTsconfig, writeEditorTypes } from '../packages/cli/src/editor-types.ts'
import { initCommand } from '../packages/cli/src/cmd-init.ts'
import { level2Diagnostics } from '../packages/lsp/src/level2.ts'

const repo = new URL('..', import.meta.url).pathname
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript')

test('jsx declarations are shipped in dist/jsx-types (npm run build:jsx-types)', () => {
  const dir = jsxTypesDir()
  assert.ok(dir, 'dist/jsx-types exists')
  for (const f of ['jsx/src/index.d.ts', 'jsx/src/jsx-runtime.d.ts', 'jsx/src/components.d.ts', 'core/src/types.d.ts']) assert.ok(existsSync(join(dir!, f)), f)
})

test('writeEditorTypes: tsconfig + .types/jsx; idempotent; own tsconfig is kept', () => {
  const root = mkdtempSync(join(tmpdir(), 'cg-edtypes-'))
  mkdirSync(join(root, '.claude/prompt'), { recursive: true })
  const first = writeEditorTypes(root)
  assert.deepEqual(first.written, ['.claude/prompt/.types/jsx/', '.claude/prompt/tsconfig.json'])
  const cfg = readFileSync(join(root, '.claude/prompt/tsconfig.json'), 'utf8')
  assert.ok(cfg.startsWith(TSCONFIG_MARK))
  assert.equal(cfg, promptTsconfig())
  const json = JSON.parse(cfg.split('\n').slice(1).join('\n'))
  assert.equal(json.compilerOptions.jsxImportSource, '@context-gate/jsx')
  assert.deepEqual(json.compilerOptions.paths['@context-gate/jsx'], ['./.types/jsx/jsx/src/index.d.ts'])
  assert.deepEqual(writeEditorTypes(root).written, [], 'nothing to rewrite')
  writeFileSync(join(root, '.claude/prompt/tsconfig.json'), '{ "compilerOptions": {} }\n')
  const own = writeEditorTypes(root)
  assert.deepEqual(own.written, [])
  assert.match(own.notes.join('\n'), /власний файл/)
  rmSync(root, { recursive: true, force: true })
})

test('init writes the editor typings and gitignores .types/jsx/', () => {
  const root = mkdtempSync(join(tmpdir(), 'cg-edinit-'))
  const r = initCommand(root, {})
  assert.equal(r.code, 0)
  assert.match(r.out, /tsconfig\.json/)
  assert.ok(existsSync(join(root, '.claude/prompt/.types/jsx/jsx/src/index.d.ts')))
  assert.ok(readFileSync(join(root, '.gitignore'), 'utf8').includes('.claude/prompt/.types/jsx/'))
  rmSync(root, { recursive: true, force: true })
})

test('generated tsconfig type-checks examples/basic with nothing installed (TypeScript program)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cg-edts-'))
  cpSync(join(repo, 'examples/basic'), root, { recursive: true })
  rmSync(join(root, '.claude/prompt/tsconfig.json'), { force: true })
  writeEditorTypes(root)
  const cfgPath = join(root, '.claude/prompt/tsconfig.json')
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, join(root, '.claude/prompt'))
  assert.deepEqual(parsed.errors.map((e) => e.messageText), [])
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const diags = ts.getPreEmitDiagnostics(program).map((d) => `${d.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
  assert.deepEqual(diags, [])
  assert.ok(parsed.fileNames.some((f) => f.endsWith('main.prompt.tsx')))
  // A wrong ctx field is a TS error through the typed ctx (level 2 / build-time constants).
  const bad = join(root, '.claude/prompt/bad.prompt.tsx')
  writeFileSync(bad, "import { Prompt, Section, ctx } from '@context-gate/jsx'\nexport default (<Prompt><Section id=\"b\" scope=\"volatile\">{ctx.git.nope}</Section></Prompt>)\n")
  const p2 = ts.createProgram([...parsed.fileNames, bad], parsed.options)
  assert.match(ts.getPreEmitDiagnostics(p2).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'), /nope/)
  rmSync(root, { recursive: true, force: true })
})

test('level2Diagnostics: live G160 on the line of a native expression outside the subset; level 1 untouched', () => {
  const src = "// @context-gate level2\nimport { Prompt, Section, ctx } from '@context-gate/jsx'\nexport default (\n  <Prompt>\n    <Section id=\"a\" scope=\"volatile\">{ctx.git.branch.toUpperCase()}</Section>\n  </Prompt>\n)\n"
  const ds = level2Diagnostics(ts, src, '.claude/prompt/a.prompt.tsx')
  assert.deepEqual(ds.map((d) => d.code), ['G160'])
  assert.equal(src.slice(0, ds[0]!.start).split('\n').length, 5)
  assert.equal(src.slice(ds[0]!.start, ds[0]!.start + 1), '<')
  assert.deepEqual(level2Diagnostics(ts, src.replace('// @context-gate level2\n', ''), 'a.prompt.tsx'), [])
  assert.deepEqual(level2Diagnostics(ts, src.replace('// @context-gate level2\n', ''), 'a.prompt.tsx', 'level2').map((d) => d.code), ['G160'])
  assert.deepEqual(level2Diagnostics(ts, src.replace('.toUpperCase()', ''), 'a.prompt.tsx'), [])
})
