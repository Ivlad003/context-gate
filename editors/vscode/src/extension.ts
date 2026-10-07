// VS Code client of context-gate: the compiler on save (Problems + status bar + log, compiler.ts), the tsserver
// plugin (`@context-gate/lsp`, contributed via `typescriptServerPlugins`), Markdown DSL / `.mdc` providers
// (providers.ts), the gate.json schema (`jsonValidation`) and the CLI preview panel (preview.ts).

import * as vscode from 'vscode'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import { buildRunArgs, invalidRunState, previewOptions, renderPreviewHtml, runCli, sectionIdAt, SAFE_ID, type PreviewState, type RunView } from './preview.ts'
import { resolveCli, shellLine, buildTargetFor, readLock, type CliCommand } from './compiler-core.ts'
import { Compiler, execCli, needsEditorTypes, type RootInfo } from './compiler.ts'
import { registerDslProviders } from './providers.ts'
import { findRoot as findRootOf } from '../../../packages/lsp/src/load.ts'

const PLUGIN = '@context-gate/lsp'

let extensionPath = ''
let output: vscode.OutputChannel
let compiler: Compiler

function findRoot(file: string): string | undefined {
  return findRootOf(file)
}

function readConfig(root: string): { tiers?: Record<string, unknown>; profiles?: Record<string, unknown>; prompt?: { dir?: string } } | undefined {
  try { return JSON.parse(readFileSync(join(root, '.claude', 'gate.json'), 'utf8')) } catch { return undefined }
}

function rootInfo(root: string): RootInfo {
  return { root, promptDir: (readConfig(root)?.prompt?.dir ?? '.claude/prompt').replace(/^\.\//, '').replace(/\/+$/, '') }
}

function fixtures(root: string): string[] {
  const out: string[] = []
  for (const d of ['fixtures', '.claude/prompt/fixtures']) {
    try { for (const f of readdirSync(join(root, d))) if (f.endsWith('.json')) out.push(`${d}/${f}`) } catch { /* none */ }
  }
  return out
}

/** CLI for a repo root: `contextGate.cliPath` → workspace `node_modules/.bin/context-gate` → bundled CLI. */
function cliFor(root?: string): CliCommand {
  return resolveCli({
    setting: vscode.workspace.getConfiguration('contextGate').get<string>('cliPath') ?? '',
    ...(root ? { root } : {}),
    extensionPath,
    execPath: process.execPath,
    appRoot: vscode.env.appRoot,
    electron: Boolean(process.versions.electron),
  })
}

function activeRoot(): string | undefined {
  const f = vscode.window.activeTextEditor?.document.uri
  const r = f?.scheme === 'file' ? findRoot(f.fsPath) : undefined
  if (r) return r
  for (const w of vscode.workspace.workspaceFolders ?? []) { const x = findRoot(join(w.uri.fsPath, 'x')); if (x) return x }
  return undefined
}

async function configureTsPlugin(): Promise<void> {
  const ext = vscode.extensions.getExtension('vscode.typescript-language-features')
  if (!ext) return
  await ext.activate()
  const api = (ext.exports as { getAPI?: (v: number) => { configurePlugin(id: string, cfg: unknown): void } } | undefined)?.getAPI?.(0)
  // Untrusted workspace: never hand the repo's node_modules/.bin/context-gate to the tsserver plugin.
  const cmd = cliFor(vscode.workspace.isTrusted ? activeRoot() : undefined)
  // The extension publishes fresh build diagnostics itself (compiler.ts); the plugin keeps the live ones.
  api?.configurePlugin(PLUGIN, { cliPath: cmd.argv, cliEnv: cmd.env, compiledDiagnostics: false })
}

class PreviewPanel {
  static current: PreviewPanel | undefined
  panel: vscode.WebviewPanel
  doc: vscode.Uri
  root: string
  state: PreviewState
  view: RunView | undefined
  busy = false
  dryScripts = true

  constructor(doc: vscode.Uri, root: string, section: string) {
    this.doc = doc
    this.root = root
    this.state = { section }
    this.panel = vscode.window.createWebviewPanel('contextGatePreview', `Preview: ${section}`, vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true })
    this.panel.onDidDispose(() => { if (PreviewPanel.current === this) PreviewPanel.current = undefined })
    this.panel.webview.onDidReceiveMessage((m: { type: string; tier?: string; profile?: string; ctxFrom?: string; line?: number }) => this.onMessage(m))
  }

  async onMessage(m: { type: string; tier?: string; profile?: string; ctxFrom?: string; line?: number }): Promise<void> {
    if (m.type === 'reveal' && m.line) {
      const editor = await vscode.window.showTextDocument(this.doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false })
      const pos = new vscode.Position(Math.max(0, m.line - 1), 0)
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
      return
    }
    const next: PreviewState = { section: this.state.section }
    if (m.tier) next.tier = m.tier
    if (m.profile) next.profile = m.profile
    if (m.ctxFrom) next.ctxFrom = m.ctxFrom
    this.state = next
    if (m.type === 'runScripts') {
      const ok = await vscode.window.showWarningMessage(
        `Виконати скрипти секції "${this.state.section}"? Run/Call/Mcp запустяться з правами користувача.`, { modal: true }, 'Виконати')
      if (ok === 'Виконати') await this.refresh(false)
      return
    }
    await this.refresh(true)
  }

  async refresh(dryScripts = true): Promise<void> {
    this.busy = true
    this.dryScripts = dryScripts
    this.render()
    const cmd = cliFor(this.root)
    const invalid = invalidRunState(this.state)
    this.view = invalid ? { text: '', sections: [], trace: [], diagnostics: [], error: invalid } : await runCli([...cmd.argv, ...buildRunArgs(this.state, { dryScripts })], this.root, 60_000, cmd.env)
    this.busy = false
    this.render()
  }

  render(): void {
    const opts = previewOptions(readConfig(this.root), fixtures(this.root))
    this.panel.title = `Preview: ${this.state.section}`
    this.panel.webview.html = renderPreviewHtml(this.view, this.state, opts, { nonce: randomBytes(16).toString('hex'), cspSource: this.panel.webview.cspSource, busy: this.busy, dryScripts: this.dryScripts })
  }
}

