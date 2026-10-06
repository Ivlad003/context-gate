// The compiler in VS Code: `context-gate build --json [--only …]` on save, its diagnostics in the Problems panel
// (DiagnosticCollection "context-gate"), a status bar item and the "context-gate" output channel with the log.
// Decisions (what to build, where diagnostics go) are pure functions in compiler-core.ts.

import * as vscode from 'vscode'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Diagnostic } from '../../../packages/core/src/types.ts'
import { buildTargetFor, diagnosticsByFile, filesOfPrompts, lineRange, parseBuildJson, readLock, statusText, type CliCommand, type StatusState } from './compiler-core.ts'

export interface RootInfo { root: string; promptDir: string }

export type Target = 'full' | { only: string[] }

export interface ExecResult { code: number; stdout: string; stderr: string; ms: number }

export function execCli(cmd: CliCommand, args: string[], cwd: string, timeoutMs = 120_000): Promise<ExecResult> {
  const [bin, ...pre] = cmd.argv
  const t0 = Date.now()
  return new Promise((done) => {
    execFile(bin!, [...pre, ...args], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, ...cmd.env }, shell: process.platform === 'win32' && cmd.source !== 'bundled' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
      done({ code, stdout: stdout ?? '', stderr: (stderr ?? '') + (err && code === -1 ? `\n${err.message}` : ''), ms: Date.now() - t0 })
    })
  })
}

function severity(s: Diagnostic['severity']): vscode.DiagnosticSeverity {
  return s === 'error' ? vscode.DiagnosticSeverity.Error : s === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information
}

function textOf(file: string): string | undefined {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)
  if (open) return open.getText()
  try { return readFileSync(file, 'utf8') } catch { return undefined }
}

export function toVsDiagnostic(d: Diagnostic, text: string | undefined): vscode.Diagnostic {
  const [line, a, b] = lineRange(text, d.line)
  const v = new vscode.Diagnostic(new vscode.Range(line, a, line, b), `${d.message}${d.hint ? ` — ${d.hint}` : ''}`, severity(d.severity))
  v.code = d.code
  v.source = 'context-gate'
  return v
}

