import type { CompiledPrompt, Node } from '../../core/src/types.ts';
export type CompiledPart = Pick<CompiledPrompt, 'sections' | 'skill' | 'uses' | 'diagnostics'> & {
    id?: string;
};
export interface CompileOptions {
    /** Absolute repo root: diagnostic and section source paths are made repo-relative. */
    root?: string;
    /** Repo-relative path of the entry file, for diagnostics without a location. */
    file?: string;
}
export declare function compilePrompt(value: unknown, opts?: CompileOptions): CompiledPart;
/** Depth-first walk over AST nodes, including `if.else`. */
export declare function walkNodes(nodes: Node[], fn: (n: Node, parents: Node[]) => void, parents?: Node[]): void;