async function previewCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) { void vscode.window.showInformationMessage('context-gate: відкрий файл .prompt.tsx або .md з .claude/prompt'); return }
  const file = editor.document.uri.fsPath
  const root = findRoot(file)
  if (!root) { void vscode.window.showWarningMessage('context-gate: не знайдено .claude/ у батьківських каталогах'); return }
  // Preview runs the CLI, which builds (executes) the repo's TSX: not in an untrusted workspace.
  if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('context-gate: preview вимкнено в недовіреному workspace'); return }
  const section = sectionIdAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active), file)
    ?? await vscode.window.showInputBox({ prompt: 'id секції' })
  if (!section) return
  const cur = PreviewPanel.current
  if (cur) { cur.doc = editor.document.uri; cur.root = root; cur.state = { ...cur.state, section }; cur.panel.reveal(vscode.ViewColumn.Beside, true) }
  else PreviewPanel.current = new PreviewPanel(editor.document.uri, root, section)
  await PreviewPanel.current!.refresh(true)
}

function quickVariantCommand(section?: string): void {
  const editor = vscode.window.activeTextEditor
  const file = editor?.document.uri.fsPath
  const root = file ? findRoot(file) : undefined
  const id = section ?? (editor && file ? sectionIdAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active), file) : undefined)
  if (!root || !id) return
  if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('context-gate: quick-варіант вимкнено в недовіреному workspace'); return }
  // The id comes from the file and goes into a shell line.
  if (!SAFE_ID.test(id)) { void vscode.window.showWarningMessage(`context-gate: невірний id секції «${id}»`); return }
  const cmd = cliFor(root)
  const term = vscode.window.createTerminal({ name: 'context-gate expand', cwd: root, env: cmd.env })
  term.show()
  term.sendText(shellLine(cmd, ['expand', '--only', id, '--tiers', 'quick']))
}

async function buildCommand(full: boolean): Promise<void> {
  const root = activeRoot()
  if (!root) { void vscode.window.showWarningMessage('context-gate: не знайдено .claude/ у workspace'); return }
  const info = rootInfo(root)
  const file = vscode.window.activeTextEditor?.document.uri.fsPath
  if (vscode.window.activeTextEditor?.document.isDirty) await vscode.window.activeTextEditor.document.save()
  const target = full || !file ? 'full' : buildTargetFor(file, root, info.promptDir, readLock(root, info.promptDir)) ?? 'full'
  await compiler.enqueue(info, target, file)
  const b = compiler.lastBuild
  if (b?.error) { output.show(true); void vscode.window.showErrorMessage(`context-gate: ${b.error}`) }
}

