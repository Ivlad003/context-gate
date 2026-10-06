// tsserver plugin of context-gate (SPEC "Редактор DSL та індекс автокомпліту" → LSP). Decorates the
// TypeScript language service for `*.prompt.tsx`: G* diagnostics of string expressions, completions and
// hover inside them, refactors "винести в Lazy" / "згенерувати quick-варіант", sections in the outline.
// All analysis lives in analyze.ts; this file only adapts it to the tsserver API.

import type TS from 'typescript'
import { spawnSync } from 'node:child_process'
import { analyzeFile, completeAt, hoverAt, hoverMarkdown, numericCode, refactorsAt, sectionSymbols, type FileDiag } from './analyze.ts'
import { LSP_CODES } from './exprcheck.ts'
import { compiledDiagnosticsFor, findRoot, isPromptFile, loadModel } from './load.ts'
import { codeInfo } from '../../core/src/codes.ts'
import { cliArgv } from './runcli.ts'

type TSModule = typeof TS

export interface PluginConfig {
  /** CLI command (`npx context-gate` by default), string or argv array. */
  cliPath?: string | string[]
  /** Turn the decorations off without uninstalling. */
  disabled?: boolean
}

const REFACTOR = 'context-gate'
const COMMAND_TYPE = 'context-gate.cli'

let globalConfig: PluginConfig = {}


function category(ts: TSModule, s: FileDiag['severity']): TS.DiagnosticCategory {
  return s === 'error' ? ts.DiagnosticCategory.Error : s === 'warning' ? ts.DiagnosticCategory.Warning : ts.DiagnosticCategory.Suggestion
}

function completionKind(ts: TSModule, k: string): TS.ScriptElementKind {
  switch (k) {
    case 'property': return ts.ScriptElementKind.memberVariableElement
    case 'function': return ts.ScriptElementKind.functionElement
    case 'filter': return ts.ScriptElementKind.functionElement
    case 'keyword': return ts.ScriptElementKind.keyword
    case 'value': return ts.ScriptElementKind.string
    default: return ts.ScriptElementKind.variableElement
  }
}

