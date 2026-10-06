// Cursor `.mdc` rules (SPEC "Шар 1 — cursor-rules"): a linear frontmatter parser without a YAML library,
// type classification, transpilation to SKILL.md / .claude/rules, injection framing and packing.

import type { Diagnostic, Item, MdcRule, RuleType } from './types.ts'
import { diag } from './codes.ts'
import { matchAny, splitTopLevel } from './glob.ts'

export interface ParseMdcOptions {
  /** Repo-relative POSIX path of the `.mdc` file. */
  path: string
  /** Rule id (file name without `.mdc`). */
  id: string
  /** Directory prefix for nested `.cursor/rules` (`packages/api/`): globs and id get it. */
  dirPrefix?: string
}

const KNOWN_KEYS = new Set(['description', 'globs', 'alwaysApply'])

function unquote(v: string): string {
  const s = v.trim()
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    const inner = s.slice(1, -1)
    if (s[0] === "'") return inner.replace(/''/g, "'")
    try { return JSON.parse(s) as string } catch { return inner.replace(/\\"/g, '"') }
  }
  return s
}

/** Strip a trailing ` # comment` (only outside quotes/braces). */
function stripComment(v: string): string {
  let q: string | undefined
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (q) { if (c === q) q = undefined; continue }
    if (c === '"' || c === "'") { q = c; continue }
    if (c === '#' && (i === 0 || /\s/.test(v[i - 1]))) return v.slice(0, i).trimEnd()
  }
  return v
}

/** `globs` value: comma string (commas inside `{}` don't split), inline array, or quoted string. */
export function parseGlobList(value: string): string[] {
  const v = value.trim()
  if (!v) return []
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1)
    // split on commas outside quotes and braces
    const out: string[] = []
    let cur = ''
    let q: string | undefined
    let depth = 0
    for (const c of inner) {
      if (q) { cur += c; if (c === q) q = undefined; continue }
      if (c === '"' || c === "'") { q = c; cur += c; continue }
      if (c === '{') depth++
      if (c === '}') depth = Math.max(0, depth - 1)
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue }
      cur += c
    }
    out.push(cur)
    return out.map(unquote)
  }
  return splitTopLevel(unquote(v)).map((s) => unquote(s))
}

