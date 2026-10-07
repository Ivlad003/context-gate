// TSX analysis for `*.prompt.tsx` (SPEC "Редактор DSL та індекс автокомпліту", Р1 level 1).
// Finds expression strings in component props (`when`, `test`, `of`, `n`, `value`, `expr`, `args`,
// `cells`, …) and `{{ }}` placeholders in string literals, then checks / completes / hovers them with
// `exprcheck.ts` against the Ctx model. Pure: the TypeScript module is passed in (tsserver gives the
// plugin its own copy; tests import `typescript`), nothing here touches the file system.

import type TS from 'typescript'
import type { Code, Diagnostic } from '../../core/src/types.ts'
import { templateClose } from '../../core/src/expr.ts'
import { checkExpr, completeExpr, hoverExpr, inferShape, type Bindings, type CompletionResult, type ExprHover } from './exprcheck.ts'
import type { CtxModel, Shape } from './model.ts'

type TSModule = typeof TS

/** Expression props that hold a list (array or object of expressions); other props take one string. */
const LIST_PROPS = new Set(['Table.cells', 'Call.args', 'Call.kwargs', 'Debug.exprs'])

/** String props the renderer never interpolates (`{{ }}` there is literal text). */
const NO_TEMPLATE = new Set(['Include.text', 'Include.description', 'Include.path', 'Lazy.path', 'Use.path'])

/** Props whose string value is a whole expression, per component. */
export const EXPR_PROPS: Record<string, string[]> = {
  Section: ['when'],
  If: ['test'],
  Assert: ['test'],
  Each: ['of'],
  Let: ['value'],
  Set: ['value'],
  Repeat: ['n'],
  V: ['expr'],
  Table: ['rows', 'cells'],
  Call: ['args', 'kwargs'],
  Debug: ['exprs'],
  HealthWarning: ['threshold'],
  CursorRules: ['match'],
}

export interface ExprSite {
  /** Absolute offsets of the expression source inside the file. */
  start: number
  end: number
  text: string
  component: string
  prop: string
  /** From a `{{ }}` placeholder rather than a whole-expression prop. */
  template: boolean
  section?: string
  /** Value offset → file offset (escapes in string literals, JSX entities, CRLF in template literals). */
  map?: number[]
  /** An unclosed `{{`: literal text for the core, so only completion and hover use it. */
  unclosed?: boolean
}

export interface SectionInfo { id: string; scope?: string; start: number; end: number; idStart: number; idEnd: number; line: number }

export interface IncludeInfo {
  tag: 'Include' | 'Skill' | 'Rule'
  start: number
  end: number
  mode?: string
  /** Range of the `mode` attribute initializer (with quotes / braces). */
  modeRange?: { start: number; end: number }
  /** Where to insert a new attribute (right after the tag name). */
  insertAt: number
  section?: string
}

export interface BindingFact {
  name: string
  kind: 'item' | 'index' | 'value' | 'ns' | 'number'
  of?: string
  shape?: Shape
  /** File range where the binding is visible (an `Each` body, a function); file-wide without it. */
  scope?: { start: number; end: number }
}

export interface FileFacts {
  sites: ExprSite[]
  sections: SectionInfo[]
  includes: IncludeInfo[]
  bindings: BindingFact[]
  /** `<Run>` without `cache` inside a `static` section. */
  uncachedStaticRuns: { start: number; end: number; section: string }[]
  /** Skill args from `<Prompt as="skill" args={{…}}>`. */
  skillArgs?: Record<string, Shape>
}

export interface FileDiag {
  start: number
  length: number
  code: Code
  severity: 'error' | 'warning' | 'info'
  message: string
  hint?: string
}

// ───────────────────────── scanning ─────────────────────────

function tagName(ts: TSModule, n: TS.JsxOpeningLikeElement): string {
  const t = n.tagName
  return ts.isIdentifier(t) ? t.text : ts.isPropertyAccessExpression(t) ? t.name.text : t.getText()
}

function attr(ts: TSModule, el: TS.JsxOpeningLikeElement, name: string): TS.JsxAttribute | undefined {
  for (const p of el.attributes.properties) if (ts.isJsxAttribute(p) && p.name.getText() === name) return p
  return undefined
}

