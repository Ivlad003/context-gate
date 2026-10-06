// @context-gate/jsx: typed TSX components that build the context-gate prompt AST at build time.

export * from './components.ts'
export { arg, type ArgOptions } from './args.ts'
export { ctx, e, expr, type Ctx, type CtxOverrides, type DefaultCtx, type GateCtx, type GitCtx, type GitCommit, type FsCtx, type FileExample, type CursorCtx, type RuleRef, type SessionCtx, type CtxWindowCtx, type BudgetsCtx } from './ctx.ts'
export { jsx, jsxs, h, Fragment, ref, isExprRef, exprOf, takeDiagnostics, normalize, INTRINSIC_TAGS, EXPR, type Child, type JsxValue, type ExprRef, type Marker, type PromptMarker, type SectionMarker, type Component, type IntrinsicTag } from './core.ts'
export { compilePrompt, walkNodes, type CompiledPart, type CompileOptions } from './compile.ts'
export type { JSX } from './jsx-runtime.ts'
