// Typed `ctx` for prompts. `ctx` is a reference object: property access builds an expression path
// (`ctx.git.branch` → `git.branch`, `ctx.ctx.percent` → `ctx.percent`) that is evaluated at render
// time, never at build time. Only property access and calls are captured — JS operators are not
// (SPEC Р1): write runtime conditions as strings or with the `e` tagged template.
//
// Types: `Ctx` = builtin defaults overridden by `CtxOverrides`, which `context-gate build` augments in
// `.claude/prompt/.types/ctx.d.ts` (profiles/tiers unions from gate.json, provider schemas).

import { EXPR, exprLiteral, isExprRef, ref } from './core.ts'

export interface RuleRef { id: string; name: string; description?: string; body: string; globs: string[]; cost: { chars: number } }
export interface GitCommit { hash: string; subject: string; author: string; date: string; type?: string; scope?: string }
export interface GitCtx { branch: string; head: string; dirty: boolean; ahead: number; behind: number; changed: string[]; log(n?: number): GitCommit[] }
export interface FileExample { path: string; body: string; chars: number }
export interface FsCtx { examples(glob: string, n?: number): FileExample[]; glob(pattern: string): string[]; exists(path: string): boolean }
export interface CursorCtx { always: RuleRef[]; auto: RuleRef[]; agent: RuleRef[]; manual: RuleRef[]; match(path: string): RuleRef[] }
export interface SessionCtx { id: string; model: string; cwd: string; root: string; turn: number; agentId?: string }
export interface CtxWindowCtx { percent: number; tokens: number; limit: number }
export interface GateCtx<P extends string = string, T extends string = string> {
  profile: P | undefined
  tier: T
  groups: string[]
  off: boolean
  skills: { on: string[]; nameOnly: string[]; off: string[]; preload: string[] }
}
export interface BudgetsCtx { soft: number; hard: number }

export interface DefaultCtx {
  gate: GateCtx
  git: GitCtx
  fs: FsCtx
  cursor: CursorCtx
  session: SessionCtx
  /** Context window usage. */
  ctx: CtxWindowCtx
  budgets: BudgetsCtx
  args: Record<string, any>
  data: Record<string, any>
}

/** Augmented by the generated `.types/ctx.d.ts` (`declare module '@context-gate/jsx' { interface CtxOverrides {...} }`). */
export interface CtxOverrides {}

export type Ctx = Omit<DefaultCtx, keyof CtxOverrides> & CtxOverrides

/** Root expression reference, typed by `Ctx`. */
export const ctx: Ctx = ref('')

/**
 * Expression tagged template: e`${ctx.ctx.percent} > ${50}` → `"ctx.percent > 50"`.
 * References give their path, strings become quoted literals, numbers/booleans stay as is.
 */
export function e(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? ''
  values.forEach((v, i) => {
    out += isExprRef(v) ? v[EXPR] : exprLiteral(v)
    out += strings[i + 1] ?? ''
  })
  return out.trim()
}

/** Alias of `e`. */
export const expr = e