function stringLit(ts: TSModule, e: TS.Node | undefined): TS.StringLiteral | TS.NoSubstitutionTemplateLiteral | undefined {
  if (!e) return undefined
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e
  if (ts.isJsxExpression(e)) return stringLit(ts, e.expression)
  if (ts.isParenthesizedExpression(e)) return stringLit(ts, e.expression)
  return undefined
}

function attrString(ts: TSModule, el: TS.JsxOpeningLikeElement, name: string): string | undefined {
  const a = attr(ts, el, name)
  const s = stringLit(ts, a?.initializer)
  return s?.text
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

/**
 * The value of a string literal as the build sees it, with a map value index → file offset (one entry per value
 * char plus the end). JSX attribute strings have no escapes but decode HTML entities; JS strings and template
 * literals decode escapes, and a template literal's CRLF (or lone CR) is one `\n` (TS `.text` is cooked).
 */
export function literalValue(ts: TSModule, text: string, node: TS.StringLiteral | TS.NoSubstitutionTemplateLiteral, sf: TS.SourceFile): { value: string; map: number[] } {
  const start = node.getStart(sf) + 1
  const end = node.end - 1
  let value = ''
  const map: number[] = []
  const push = (s: string, at: number): void => { value += s; for (let k = 0; k < s.length; k++) map.push(at) }
  if (node.parent && ts.isJsxAttribute(node.parent)) {
    for (let i = start; i < end;) {
      const m = text[i] === '&' ? /^&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/.exec(text.slice(i, Math.min(end, i + 12))) : null
      const e = m?.[1]
      const code = e?.[0] === '#' ? (e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : undefined
      const decoded = !e ? undefined : code !== undefined ? (Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : undefined) : ENTITIES[e]
      if (m && decoded !== undefined) { push(decoded, i); i += m[0].length; continue }
      push(text[i]!, i)
      i++
    }
    map.push(end)
    return { value, map }
  }
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' }
  for (let i = start; i < end;) {
    const c = text[i]!
    if (c === '\r') { push('\n', i); i += text[i + 1] === '\n' ? 2 : 1; continue }
    if (c !== '\\') { push(c, i); i++; continue }
    const e = text[i + 1] ?? ''
    // Line continuation: no value char.
    if (e === '\r' || e === '\n' || e === '\u2028' || e === '\u2029') { i += e === '\r' && text[i + 2] === '\n' ? 3 : 2; continue }
    if (e in simple) { push(simple[e]!, i); i += 2; continue }
    if (e === '0' && !/[0-9]/.test(text[i + 2] ?? '')) { push('\0', i); i += 2; continue }
    if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 2, i + 4))) { push(String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16)), i); i += 4; continue }
    if (e === 'u') {
      const b = /^\{([0-9a-fA-F]{1,6})\}/.exec(text.slice(i + 2, i + 10))
      if (b) { push(String.fromCodePoint(Math.min(0x10ffff, parseInt(b[1]!, 16))), i); i += 2 + b[0].length; continue }
      if (/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { push(String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)), i); i += 6; continue }
    }
    // `\"`, `\\`, `\/`, …: the next char stands for itself.
    push(e, i)
    i += 2
  }
  map.push(end)
  return { value, map }
}

function makeSite(lv: { value: string; map: number[] }, valueStart: number, valueEnd: number, rest: Omit<ExprSite, 'start' | 'end' | 'text' | 'map'>): ExprSite {
  const at = (i: number): number => lv.map[Math.min(i, lv.map.length - 1)]!
  const site: ExprSite = { ...rest, start: at(valueStart), end: at(valueEnd), text: lv.value.slice(valueStart, valueEnd) }
  // Only a literal whose value is not a plain copy of its source needs the offset map.
  const map = lv.map.slice(valueStart, valueEnd + 1)
  if (map.some((x, i) => x !== site.start + i)) site.map = map
  return site
}

/** Placeholders of a template string: [contentStart, contentEnd) value offsets; an unclosed `{{` runs to the end. */
export function placeholderRanges(s: string): [number, number][] {
  const out: [number, number][] = []
  let i = 0
  while (i < s.length) {
    const open = s.indexOf('{{', i)
    if (open < 0) break
    let close = templateClose(s, open + 2)
    if (close < 0) close = s.indexOf('}}', open + 2)
    let a = open + 2
    let b = close < 0 ? s.length : close
    while (a < b && /\s/.test(s[a]!)) a++
    while (b > a && /\s/.test(s[b - 1]!)) b--
    out.push([a, b])
    if (close < 0) break
    i = close + 2
  }
  return out
}

