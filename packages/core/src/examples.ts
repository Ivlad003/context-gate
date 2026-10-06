// Contract of the builtin `fs.examples(glob, n)` provider helper (SPEC «Шар 3а»): the adapter (mod) and the
// CLI list files matching the glob themselves, then call this pure function so both pick identically.

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
