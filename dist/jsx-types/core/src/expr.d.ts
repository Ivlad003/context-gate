import type { Diagnostic, Scope_, Value } from './types.ts';
export type BinOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '~' | 'in' | '&&' | '||' | '??';
export type TemplatePart = string | ExprAst;
export type ExprAst = {
    k: 'lit';
    v: Value;
} | {
    k: 'list';
    items: ExprAst[];
} | {
    k: 'id';
    name: string;
} | {
    k: 'member';
    obj: ExprAst;
    prop: string;
    optional?: boolean;
} | {
    k: 'index';
    obj: ExprAst;
    index: ExprAst;
} | {
    k: 'unary';
    op: '!' | '-';
    arg: ExprAst;
} | {
    k: 'bin';
    op: BinOp;
    l: ExprAst;
    r: ExprAst;
} | {
    k: 'cond';
    test: ExprAst;
    then: ExprAst;
    else: ExprAst;
}
/** Builtin function: len min max abs round floor ceil. */
 | {
    k: 'builtin';
    fn: string;
    args: ExprAst[];
}
/** Value method: `.at(i)`, `.in(list)`. */
 | {
    k: 'method';
    obj: ExprAst;
    fn: 'at' | 'in';
    args: ExprAst[];
}
/** Provider / module function call `ns.fn(args, k=v)`, resolved by the host. */
 | {
    k: 'call';
    path: string;
    args: ExprAst[];
    kwargs: Record<string, ExprAst>;
}
/** `input | filter(args)`; `tpl` is the pre-parsed template of `map("…{{ item.x }}…")`. */
 | {
    k: 'pipe';
    input: ExprAst;
    filter: string;
    args: ExprAst[];
    tpl?: TemplatePart[];
};
export declare const BUILTINS: readonly ["len", "min", "max", "abs", "round", "floor", "ceil"];
export declare const FILTERS: readonly ["take", "sort", "grep", "map", "join", "truncate", "fence", "unique", "where", "len", "round", "ago"];
/** Parse one expression string. Never throws; errors come back as G1xx diagnostics with `ast` undefined. */
export declare function parseExpr(src: string): {
    ast?: ExprAst;
    diagnostics: Diagnostic[];
};
/**
 * Index of the `}}` closing the placeholder whose content starts at `from`, or -1. String literals
 * (`"…"`, `'…'`, with `\\` escapes) are skipped and nested `{{ … }}` outside strings are balanced, so a template
 * argument such as `map("{{ item.from }} → {{ item.to }}")` stays inside the outer placeholder.
 */
export declare function templateClose(src: string, from: number): number;
/** Split `text {{ expr }} text` into literal and expression source parts (no parsing). */
export declare function splitTemplate(src: string): ({
    text: string;
} | {
    expr: string;
})[];
/** Parse a `{{ }}` template into literal strings and expression ASTs. */
export declare function parseTemplate(src: string): {
    parts: TemplatePart[];
    diagnostics: Diagnostic[];
};
export interface Budget {
    steps: number;
    limit: number;
}
export declare const DEFAULT_STEP_LIMIT = 10000;
export declare function newBudget(limit?: number): Budget;
/** Thrown internally when the step budget is exhausted; the renderer turns it into G155. */
export declare class StepLimitError extends Error {
    constructor(limit: number);
}
/**
 * A value or string past the size limits (`MAX_VALUE_CELLS`, `MAX_STRING_LENGTH`, `MAX_VALUE_DEPTH`). A StepLimitError,
 * so every host that already turns the step limit into G155 stops the section instead of hanging or hitting a RangeError.
 */
export declare class ValueLimitError extends StepLimitError {
    constructor(what: string);
}
export interface EvalEnv {
    /** Resolver for `ns.fn(...)` calls. Absent → G157. Returns null while a value is not ready. */
    call?: (path: string, args: Value[], kwargs: Record<string, Value>) => Value;
    diagnostics?: Diagnostic[];
    /** Current time (ms) for `ago`. */
    now?: number;
}
export declare const isObj: (v: Value | undefined) => v is {
    [k: string]: Value;
};
/** Cells of the largest value an expression may build (1 per scalar, list, object and key; strings per 64 chars). */
export declare const MAX_VALUE_CELLS: number;
/** Longest string an expression may build; V8's own limit (~2^29) throws a RangeError far above it. */
export declare const MAX_STRING_LENGTH: number;
/** Deepest value an expression may build or walk: deeper values would overflow the walkers' recursion. */
export declare const MAX_VALUE_DEPTH = 256;
/** Cells of a value (see MAX_VALUE_CELLS); Infinity when it is deeper than MAX_VALUE_DEPTH. */
export declare function valueCells(v: Value): number;
/**
 * Charge the budget for walking `v` (serializing, hashing, comparing it): one step per CELLS_PER_STEP cells.
 * Hosts call it before `toText`/`JSON.stringify` of a value an expression produced. Too deep → ValueLimitError.
 */
export declare function chargeValue(budget: Budget, v: Value): void;
export declare function truthy(v: Value): boolean;
/** Text form of a value inside the prompt. */
export declare function toText(v: Value | undefined): string;
/** Structural equality. With a budget, comparing two composites is charged by their cells (see chargeValue). */
export declare function deepEqual(a: Value, b: Value, budget?: Budget): boolean;
/** Dotted path lookup on a value (`cost.chars`); '' → the value itself. */
export declare function getPath(v: Value, path: string): Value;
/** Variable lookup along the frame chain (frames are prototype-linked objects); never reaches Object.prototype. */
export declare function lookup(scope: Scope_, name: string): Value;
/**
 * Linear-time `RegExp#test` (no flags) for hosts that match user patterns outside expressions: null when the pattern
 * is invalid or unsupported (G107 in `env.diagnostics`); the scan is charged to `budget`.
 */
export declare function regexTest(pattern: string, subject: string, budget?: Budget, env?: EvalEnv): boolean | null;
/** Markdown code fence around `body`: one backtick longer than the longest backtick run inside (CommonMark). */
export declare function fenceText(body: string, lang?: string): string;
/** Render a parsed template to text in `scope`. Output and value walks are charged; past MAX_STRING_LENGTH → G155. */
export declare function renderTemplate(parts: TemplatePart[], scope: Scope_, budget: Budget, env?: EvalEnv): string;
/** Evaluate an expression AST. Total: every step counts against `budget` (StepLimitError past the limit). */
export declare function evalExpr(ast: ExprAst, scope: Scope_, budget: Budget, env?: EvalEnv): Value;
/** Parse and evaluate in one go; parse diagnostics are appended to env.diagnostics. */
export declare function evalSource(src: string, scope: Scope_, budget: Budget, env?: EvalEnv): Value;
/** Root identifiers an expression reads (sorted, unique). `item` inside map templates is bound, not free. */
export declare function freeVars(ast: ExprAst): string[];
/** Provider/module function paths an expression calls (`util.next_version`). */
export declare function callPaths(ast: ExprAst): string[];
/** Keys of `data.*` an expression reads (`data.api-endpoints.count` → `api-endpoints`). */
export declare function dataKeys(ast: ExprAst): string[];
/** True when the expression is a compile-time constant (no identifiers, no calls). */
export declare function isStatic(ast: ExprAst): boolean;