/** Whether the placeholder range ending at `end` (from `placeholderRanges`) has no closing `}}`: literal text for the core. */
export function isUnclosed(s: string, end: number): boolean {
  return !s.slice(end).trimStart().startsWith('}}')
}

function skillArgShapes(ts: TSModule, init: TS.Node | undefined): Record<string, Shape> | undefined {
  const e = init && ts.isJsxExpression(init) ? init.expression : undefined
  if (!e || !ts.isObjectLiteralExpression(e)) return undefined
  const out: Record<string, Shape> = {}
  for (const p of e.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue
    const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined
    if (!name) continue
    let shape: Shape = { k: 'any' }
    if (ts.isPropertyAssignment(p) && ts.isCallExpression(p.initializer) && ts.isPropertyAccessExpression(p.initializer.expression)) {
      const kind = p.initializer.expression.name.text
      if (kind === 'number') shape = { k: 'prim', t: 'number' }
      else if (kind === 'flag') shape = { k: 'prim', t: 'boolean' }
      else if (kind === 'list') shape = { k: 'array', item: { k: 'prim', t: 'string' } }
      else if (kind === 'enum') {
        const a0 = p.initializer.arguments[0]
        const values = a0 && ts.isArrayLiteralExpression(a0) ? a0.elements.filter(ts.isStringLiteral).map((x) => x.text) : undefined
        shape = { k: 'prim', t: 'string', ...(values?.length ? { values } : {}) }
      } else if (kind === 'string' || kind === 'path' || kind === 'rest') shape = { k: 'prim', t: 'string' }
    }
    out[name] = { ...shape, doc: `аргумент skill --${name}` } as Shape
  }
  return out
}

