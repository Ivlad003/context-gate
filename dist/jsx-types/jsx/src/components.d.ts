import type { ArgSpec, IncludeMode, Node, Scope, Tier as TierName } from '../../core/src/types.ts';
import { type Child, type ExprRef, type JsxValue, type PromptMarker, type SectionMarker, type ElseMarker } from './core.ts';
/** A runtime expression: a string in the expression language, or a `ctx`/`Each` reference. */
export type Expr = string | ExprRef;
/**
 * A runtime condition. Level 1: an `Expr`. Level 2 (`prompt.transform: "level2"` or `// @context-gate level2`):
 * also a native TS boolean expression over `ctx` (`ctx.ctx.percent > ctx.budgets.soft`), rewritten at build.
 */
export type Cond = Expr | boolean;
type WithChildren = {
    children?: Child;
};
export interface PromptProps extends WithChildren {
    /** `skill`: the prompt is a skill rendered at invocation time with parsed `args`. */
    as?: 'skill';
    /** Prompt id (default: file name without `.prompt.tsx`); for skills the `name`. */
    id?: string;
    name?: string;
    description?: string;
    args?: Record<string, ArgSpec>;
    /** Default `{ user: true, model: 'skill' }`. */
    invoke?: {
        user?: boolean;
        model?: 'tool' | 'skill' | false;
    };
    tiers?: TierName[];
}
export declare const Prompt: (props: PromptProps) => PromptMarker;
export interface SectionProps extends WithChildren {
    id: string;
    scope: Scope;
    /** Section is present only when the expression is true. */
    when?: Cond;
    /** Max characters; overflow is truncated with a marker. */
    budget?: number;
    /** Insert after this section id (within the scope). */
    after?: string;
    /** Shorthand for `<Tier>` around the whole section. */
    tier?: TierName | TierName[];
}
export declare const Section: (props: SectionProps) => SectionMarker;
export interface IfProps extends WithChildren {
    test: Cond;
}
export declare const If: (props: IfProps) => Node;
export declare const Else: (props: WithChildren) => ElseMarker;
export type EachChild = Child | ((item: any, index: any) => Child);
export interface EachProps {
    /** List expression (`"cursor.always"`), a reference, or a build-time array (unrolled at build time). */
    of: Expr | readonly unknown[];
    /** Item variable name; default: the function child's parameter name, else `it`. */
    as?: string;
    index?: string;
    children?: EachChild;
}
export declare const Each: (props: EachProps) => JsxValue;
export declare const Let: (props: {
    name: string;
    value: Expr | number | boolean | object | null;
}) => Node;
export declare const Set: (props: {
    name: string;
    value: Expr | number | boolean | object | null;
}) => Node;
/** Persist a section variable to `data.<name>`. */
/** `<Store name="api" />` persists `api` to `data.api`; `to="api-endpoints"` picks another data key. After a
 * `Run`/`Call` it keeps that result's `fetchedAt` and `cache` (the renderer carries the metadata). */
export declare const Store: (props: {
    name: string;
    to?: string;
}) => Node;
export declare const Repeat: (props: {
    n: Expr | number;
    children?: Child;
}) => Node;
export declare const Break: () => Node;
export declare const Continue: () => Node;
export interface RunProps {
    lang: string;
    /** Duration (`5m`). Required inside `static` sections (build error G163). */
    cache?: string;
    as?: string;
    store?: string;
    needs?: string[];
    /** Code. Use a template literal when it contains `{`/`}`: `{\`...\`}`. */
    children?: Child;
}
export declare const Run: (props: RunProps) => Node;
/** Bind a script module to a namespace (`gitx` → `scripts/git-extra.js`). */
export declare const Use: (props: {
    name: string;
    path: string;
}) => Node;
export interface CallProps {
    /** `ns.fn`, namespace bound by `<Use>`. */
    fn: string;
    args?: (Expr | number)[];
    kwargs?: Record<string, Expr | number>;
    as?: string;
    cache?: string;
    store?: string;
}
export declare const Call: (props: CallProps) => Node;
export interface IncludeProps {
    /** Repo file (repo-relative). */
    path?: string;
    /** Literal text (e.g. an imported `.md`). */
    text?: string | {
        text: string;
    };
    /** Another section id (`prompt://<id>`). */
    section?: string;
    mode?: IncludeMode;
    budget?: number;
    description?: string;
}
export declare const Include: (props: IncludeProps) => Node;
export declare const Skill: (props: {
    name: string;
    mode?: IncludeMode;
    budget?: number;
}) => Node;
export declare const Rule: (props: {
    id: string;
    mode?: IncludeMode;
    budget?: number;
}) => Node;
export interface McpProps {
    server: string;
    tool: string;
    /** Literals (`'open'`, `3`, `true`) or expressions (`'{{ args.pr }}'`, a `ctx` reference). */
    args?: Record<string, unknown>;
    /** Variable for the result (data, not text). Default `<tool>`. */
    as?: string;
    mode?: IncludeMode;
}
export declare const Mcp: (props: McpProps) => Node;
/** Legacy: `<Lazy name path>description</Lazy>` → `include mode=lazy` + G180 (SPEC Р5). */
export declare const Lazy: (props: {
    name: string;
    path: string;
    children?: Child;
}) => Node;
/** Variant for model tiers. Without `is`: every tier except premium. */
export declare const Tier: (props: {
    is?: TierName | TierName[] | "non-premium";
    children?: Child;
}) => Node;
export declare const Fence: (props: {
    lang?: string;
    title?: string | ExprRef;
    children?: Child;
}) => Node;
export declare const List: (props: {
    ordered?: boolean;
    children?: Child;
}) => Node;
export interface TableProps {
    columns: string[];
    /** List expression. */
    rows: Expr;
    /** One expression per column, over `row`. */
    cells: Expr[];
}
export declare const Table: (props: TableProps) => Node;
/** `{{ expr }}` interpolation. */
export declare const V: (props: {
    expr: Expr;
}) => Node;
export declare const Debug: (props: {
    exprs?: Expr[];
    message?: string;
    children?: Child;
}) => Node;
export declare const Assert: (props: {
    test: Cond;
    message?: string;
}) => Node;
export declare const Log: (props: {
    level?: "info" | "warn" | "error";
    message?: string;
    children?: Child;
}) => Node;
export declare const Trace: (props: {
    on?: boolean;
}) => Node;
/**
 * Cursor rules as a list. `match` — a path expression: rules attached to that path via the cursor
 * provider (`cursor.match(path)`); without `match` — Always rules (`cursor.always`).
 */
export declare const CursorRules: (props: {
    match?: Expr;
    heading?: string;
}) => JsxValue;
/** Repository examples: `fs.examples(glob, n)` (smallest files), each as a fenced block. */
export declare const Examples: (props: {
    glob: string;
    n?: number;
    lang?: string;
    title?: string;
}) => Node;
/** Context-budget warning: shown when `ctx.percent` passes the soft budget. */
export declare const HealthWarning: (props: {
    threshold?: Expr;
    children?: Child;
}) => Node;
export {};