function prefixGlob(glob: string, dirPrefix: string): string {
  let g = glob.replace(/^\.\//, '').replace(/^\//, '')
  // `*.ts` in a nested rules dir means "any .ts under that dir"
  if (!g.includes('/') && !g.startsWith('**')) g = `**/${g}`
  return dirPrefix + g
}

function normPrefix(p: string | undefined): string {
  if (!p) return ''
  let s = p.replace(/\\/g, '/').replace(/^\.\//, '')
  if (s && !s.endsWith('/')) s += '/'
  return s === '/' ? '' : s
}

/** Collect `@file` references (outside code) and replace each with `див. файл <path>`. */
export function expandFileRefs(body: string): { body: string; fileRefs: string[] } {
  const refs: string[] = []
  let inFence = false
  const lines = body.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line }
    if (inFence) return line
    const onlyRef = /^\s*@([^\s`]+?)[.,;:!?)]*\s*$/.exec(line)
    if (onlyRef && looksLikeFile(onlyRef[1])) {
      refs.push(onlyRef[1])
      return `див. файл ${onlyRef[1]}`
    }
    // inline refs, skipping inline code spans
    return line.split(/(`[^`]*`)/).map((part) => part.startsWith('`') ? part : part.replace(/(^|[\s(])@([^\s`,;!?)]+)/g, (m, pre: string, ref: string) => {
      const p = ref.replace(/[.:]+$/, '')
      if (!looksLikeFile(p)) return m
      refs.push(p)
      return `${pre}див. файл ${p}${ref.slice(p.length)}`
    })).join('')
  })
  return { body: lines.join('\n'), fileRefs: [...new Set(refs)] }
}

function looksLikeFile(s: string): boolean {
  return /[/.]/.test(s) && !s.includes('@') && /[A-Za-z0-9]/.test(s)
}

export function classifyRule(r: { alwaysApply: boolean; globs: string[]; negGlobs: string[]; description?: string }): RuleType {
  if (r.alwaysApply) return 'always'
  if (r.globs.length || r.negGlobs.length) return 'auto'
  if (r.description) return 'agent'
  return 'manual'
}

export function parseMdc(text: string, opts: ParseMdcOptions): { rule: MdcRule; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const prefix = normPrefix(opts.dirPrefix)
  const id = prefix && !opts.id.startsWith(prefix) ? prefix + opts.id : opts.id
  let description: string | undefined
  let alwaysApply = false
  const rawGlobs: string[] = []
  let bodyStart = 0

  const lines = src.split('\n')
  if (lines[0]?.trim() === '---') {
    let end = -1
    for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break }
    if (end < 0) {
      diagnostics.push(diag('G010', undefined, { path: opts.path, line: 1 }))
    } else {
      let listKey: string | undefined
      for (let i = 1; i < end; i++) {
        const line = lines[i]
        const lineNo = i + 1
        if (!line.trim() || line.trim().startsWith('#')) continue
        const item = /^\s*-\s*(.*)$/.exec(line)
        if (item && listKey) {
          if (listKey === 'globs') {
            const v = unquote(stripComment(item[1]))
            if (v) rawGlobs.push(v)
            else diagnostics.push(diag('G013', undefined, { path: opts.path, line: lineNo }))
          }
          continue
        }
        const kv = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line)
        if (!kv) {
          // folded continuation of description (indented line)
          if (/^\s+\S/.test(line) && listKey === 'description') { description = ((description ?? '') + ' ' + line.trim()).trim(); continue }
          diagnostics.push(diag('G014', `Рядок frontmatter не розпізнано: ${line.trim()}`, { path: opts.path, line: lineNo }))
          continue
        }
        const key = kv[1]
        const value = stripComment(kv[2].trim())
        listKey = key
        if (!KNOWN_KEYS.has(key)) {
          diagnostics.push(diag('G011', `Невідоме поле frontmatter: ${key}`, { path: opts.path, line: lineNo }))
          continue
        }
        if (key === 'description') {
          const v = value === '|' || value === '>' || value === '>-' || value === '|-' ? '' : unquote(value)
          description = v || undefined
        } else if (key === 'alwaysApply') {
          const v = unquote(value).toLowerCase()
          if (v === 'true' || v === 'yes') alwaysApply = true
          else if (v === 'false' || v === 'no' || v === '') alwaysApply = false
          else diagnostics.push(diag('G012', `alwaysApply: ${value}`, { path: opts.path, line: lineNo }))
        } else if (key === 'globs') {
          if (value && value !== 'null' && value !== '~') {
            const parts = parseGlobList(value)
            if (parts.some((p) => !p.trim())) diagnostics.push(diag('G013', undefined, { path: opts.path, line: lineNo }))
            rawGlobs.push(...parts.map((p) => p.trim()).filter(Boolean))
          }
        }
      }
      bodyStart = end + 1
    }
  }
  const rawBody = lines.slice(bodyStart).join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
  const { body, fileRefs } = expandFileRefs(rawBody)
  const globs: string[] = []
  const negGlobs: string[] = []
  for (const g of rawGlobs) {
    const neg = g.startsWith('!')
    const p = neg ? g.slice(1).trim() : g
    if (!p) continue
    const full = prefix ? prefixGlob(p, prefix) : p
    ;(neg ? negGlobs : globs).push(full)
  }
  if (!globs.length && negGlobs.length) diagnostics.push(diag('G015', undefined, { path: opts.path }))
  const rule: MdcRule = { id, path: opts.path, type: 'manual', globs, negGlobs, alwaysApply, body, fileRefs }
  if (description) rule.description = description
  rule.type = classifyRule(rule)
  return { rule, diagnostics }
}

/** Rule id and dir prefix from a repo-relative `.mdc` path: `packages/api/.cursor/rules/db/x.mdc` → id `packages/api/db/x`, prefix `packages/api/`. */
export function ruleIdFromPath(path: string): { id: string; dirPrefix: string } {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const m = /^(.*?)\.cursor\/rules\/(.+?)\.mdc$/.exec(p)
  if (!m) return { id: p.replace(/\.mdc$/, '').split('/').pop() ?? p, dirPrefix: '' }
  return { id: m[2], dirPrefix: m[1] }
}

// ───────────────────────── Matching ─────────────────────────

export interface RuleMatchOptions {
  /** Case-insensitive match (Windows repos). */
  nocase?: boolean
}

/** Cursor glob semantics for one rule, shared by the mod, the hooks adapter and the CLI:
 * a slash-less glob (`*.ts`) matches the basename at any depth, `!`-globs exclude, nested rule
 * dirs are already prefixed by `parseMdc` (`packages/api/**\/*.ts`). `path` is repo-relative POSIX
 * (a leading `./` and backslashes are tolerated). Rule type is not checked; see `autoRulesFor`. */
export function ruleMatches(rule: Pick<MdcRule, 'globs' | 'negGlobs'>, path: string, opts: RuleMatchOptions = {}): boolean {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return matchAny(p, rule.globs, rule.negGlobs, { nocase: !!opts.nocase, matchBase: true })
}

/** Auto Attached rules whose globs match `path` (Cursor attaches only these by path). */
export function autoRulesFor<T extends Pick<MdcRule, 'type' | 'globs' | 'negGlobs'>>(rules: readonly T[], path: string, opts: RuleMatchOptions = {}): T[] {
  return rules.filter((r) => r.type === 'auto' && ruleMatches(r, path, opts))
}

// ───────────────────────── To Item / transpile ─────────────────────────

export function ruleToItem(rule: MdcRule): Item {
  const when: Item['attach']['when'] = rule.type === 'always' ? 'always' : rule.type === 'auto' ? 'paths' : rule.type === 'agent' ? 'on-demand' : 'manual'
  const item: Item = {
    kind: 'rule',
    id: `rule:${rule.id}`,
    name: rule.id,
    body: rule.body,
    attach: { when },
    cost: { chars: rule.body.length },
    provenance: { source: 'cursor-mdc', path: rule.path },
    ruleType: rule.type,
  }
  if (rule.description) item.description = rule.description
  if (rule.type === 'auto') item.attach.globs = [...rule.globs, ...rule.negGlobs.map((g) => `!${g}`)]
  return item
}

function yamlStr(s: string): string {
  return /^[\w .,/()'-]*$/.test(s) && !/^[\s'-]/.test(s) && !s.includes(': ') ? s : JSON.stringify(s)
}

/** Skill dir name for an agent-requested/manual rule: `cursor-<id>` with `/` → `-`. */
export function skillNameForRule(rule: Pick<MdcRule, 'id'>): string {
  return `cursor-${rule.id.replace(/[^\w-]+/g, '-')}`
}

/** `.claude/skills/cursor-<id>/SKILL.md` for Agent Requested (and Manual: `disable-model-invocation`). */
export function transpileAgentRule(rule: MdcRule): string {
  const fm = ['---', `name: ${skillNameForRule(rule)}`]
  fm.push(`description: ${yamlStr(rule.description ?? `Cursor rule ${rule.id}`)}`)
  if (rule.type === 'manual') fm.push('disable-model-invocation: true')
  fm.push('---')
  return `${fm.join('\n')}\n<!-- generated by context-gate from ${rule.path}; edit the .mdc instead -->\n\n${rule.body}\n`
}

/** `.claude/rules/cursor/<id>.md` for Always (no frontmatter) and Auto Attached (`paths:`). Others → undefined. */
export function transpileRuleToClaudeRule(rule: MdcRule): string | undefined {
  const note = `<!-- generated by context-gate from ${rule.path}; edit the .mdc instead -->`
  if (rule.type === 'always') return `${note}\n\n${rule.body}\n`
  if (rule.type !== 'auto') return undefined
  const fm = ['---', 'paths:', ...rule.globs.map((g) => `  - ${JSON.stringify(g)}`), '---']
  const neg = rule.negGlobs.length ? `\nНе застосовується до: ${rule.negGlobs.join(', ')}\n` : ''
  return `${fm.join('\n')}\n${note}\n${neg}\n${rule.body}\n`
}

/** Injection frame used after a tool result: `Contents of <path> (Cursor rule <id>):`. */
export function frameRule(rule: Pick<MdcRule, 'id' | 'path' | 'body'>, path?: string): string {
  return `Contents of ${path ?? rule.path} (Cursor rule ${rule.id}):\n${rule.body}`
}

export function pointerLine(path: string): string {
  return `також діє: ${path}, прочитай за потреби`
}

/** Pack framed rules into `maxChars`; rules that don't fit become one pointer line each. Order is kept. */
export function packInjections(rules: readonly Pick<MdcRule, 'id' | 'path' | 'body'>[], maxChars: number): { text: string; included: string[]; deferred: string[] } {
  const parts: string[] = []
  const included: string[] = []
  const deferred: string[] = []
  let used = 0
  for (const r of rules) {
    const framed = frameRule(r)
    const add = framed.length + (parts.length ? 2 : 0)
    if (used + add <= maxChars) {
      parts.push(framed)
      included.push(r.id)
      used += add
    } else {
      deferred.push(r.id)
    }
  }
  const pointers = rules.filter((r) => deferred.includes(r.id)).map((r) => pointerLine(r.path))
  const text = [...parts, ...(pointers.length ? [pointers.join('\n')] : [])].join('\n\n')
  return { text, included, deferred }
}

/** Edge case 1: a Read with offset/limit (or pages) is a partial read and doesn't count as delivery. */
export function isPartialRead(toolInput: unknown): boolean {
  if (!toolInput || typeof toolInput !== 'object') return false
  const t = toolInput as Record<string, unknown>
  return [t.offset, t.limit, t.pages].some((v) => v !== undefined && v !== null && v !== '')
}
