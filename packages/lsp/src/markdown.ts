// Markdown prompt form (`@if`, `@each`, `{{ }}`) for the browser editor: expression sites with offsets,
// diagnostics (parser G0xx/G15x + Ctx checks) and completions. Pure.

import { parseMarkdownPrompt, splitTopLevel } from '../../core/src/mddsl.ts'
import { checkExpr, completeExpr, hoverExpr, inferShape, type Bindings, type CompletionResult, type ExprHover } from './exprcheck.ts'
import { placeholderRanges, type FileDiag } from './analyze.ts'
import type { CtxModel, Shape } from './model.ts'

export interface MdSite { start: number; end: number; text: string; line: number }

export interface MdFacts { sites: MdSite[]; bindings: { name: string; of?: string; kind: 'item' | 'value' | 'number' }[] }

function trimRange(line: string, a: number, b: number): [number, number] {
  while (a < b && /\s/.test(line[a]!)) a++
  while (b > a && /\s/.test(line[b - 1]!)) b--
  return [a, b]
}

/** Expression sites of a Markdown prompt (file offsets). */
export function scanMarkdown(text: string): MdFacts {
  const facts: MdFacts = { sites: [], bindings: [] }
  const lines = text.split('\n')
  let off = 0
  let i = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---')
    if (end > 0) { for (; i <= end; i++) off += lines[i]!.length + 1 }
  }
  let inRun = false
  let inFence = false
  for (; i < lines.length; i++) {
    const line = lines[i]!
    const base = off
    off += line.length + 1
    const add = (a: number, b: number): void => { const [x, y] = trimRange(line, a, b); facts.sites.push({ start: base + x, end: base + y, text: line.slice(x, y), line: i + 1 }) }
    const t = line.trim()
    if (inRun) { if (t === '@end') inRun = false; continue }
    if (/^(```|~~~)/.test(t)) { inFence = !inFence; }
    if (!inFence) for (const [a, b] of placeholderRanges(line)) add(a, b)
    if (inFence || !t.startsWith('@')) continue
    const lead = line.indexOf('@')
    const dm = /^@([A-Za-z_][\w-]*)\s*/.exec(line.slice(lead))
    if (!dm) continue
    const name = dm[1]!
    const restAt = lead + dm[0].length
    const rest = line.slice(restAt)
    switch (name) {
      case 'if': case 'elif': case 'repeat': case 'assert': {
        let expr = rest
        if (name === 'assert') expr = splitTopLevel(rest)[0] ?? rest
        if (expr.trim()) add(restAt, restAt + expr.length)
        if (name === 'repeat') facts.bindings.push({ name: 'i', kind: 'number' })
        break
      }
      case 'else': {
        const m = /^if\s+/.exec(rest)
        if (m) add(restAt + m[0].length, line.length)
        break
      }
      case 'each': {
        const m = /^([A-Za-z_]\w*)(?:\s*,\s*([A-Za-z_]\w*))?\s+in\s+/.exec(rest)
        if (m) {
          add(restAt + m[0].length, line.length)
          facts.bindings.push({ name: m[1]!, kind: 'item', of: rest.slice(m[0].length).trim() })
          if (m[2]) facts.bindings.push({ name: m[2], kind: 'number' })
        }
        break
      }
      case 'let': case 'set': {
        const m = /^([A-Za-z_]\w*)\s*=(?!=)\s*/.exec(rest)
        if (m) { add(restAt + m[0].length, line.length); facts.bindings.push({ name: m[1]!, kind: 'value', of: rest.slice(m[0].length).trim() }) }
        break
      }
      case 'debug': {
        let at = restAt
        for (const part of splitTopLevel(rest)) {
          const idx = line.indexOf(part, at)
          if (idx >= 0 && part.trim() && !/^["']/.test(part.trim())) add(idx, idx + part.length)
          at = idx >= 0 ? idx + part.length : at
        }
        break
      }
      case 'run': {
        inRun = true
        const as = /\bas=([\w-]+)/.exec(rest)
        if (as) facts.bindings.push({ name: as[1]!, kind: 'value' })
        break
      }
      case 'call': case 'mcp': case 'include': {
        const as = /\bas[= ]\s*([A-Za-z_][\w-]*)/.exec(rest)
        if (as) facts.bindings.push({ name: as[1]!, kind: 'value' })
        break
      }
      case 'use': { const n = /^([A-Za-z_][\w-]*)/.exec(rest); if (n) facts.bindings.push({ name: n[1]!, kind: 'value' }); break }
      case 'fn': {
        const m = /^[\w-]+\s*\(([^)]*)\)/.exec(rest)
        if (m) for (const p of m[1]!.split(',').map((s) => s.trim()).filter(Boolean)) facts.bindings.push({ name: p, kind: 'value' })
        break
      }
    }
  }
  return facts
}

function mdBindings(facts: MdFacts, model: CtxModel): Bindings {
  const m: Bindings = new Map()
  for (const b of facts.bindings) m.set(b.name, b.kind === 'number' ? { k: 'prim', t: 'number' } : { k: 'any' })
  for (const b of facts.bindings) {
    if (b.of === undefined) continue
    const s: Shape = inferShape(b.of, model, m)
    m.set(b.name, b.kind === 'item' ? (s.k === 'array' ? s.item : { k: 'any' }) : s)
  }
  return m
}

/** Diagnostics for a Markdown prompt: parser structure codes by line + live expression checks by range. */
export function analyzeMarkdown(text: string, path: string, model: CtxModel): FileDiag[] {
  const facts = scanMarkdown(text)
  const bound = mdBindings(facts, model)
  const out: FileDiag[] = []
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  for (const d of parseMarkdownPrompt(text, { path }).diagnostics) {
    if (/^G1(0\d)$/.test(d.code)) continue // reported per expression below
    const line = Math.min(Math.max(1, d.line ?? 1), lineStarts.length)
    const start = lineStarts[line - 1]!
    const end = line < lineStarts.length ? lineStarts[line]! - 1 : text.length
    out.push({ start, length: Math.max(1, end - start), code: d.code, severity: d.severity, message: d.message, ...(d.hint ? { hint: d.hint } : {}) })
  }
  for (const s of facts.sites) {
    for (const d of checkExpr(s.text, model, bound)) out.push({ start: s.start + d.start, length: Math.max(1, d.end - d.start), code: d.code, severity: d.severity, message: d.message, ...(d.hint ? { hint: d.hint } : {}) })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Completions in a Markdown prompt (file offsets); undefined outside expressions. */
export function completeMarkdown(text: string, pos: number, model: CtxModel): CompletionResult | undefined {
  const facts = scanMarkdown(text)
  const site = facts.sites.find((s) => pos >= s.start && pos <= s.end)
  if (!site) return undefined
  const r = completeExpr(site.text, pos - site.start, model, mdBindings(facts, model))
  return { ...r, start: site.start + r.start, end: site.start + r.end }
}

export function hoverMarkdownAt(text: string, pos: number, model: CtxModel): ExprHover | undefined {
  const facts = scanMarkdown(text)
  const site = facts.sites.find((s) => pos >= s.start && pos <= s.end)
  if (!site) return undefined
  const h = hoverExpr(site.text, pos - site.start, model, mdBindings(facts, model))
  return h && { ...h, start: site.start + h.start, end: site.start + h.end }
}