export function createPlugin(ts: TSModule, info: TS.server.PluginCreateInfo): TS.LanguageService {
  const ls = info.languageService
  const cfg = (): PluginConfig => ({ ...globalConfig, ...(info.config as PluginConfig | undefined) })
  const log = (m: string): void => { try { info.project.projectService.logger.info(`[context-gate] ${m}`) } catch { /* no logger */ } }
  const textOf = (fileName: string): string | undefined => {
    const snap = info.languageServiceHost.getScriptSnapshot(fileName)
    return snap ? snap.getText(0, snap.getLength()) : undefined
  }
  const ours = (fileName: string): { text: string; root: string } | undefined => {
    if (cfg().disabled || !isPromptFile(fileName)) return undefined
    const root = findRoot(fileName)
    const text = textOf(fileName)
    return root && text !== undefined ? { text, root } : undefined
  }
  const safe = <T>(what: string, f: () => T, fallback: () => T): T => {
    try { return f() } catch (e) { log(`${what}: ${(e as Error).stack ?? e}`); return fallback() }
  }

  const proxy: TS.LanguageService = Object.create(null)
  for (const k of Object.keys(ls) as (keyof TS.LanguageService)[]) {
    const x = ls[k] as unknown
    ;(proxy as unknown as Record<string, unknown>)[k] = typeof x === 'function' ? (...args: unknown[]) => (x as (...a: unknown[]) => unknown).apply(ls, args) : x
  }

  proxy.getSemanticDiagnostics = (fileName) => {
    const prior = ls.getSemanticDiagnostics(fileName)
    const o = ours(fileName)
    if (!o) return prior
    return safe('diagnostics', () => {
      const sf = ls.getProgram()?.getSourceFile(fileName)
      const { model } = loadModel(o.root)
      const diags = analyzeFile(ts, fileName, o.text, model, compiledDiagnosticsFor(o.root, fileName))
      return [...prior, ...diags.map((d): TS.Diagnostic => ({
        file: sf,
        start: d.start,
        length: d.length,
        category: category(ts, d.severity),
        code: numericCode(d.code),
        source: 'context-gate',
        messageText: `${d.code}: ${d.message}${d.hint ? ` — ${d.hint}` : ''}`,
      }))]
    }, () => prior)
  }

  proxy.getCompletionsAtPosition = (fileName, position, options, formatting) => {
    const o = ours(fileName)
    const prior = () => ls.getCompletionsAtPosition(fileName, position, options, formatting)
    if (!o) return prior()
    return safe('completions', () => {
      const r = completeAt(ts, fileName, o.text, position, loadModel(o.root).model)
      if (!r) return prior()
      const replacementSpan = { start: r.start, length: r.end - r.start }
      return {
        isGlobalCompletion: false,
        isMemberCompletion: false,
        isNewIdentifierLocation: false,
        entries: r.entries.map((e): TS.CompletionEntry => ({
          name: e.name,
          kind: completionKind(ts, e.kind),
          kindModifiers: '',
          sortText: e.sort ?? '1',
          insertText: e.insert ?? e.name,
          replacementSpan,
          ...(e.detail ? { labelDetails: { description: e.detail } } : {}),
        })),
      }
    }, prior)
  }

  proxy.getQuickInfoAtPosition = (fileName, position, ...rest) => {
    const o = ours(fileName)
    const prior = () => (ls.getQuickInfoAtPosition as (...a: unknown[]) => TS.QuickInfo | undefined)(fileName, position, ...rest)
    if (!o) return prior()
    return safe('hover', () => {
      const h = hoverAt(ts, fileName, o.text, position, loadModel(o.root).model)
      if (!h) return prior()
      return {
        kind: ts.ScriptElementKind.variableElement,
        kindModifiers: '',
        textSpan: { start: h.start, length: h.end - h.start },
        displayParts: [{ text: `${h.text}: ${h.type}`, kind: 'text' }],
        documentation: [{ text: hoverMarkdown(h).split('\n\n').slice(1).join('\n\n'), kind: 'markdown' }],
      }
    }, prior)
  }

  proxy.getApplicableRefactors = (fileName, positionOrRange, preferences, ...rest) => {
    const prior = (ls.getApplicableRefactors as (...a: unknown[]) => TS.ApplicableRefactorInfo[])(fileName, positionOrRange, preferences, ...rest)
    const o = ours(fileName)
    if (!o) return prior
    return safe('refactors', () => {
      const pos = typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.pos
      const rs = refactorsAt(ts, fileName, o.text, pos)
      if (!rs.length) return prior
      return [...prior, { name: REFACTOR, description: 'context-gate', actions: rs.map((r) => ({ name: r.name, description: r.title })) }]
    }, () => prior)
  }

  proxy.getEditsForRefactor = (fileName, formatOptions, positionOrRange, refactorName, actionName, preferences, ...rest) => {
    const prior = () => (ls.getEditsForRefactor as (...a: unknown[]) => TS.RefactorEditInfo | undefined)(fileName, formatOptions, positionOrRange, refactorName, actionName, preferences, ...rest)
    const o = ours(fileName)
    if (!o || refactorName !== REFACTOR) return prior()
    return safe<TS.RefactorEditInfo | undefined>('refactor edits', () => {
      const pos = typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.pos
      const r = refactorsAt(ts, fileName, o.text, pos).find((x) => x.name === actionName)
      if (!r) return undefined
      if (r.name === 'extract-lazy') return { edits: [{ fileName, textChanges: r.edits.map((e) => ({ span: { start: e.start, length: e.end - e.start }, newText: e.newText })) }] }
      return { edits: [], commands: [{ type: COMMAND_TYPE, root: o.root, argv: r.command } as TS.CodeActionCommand] }
    }, prior)
  }

  proxy.applyCodeActionCommand = ((action: unknown, ...rest: unknown[]) => {
    const one = Array.isArray(action) ? undefined : (action as { type?: string; root?: string; argv?: string[] })
    if (!one || one.type !== COMMAND_TYPE || !one.argv) return (ls.applyCodeActionCommand as (...a: unknown[]) => unknown)(action, ...rest)
    const [bin, ...args] = [...cliArgv(cfg().cliPath), ...one.argv.slice(1)]
    const r = spawnSync(bin!, args, { cwd: one.root, encoding: 'utf8', timeout: 120_000 })
    const ok = r.status === 0
    return Promise.resolve(ok ? { successMessage: `context-gate: ${one.argv.slice(1).join(' ')} — пропозицію записано в proposals/` } : { successMessage: `context-gate: помилка (${r.status ?? r.error?.message}): ${(r.stderr || r.stdout || '').slice(0, 500)}` })
  }) as TS.LanguageService['applyCodeActionCommand']

  proxy.getNavigationTree = (fileName) => {
    const tree = ls.getNavigationTree(fileName)
    const o = ours(fileName)
    if (!o) return tree
    return safe('outline', () => {
      const sections = sectionSymbols(ts, fileName, o.text)
      const items: TS.NavigationTree[] = sections.map((s) => ({
        text: `Section ${s.id}${s.scope ? ` (${s.scope})` : ''}`,
        kind: ts.ScriptElementKind.moduleElement,
        kindModifiers: '',
        spans: [{ start: s.start, length: s.end - s.start }],
        nameSpan: { start: s.idStart, length: s.idEnd - s.idStart },
      }))
      return { ...tree, childItems: [...items, ...(tree.childItems ?? [])] }
    }, () => tree)
  }

  log('plugin loaded')
  return proxy
}

/** tsserver entry: `require('@context-gate/lsp')({ typescript })`. */
export function init(mod: { typescript: TSModule }): TS.server.PluginModule {
  return {
    create: (info) => createPlugin(mod.typescript, info),
    onConfigurationChanged: (config: PluginConfig) => { globalConfig = { ...globalConfig, ...config } },
  }
}

/** Title + hint of a code for UIs (compiler table first, then editor-only codes). */
export function describeCode(code: string): string {
  const c = codeInfo(code) ?? LSP_CODES[code]
  return c ? `${code} — ${c.title}${c.hint ? `. ${c.hint}` : ''}` : code
}