/** Collect expression sites, sections, includes and bindings of a `.prompt.tsx` file. */
export function scanTsx(ts: TSModule, fileName: string, text: string): FileFacts {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const facts: FileFacts = { sites: [], sections: [], includes: [], bindings: [], uncachedStaticRuns: [] }
  const claimed = new Set<TS.Node>()
  const sectionStack: { id: string; scope?: string }[] = []
  let rawDepth = 0

  /** String literals of a prop; arrays and objects only for props that hold expression lists (`list`). */
  const exprLiterals = (init: TS.Node | undefined, list = true): (TS.StringLiteral | TS.NoSubstitutionTemplateLiteral)[] => {
    if (!init) return []
    const s = stringLit(ts, init)
    if (s) return [s]
    const e = ts.isJsxExpression(init) ? init.expression : init
    if (!e || !list) return []
    if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((x) => exprLiterals(x))
    if (ts.isObjectLiteralExpression(e)) return e.properties.flatMap((p) => (ts.isPropertyAssignment(p) ? exprLiterals(p.initializer) : []))
    return []
  }

  const addTemplates = (lit: TS.StringLiteral | TS.NoSubstitutionTemplateLiteral, component: string, prop: string): void => {
    claimed.add(lit)
    if (!lit.getText(sf).includes('{') && !lit.getText(sf).includes('&#')) return
    const lv = literalValue(ts, text, lit, sf)
    if (!lv.value.includes('{{')) return
    const section = sectionStack[sectionStack.length - 1]?.id
    for (const [a, b] of placeholderRanges(lv.value)) facts.sites.push(makeSite(lv, a, b, { component, prop, template: true, ...(section ? { section } : {}), ...(isUnclosed(lv.value, b) ? { unclosed: true } : {}) }))
  }

  const visitOpening = (el: TS.JsxOpeningLikeElement, whole: TS.Node): void => {
    const name = tagName(ts, el)
    const section = sectionStack[sectionStack.length - 1]?.id
    const exprProps = EXPR_PROPS[name] ?? []
    for (const p of el.attributes.properties) {
      if (!ts.isJsxAttribute(p)) continue
      const prop = p.name.getText()
      if (exprProps.includes(prop)) {
        // `Each of={['a', 'b']}` is build-time data, not a list of expressions.
        for (const lit of exprLiterals(p.initializer, LIST_PROPS.has(`${name}.${prop}`))) {
          claimed.add(lit)
          const lv = literalValue(ts, text, lit, sf)
          facts.sites.push(makeSite(lv, 0, lv.value.length, { component: name, prop, template: false, ...(section ? { section } : {}) }))
        }
      } else if (NO_TEMPLATE.has(`${name}.${prop}`) || /^[a-z]/.test(name) || name === 'Run') {
        // Never interpolated at render: Include text/description, intrinsic attributes, Run props.
        for (const lit of exprLiterals(p.initializer)) claimed.add(lit)
      } else {
        // Mcp args, Fence title, Log message, …: only `{{ }}` placeholders are expressions.
        for (const lit of exprLiterals(p.initializer)) addTemplates(lit, name, prop)
      }
    }
    const as = attrString(ts, el, 'as')
    switch (name) {
      case 'Each': {
        const of = attrString(ts, el, 'of')
        const index = attrString(ts, el, 'index')
        // Function child `{r => …}` names the item.
        let fnParams: string[] = []
        if (ts.isJsxElement(whole)) {
          for (const c of whole.children) {
            if (ts.isJsxExpression(c) && c.expression && (ts.isArrowFunction(c.expression) || ts.isFunctionExpression(c.expression))) {
              fnParams = c.expression.parameters.map((x) => (ts.isIdentifier(x.name) ? x.name.text : ''))
            }
          }
        }
        const itemName = as ?? (fnParams[0] || 'it')
        // The item is visible in the body only, so two loops may reuse a name with different shapes.
        const scope = { start: el.getEnd(), end: whole.getEnd() }
        facts.bindings.push({ name: itemName, kind: 'item', ...(of !== undefined ? { of } : {}), scope })
        const idx = index ?? fnParams[1]
        if (idx) facts.bindings.push({ name: idx, kind: 'index', scope })
        break
      }
      case 'Let': case 'Set': case 'Store': {
        const n = attrString(ts, el, 'name')
        const value = attrString(ts, el, 'value')
        if (n) facts.bindings.push({ name: n, kind: 'value', ...(value !== undefined ? { of: value } : {}) })
        break
      }
      case 'Run': {
        if (as) facts.bindings.push({ name: as, kind: 'value', shape: { k: 'object', props: { stdout: { k: 'prim', t: 'string' }, stderr: { k: 'prim', t: 'string' }, exitCode: { k: 'prim', t: 'number' }, ms: { k: 'prim', t: 'number' } }, open: true, doc: 'результат <Run>' } })
        const cur = sectionStack[sectionStack.length - 1]
        if (cur?.scope === 'static' && !attr(ts, el, 'cache')) facts.uncachedStaticRuns.push({ start: whole.getStart(sf), end: el.getEnd(), section: cur.id })
        break
      }
      case 'Call': {
        const f = attrString(ts, el, 'fn')
        const n = as ?? f?.split('.').pop()
        if (n) facts.bindings.push({ name: n, kind: 'value' })
        break
      }
      case 'Mcp': {
        const n = as ?? attrString(ts, el, 'tool')
        if (n) facts.bindings.push({ name: n, kind: 'value' })
        break
      }
      case 'Use': {
        const n = attrString(ts, el, 'name')
        if (n) facts.bindings.push({ name: n, kind: 'ns' })
        break
      }
      case 'Repeat': facts.bindings.push({ name: 'i', kind: 'number', scope: { start: el.getEnd(), end: whole.getEnd() } }); break
      case 'Table': facts.bindings.push({ name: 'row', kind: 'item', ...(attrString(ts, el, 'rows') !== undefined ? { of: attrString(ts, el, 'rows')! } : {}) }); break
      case 'Include': case 'Skill': case 'Rule': {
        const m = attr(ts, el, 'mode')
        const info: IncludeInfo = { tag: name, start: whole.getStart(sf), end: whole.getEnd(), insertAt: el.tagName.getEnd(), ...(section ? { section } : {}) }
        if (m) {
          const mv = stringLit(ts, m.initializer)
          if (mv) info.mode = mv.text
          else if (m.initializer && ts.isJsxExpression(m.initializer)) info.mode = '<expr>'
          if (m.initializer) info.modeRange = { start: m.initializer.getStart(sf), end: m.initializer.getEnd() }
        } else info.mode = name === 'Include' ? 'inline' : 'ref'
        facts.includes.push(info)
        break
      }
      case 'Prompt': {
        if (attrString(ts, el, 'as') === 'skill') {
          const a = attr(ts, el, 'args')
          facts.skillArgs = skillArgShapes(ts, a?.initializer) ?? {}
        }
        break
      }
    }
  }

  const visit = (node: TS.Node, inJsx: boolean): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node
      const name = tagName(ts, opening)
      let pushed = false
      if (name === 'Section') {
        const idAttr = attr(ts, opening, 'id')
        const idLit = stringLit(ts, idAttr?.initializer)
        if (idLit) {
          const scope = attrString(ts, opening, 'scope')
          const start = node.getStart(sf)
          facts.sections.push({ id: idLit.text, ...(scope ? { scope } : {}), start, end: node.getEnd(), idStart: idLit.getStart(sf) + 1, idEnd: idLit.getEnd() - 1, line: sf.getLineAndCharacterOfPosition(start).line + 1 })
          sectionStack.push({ id: idLit.text, ...(scope ? { scope } : {}) })
          pushed = true
        }
      }
      visitOpening(opening, node)
      // `<Run>` code and `<Lazy>` descriptions are never interpolated: `{{ .State }}` there is not an expression.
      const raw = name === 'Run' || name === 'Lazy'
      if (raw) rawDepth++
      ts.forEachChild(node, (c) => visit(c, true))
      if (raw) rawDepth--
      if (pushed) sectionStack.pop()
      return
    }
    if (inJsx && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !claimed.has(node) && !rawDepth) {
      const parent = node.parent
      const component = parent && ts.isJsxAttribute(parent) ? 'attr' : 'text'
      addTemplates(node, component, component === 'attr' ? (parent as TS.JsxAttribute).name.getText() : 'children')
    }
    if (inJsx && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      const scope = { start: node.getStart(sf), end: node.getEnd() }
      for (const p of node.parameters) {
        if (!ts.isIdentifier(p.name)) continue
        const pname = p.name.text
        if (!facts.bindings.some((b) => b.name === pname && (!b.scope || (b.scope.start <= scope.start && scope.end <= b.scope.end)))) facts.bindings.push({ name: pname, kind: 'value', scope })
      }
    }
    ts.forEachChild(node, (c) => visit(c, inJsx || ts.isJsxFragment(node)))
  }
  visit(sf, false)
  facts.sites.sort((a, b) => a.start - b.start)
  return facts
}

