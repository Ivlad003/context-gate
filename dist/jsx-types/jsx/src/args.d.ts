import type { ArgSpec } from '../../core/src/types.ts';
export interface ArgOptions {
    /** 0-based position for positional arguments. */
    positional?: number;
    required?: boolean;
    default?: unknown;
    /** Shown in `argument-hint` (`<tag|sha>`). */
    hint?: string;
    description?: string;
}
export declare const arg: {
    string: (opts?: ArgOptions) => ArgSpec;
    number: (opts?: ArgOptions) => ArgSpec;
    /** `arg.enum(['md', 'slack'], { default: 'md' })`. */
    enum: (values: readonly string[], opts?: ArgOptions) => ArgSpec;
    flag: (opts?: ArgOptions) => ArgSpec;
    /** Existence is checked relative to the repo root at parse time. */
    path: (opts?: ArgOptions) => ArgSpec;
    /** Comma-separated list. */
    list: (opts?: ArgOptions) => ArgSpec;
    json: (opts?: ArgOptions) => ArgSpec;
    /** Raw tail after `--`. */
    rest: (opts?: ArgOptions) => ArgSpec;
};
