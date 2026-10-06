// Markdown DSL (`.claude/prompt/**/*.md`) and Cursor `.mdc` providers. The analysis is the one the tsserver
// plugin and the browser editor use (packages/lsp markdown.ts over the Ctx model of the repo); this file only
// maps offsets and kinds onto the VS Code API.

import * as vscode from 'vscode'
import { relative } from 'node:path'
import { analyzeMarkdown, completeMarkdown, hoverMarkdownAt } from '../../../packages/lsp/src/markdown.ts'
import { findRoot, loadModel, toPosix } from '../../../packages/lsp/src/load.ts'
import type { ExprCompletion } from '../../../packages/lsp/src/exprcheck.ts'
import { DIRECTIVES, directiveAt, directiveDoc, directivePrefixAt, frontmatterLines, markdownSymbols, mdcDiagnostics, mdcHover, tierListAt, type MdSymbol } from './dsl-core.ts'

const MD_PROMPT = /[\\/]\.claude[\\/]prompt[\\/](?!\.(compiled|trace|types)[\\/]).*\.md$/
const MDC_RULE = /\.mdc$/

export const isMarkdownPrompt = (doc: vscode.TextDocument): boolean => doc.uri.scheme === 'file' && MD_PROMPT.test(doc.uri.fsPath)
export const isMdcRule = (doc: vscode.TextDocument): boolean => doc.uri.scheme === 'file' && MDC_RULE.test(doc.uri.fsPath)

function kindOf(k: ExprCompletion['kind']): vscode.CompletionItemKind {
  switch (k) {
    case 'property': return vscode.CompletionItemKind.Field
    case 'function': return vscode.CompletionItemKind.Function
    case 'filter': return vscode.CompletionItemKind.Method
    case 'keyword': return vscode.CompletionItemKind.Keyword
    case 'value': return vscode.CompletionItemKind.Value
    default: return vscode.CompletionItemKind.Variable
  }
}

function severity(s: string): vscode.DiagnosticSeverity {
  return s === 'error' ? vscode.DiagnosticSeverity.Error : s === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information
}

function symbolKind(k: MdSymbol['kind']): vscode.SymbolKind {
  return k === 'section' ? vscode.SymbolKind.Module : k === 'function' ? vscode.SymbolKind.Function : k === 'variable' ? vscode.SymbolKind.Variable : vscode.SymbolKind.Namespace
}

function toSymbol(doc: vscode.TextDocument, s: MdSymbol): vscode.DocumentSymbol {
  const end = Math.min(s.endLine, doc.lineCount - 1)
  const range = new vscode.Range(s.line, 0, end, doc.lineAt(end).text.length)
  const sel = new vscode.Range(s.line, 0, s.line, doc.lineAt(s.line).text.length)
  const out = new vscode.DocumentSymbol(s.name, s.detail, symbolKind(s.kind), range, sel)
  out.children = s.children.map((c) => toSymbol(doc, c))
  return out
}

