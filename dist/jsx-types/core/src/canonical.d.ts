import type { Node } from './types.ts';
/** `scripts.<name>(a, b, k=v)` as the whole expression → the call parts (argument sources), else undefined. */
export declare function scriptsCallOf(expr: string): {
    fn: string;
    args: string[];
    kwargs?: Record<string, string>;
} | undefined;
/** Canonical nodes (see the file comment). Returns a new tree; nodes without legacy forms are kept as they are. */
export declare function canonicalNodes(nodes: readonly Node[], nested?: boolean): Node[];