async function healthCommand(): Promise<void> {
  const root = activeRoot()
  if (!root) { void vscode.window.showWarningMessage('context-gate: не знайдено .claude/ у workspace'); return }
  const cmd = cliFor(root)
  compiler.log(`${cmd.argv.join(' ')} health  (cwd ${root})`)
  const r = await execCli(cmd, ['health'], root)
  output.appendLine(r.stdout.trimEnd())
  if (r.stderr.trim()) output.appendLine(r.stderr.trimEnd())
  output.show(true)
  const warn = (r.stdout.match(/\bH0\d\d\b/g) ?? []).length
  void vscode.window.showInformationMessage(`context-gate health: ${r.code === 0 ? (warn ? `${warn} попереджень H0xx` : 'усе в межах') : `код ${r.code}`} — деталі в журналі`)
}

/** First build of a repo whose editor typings (prompt tsconfig, .types/jsx) are missing: writes them. */
async function ensureEditorTypes(): Promise<void> {
  if (!vscode.workspace.isTrusted) return
  const roots = new Set<string>()
  for (const w of vscode.workspace.workspaceFolders ?? []) { const r = findRoot(join(w.uri.fsPath, 'x')); if (r) roots.add(r) }
  for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === 'file') { const r = findRoot(d.uri.fsPath); if (r) roots.add(r) }
  let wrote = false
  for (const root of roots) {
    const info = rootInfo(root)
    if (!needsEditorTypes(info)) continue
    compiler.log(`${relative(root, join(root, info.promptDir, 'tsconfig.json'))} або .types/jsx/ відсутні — перша збірка`)
    await compiler.enqueue(info, 'full')
    wrote = true
  }
  // tsserver may have put open prompts into an inferred project before the tsconfig existed.
  if (wrote && vscode.workspace.textDocuments.some((d) => /\.prompt\.tsx$/.test(d.uri.fsPath))) await vscode.commands.executeCommand('typescript.restartTsServer')
}

export function activate(context: vscode.ExtensionContext): { compiler: Compiler; ready: Promise<void> } {
  extensionPath = context.extensionPath
  output = vscode.window.createOutputChannel('context-gate')
  compiler = new Compiler(output, (root) => cliFor(root))
  void configureTsPlugin()
  registerDslProviders(context)
  context.subscriptions.push(
    output, compiler,
    vscode.commands.registerCommand('contextGate.build', () => buildCommand(true)),
    vscode.commands.registerCommand('contextGate.buildFile', () => buildCommand(false)),
    vscode.commands.registerCommand('contextGate.health', healthCommand),
    vscode.commands.registerCommand('contextGate.showLog', () => output.show()),
    vscode.commands.registerCommand('contextGate.preview', previewCommand),
    vscode.commands.registerCommand('contextGate.quickVariant', quickVariantCommand),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') return
      const root = findRoot(doc.uri.fsPath)
      if (!root) return
      if (vscode.workspace.getConfiguration('contextGate').get<boolean>('buildOnSave') ?? true) void compiler.onSaved(doc.uri.fsPath, rootInfo(root))
      const p = PreviewPanel.current
      if (!p) return
      // Refresh on save of .claude/** (prompts, gate.json) or scripts/** of the same repo.
      const rel = relative(p.root, doc.uri.fsPath).split(/[\\/]/)
      if (rel[0] === '.claude' || rel[0] === 'scripts') void p.refresh(true)
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { void ensureEditorTypes(); void configureTsPlugin() }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('contextGate.cliPath')) void configureTsPlugin() }),
    vscode.languages.registerCodeActionsProvider({ pattern: '**/.claude/prompt/**/*.{tsx,md}' }, {
      provideCodeActions(document: vscode.TextDocument, range: vscode.Range) {
        const id = sectionIdAt(document.getText(), document.offsetAt(range.start), document.uri.fsPath)
        if (!id) return []
        const a = new vscode.CodeAction(`context-gate: згенерувати quick-варіант "${id}"`, vscode.CodeActionKind.RefactorRewrite)
        a.command = { command: 'contextGate.quickVariant', title: 'quick-варіант', arguments: [id] }
        const p = new vscode.CodeAction(`context-gate: preview "${id}"`, vscode.CodeActionKind.Empty)
        p.command = { command: 'contextGate.preview', title: 'preview' }
        return [a, p]
      },
    }),
  )
  const ready = ensureEditorTypes().catch((e: unknown) => compiler.log(`помилка першої збірки: ${(e as Error).message}`))
  return { compiler, ready }
}

export function deactivate(): void {}