export class Compiler implements vscode.Disposable {
  readonly diagnostics = vscode.languages.createDiagnosticCollection('context-gate')
  readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20)
  state: StatusState = { kind: 'idle' }
  lastBuild: { root: string; target: Target; ok: boolean; ms: number; codes: string[]; cli: CliCommand['source']; error?: string } | undefined
  private running = new Map<string, Promise<void>>()
  private pending = new Map<string, { target: Target; file?: string }>()
  private listeners: (() => void)[] = []

  readonly output: vscode.OutputChannel
  readonly cli: (root: string) => CliCommand

  constructor(output: vscode.OutputChannel, cli: (root: string) => CliCommand) {
    this.output = output
    this.cli = cli
    this.status.command = 'contextGate.showLog'
    this.status.tooltip = 'context-gate: журнал збірки'
    this.setState({ kind: 'idle' })
  }

  dispose(): void { this.diagnostics.dispose(); this.status.dispose() }

  /** Resolves after the next build of any root finishes (tests, commands). */
  onIdle(): Promise<void> { return new Promise((r) => this.listeners.push(r)) }

  setState(s: StatusState): void {
    this.state = s
    this.status.text = statusText(s)
    this.status.show()
  }

  log(line: string): void { this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`) }

  /** Build on save: decide the target from the saved file; nothing for files the build doesn't read. */
  onSaved(file: string, info: RootInfo): Promise<void> | undefined {
    const target = buildTargetFor(file, info.root, info.promptDir, readLock(info.root, info.promptDir))
    return target ? this.enqueue(info, target, file) : undefined
  }

  /** Queues a build per root; while one runs, further requests merge into one follow-up build. */
  enqueue(info: RootInfo, target: Target, file?: string): Promise<void> {
    const cur = this.running.get(info.root)
    if (cur) {
      const p = this.pending.get(info.root)
      const merged: Target = p?.target === 'full' || target === 'full' ? 'full' : { only: [...new Set([...(p?.target as { only: string[] } | undefined)?.only ?? [], ...target.only])] }
      this.pending.set(info.root, { target: merged, ...(file ? { file } : {}) })
      return cur.then(() => this.running.get(info.root))
    }
    const run = this.build(info, target, file).finally(() => {
      this.running.delete(info.root)
      const next = this.pending.get(info.root)
      if (next) { this.pending.delete(info.root); void this.enqueue(info, next.target, next.file) }
      else { const ls = this.listeners.splice(0); for (const l of ls) l() }
    })
    this.running.set(info.root, run)
    return run
  }

  private async build(info: RootInfo, target: Target, file?: string): Promise<void> {
    if (!vscode.workspace.isTrusted) { this.log('збірку пропущено: workspace не довірений'); return }
    const { root, promptDir } = info
    const cmd = this.cli(root)
    const args = ['build', '--json', ...(target === 'full' ? [] : ['--only', target.only.join(',')])]
    this.setState({ kind: 'building' })
    this.log(`${cmd.argv.join(' ')} ${args.join(' ')}  (cwd ${root}, CLI: ${cmd.source})`)
    const lockBefore = readLock(root, promptDir)
    const r = await execCli(cmd, args, root)
    if (r.stderr.trim()) this.output.appendLine(r.stderr.trimEnd())
    const parsed = parseBuildJson(r.stdout)
    if ('error' in parsed) {
      this.log(`${parsed.error} (код ${r.code})\n${r.stdout.slice(0, 4000)}`)
      this.setState({ kind: 'failed', message: parsed.error })
      this.lastBuild = { root, target, ok: false, ms: r.ms, codes: [], cli: cmd.source, error: parsed.error }
      return
    }
    const fallback = file ?? join(root, '.claude', 'gate.json')
    if (target === 'full') {
      // Only this root's files: other roots keep theirs.
      this.diagnostics.forEach((uri) => { if (uri.fsPath.startsWith(root)) this.diagnostics.delete(uri) })
    } else {
      const lockAfter = readLock(root, promptDir)
      for (const f of new Set([fallback, ...filesOfPrompts(root, lockBefore, target.only), ...filesOfPrompts(root, lockAfter, target.only), ...target.only.map((o) => join(root, o))])) this.diagnostics.delete(vscode.Uri.file(f))
    }
    for (const [f, ds] of diagnosticsByFile(parsed.diagnostics, root, fallback)) {
      const text = textOf(f)
      const uri = vscode.Uri.file(f)
      this.diagnostics.set(uri, [...(this.diagnostics.get(uri) ?? []), ...ds.map((d) => toVsDiagnostic(d, text))])
    }
    for (const d of parsed.diagnostics) this.output.appendLine(`  ${d.severity} ${d.code}${d.path ? ` ${d.path}${d.line ? ':' + d.line : ''}` : ''} ${d.message}`)
    this.log(`${parsed.ok ? 'зібрано' : 'помилки збірки'}: ${parsed.compiled.join(', ') || '—'} за ${parsed.ms ?? r.ms} мс${parsed.written.length ? `; записано ${parsed.written.join(', ')}` : ''}`)
    let errors = 0
    let warnings = 0
    this.diagnostics.forEach((_u, ds) => { for (const d of ds) { if (d.severity === vscode.DiagnosticSeverity.Error) errors++; else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++ } })
    this.setState({ kind: 'done', errors, warnings })
    this.lastBuild = { root, target, ok: parsed.ok, ms: r.ms, codes: parsed.diagnostics.map((d) => d.code), cli: cmd.source }
  }
}

/** Whether the editor typings (`tsconfig.json`, `.types/jsx/`) still have to be written by a build. */
export function needsEditorTypes(info: RootInfo): boolean {
  const dir = join(info.root, info.promptDir)
  return existsSync(dir) && (!existsSync(join(dir, 'tsconfig.json')) || !existsSync(join(dir, '.types', 'jsx', 'jsx', 'src', 'index.d.ts')))
}