/**
 * Bindings map for the expression checker, refining `Each` items from their `of` shapes. With `pos`, only the
 * bindings visible there count (scoped ones whose range holds it; the innermost, scanned last, wins).
 */
export function bindingsFor(facts: FileFacts, model: CtxModel, pos?: number): Bindings {
  const m: Bindings = new Map()
  const ANY: Shape = { k: 'any' }
  const visible = facts.bindings.filter((b) => !b.scope || pos === undefined || (pos >= b.scope.start && pos <= b.scope.end))
  // File-wide bindings first, so a scoped one (a loop item) overrides the same name.
  const ordered = [...visible.filter((b) => !b.scope), ...visible.filter((b) => b.scope)]
  for (const b of ordered) m.set(b.name, b.shape ?? (b.kind === 'number' || b.kind === 'index' ? { k: 'prim', t: 'number' } : ANY))
  const modelWithArgs = facts.skillArgs ? { ...model, roots: { ...model.roots, args: { k: 'object', props: facts.skillArgs, doc: 'аргументи skill' } as Shape } } : model
  for (const b of ordered) {
    if (b.of === undefined) continue
    const s = inferShape(b.of, modelWithArgs, m)
    if (b.kind === 'item') m.set(b.name, s.k === 'array' ? s.item : ANY)
    else if (b.kind === 'value') m.set(b.name, s)
  }
  return m
}

/** The model as seen from this file (skill args narrow `args`). */
export function fileModel(facts: FileFacts, model: CtxModel): CtxModel {
  return facts.skillArgs ? { ...model, roots: { ...model.roots, args: { k: 'object', props: facts.skillArgs, doc: 'аргументи skill' } } } : model
}

// ───────────────────────── diagnostics ─────────────────────────

const toFile = (site: ExprSite, off: number): number => (site.map ? site.map[Math.min(off, site.map.length - 1)]! : site.start + off)
const toLocal = (site: ExprSite, pos: number): number => {
  if (!site.map) return pos - site.start
  const i = site.map.findIndex((x) => x >= pos)
  return i < 0 ? site.text.length : i
}

