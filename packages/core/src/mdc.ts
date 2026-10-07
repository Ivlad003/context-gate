// Cursor `.mdc` rules (SPEC "Шар 1 — cursor-rules"): a linear frontmatter parser without a YAML library,
// type classification, transpilation to SKILL.md / .claude/rules, injection framing and packing.

import type { Diagnostic, GateConfig, Item, ItemSourceConfig, MdcRule, RuleType, Value } from './types.ts'
import { diag } from './codes.ts'
import { globError, isRepoRelative, matchAny, splitTopLevel } from './glob.ts'
import { evalSource, newBudget, splitTemplate, toText } from './expr.ts'

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

/** Split on commas outside quotes and braces. */
function splitGlobItems(inner: string): string[] {
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
  return out
}

/** `globs` value: comma string (commas inside `{}` don't split), inline array, or quoted string(s):
 * `"src/**\/*.ts", "test/**\/*.ts"` is two globs, not one string with stray quotes. */
export function parseGlobList(value: string): string[] {
  const v = value.trim()
  if (!v) return []
  if (v.startsWith('[') && v.endsWith(']')) return splitGlobItems(v.slice(1, -1)).map(unquote)
  const items = splitGlobItems(v)
  // One quoted string holding a comma list (`"src/**, !src/gen/**"`) is still split.
  if (items.length === 1) return splitTopLevel(unquote(v)).map((s) => unquote(s))
  return items.map((s) => unquote(s))
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

/** A repo path, not an npm scope (`@types/node`, `@angular/core`): `./` or `../`, a trailing `/`, or an
 * extension on the last segment. */
function looksLikeFile(s: string): boolean {
  if (s.includes('@') || !/[A-Za-z0-9]/.test(s)) return false
  return /^\.\.?\//.test(s) || s.endsWith('/') || /\.[A-Za-z0-9]+$/.test(s.split('/').pop() ?? '')
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
  const id = prefix + opts.id
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
    const bad = globError(full)
    if (bad) { diagnostics.push(diag('G016', `Невірний glob ${g}: ${bad}. Його пропущено.`, { path: opts.path, severity: 'warning' })); continue }
    if (/["']/.test(p)) diagnostics.push(diag('G016', `Glob ${g} містить лапки: перевір, чи список globs записано правильно`, { path: opts.path, severity: 'warning' }))
    ;(neg ? negGlobs : globs).push(full)
  }
  if (!globs.length && negGlobs.length) diagnostics.push(diag('G015', undefined, { path: opts.path }))
  const rule: MdcRule = { id, path: opts.path, type: 'manual', globs, negGlobs, alwaysApply, body, fileRefs }
  if (description) rule.description = description
  rule.type = classifyRule(rule)
  return { rule, diagnostics }
}

/** Rule id and dir prefix from a repo-relative `.mdc` path: `packages/api/.cursor/rules/db/x.mdc` → id `packages/api/db/x`, prefix `packages/api/`.
 * Under a custom `cursor-mdc` `dir` (pass the source dirs, `cursorRuleDirs(cfg).dirs`) the id is the path below
 * that dir (`config/rules/api/x.mdc` → `api/x`), as for `markdown-dir`, so two `x.mdc` in different subdirs never
 * share an id. Without `sourceDirs` it falls back to the file name. */
export function ruleIdFromPath(path: string, sourceDirs: readonly string[] = []): { id: string; dirPrefix: string } {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const m = /^(.*?)\.cursor\/rules\/(.+?)\.mdc$/.exec(p)
  if (m) return { id: m[2], dirPrefix: m[1] }
  const dir = sourceDirs.map(trimRuleDir).filter((d) => d && p.startsWith(d + '/')).sort((a, b) => b.length - a.length)[0]
  if (dir) return { id: p.slice(dir.length + 1).replace(/\.mdc$/, ''), dirPrefix: '' }
  return { id: p.replace(/\.mdc$/, '').split('/').pop() ?? p, dirPrefix: '' }
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
  if (!isRepoRelative(p)) return false // a file outside the repo root never attaches a repo rule
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
    provenance: { source: rule.source ?? 'cursor-mdc', path: rule.path },
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

/** Injection frame used after a tool result: `Contents of <path> (Cursor rule <id>):`
 * (`(rule <id>)` for rules from other sources: markdown-dir, provider). */
export function frameRule(rule: Pick<MdcRule, 'id' | 'path' | 'body'> & { source?: string }, path?: string): string {
  const label = !rule.source || rule.source === 'cursor-mdc' ? 'Cursor rule' : 'rule'
  return `Contents of ${path ?? rule.path} (${label} ${rule.id}):\n${rule.body}`
}

export function pointerLine(path: string): string {
  return `також діє: ${path}, прочитай за потреби`
}

/** Pack framed rules into `maxChars`; rules that don't fit become one pointer line each. Order is kept. */
export function packInjections(rules: readonly (Pick<MdcRule, 'id' | 'path' | 'body'> & { source?: string })[], maxChars: number): { text: string; included: string[]; deferred: string[] } {
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

// ───────────────────────── Other rule sources (G-51) ─────────────────────────
// SPEC "Провайдери — Джерела правил", "Єдина модель — Джерела": `markdown-dir` and `provider` sources yield the
// same MdcRule shape as `.mdc` files, so delivery, dedup and statuses are shared by every source.

/** Rule sources from `itemSources` (and legacy `ruleSources`): cursor-mdc, markdown-dir, provider (`as` ≠ datum). */
export function ruleSourcesOf(cfg: Pick<GateConfig, 'itemSources' | 'ruleSources'>): ItemSourceConfig[] {
  const out: ItemSourceConfig[] = []
  for (const s of [...(cfg.itemSources ?? []), ...(cfg.ruleSources ?? [])]) {
    if (s.kind === 'cursor-mdc' || s.kind === 'markdown-dir') out.push(s)
    else if (s.kind === 'provider' && s.name && s.as !== 'datum' && s.as !== 'skill' && s.as !== 'tool' && s.as !== 'agent' && s.as !== 'section') out.push(s)
  }
  return out
}

/** `.cursor/rules` dirs to scan: the default plus every `cursor-mdc` source `dir`. `nested` is true when the
 * config or any cursor-mdc source asks for nested `.cursor/rules` discovery. */
export function cursorRuleDirs(cfg: Pick<GateConfig, 'itemSources' | 'ruleSources' | 'cursorRules'>): { dirs: string[]; nested: boolean } {
  const dirs = ['.cursor/rules']
  let nested = !!cfg.cursorRules?.nested
  for (const s of ruleSourcesOf(cfg)) {
    if (s.kind !== 'cursor-mdc') continue
    const d = (s.dir ?? '.cursor/rules').replace(/^\.\//, '').replace(/\/+$/, '')
    if (d && !dirs.includes(d)) dirs.push(d)
    if (s.nested) nested = true
  }
  return { dirs, nested }
}

/** Markdown-dir rule id: path under the source dir without the extension (`docs/rules/api/x.md` → `api/x`). */
export function markdownRuleId(path: string, dir: string): string {
  const d = dir.replace(/^\.\//, '').replace(/\/+$/, '')
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const rel = d && p.startsWith(d + '/') ? p.slice(d.length + 1) : p.split('/').pop() ?? p
  return rel.replace(/\.(md|mdc|markdown)$/i, '')
}

/** A Markdown rule file (`markdown-dir`). `frontmatter` maps file keys to rule fields (`{ paths: "globs" }`:
 * Claude `.claude/rules` style). Unknown frontmatter keys are ignored (no G011: docs carry titles, tags…).
 * `as: "always"` makes every file an Always rule; otherwise the type follows Cursor's classification. */
export function parseMarkdownRule(text: string, opts: { path: string; id: string; frontmatter?: Record<string, string>; as?: string }): { rule: MdcRule; diagnostics: Diagnostic[] } {
  const map = opts.frontmatter ?? {}
  let src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = src.split('\n')
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end > 0) {
      let keep = true
      const fm: string[] = []
      for (const line of lines.slice(1, end)) {
        const kv = /^([A-Za-z_][\w-]*)(\s*:.*)$/.exec(line)
        if (kv) {
          const key = map[kv[1]] ?? kv[1]
          keep = KNOWN_KEYS.has(key)
          if (keep) fm.push(key + kv[2])
          continue
        }
        if (keep) fm.push(line)
      }
      src = ['---', ...fm, '---', ...lines.slice(end + 1)].join('\n')
    }
  }
  const r = parseMdc(src, { path: opts.path, id: opts.id })
  const rule: MdcRule = { ...r.rule, source: 'markdown-dir' }
  if (opts.as === 'always') { rule.alwaysApply = true; rule.type = 'always' }
  return { rule, diagnostics: r.diagnostics.filter((d) => d.code !== 'G011') }
}

function getPath(v: Value | undefined, path: string | undefined): Value | undefined {
  if (!path) return v
  let cur: Value | undefined = v
  for (const k of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur) && /^\d+$/.test(k)) cur = cur[Number(k)]
    else if (typeof cur === 'object' && !Array.isArray(cur)) cur = (cur as Record<string, Value>)[k]
    else return undefined
  }
  return cur
}

function globsOf(v: Value | undefined): string[] {
  if (typeof v === 'string') return parseGlobList(v)
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
  return []
}

/** `{{ item.from }} не імпортує {{ item.to }}`: each `{{ expr }}` is a core expression over `{ item, index }`. */
export function renderItemTemplate(template: string, item: Value, index: number): string {
  return splitTemplate(template).map((p) => {
    if ('text' in p) return p.text
    try { return toText(evalSource(p.expr, { item, index }, newBudget(1000))) } catch { return '' }
  }).join('')
}

/** Rules from a provider value (`provider` source): `field` (or `pick`) selects a list (an object's values,
 * a single value), each element becomes one rule. Body: `template`, else the element's `body`/`text`/
 * `message`/`description`, else the element as text. Id: `<provider>/<element id|name|index>`. `as: "always"`
 * → Always; otherwise (`as: "rule"`) an element with `globs`/`paths` is Auto Attached and one without is Always
 * (provider rules have no file to fall back on, so they are never Manual or Agent Requested). */
export function providerRules(value: Value | undefined, src: ItemSourceConfig): { rules: MdcRule[]; diagnostics: Diagnostic[] } {
  const name = src.name ?? 'provider'
  const diagnostics: Diagnostic[] = []
  if (value === null || value === undefined) return { rules: [], diagnostics }
  if (typeof value === 'object' && !Array.isArray(value) && (value as Record<string, Value>).unverified === true) {
    diagnostics.push(diag('G203', `Провайдер ${name}: правила не отримано (unverified)`))
    return { rules: [], diagnostics }
  }
  const picked = getPath(value, src.field ?? src.pick)
  if (picked === undefined || picked === null) {
    diagnostics.push(diag('G313', `itemSources provider ${name}: поле ${src.field ?? src.pick} відсутнє в даних провайдера`))
    return { rules: [], diagnostics }
  }
  const list: Value[] = Array.isArray(picked) ? picked : typeof picked === 'object' ? Object.entries(picked).map(([k, v]): Value => (v && typeof v === 'object' && !Array.isArray(v) ? { id: k, ...(v as Record<string, Value>) } : { id: k, text: v ?? null })) : [picked]
  const rules: MdcRule[] = []
  const used = new Set<string>()
  list.forEach((el, i) => {
    const obj = el && typeof el === 'object' && !Array.isArray(el) ? (el as Record<string, Value>) : undefined
    const body = src.template ? renderItemTemplate(src.template, el, i)
      : obj ? toText(obj.body ?? obj.text ?? obj.message ?? obj.description ?? null) || JSON.stringify(el)
      : toText(el)
    if (!body.trim()) return
    const key = obj && (typeof obj.id === 'string' || typeof obj.id === 'number') ? String(obj.id) : obj && typeof obj.name === 'string' ? obj.name : String(i)
    let id = `${name}/${key.replace(/[^\w.@-]+/g, '-')}`
    for (let n = 2; used.has(id); n++) id = `${name}/${key}-${n}`
    used.add(id)
    const all = globsOf(obj?.globs ?? obj?.paths)
    const globs = all.filter((g) => !g.startsWith('!'))
    const negGlobs = all.filter((g) => g.startsWith('!')).map((g) => g.slice(1))
    const auto = src.as !== 'always' && globs.length > 0
    const rule: MdcRule = { id, path: `provider:${name}`, type: auto ? 'auto' : 'always', globs: auto ? globs : [], negGlobs: auto ? negGlobs : [], alwaysApply: !auto, body: body.trim(), fileRefs: [], source: `provider:${name}` }
    if (obj && typeof obj.description === 'string' && src.template) rule.description = obj.description
    rules.push(rule)
  })
  return { rules, diagnostics }
}

/** A rule that lives in a repo file (instruction-file delivery is possible), as opposed to provider data. */
export function isFileRule(rule: Pick<MdcRule, 'source'>): boolean {
  return !rule.source?.startsWith('provider:')
}

// ───────────────────────── all rule sources over a sync file port ─────────────────────────

/** Repo access for `loadRuleSources`: repo-relative POSIX paths (`''` is the root). */
export interface RuleSourceFs {
  /** Entries of a directory; `[]` when it is missing. Links are reported as their target kind or skipped. */
  list(dir: string): { name: string; kind: 'file' | 'dir' }[]
  read(path: string): string | undefined
}

const RULE_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', 'vendor', '.venv'])
const RULE_MAX_DEPTH = 6
const RULE_MAX_DIRS = 400
const MD_RULE_FILE = /^(?!readme\.md$).+\.(md|markdown)$/i

function trimRuleDir(d: string): string {
  return d.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function listRuleFiles(fs: RuleSourceFs, dir: string, ext: RegExp, out: string[], depth = 0): void {
  if (depth > RULE_MAX_DEPTH) return
  for (const e of fs.list(dir)) {
    const rel = dir ? `${dir}/${e.name}` : e.name
    if (e.kind === 'file' && ext.test(e.name)) out.push(rel)
    else if (e.kind === 'dir' && !RULE_SKIP_DIRS.has(e.name)) listRuleFiles(fs, rel, ext, out, depth + 1)
  }
}

/** `*\/.cursor/rules` below the root (the `nested` option), breadth-first with the mod's caps. */
export function nestedCursorRuleDirs(fs: RuleSourceFs): string[] {
  const found: string[] = []
  const queue: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }]
  let visited = 0
  while (queue.length && visited < RULE_MAX_DIRS) {
    const { rel, depth } = queue.shift()!
    visited++
    for (const e of fs.list(rel)) {
      if (e.kind !== 'dir') continue
      if (e.name === '.cursor' && rel) found.push(`${rel}/.cursor/rules`)
      if (e.name.startsWith('.') || RULE_SKIP_DIRS.has(e.name) || depth + 1 > RULE_MAX_DEPTH) continue
      queue.push({ rel: rel ? `${rel}/${e.name}` : e.name, depth: depth + 1 })
    }
  }
  return found
}

/**
 * Every rule source of the config, as the mod's layer 1 loads them (G-04, G-51): `.cursor/rules` plus each
 * `cursor-mdc` `dir` (and nested `*\/.cursor/rules` when asked), `markdown-dir` sources, then `provider` sources.
 * `providerValue(name)` gives the provider's data; `undefined` means the adapter cannot produce it (a `G208` info
 * names the skipped source). Ids are unique: a later source never replaces an earlier rule with the same id.
 */
export function loadRuleSources(cfg: GateConfig, fs: RuleSourceFs, opts: { providerValue?: (name: string) => Value | undefined } = {}): { rules: MdcRule[]; diagnostics: Diagnostic[] } {
  const rules: MdcRule[] = []
  const diagnostics: Diagnostic[] = []
  if (cfg.cursorRules?.enabled === false) return { rules, diagnostics }
  const { dirs, nested } = cursorRuleDirs(cfg)
  const mdc: string[] = []
  for (const d of dirs) listRuleFiles(fs, trimRuleDir(d), /\.mdc$/, mdc)
  if (nested) for (const d of nestedCursorRuleDirs(fs)) listRuleFiles(fs, d, /\.mdc$/, mdc)
  for (const path of [...new Set(mdc)].sort()) {
    const text = fs.read(path)
    if (text === undefined) continue
    const { id, dirPrefix } = ruleIdFromPath(path, dirs)
    const r = parseMdc(text, { path, id, dirPrefix })
    diagnostics.push(...r.diagnostics)
    const dup = rules.find((x) => x.id === r.rule.id)
    if (dup) { diagnostics.push(diag('G001', `Правило ${r.rule.id}: id уже має ${dup.path}; ${path} пропущено`, { path, severity: 'warning' })); continue }
    rules.push(r.rule)
  }
  const has = (id: string) => rules.some((x) => x.id === id)
  const md: { path: string; src: ItemSourceConfig }[] = []
  for (const src of ruleSourcesOf(cfg)) {
    if (src.kind !== 'markdown-dir' || !src.dir) continue
    const found: string[] = []
    listRuleFiles(fs, trimRuleDir(src.dir), MD_RULE_FILE, found)
    for (const path of found) md.push({ path, src })
  }
  for (const f of md.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const text = fs.read(f.path)
    if (text === undefined) continue
    const r = parseMarkdownRule(text, { path: f.path, id: markdownRuleId(f.path, trimRuleDir(f.src.dir!)), ...(f.src.frontmatter ? { frontmatter: f.src.frontmatter } : {}), ...(f.src.as ? { as: f.src.as } : {}) })
    if (!has(r.rule.id)) rules.push(r.rule)
    diagnostics.push(...r.diagnostics)
  }
  for (const src of ruleSourcesOf(cfg)) {
    if (src.kind !== 'provider' || !src.name) continue
    const v = opts.providerValue?.(src.name)
    if (v === undefined) {
      diagnostics.push(diag('G208', `itemSources provider ${src.name}: дані провайдера недоступні в цьому адаптері — правила пропущено`))
      continue
    }
    const r = providerRules(v, src)
    for (const rule of r.rules) if (!has(rule.id)) rules.push(rule)
    diagnostics.push(...r.diagnostics)
  }
  return { rules, diagnostics }
}
