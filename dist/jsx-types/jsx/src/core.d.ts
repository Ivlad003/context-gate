import type { Code, Diagnostic, Node, SectionNode, ArgSpec, Tier } from '../../core/src/types.ts';
/** Records a build-time diagnostic, tagged with the caller location (first frame outside this package). */
export declare function report(code: Code, severity: Diagnostic['severity'], message: string, hint?: string): void;
/** Returns and clears every diagnostic recorded since the last call. */
export declare function takeDiagnostics(): Diagnostic[];
/**
 * Attributes to `marker` every diagnostic recorded since the previous `<Prompt>` (its children are evaluated
 * before it) plus those tied to any element inside `children`: a Section or component constant shared by several
 * skills of one package is built once, and its errors must reach every prompt that contains it (M77).
 */
export declare function claimDiagnostics(marker: object, children?: unknown): void;
/** Diagnostics of one prompt: its claimed ones plus the not yet claimed rest (module-level code). Drains `pending`. */
export declare function diagnosticsOf(marker: object | undefined): Diagnostic[];
/** File and line of the first stack frame outside @context-gate/jsx (source-mapped during builds). */
export declare function callerLocation(): {
    path: string;
    line: number;
} | undefined;
/** Brand carried by expression references (`ctx.git.branch`, the `Each` item proxy). */
export declare const EXPR: unique symbol;
/** A runtime expression reference: property access and calls build a path, nothing is evaluated. */
export interface ExprRef {
    readonly [EXPR]: string;
}
export declare function isExprRef(v: unknown): v is ExprRef;
/** Plain-decimal source of a number: the expression lexer has no exponent form; NaN/Infinity are G160. */
export declare function numberLiteral(n: number, where?: string): string;
/** Expression source for a literal or reference used inside a call/template (`"str"`, `3`, `a.b`). */
export declare function exprLiteral(v: unknown): string;
export declare const HINT_G160 = "\u0432\u0438\u043D\u0435\u0441\u0442\u0438 \u0443 module-\u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u0430\u0431\u043E pipe-\u0444\u0456\u043B\u044C\u0442\u0440";
/**
 * Creates an expression reference. `ref('r').body` → path `r.body`; `ref('').git.branch` → `git.branch`.
 * Supported: property access, numeric index (`.at(n)`), calls with literal/reference args, template
 * literals and string concatenation (→ `{{ path }}`). JS operators (`>`, `===`, `&&`, `? :`) are NOT
 * intercepted (SPEC Р1): arithmetic/relational use is reported as G160, the rest silently yields a
 * build-time value, so runtime conditions must be written as strings.
 */
export declare function ref(path: string, item?: boolean): any;
/**
 * Normalizes a value in an expression position (`when`, `test`, `of`, `value`, `expr`, `n`, ...)
 * to an expression string. Strings are expression sources (`{{ x }}` placeholders are unwrapped,
 * so template literals over `ctx` work); references give their path; numbers/null are literals.
 * Booleans and objects are build-time values that leaked into a runtime position → G160.
 */
export declare function exprOf(v: unknown, where: string): string | undefined;
export interface SectionMarker {
    $cg: 'section';
    section: SectionNode;
}
export interface ElseMarker {
    $cg: 'else';
    children: Node[];
}
export interface PromptMarker {
    $cg: 'prompt';
    id?: string;
    sections: SectionNode[];
    uses: Record<string, string>;
    skill?: {
        name: string;
        description: string;
        args: Record<string, ArgSpec>;
        invoke: {
            user: boolean;
            model: 'tool' | 'skill' | false;
        };
        tiers?: Tier[];
        body: Node[];
    };
}
export type Marker = SectionMarker | ElseMarker | PromptMarker;
/** What the JSX factory returns. Fragments and inlined components may yield arrays. */
export type JsxValue = Node | Marker | JsxValue[];
/** Anything accepted as a JSX child. Functions are only valid as the child of `Each`. */
export type Child = JsxValue | string | number | boolean | null | undefined | ExprRef | Child[];
export declare function isMarker(v: unknown): v is Marker;
/** Splits a string into text and `{{ expr }}` nodes. */
export declare function interpolate(s: string): Node[];
/**
 * Normalizes children of one container: flattens arrays/fragments, dedents the raw text authored in
 * this container (Markdown rules, not JSX rules), parses `{{ }}` placeholders, merges adjacent
 * text, collapses whitespace-only runs between blocks to `\n`/`\n\n`, trims the container edges.
 * Markers (Section, Else, Prompt) are passed through for the container to validate.
 */
export declare function normalize(children: unknown, where: string): (Node | Marker)[];
/** `normalize` for containers that accept only AST nodes; markers are reported (G001) and dropped. */
export declare function toNodes(children: unknown, where: string): Node[];
/** Raw string content of children (for `Run` code): text concatenated as authored, then dedented. */
export declare function rawText(children: unknown, where: string): string;
/** Dedent a multi-line block (all lines, incl. the first) and trim surrounding blank lines. */
export declare function dedentBlock(s: string): string;
/** Brand for builtin components: they are not subject to the recursion guard. */
export declare const BUILTIN: unique symbol;
export type Component<P = any> = (props: P) => unknown;
export declare function builtin<F extends Component>(name: string, fn: F): F;
export declare const INTRINSIC_TAGS: readonly ["ol", "ul", "li", "pre", "code", "b", "i", "p", "h1", "h2", "h3", "h4", "h5", "h6", "br"];
export type IntrinsicTag = (typeof INTRINSIC_TAGS)[number];
/** Automatic-runtime factory (`jsx`/`jsxs`): builtins build nodes, user components are inlined. */
export declare function jsx(type: string | Component, props: Record<string, unknown> | null, _key?: unknown): JsxValue;
export declare const jsxs: typeof jsx;
/**
 * Whether a loop body ends with a line break as authored (`x => `- ${x}\n``, `<>- {f}{'\n'}</>`). `normalize`
 * trims it as container-edge formatting; a loop body keeps it, so text iterations are not glued together.
 */
export declare function endsWithNewline(v: unknown): boolean;
/** Normalized loop-body nodes, with the authored trailing line break kept after inline content. */
export declare function loopBody(body: unknown, where: string): Node[];
/** Fragment: normalizes its children in place (text dedented relative to the fragment). */
export declare const Fragment: (props: {
    children?: unknown;
}) => JsxValue;
/** Classic factory (`h(type, props, ...children)`), e.g. for tests or `jsxFactory: 'h'`. */
export declare function h(type: string | Component, props: Record<string, unknown> | null, ...children: unknown[]): JsxValue;
