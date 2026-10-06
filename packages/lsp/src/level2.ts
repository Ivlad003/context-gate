// TSX level 2 (SPEC Р1) in the editor: the same transformer the build runs (`cli/src/transform.ts`) is applied to
// the open text, so its rejections (G160: a native expression outside the subset) show up live, on the line the
// build would report, without saving and rebuilding.

import type TS from 'typescript'
import { transformLevel2, wantsLevel2 } from '../../cli/src/transform.ts'
import type { FileDiag } from './analyze.ts'

/** G160 & co. from the level-2 transform for a file that opts in (pragma or `prompt.transform: "level2"`). */
export function level2Diagnostics(ts: typeof TS, text: string, relPath: string, configTransform?: unknown): FileDiag[] {
  if (!wantsLevel2(text, configTransform)) return []
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  return transformLevel2(ts as never, text, { path: relPath }).diagnostics.map((d): FileDiag => {
    const line = Math.min(Math.max(1, d.line ?? 1), lineStarts.length)
    const start = lineStarts[line - 1]!
    const end = line < lineStarts.length ? lineStarts[line]! - 1 : text.length
    const lead = /^\s*/.exec(text.slice(start, end))![0].length
    return { start: start + lead, length: Math.max(1, end - start - lead), code: d.code, severity: d.severity, message: d.message, ...(d.hint ? { hint: d.hint } : {}) }
  })
}
