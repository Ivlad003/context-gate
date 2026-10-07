// Turns the default export of a `.prompt.tsx` module into the serializable part of `CompiledPrompt`.
// Runs inside the build child process (bundled together with the prompt), so diagnostics
// collected by the components during module evaluation are drained here.

import type { CompiledPrompt, Diagnostic, Node, SectionNode } from '../../core/src/types.ts'
import { diagnosticsOf, isMarker, type PromptMarker } from './core.ts'
import { canonicalNodes } from '../../core/src/canonical.ts'

export type CompiledPart = Pick<CompiledPrompt, 'sections' | 'skill' | 'uses' | 'diagnostics'> & { id?: string }

export interface CompileOptions {
  /** Absolute repo root: diagnostic and section source paths are made repo-relative. */
  root?: string
  /** Repo-relative path of the entry file, for diagnostics without a location. */
  file?: string
}

function rel(p: string, root?: string): string {
  if (!root) return p
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
  return p.startsWith(r) ? p.slice(r.length) : p
}

export function compilePrompt(value: unknown, opts: CompileOptions = {}): CompiledPart {
  let marker: PromptMarker | undefined
  if (isMarker(value) && value.$cg === 'prompt') marker = value
  // Multi-skill packages: each <Prompt> owns the diagnostics recorded while it was built (core `claimDiagnostics`).
  const diagnostics: Diagnostic[] = diagnosticsOf(marker)
  if (!marker) diagnostics.push({ code: 'G001', severity: 'error', message: 'Default export промпту має бути елементом <Prompt>.', ...(opts.file ? { path: opts.file } : {}) })
  const out: CompiledPart = { sections: [], diagnostics }
  if (marker) {
    if (marker.id) out.id = marker.id
    // Р5: only canonical nodes reach `.compiled` (core `canonicalNodes`: `store=` → `Store`, `scripts.f()` lets → `Call`).
    out.sections = marker.sections.map((s): SectionNode => {
      const c = { ...s, children: canonicalNodes(s.children) }
      return c.source ? { ...c, source: { ...c.source, path: rel(c.source.path, opts.root) } } : c
    })
    if (Object.keys(marker.uses).length) out.uses = marker.uses
    if (marker.skill) out.skill = { ...marker.skill, body: canonicalNodes(marker.skill.body) }
  }
  for (const d of diagnostics) {
    if (d.path) d.path = rel(d.path, opts.root)
    else if (opts.file) d.path = opts.file
  }
  return JSON.parse(JSON.stringify(out)) as CompiledPart
}

/** Depth-first walk over AST nodes, including `if.else`. */
export function walkNodes(nodes: Node[], fn: (n: Node, parents: Node[]) => void, parents: Node[] = []): void {
  for (const n of nodes) {
    fn(n, parents)
    const kids: Node[][] = []
    if ('children' in n && Array.isArray(n.children)) kids.push(n.children)
    if (n.t === 'if') { kids.push(n.then); if (n.else) kids.push(n.else) }
    for (const k of kids) walkNodes(k, fn, [...parents, n])
  }
}
