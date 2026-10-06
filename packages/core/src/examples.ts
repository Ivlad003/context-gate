// Contract of the builtin `fs.examples(glob, n)` provider helper (SPEC «Шар 3а»): the adapter (mod) and the
// CLI list files matching the glob themselves, then call this pure function so both pick identically.

import { compileGlob } from './glob.ts'

export interface ExampleFile { path: string; size: number; body: string }

export const EXAMPLE_TRUNCATION_MARKER = '…[обрізано]'

/**
 * The `n` smallest files by size, ties broken by path (byte order), so the choice is deterministic.
 * With `budget`, each body is cut to at most `budget` characters plus a marker line. `size` is kept as the
 * original file size. n ≤ 0 or non-finite → no examples.
 */
export function pickExamples(files: ExampleFile[], n: number, budget?: number): ExampleFile[] {
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
  const picked = [...files]
    .sort((a, b) => a.size - b.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, count)
  if (!budget || budget <= 0) return picked.map(f => ({ ...f }))
  return picked.map(f => (f.body.length > budget
    ? { ...f, body: f.body.slice(0, budget).replace(/\s+$/, '') + '\n' + EXAMPLE_TRUNCATION_MARKER }
    : { ...f }))
}

/** Body cap of one `fs.examples` entry (the mod and the CLI). */
export const EXAMPLE_MAX_CHARS = 8000

/**
 * `fs.examples(glob, n)` selection over a file listing: the glob is matched with Cursor/`fs.glob` semantics
 * (a slash-less glob matches the basename at any depth), then `pickExamples` orders by size and path.
 * Callers read the bodies of the result and build values with `exampleValue`.
 */
export function selectExamples(files: readonly { path: string; size: number }[], glob: string, n: number): { path: string; size: number }[] {
  const m = compileGlob(glob, { matchBase: true })
  return pickExamples(files.filter((f) => m(f.path)).map((f) => ({ path: f.path, size: f.size, body: '' })), n).map((f) => ({ path: f.path, size: f.size }))
}

/** The scope value of one example: `{ path, size, body, chars }`, body capped at EXAMPLE_MAX_CHARS. */
export function exampleValue(f: { path: string; size: number }, body: string): { path: string; size: number; body: string; chars: number } {
  const [cut] = pickExamples([{ path: f.path, size: f.size, body }], 1, EXAMPLE_MAX_CHARS)
  return { path: f.path, size: f.size, body: cut?.body ?? body, chars: body.length }
}
