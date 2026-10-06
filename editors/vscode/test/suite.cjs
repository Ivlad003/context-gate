// Runs inside the VS Code extension host (test/run.mjs). Each check drives the real editor through the
// `vscode` API and records evidence in CG_REPORT; any failed check rejects run() → non-zero exit.
const vscode = require('vscode')
const assert = require('node:assert/strict')
const { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const ws = process.env.CG_WS
const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(what, f, timeoutMs = 90_000, every = 250) {
  const t0 = Date.now()
  let last
  for (;;) {
    last = await f()
    if (last) return last
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`)
    await sleep(every)
  }
}

async function check(name, f) {
  const t0 = Date.now()
  try {
    const evidence = await f()
    results.push({ name, ok: true, ms: Date.now() - t0, evidence })
    console.log(`ok   ${name}: ${JSON.stringify(evidence)}`)
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.stack || e) })
    console.log(`FAIL ${name}: ${e && e.stack || e}`)
  }
}

const labels = (list) => (list ? list.items : []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label))
const diagsOf = (uri) => vscode.languages.getDiagnostics(uri)
const codeOf = (d) => (typeof d.code === 'object' && d.code ? String(d.code.value) : String(d.code))

async function setText(editor, text) {
  const doc = editor.document
  await editor.edit((e) => e.replace(new vscode.Range(0, 0, doc.lineCount, 0), text))
}

async function complete(uri, pos, want) {
  return until(`completion ${want}`, async () => {
    const l = labels(await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, pos))
    return l.includes(want) ? l : undefined
  }, 60_000, 500)
}

exports.run = async function run() {
  const prompt = join(ws, '.claude/prompt')
  const ext = vscode.extensions.getExtension('context-gate.context-gate-vscode')
  assert.ok(ext, 'extension present')
  const api = await ext.activate()

  await check('setup: first build of the bundled CLI writes the editor typings', async () => {
    await api.ready
    assert.ok(existsSync(join(prompt, 'tsconfig.json')), 'tsconfig.json')
    assert.ok(existsSync(join(prompt, '.types/jsx/jsx/src/index.d.ts')), '.types/jsx')
    assert.ok(existsSync(join(prompt, '.compiled/main.json')), '.compiled/main.json')
    return { tsconfig: readFileSync(join(prompt, 'tsconfig.json'), 'utf8').split('\n')[0], lastBuild: api.compiler.lastBuild, status: api.compiler.status.text }
  })

  const mainUri = vscode.Uri.file(join(prompt, 'main.prompt.tsx'))
  const original = readFileSync(mainUri.fsPath, 'utf8')
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mainUri))
  const close = original.lastIndexOf('  </Prompt>')

  await check('types: @context-gate/jsx resolves through the generated tsconfig (no TS errors in main.prompt.tsx)', async () => {
    // Wait for the TS project to load (any semantic answer), then require zero TS errors.
    await complete(mainUri, editor.document.positionAt(original.indexOf('<Section') + 4), 'Section')
    await sleep(1500)
    const ts = diagsOf(mainUri).filter((d) => d.source === 'ts' && d.severity === vscode.DiagnosticSeverity.Error)
    assert.deepEqual(ts.map((d) => `${codeOf(d)} ${d.message}`), [])
    return { tsErrors: 0 }
  })

  await check('(a) when="git.nope" → G172 from the tsserver plugin', async () => {
    await setText(editor, original.slice(0, close) + '    <Section id="probe" scope="volatile" when="git.nope">x</Section>\n' + original.slice(close))
    const d = await until('G172', () => diagsOf(mainUri).find((x) => x.message.startsWith('G172')))
    return { code: codeOf(d), source: d.source, message: d.message, line: d.range.start.line + 1, col: d.range.start.character + 1 }
  })

  await check('(b) completion inside when="git.|" offers branch', async () => {
    const text = original.slice(0, close) + '    <Section id="probe" scope="volatile" when="git.">x</Section>\n' + original.slice(close)
    await setText(editor, text)
    const pos = editor.document.positionAt(text.indexOf('when="git.') + 'when="git.'.length)
    const l = await complete(mainUri, pos, 'branch')
    return { at: `${pos.line + 1}:${pos.character + 1}`, items: l.slice(0, 12) }
  })

  await check('(c) completion of <Sec offers Section (types via generated tsconfig)', async () => {
    const text = original.slice(0, close) + '    <Sec\n' + original.slice(close)
    await setText(editor, text)
    const pos = editor.document.positionAt(text.indexOf('<Sec\n') + 4)
    const l = await complete(mainUri, pos, 'Section')
    const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', mainUri, editor.document.positionAt(original.indexOf('<Section') + 3))
    const ht = (hover || []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join(' ').slice(0, 160)
    return { items: l.filter((x) => /^Sec|^Skill|^Each|^If$/.test(x)), hover: ht }
  })

  await check('(d) save with an error → compiler G-code in Problems; fix → cleared and .compiled updated', async () => {
    const compiled = join(prompt, '.compiled/main.json')
    const broken = original.replace("'../../CONVENTIONS.md'", "'../../CONVENTIONS-missing.md'")
    await setText(editor, broken)
    await editor.document.save()
    const d = await until('G164 from build', () => diagsOf(mainUri).find((x) => x.source === 'context-gate' && codeOf(x) === 'G164'))
    const statusBroken = api.compiler.status.text
    const before = statSync(compiled).mtimeMs
    await setText(editor, original)
    await editor.document.save()
    await until('G164 cleared', () => !diagsOf(mainUri).some((x) => x.source === 'context-gate' && codeOf(x) === 'G164'))
    await until('.compiled updated', () => statSync(compiled).mtimeMs > before)
    return { diagnostic: { code: codeOf(d), line: d.range.start.line + 1, message: d.message.slice(0, 120) }, statusBroken, statusFixed: api.compiler.status.text, compiledMtime: [before, statSync(compiled).mtimeMs], lastBuild: api.compiler.lastBuild }
  })

  await check('(e) Markdown section: completion after @ and inside {{ ctx.| }}, G172 diagnostic, hover, symbols', async () => {
    const md = join(prompt, 'notes.md')
    const text = '---\nid: notes\nscope: volatile\n---\nГілка {{ git.branch }}.\n@\n{{ ctx.percent }}\n{{ git.nope }}\n@if gate.tier == "quick"\nшвидко\n@end\n'
    writeFileSync(md, text)
    const uri = vscode.Uri.file(md)
    const doc = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(doc)
    const at = await complete(uri, new vscode.Position(5, 1), 'if')
    const inCtx = await complete(uri, new vscode.Position(6, '{{ ctx.'.length), 'percent')
    const d = await until('md G172', () => diagsOf(uri).find((x) => x.source === 'context-gate' && codeOf(x) === 'G172'))
    const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, new vscode.Position(8, 2))
    const syms = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)
    return {
      afterAt: at.filter((x) => ['if', 'each', 'end', 'run', 'tier'].includes(x)),
      inCtx: inCtx.filter((x) => ['percent', 'tokens', 'limit'].includes(x)),
      diagnostic: `${codeOf(d)} line ${d.range.start.line + 1}: ${d.message.slice(0, 80)}`,
      hover: (hover || []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join(' ').slice(0, 80),
      symbols: (syms || []).map((s) => s.name),
    }
  })

  await check('(f) gate.json: unknown key / wrong type → schema diagnostics', async () => {
    const uri = vscode.Uri.file(join(ws, '.claude/gate.json'))
    const doc = await vscode.workspace.openTextDocument(uri)
    const ed = await vscode.window.showTextDocument(doc)
    await sleep(3000)
    const clean = diagsOf(uri).map((d) => d.message)
    assert.deepEqual(clean, [], 'the example gate.json is valid against the schema')
    const text = doc.getText().replace('{', '{\n  "bogusKey": 1,').replace('"mode": "shadow"', '"mode": 5')
    await setText(ed, text)
    const ds = await until('schema diagnostics', () => { const x = diagsOf(uri); return x.length >= 2 ? x : undefined }, 60_000)
    await vscode.commands.executeCommand('workbench.action.files.revert')
    assert.ok(ds.some((d) => /bogusKey/.test(d.message)) && ds.some((d) => d.range.start.line + 1 === text.split('\n').findIndex((l) => l.includes('"mode": 5')) + 1))
    return { cleanBefore: clean.length, after: ds.map((d) => `line ${d.range.start.line + 1}: ${d.message}`) }
  })

  await check('(g) bad .mdc frontmatter → G010 / G011 / G012 diagnostics, hover with the rule type', async () => {
    const dir = join(ws, '.cursor/rules')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'unclosed.mdc'), '---\ndescription: broken\nalwaysApply: false\n')
    writeFileSync(join(dir, 'bad.mdc'), '---\ndescription: bad\nalwaysApply: maybe\nfoo: bar\n---\nBody\n')
    const u1 = vscode.Uri.file(join(dir, 'unclosed.mdc'))
    const u2 = vscode.Uri.file(join(dir, 'bad.mdc'))
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(u1))
    const d1 = await until('G010', () => diagsOf(u1).find((x) => codeOf(x) === 'G010'), 20_000)
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(u2))
    const d2 = await until('G012', () => { const x = diagsOf(u2); return x.some((y) => codeOf(y) === 'G012') ? x : undefined }, 20_000)
    const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', u2, new vscode.Position(1, 3))
    return {
      unclosed: `${codeOf(d1)} line ${d1.range.start.line + 1}: ${d1.message}`,
      bad: d2.map((d) => `${codeOf(d)} line ${d.range.start.line + 1}`),
      hover: (hover || []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join(' ').replace(/\s+/g, ' ').slice(0, 140),
    }
  })

  await check('(h) TSX level 2: native expression outside the subset → live G160 from the transform', async () => {
    const file = join(prompt, 'shared/level2.prompt.tsx')
    writeFileSync(file, "// @context-gate level2\nimport { Prompt, Section, ctx } from '@context-gate/jsx'\n\nexport default (\n  <Prompt>\n    <Section id=\"l2\" scope=\"volatile\">Гілка {ctx.git.branch.toUpperCase()}.</Section>\n  </Prompt>\n)\n")
    const uri = vscode.Uri.file(file)
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri))
    const d = await until('G160', () => diagsOf(uri).find((x) => x.message.startsWith('G160')))
    return { line: d.range.start.line + 1, message: d.message.slice(0, 140) }
  })

  await check('commands: Build prompts / Health run through the bundled CLI', async () => {
    await vscode.commands.executeCommand('contextGate.build')
    const b = api.compiler.lastBuild
    assert.equal(b && b.target, 'full')
    await vscode.commands.executeCommand('contextGate.health')
    return { status: api.compiler.status.text, lastBuild: b }
  })

  writeFileSync(process.env.CG_REPORT, JSON.stringify(results, null, 2))
  await vscode.commands.executeCommand('workbench.action.files.revertAll').then(undefined, () => {})
  const failed = results.filter((r) => !r.ok)
  if (failed.length) throw new Error(`${failed.length} check(s) failed: ${failed.map((f) => f.name).join('; ')}`)
}
