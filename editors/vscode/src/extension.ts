// VS Code client of context-gate: a thin shell around the tsserver plugin (`@context-gate/lsp`,
// contributed via `typescriptServerPlugins`) and the CLI preview. All logic is in preview.ts.

import * as vscode from 'vscode'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import { buildRunArgs, cliArgv, previewOptions, renderPreviewHtml, runCli, sectionIdAt, type PreviewState, type RunView } from './preview.ts'

const PLUGIN = '@context-gate/lsp'

function findRoot(file: string): string | undefined {
  let dir = dirname(file)
  for (;;) {
    if (existsSync(join(dir, '.claude', 'gate.json')) || existsSync(join(dir, '.claude', 'prompt'))) return dir
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

function readConfig(root: string): { tiers?: Record<string, unknown>; profiles?: Record<string, unknown>; prompt?: { dir?: string } } | undefined {
  try { return JSON.parse(readFileSync(join(root, '.claude', 'gate.json'), 'utf8')) } catch { return undefined }
}

function fixtures(root: string): string[] {
  const out: string[] = []
  for (const d of ['fixtures', '.claude/prompt/fixtures']) {
    try { for (const f of readdirSync(join(root, d))) if (f.endsWith('.json')) out.push(`${d}/${f}`) } catch { /* none */ }
  }
  return out
}

function cliPath(): string[] {
  return cliArgv(vscode.workspace.getConfiguration('contextGate').get<string>('cliPath') ?? 'npx context-gate')
}

async function configureTsPlugin(): Promise<void> {
  const ext = vscode.extensions.getExtension('vscode.typescript-language-features')
  if (!ext) return
  await ext.activate()
  const api = (ext.exports as { getAPI?: (v: number) => { configurePlugin(id: string, cfg: unknown): void } } | undefined)?.getAPI?.(0)
  api?.configurePlugin(PLUGIN, { cliPath: cliPath() })
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
    const argv = [...cliPath(), ...buildRunArgs(this.state, { dryScripts })]
    this.view = await runCli(argv, this.root)
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
  const term = vscode.window.createTerminal({ name: 'context-gate expand', cwd: root })
  term.show()
  term.sendText([...cliPath(), 'expand', '--only', id].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' '))
}

export function activate(context: vscode.ExtensionContext): void {
  void configureTsPlugin()
  context.subscriptions.push(
    vscode.commands.registerCommand('contextGate.preview', previewCommand),
    vscode.commands.registerCommand('contextGate.quickVariant', quickVariantCommand),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const p = PreviewPanel.current
      if (!p) return
      // Refresh on save of .claude/** (prompts, gate.json) or scripts/** of the same repo.
      const rel = relative(p.root, doc.uri.fsPath).split(/[\\/]/)
      if (rel[0] === '.claude' || rel[0] === 'scripts') void p.refresh(true)
    }),
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
}

export function deactivate(): void {}
