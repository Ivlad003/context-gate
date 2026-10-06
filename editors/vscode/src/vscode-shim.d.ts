// Minimal typings of the `vscode` API used by extension.ts, so the extension type-checks without the
// `@types/vscode` package (`npx tsc -p editors/vscode`). Install @types/vscode for full typings.

declare module 'vscode' {
  export interface Disposable { dispose(): void }
  export interface ExtensionContext { subscriptions: Disposable[] }
  export class Uri { readonly fsPath: string }
  export class Position { constructor(line: number, character: number) }
  export class Range { constructor(start: Position, end: Position); readonly start: Position; readonly end: Position }
  export class Selection extends Range { constructor(anchor: Position, active: Position); readonly anchor: Position; readonly active: Position }
  export interface TextDocument { uri: Uri; getText(): string; offsetAt(p: Position): number }
  export interface TextEditor { document: TextDocument; selection: Selection; revealRange(r: Range, t?: TextEditorRevealType): void }
  export enum TextEditorRevealType { Default = 0, InCenter = 1 }
  export enum ViewColumn { Active = -1, Beside = -2, One = 1 }
  export interface Webview { html: string; readonly cspSource: string; onDidReceiveMessage(cb: (m: any) => unknown): Disposable; postMessage(m: unknown): Thenable<boolean> }
  export interface WebviewPanel { webview: Webview; title: string; reveal(col?: ViewColumn, preserveFocus?: boolean): void; onDidDispose(cb: () => void): Disposable; dispose(): void }
  export interface Terminal { show(): void; sendText(text: string): void }
  export interface Command { command: string; title: string; arguments?: unknown[] }
  export class CodeActionKind { static readonly Empty: CodeActionKind; static readonly RefactorRewrite: CodeActionKind }
  export class CodeAction { constructor(title: string, kind?: CodeActionKind); command?: Command }
  export interface WorkspaceConfiguration { get<T>(key: string): T | undefined }
  export interface ConfigurationChangeEvent { affectsConfiguration(section: string): boolean }
  export interface Extension<T> { exports: T; activate(): Thenable<T> }
  export interface DocumentFilter { pattern?: string; language?: string }
  export namespace window {
    const activeTextEditor: TextEditor | undefined
    function showInformationMessage(msg: string, ...items: string[]): Thenable<string | undefined>
    function showWarningMessage(msg: string, options: { modal?: boolean }, ...items: string[]): Thenable<string | undefined>
    function showWarningMessage(msg: string, ...items: string[]): Thenable<string | undefined>
    function showInputBox(o: { prompt?: string }): Thenable<string | undefined>
    function showTextDocument(uri: Uri, o?: { viewColumn?: ViewColumn; preserveFocus?: boolean }): Thenable<TextEditor>
    function createWebviewPanel(type: string, title: string, col: ViewColumn, o: { enableScripts?: boolean; retainContextWhenHidden?: boolean }): WebviewPanel
    function createTerminal(o: { name?: string; cwd?: string }): Terminal
  }
  export namespace workspace {
    function getConfiguration(section?: string): WorkspaceConfiguration
    function onDidSaveTextDocument(cb: (d: TextDocument) => unknown): Disposable
    function onDidChangeConfiguration(cb: (e: ConfigurationChangeEvent) => unknown): Disposable
  }
  export namespace commands {
    function registerCommand(id: string, cb: (...args: any[]) => unknown): Disposable
  }
  export namespace extensions {
    function getExtension<T = unknown>(id: string): Extension<T> | undefined
  }
  export namespace languages {
    function registerCodeActionsProvider(selector: DocumentFilter, provider: { provideCodeActions(d: TextDocument, r: Range): CodeAction[] | undefined }): Disposable
  }
}
