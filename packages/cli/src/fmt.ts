// `context-gate fmt`: normalizes Markdown DSL prompt files (SPEC «Коди, explain, fmt»). Only directive lines
// are re-indented (2 spaces per open block) and get one space after the name; every other line (text,
// blank, frontmatter, fenced code, `@run` bodies) stays byte-identical,
// so the parsed AST does not change. Nesting it can't prove balanced is refused, and the file is left alone.
// Pure: no Node imports.

export interface FmtResult { text: string; changed: boolean; refused?: string; line?: number }

const BLOCK_OPEN = new Set(['if', 'each', 'repeat', 'tier', 'fn'])
const DIRECTIVES = new Set(['if', 'else', 'elif', 'end', 'each', 'let', 'set', 'repeat', 'break', 'continue', 'store', 'run', 'call', 'use', 'include', 'section', 'skill', 'rule', 'mcp', 'lazy', 'tier', 'fn', 'debug', 'assert', 'log', 'trace'])
const MAX_IF = 3
const MAX_EACH = 2

export function formatPrompt(src: string): FmtResult {
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  // Frontmatter is copied verbatim.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---')
    if (end < 0) return { text: src, changed: false, refused: 'незакритий frontmatter', line: 1 }
    for (; i <= end; i++) out.push(lines[i]!)
  }
  const stack: { kind: string; line: number; fenceAt: number }[] = []
  let fence: { marker: string; line: number; depth: number } | undefined
  let run: number | undefined
  for (; i < lines.length; i++) {
    const raw = lines[i]!
    const line = i + 1
    const trimmed = raw.trim()
    if (run !== undefined) {
      if (trimmed === '@end') { out.push('  '.repeat(stack.length) + '@end'); run = undefined }
      else out.push(raw)
      continue
    }
    const fm = /^(```+|~~~+)/.exec(trimmed)
    if (fm) {
      if (!fence) fence = { marker: fm[1]![0]!, line, depth: stack.length }
      else if (fm[1]![0] === fence.marker) {
        if (fence.depth !== stack.length) return { text: src, changed: false, refused: `блок коду з рядка ${fence.line} перетинає межу @-блоку`, line }
        fence = undefined
      }
      out.push(raw)
      continue
    }
    if (fence) { out.push(raw); continue }
    if (!trimmed) { out.push(raw); continue }
    const dm = /^@([A-Za-z_][\w-]*)(.*)$/.exec(trimmed)
    if (!dm || trimmed.startsWith('\\@')) { out.push(raw); continue }
    const name = dm[1]!
    // Unknown `@word` lines are text for the parser (only `@fn(…)` calls are directives): leave them.
    if (!DIRECTIVES.has(name) && !dm[2]!.trimStart().startsWith('(')) { out.push(raw); continue }
    const rest = dm[2]!.trim()
    const norm = (n: string) => (rest.startsWith('(') ? `@${n}${rest}` : `@${n}${rest ? ' ' + rest : ''}`)
    if (name === 'end') {
      if (!stack.length) return { text: src, changed: false, refused: 'зайвий @end', line }
      stack.pop()
      out.push('  '.repeat(stack.length) + '@end')
      continue
    }
    if (name === 'else' || name === 'elif') {
      const top = stack[stack.length - 1]
      if (!top || top.kind !== 'if') return { text: src, changed: false, refused: `@${name} поза @if`, line }
      out.push('  '.repeat(stack.length - 1) + norm(name))
      continue
    }
    if (name === 'run') {
      out.push('  '.repeat(stack.length) + norm(name))
      run = line
      continue
    }
    out.push('  '.repeat(stack.length) + norm(name))
    if (BLOCK_OPEN.has(name)) {
      stack.push({ kind: name, line, fenceAt: 0 })
      const ifs = stack.filter((b) => b.kind === 'if').length
      const eachs = stack.filter((b) => b.kind === 'each' || b.kind === 'repeat').length
      if (ifs > MAX_IF) return { text: src, changed: false, refused: `вкладення @if глибше за ${MAX_IF} (G156)`, line }
      if (eachs > MAX_EACH) return { text: src, changed: false, refused: `вкладення @each/@repeat глибше за ${MAX_EACH} (G156)`, line }
    }
  }
  if (run !== undefined) return { text: src, changed: false, refused: '@run без @end', line: run }
  if (fence) return { text: src, changed: false, refused: 'незакритий блок коду', line: fence.line }
  if (stack.length) return { text: src, changed: false, refused: `@${stack[stack.length - 1]!.kind} без @end`, line: stack[stack.length - 1]!.line }
  const text = out.join(eol)
  return { text, changed: text !== src }
}
