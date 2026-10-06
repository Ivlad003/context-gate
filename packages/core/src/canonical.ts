// Р5 canonical AST: the compilers (Markdown `mddsl.ts`, TSX `@context-gate/jsx` compile) emit only canonical
// nodes. Legacy surface forms are accepted (with G180 where they are deprecated) and normalized here:
//   - `store=` on `run` / `call` → the node without `store`, followed by `{ t: 'store', name: <as>, key: <store> }`.
//     The renderer gives a `store` node the metadata of the value it persists (`fetchedAt`, `cache` of the run or
//     call that produced the variable), so `data.<key>` keeps `fetchedAt` / `stale` exactly as before.
//   - `@let x = scripts.f(args)` at the top level of a section or skill body (a `call` binds in the section frame,
//     a nested `let` in its block) → `{ t: 'call', fn: 'scripts.f', args, as: 'x' }` (Р5: «scripts — цукор, який
//     компілюється в Use+Call»). The `scripts` namespace has no `use` binding: the host resolves it to
//     `<prompt dir>/scripts/f.*` and runs the WHOLE script with `{ ctx, args }` on stdin (run-from-file), which
//     is not a module function call. See docs/ARCHITECTURE.md «Канонічні вузли».
// Pure; the renderer still executes legacy JSON (old `.compiled`) unchanged.

import type { Node } from './types.ts'
import { parseExpr } from './expr.ts'

/** Source text of the argument ASTs is not kept by the parser: re-split the call's argument list instead. */
function splitArgs(src: string): string[] | undefined {
  const out: string[] = []
  let depth = 0
  let quote: string | undefined
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = undefined
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { out.push(src.slice(start, i).trim()); start = i + 1 }
    if (depth < 0) return undefined
  }
  if (quote || depth !== 0) return undefined
  const last = src.slice(start).trim()
  if (last) out.push(last)
  else if (out.length) return undefined
  return out
}

/** `scripts.<name>(a, b, k=v)` as the whole expression → the call parts (argument sources), else undefined. */
export function scriptsCallOf(expr: string): { fn: string; args: string[]; kwargs?: Record<string, string> } | undefined {
  const m = /^\s*scripts\.([A-Za-z_][\w-]*)\s*\(([\s\S]*)\)\s*$/.exec(expr)
  if (!m) return undefined
  const ast = parseExpr(expr).ast
  if (!ast || ast.k !== 'call' || ast.path !== `scripts.${m[1]}`) return undefined
  const parts = splitArgs(m[2]!)
  if (!parts || parts.length !== ast.args.length + Object.keys(ast.kwargs).length) return undefined
  const args: string[] = []
  const kwargs: Record<string, string> = {}
  for (const p of parts) {
    const kv = /^([A-Za-z_][\w]*)\s*=(?!=)\s*([\s\S]+)$/.exec(p)
    if (kv && kv[1]! in ast.kwargs) kwargs[kv[1]!] = kv[2]!.trim()
    else args.push(p)
  }
  return { fn: `scripts.${m[1]}`, args, ...(Object.keys(kwargs).length ? { kwargs } : {}) }
}

/** Canonical nodes (see the file comment). Returns a new tree; nodes without legacy forms are kept as they are. */
export function canonicalNodes(nodes: readonly Node[], nested = false): Node[] {
  const out: Node[] = []
  for (const n of nodes) {
    switch (n.t) {
      case 'run':
      case 'call': {
        if (!n.store) { out.push(n); break }
        const { store, ...rest } = n
        const name = n.t === 'run' ? n.as ?? 'run' : n.as
        out.push(rest as Node, { t: 'store', name, ...(store !== name ? { key: store } : {}) })
        break
      }
      case 'let': {
        const c = nested ? undefined : scriptsCallOf(n.value)
        out.push(c ? { t: 'call', fn: c.fn, args: c.args, ...(c.kwargs ? { kwargs: c.kwargs } : {}), as: n.name } : n)
        break
      }
      case 'if': out.push({ ...n, then: canonicalNodes(n.then, true), ...(n.else ? { else: canonicalNodes(n.else, true) } : {}) }); break
      case 'each': case 'repeat': case 'tier': case 'el': case 'fence': case 'list':
        out.push({ ...n, children: canonicalNodes(n.children, true) } as Node)
        break
      default: out.push(n)
    }
  }
  return out
}
