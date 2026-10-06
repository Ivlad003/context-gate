// `arg.*` builders for `<Prompt as="skill" args={...}>` → `ArgSpec` (types.ts).

import type { ArgSpec } from '../../core/src/types.ts'

export interface ArgOptions {
  /** 0-based position for positional arguments. */
  positional?: number
  required?: boolean
  default?: unknown
  /** Shown in `argument-hint` (`<tag|sha>`). */
  hint?: string
  description?: string
}

function spec(type: ArgSpec['type'], opts: ArgOptions = {}): ArgSpec {
  const s: ArgSpec = { type }
  if (opts.positional !== undefined) s.positional = opts.positional
  if (opts.required !== undefined) s.required = opts.required
  if ('default' in opts) s.default = opts.default
  if (opts.hint !== undefined) s.hint = opts.hint
  if (opts.description !== undefined) s.description = opts.description
  return s
}

export const arg = {
  string: (opts?: ArgOptions): ArgSpec => spec('string', opts),
  number: (opts?: ArgOptions): ArgSpec => spec('number', opts),
  /** `arg.enum(['md', 'slack'], { default: 'md' })`. */
  enum: (values: readonly string[], opts?: ArgOptions): ArgSpec => ({ ...spec('enum', opts), values: [...values] }),
  flag: (opts?: ArgOptions): ArgSpec => spec('flag', opts),
  /** Existence is checked relative to the repo root at parse time. */
  path: (opts?: ArgOptions): ArgSpec => spec('path', opts),
  /** Comma-separated list. */
  list: (opts?: ArgOptions): ArgSpec => spec('list', opts),
  json: (opts?: ArgOptions): ArgSpec => spec('json', opts),
  /** Raw tail after `--`. */
  rest: (opts?: ArgOptions): ArgSpec => spec('rest', opts),
}