/** Codes the live analysis computes itself; compiled copies of them are dropped. */
const LIVE_CODES = /^G1(0\d|5[47]|63|7\d)$/

/** Live diagnostics for a `.prompt.tsx` file plus compile diagnostics (G151, G160, …) from `.compiled`. */
export function analyzeFile(ts: TSModule, fileName: string, text: string, model: CtxModel, compiled?: { diagnostics?: Diagnostic[]; relPath?: string }): FileDiag[] {
  const facts = scanTsx(ts, fileName, text)
  const fm = fileModel(facts, model)
  const out: FileDiag[] = []
  for (const site of facts.sites) {
    if (site.unclosed) continue
    for (const d of checkExpr(site.text, fm, bindingsFor(facts, model, site.start))) {
      const start = toFile(site, d.start)
      const end = toFile(site, Math.max(d.end, d.start))
      out.push({ start, length: Math.max(1, end - start), code: d.code, severity: d.severity, message: `${d.message}`, ...(d.hint ? { hint: d.hint } : {}) })
    }
  }
  for (const r of facts.uncachedStaticRuns) {
    out.push({ start: r.start, length: Math.max(1, r.end - r.start), code: 'G163', severity: 'error', message: `<Run> без cache у static-секції "${r.section}": static рендериться один раз і має бути стабільною.`, hint: 'додай cache="1h" або перенеси в scope="volatile"' })
  }
  if (compiled?.diagnostics) {
    const lineOf = lineIndex(text)
    const scanned = new Set<number>()
    for (const site of facts.sites) for (let l = lineOf(site.start); l <= lineOf(site.end); l++) scanned.add(l)
    out.push(...compiledDiagnostics(compiled.diagnostics, text, compiled.relPath, { diagnostics: out, lines: scanned }))
  }
  return out
}

/** 1-based line of a file offset. */
function lineIndex(text: string): (off: number) => number {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  return (off: number): number => {
    let lo = 0, hi = lineStarts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid]! <= off) lo = mid; else hi = mid - 1 }
    return lo + 1
  }
}

/**
 * Map `.compiled/<id>.json` diagnostics of this file onto line ranges. A compiled copy of a code the live analysis
 * computes is dropped only when the live scan covers its line (a scanned expression there, or the same live code):
 * the scan sees string literals only, so a build error elsewhere (a component, an `e` template) must still show.
 * Without `live`, all such copies are dropped.
 */
export function compiledDiagnostics(diags: Diagnostic[], text: string, relPath?: string, live?: { diagnostics: FileDiag[]; lines: Set<number> }): FileDiag[] {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  const lineOf = lineIndex(text)
  const liveAt = new Set((live?.diagnostics ?? []).map((d) => `${d.code}@${lineOf(d.start)}`))
  const out: FileDiag[] = []
  for (const d of diags) {
    if (LIVE_CODES.test(d.code) && (live === undefined || d.line === undefined || live.lines.has(d.line) || liveAt.has(`${d.code}@${d.line}`))) continue
    if (relPath && d.path && !(d.path === relPath || d.path.endsWith('/' + relPath) || relPath.endsWith('/' + d.path) || relPath.endsWith(d.path))) continue
    const line = Math.min(Math.max(1, d.line ?? 1), lineStarts.length)
    const start = lineStarts[line - 1]!
    const lineEnd = line < lineStarts.length ? lineStarts[line]! - 1 : text.length
    const lead = /^\s*/.exec(text.slice(start, lineEnd))![0].length
    out.push({ start: start + lead, length: Math.max(1, lineEnd - start - lead), code: d.code, severity: d.severity, message: `${d.message} (остання збірка)`, ...(d.hint ? { hint: d.hint } : {}) })
  }
  return out
}

// ───────────────────────── completion / hover ─────────────────────────

export function siteAt(facts: FileFacts, pos: number): ExprSite | undefined {
  return facts.sites.find((s) => pos >= s.start && pos <= s.end)
}

export interface FileCompletion extends CompletionResult { site: ExprSite }