export function registerDslProviders(context: vscode.ExtensionContext): void {
  const mdDiags = vscode.languages.createDiagnosticCollection('context-gate-md')
  const mdcDiags = vscode.languages.createDiagnosticCollection('context-gate-mdc')
  const timers = new Map<string, NodeJS.Timeout>()

  const refresh = (doc: vscode.TextDocument): void => {
    if (isMarkdownPrompt(doc)) {
      const root = findRoot(doc.uri.fsPath)
      if (!root) return
      const text = doc.getText()
      const rel = toPosix(relative(root, doc.uri.fsPath))
      const ds = analyzeMarkdown(text, rel, loadModel(root).model).map((d) => {
        const v = new vscode.Diagnostic(new vscode.Range(doc.positionAt(d.start), doc.positionAt(d.start + d.length)), `${d.message}${d.hint ? ` — ${d.hint}` : ''}`, severity(d.severity))
        v.code = d.code
        v.source = 'context-gate'
        return v
      })
      mdDiags.set(doc.uri, ds)
    } else if (isMdcRule(doc)) {
      const root = findRoot(doc.uri.fsPath) ?? vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath
      const rel = root ? toPosix(relative(root, doc.uri.fsPath)) : doc.uri.fsPath
      mdcDiags.set(doc.uri, mdcDiagnostics(doc.getText(), rel).map((d) => {
        const line = Math.min(Math.max(1, d.line ?? 1), doc.lineCount) - 1
        const v = new vscode.Diagnostic(doc.lineAt(line).range, `${d.message}${d.hint ? ` — ${d.hint}` : ''}`, severity(d.severity))
        v.code = d.code
        v.source = 'context-gate'
        return v
      }))
    }
  }
  const later = (doc: vscode.TextDocument): void => {
    const k = doc.uri.toString()
    clearTimeout(timers.get(k))
    timers.set(k, setTimeout(() => { timers.delete(k); refresh(doc) }, 250))
  }

  const mdSelector: vscode.DocumentSelector = [{ scheme: 'file', pattern: '**/.claude/prompt/**/*.md' }]
  context.subscriptions.push(
    mdDiags, mdcDiags,
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => later(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => { mdDiags.delete(d.uri); mdcDiags.delete(d.uri) }),
    // Model inputs (gate.json, index, ctx.d.ts, trace) changed → recheck open Markdown sections.
    vscode.workspace.onDidSaveTextDocument((d) => { if (/gate(\.index)?\.json$|\.d\.ts$/.test(d.uri.fsPath)) for (const doc of vscode.workspace.textDocuments) if (isMarkdownPrompt(doc)) refresh(doc) }),

    vscode.languages.registerCompletionItemProvider(mdSelector, {
      provideCompletionItems(doc, pos) {
        if (!isMarkdownPrompt(doc)) return undefined
        const fm = frontmatterLines(doc.getText())
        if (fm && pos.line <= fm[1]) return undefined
        const line = doc.lineAt(pos.line).text
        const dp = directivePrefixAt(line, pos.character)
        if (dp) {
          const range = new vscode.Range(pos.line, dp.start, pos.line, pos.character)
          return DIRECTIVES.map((d) => {
            const it = new vscode.CompletionItem(d.name, vscode.CompletionItemKind.Keyword)
            it.insertText = new vscode.SnippetString(d.snippet)
            it.range = range
            it.detail = `@${d.name}`
            it.documentation = new vscode.MarkdownString(d.doc)
            return it
          })
        }
        const root = findRoot(doc.uri.fsPath)
        if (!root) return undefined
        const model = loadModel(root).model
        if (tierListAt(line, pos.character)) return model.tiers.map((t) => new vscode.CompletionItem(t, vscode.CompletionItemKind.EnumMember))
        const r = completeMarkdown(doc.getText(), doc.offsetAt(pos), model)
        if (!r) return undefined
        const range = new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end))
        return r.entries.map((e) => {
          const it = new vscode.CompletionItem(e.name, kindOf(e.kind))
          it.insertText = e.insert ?? e.name
          it.range = range
          if (e.detail) it.detail = e.detail
          if (e.sort) it.sortText = e.sort
          return it
        })
      },
    }, '@', '.', '|', '"', ' ', '{'),

    vscode.languages.registerHoverProvider(mdSelector, {
      provideHover(doc, pos) {
        if (!isMarkdownPrompt(doc)) return undefined
        const line = doc.lineAt(pos.line).text
        const d = directiveAt(line, pos.character)
        const dd = d && directiveDoc(d.name)
        if (d && dd) return new vscode.Hover(new vscode.MarkdownString(`**@${dd.name}** — ${dd.doc}`), new vscode.Range(pos.line, d.start, pos.line, d.end))
        const root = findRoot(doc.uri.fsPath)
        if (!root) return undefined
        const h = hoverMarkdownAt(doc.getText(), doc.offsetAt(pos), loadModel(root).model)
        if (!h) return undefined
        const md = new vscode.MarkdownString()
        md.appendCodeblock(`${h.text}: ${h.type}`, 'typescript')
        if (h.doc) md.appendMarkdown('\n' + h.doc)
        if (h.value !== undefined) md.appendMarkdown(`\n\nостаннє значення: \`${String(h.value).slice(0, 200)}\``)
        return new vscode.Hover(md, new vscode.Range(doc.positionAt(h.start), doc.positionAt(h.end)))
      },
    }),

    vscode.languages.registerDocumentSymbolProvider(mdSelector, {
      provideDocumentSymbols(doc) {
        return isMarkdownPrompt(doc) ? markdownSymbols(doc.getText(), doc.uri.fsPath).map((s) => toSymbol(doc, s)) : []
      },
    }, { label: 'context-gate' }),

    vscode.languages.registerHoverProvider([{ scheme: 'file', pattern: '**/*.mdc' }], {
      provideHover(doc, pos) {
        const fm = frontmatterLines(doc.getText())
        if (fm && pos.line > fm[1]) return undefined
        const root = findRoot(doc.uri.fsPath) ?? vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath
        return new vscode.Hover(new vscode.MarkdownString(mdcHover(doc.getText(), root ? toPosix(relative(root, doc.uri.fsPath)) : doc.uri.fsPath)))
      },
    }),
  )
  for (const doc of vscode.workspace.textDocuments) refresh(doc)
}
