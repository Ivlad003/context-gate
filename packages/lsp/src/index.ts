// Entry of @context-gate/lsp. Built to dist/index.cjs (CommonJS, `module.exports = init`) for tsserver;
// the pure analysis is re-exported for other tools (VS Code client, browser editor, CLI build hook).

export { init as default, init, createPlugin, describeCode, type PluginConfig } from './plugin.ts'
export * from './analyze.ts'
export * from './exprcheck.ts'
export * from './model.ts'
export { findRoot, isPromptFile, loadModel, compiledDiagnosticsFor, promptIdOfFile, modelPaths } from './load.ts'
export * from './runcli.ts'
export * from './markdown.ts'