/** Completions at a file position, when it is inside an expression string. Positions in the result are file offsets. */
export function completeAt(ts: TSModule, fileName: string, text: string, pos: number, model: CtxModel): FileCompletion | undefined {
  const facts = scanTsx(ts, fileName, text)
  const site = siteAt(facts, pos)
  if (!site) return undefined
  const r = completeExpr(site.text, toLocal(site, pos), fileModel(facts, model), bindingsFor(facts, model, site.start))
  return { ...r, start: toFile(site, r.start), end: toFile(site, r.end), site }
}

export interface FileHover extends ExprHover { site: ExprSite; trace?: string[] }

/** Hover at a file position: type, doc, value from the last trace and trace lines of the section. */
export function hoverAt(ts: TSModule, fileName: string, text: string, pos: number, model: CtxModel): FileHover | undefined {
  const facts = scanTsx(ts, fileName, text)
  const site = siteAt(facts, pos)
  if (!site) return undefined
  const h = hoverExpr(site.text, toLocal(site, pos), fileModel(facts, model), bindingsFor(facts, model, site.start))
  if (!h) return undefined
  const res: FileHover = { ...h, start: toFile(site, h.start), end: toFile(site, h.end), site }
  if (site.section) {
    const lines = model.trace.filter((t) => t.section === site.section && t.detail.includes(h.text)).slice(0, 5).map((t) => `${t.kind}: ${t.detail}${t.source ? ` (${t.source})` : ''}`)
    if (lines.length) res.trace = lines
  }
  return res
}

/** Markdown text for a hover. */
export function hoverMarkdown(h: ExprHover & { trace?: string[] }): string {
  const parts = [`\`${h.text}\`: \`${h.type}\``]
  if (h.doc) parts.push(h.doc)
  parts.push(h.value !== undefined ? `Значення з останнього trace: \`${h.value}\`` : 'Значення: немає trace (`context-gate run --json` пише `.claude/prompt/.trace/last.json`).')
  if (h.trace?.length) parts.push(h.trace.map((t) => `- ${t}`).join('\n'))
  return parts.join('\n\n')
}

// ───────────────────────── code actions / symbols ─────────────────────────

export interface TextEdit { start: number; end: number; newText: string }

export type Refactor =
  | { name: 'extract-lazy'; title: string; edits: TextEdit[] }
  | { name: 'quick-variant'; title: string; section: string; command: string[] }

/** CLI command for "згенерувати quick-варіант" (proposal written by `expand`, never applied silently). */
export function quickVariantCommand(sectionId: string): string[] {
  return ['context-gate', 'expand', '--only', sectionId, '--tiers', 'quick']
}

export function sectionAt(facts: FileFacts, pos: number): SectionInfo | undefined {
  let best: SectionInfo | undefined
  for (const s of facts.sections) if (pos >= s.start && pos <= s.end && (!best || s.start >= best.start)) best = s
  return best
}

/** Refactors applicable at a position: "винести в Lazy" on Include/Skill/Rule, "згенерувати quick-варіант" in a Section. */
export function refactorsAt(ts: TSModule, fileName: string, text: string, pos: number): Refactor[] {
  const facts = scanTsx(ts, fileName, text)
  const out: Refactor[] = []
  const inc = facts.includes.filter((i) => pos >= i.start && pos <= i.end).sort((a, b) => b.start - a.start)[0]
  if (inc && inc.mode !== 'lazy') {
    const edits: TextEdit[] = inc.modeRange ? [{ start: inc.modeRange.start, end: inc.modeRange.end, newText: '"lazy"' }] : [{ start: inc.insertAt, end: inc.insertAt, newText: ' mode="lazy"' }]
    out.push({ name: 'extract-lazy', title: 'винести в Lazy', edits })
  }
  const sec = sectionAt(facts, pos)
  if (sec) out.push({ name: 'quick-variant', title: `згенерувати quick-варіант секції "${sec.id}"`, section: sec.id, command: quickVariantCommand(sec.id) })
  return out
}

/** Document symbols: the sections of the file. */
export function sectionSymbols(ts: TSModule, fileName: string, text: string): SectionInfo[] {
  return scanTsx(ts, fileName, text).sections
}

/** Numeric code for tsserver (`G170` → 90170, `H013` → 91013, `D001` → 92001). */
export function numericCode(code: Code): number {
  const n = Number(code.slice(1))
  return (code[0] === 'G' ? 90000 : code[0] === 'H' ? 91000 : 92000) + n
}
