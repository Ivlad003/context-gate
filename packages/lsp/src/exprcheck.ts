// Expression-level analysis against the Ctx model: diagnostics, completions and hover for one
// level-1 expression string (SPEC Р1). Pure; positions are offsets inside the expression source.
import { codeInfo } from '../../core/src/codes.ts'

import type { Code, Diagnostic, Scope_, Value } from '../../core/src/types.ts'
import { BUILTINS, FILTERS, evalExpr, newBudget, parseExpr, toText, type ExprAst } from '../../core/src/expr.ts'
import { membersOf, memberShape, shapeText, type CtxModel, type Shape } from './model.ts'

export interface ExprDiag {
  code: Code
  severity: 'error' | 'warning' | 'info'
  message: string
  /** Offset range inside the expression source. */
  start: number
  end: number
  hint?: string
}

/** Bound local names → shape (`as=`, `name=`, Each params, `i` of Repeat, `row` of Table, Use namespaces). */
export type Bindings = Map<string, Shape>

const ANY: Shape = { k: 'any' }
const NUM: Shape = { k: 'prim', t: 'number' }
const STR: Shape = { k: 'prim', t: 'string' }
const BOOL: Shape = { k: 'prim', t: 'boolean' }

export const FILTER_DOCS: Record<string, string> = {
  take: 'take(n) — перші n елементів',
  sort: 'sort("поле") — сортування за полем (або за значенням)',
  grep: 'grep("regex") — елементи, текст яких збігається',
  map: 'map("поле") або map("…{{ item.x }}…") — поле чи шаблон для кожного елемента',
  join: 'join(", ") — склеїти список у рядок',
  truncate: 'truncate(n) — обрізати текст до n символів',
  fence: 'fence("lang") — загорнути в ```-блок',
  unique: 'unique — без дублікатів',
  where: 'where("поле", значення) — фільтр за рівністю поля',
  len: 'len — довжина списку чи рядка',
  round: 'round(n) — округлення до n знаків',
  ago: 'ago — «5 хв тому» від мітки часу',
}

export const BUILTIN_DOCS: Record<string, string> = {
  len: 'len(x) — довжина списку чи рядка', min: 'min(a, b, …)', max: 'max(a, b, …)', abs: 'abs(x)', round: 'round(x, n?)', floor: 'floor(x)', ceil: 'ceil(x)',
}

const KEYWORDS = ['true', 'false', 'null', 'in']

/** Locate a dotted path in the source for a diagnostic range (first match at an identifier boundary). */
function findPath(src: string, path: string, from = 0): { start: number; end: number } {
  const re = new RegExp(`(^|[^\\w$.])(${path.split('.').map((p) => p.replace(/[$-]/g, '\\$&')).join('\\??\\.')})(?![\\w$])`, 'g')
  re.lastIndex = from
  const m = re.exec(src)
  if (m) { const start = m.index + m[1]!.length; return { start, end: start + m[2]!.length } }
  return { start: 0, end: src.length }
}

function pathOfAst(e: ExprAst): string[] | undefined {
  if (e.k === 'id') return [e.name]
  if (e.k === 'member') { const p = pathOfAst(e.obj); return p ? [...p, e.prop] : undefined }
  return undefined
}

function litShape(v: Value): Shape {
  if (typeof v === 'string') return STR
  if (typeof v === 'number') return NUM
  if (typeof v === 'boolean') return BOOL
  return ANY
}

interface Ctx { model: CtxModel; bound: Bindings; src: string; out: ExprDiag[]; seen: Set<string> }

function push(c: Ctx, d: Omit<ExprDiag, 'start' | 'end'>, path?: string): void {
  const key = `${d.code}:${d.message}`
  if (c.seen.has(key)) return
  c.seen.add(key)
  c.out.push({ ...d, ...(path ? findPath(c.src, path) : { start: 0, end: c.src.length }) })
}

function rootShape(c: Ctx, name: string, report: boolean): Shape {
  const b = c.bound.get(name)
  if (b) return b
  const r = c.model.roots[name]
  if (r) return r
  if (name === 'item' || name === 'i' || name === 'it' || name === 'row') return ANY
  if (report) push(c, { code: 'G171', severity: 'warning', message: `Невідома змінна «${name}»`, hint: codeInfo('G171')!.hint }, name)
  return ANY
}

function step(c: Ctx, s: Shape, prop: string, path: string[]): Shape {
  if (s.k === 'unknown') {
    push(c, { code: 'G170', severity: 'warning', message: `Поле «${[...path, prop].join('.')}»: провайдер «${s.provider}» без schema, тип unknown`, hint: 'Додай `schema` або згенеруй чернетку: `context-gate schema infer ' + s.provider + '`.' }, [...path, prop].join('.'))
    return ANY
  }
  const m = memberShape(s, prop)
  if (m) return m
  if (s.k === 'fn') {
    push(c, { code: 'G172', severity: 'warning', message: `«${path.join('.')}» — функція; виклич її: ${path.join('.')}(…)` }, path.join('.'))
    return ANY
  }
  const known = membersOf(s).map(([k]) => k)
  push(c, { code: 'G172', severity: 'warning', message: `Поле «${prop}» не існує в «${path.join('.')}»${known.length ? ` (є: ${known.slice(0, 10).join(', ')})` : ''}`, hint: codeInfo('G172')!.hint }, [...path, prop].join('.'))
  return ANY
}

function shapeOf(e: ExprAst, c: Ctx, report = true): Shape {
  switch (e.k) {
    case 'lit': return litShape(e.v)
    case 'list': { const items = e.items.map((i) => shapeOf(i, c, report)); return { k: 'array', item: items[0] ?? ANY } }
    case 'id': return rootShape(c, e.name, report)
    case 'member': {
      const base = shapeOf(e.obj, c, report)
      const path = pathOfAst(e.obj) ?? ['…']
      return report ? step(c, base, e.prop, path) : (memberShape(base, e.prop) ?? ANY)
    }
    case 'index': {
      const base = shapeOf(e.obj, c, report)
      shapeOf(e.index, c, report)
      if (base.k === 'array') return base.item
      if (base.k === 'object' && e.index.k === 'lit' && typeof e.index.v === 'string') return memberShape(base, e.index.v) ?? ANY
      return ANY
    }
    case 'unary': shapeOf(e.arg, c, report); return e.op === '!' ? BOOL : NUM
    case 'bin': {
      const l = shapeOf(e.l, c, report)
      const r = shapeOf(e.r, c, report)
      if (['==', '!=', '<', '<=', '>', '>=', '~', 'in'].includes(e.op)) return BOOL
      if (e.op === '??' || e.op === '||' || e.op === '&&') return l.k === 'any' ? r : l
      if (e.op === '+' && ((l.k === 'prim' && l.t === 'string') || (r.k === 'prim' && r.t === 'string'))) return STR
      return NUM
    }
    case 'cond': shapeOf(e.test, c, report); { const t = shapeOf(e.then, c, report); shapeOf(e.else, c, report); return t }
    case 'builtin': e.args.forEach((a) => shapeOf(a, c, report)); return NUM
    case 'method': {
      const base = shapeOf(e.obj, c, report)
      e.args.forEach((a) => shapeOf(a, c, report))
      if (e.fn === 'in') return BOOL
      return base.k === 'array' ? base.item : base.k === 'prim' && base.t === 'string' ? STR : ANY
    }
    case 'call': {
      e.args.forEach((a) => shapeOf(a, c, report))
      Object.values(e.kwargs).forEach((a) => shapeOf(a, c, report))
      const [root, ...rest] = e.path.split('.')
      const bound = c.bound.get(root!)
      if (bound && bound.k === 'any') return ANY // Use namespace or local
      let s = c.bound.get(root!) ?? c.model.roots[root!]
      if (!s) {
        if (report) push(c, { code: 'G157', severity: 'warning', message: `«${e.path}» не є функцією провайдера чи модуля (немає «${root}» у gate.json чи <Use>)`, hint: 'Додай провайдер у gate.json або <Use name="' + root + '" path="…" />.' }, e.path)
        return ANY
      }
      const walked: string[] = [root!]
      for (const seg of rest) {
        if (s.k === 'unknown' || s.k === 'any') return ANY
        const m = memberShape(s, seg)
        if (!m) {
          if (report) push(c, { code: 'G158', severity: 'warning', message: `Функції «${seg}» немає в «${walked.join('.')}»${membersOf(s).length ? ` (є: ${membersOf(s).map(([k]) => k).slice(0, 10).join(', ')})` : ''}` }, e.path)
          return ANY
        }
        walked.push(seg)
        s = m
      }
      return s.k === 'fn' ? s.ret : ANY
    }
    case 'pipe': {
      const input = shapeOf(e.input, c, report)
      e.args.forEach((a) => shapeOf(a, c, report))
      const item = input.k === 'array' ? input.item : ANY
      if (e.tpl) {
        const prev = c.bound.get('item')
        c.bound.set('item', item)
        for (const p of e.tpl) if (typeof p !== 'string') shapeOf(p, c, report)
        if (prev) c.bound.set('item', prev); else c.bound.delete('item')
      }
      switch (e.filter) {
        case 'take': case 'sort': case 'grep': case 'unique': case 'where': return input
        case 'map': {
          if (e.tpl) return { k: 'array', item: STR }
          const a = e.args[0]
          if (a?.k === 'lit' && typeof a.v === 'string') {
            let s: Shape = item
            for (const seg of a.v.split('.')) { const m = memberShape(s, seg); if (!m) { if (report && item.k === 'object' && !item.open) push(c, { code: 'G172', severity: 'warning', message: `map("${a.v}"): поля «${seg}» немає в елементі списку` }, undefined); s = ANY; break } s = m }
            return { k: 'array', item: s }
          }
          return { k: 'array', item: ANY }
        }
        case 'len': case 'round': return NUM
        default: return STR
      }
    }
  }
}

/** Diagnostics of one expression: parse errors (G1xx) and Ctx checks (G170/G171/G172/G157/G158). */
export function checkExpr(src: string, model: CtxModel, bound: Bindings = new Map()): ExprDiag[] {
  const r = parseExpr(src)
  if (!r.ast) {
    return r.diagnostics.map((d) => {
      const pos = /позиції (\d+)/.exec(d.message)
      const start = pos ? Math.min(Number(pos[1]), Math.max(0, src.length - 1)) : 0
      return { code: d.code, severity: d.severity, message: d.message, start, end: pos ? start + 1 : src.length, ...(d.hint ? { hint: d.hint } : {}) }
    })
  }
  const c: Ctx = { model, bound: new Map(bound), src, out: [], seen: new Set() }
  for (const d of r.diagnostics) c.out.push({ code: d.code, severity: d.severity, message: d.message, start: 0, end: src.length, ...(d.hint ? { hint: d.hint } : {}) })
  shapeOf(r.ast, c, true)
  return c.out
}

/** Shape of an expression without reporting (for `Each of` item types and hover). */
export function inferShape(src: string, model: CtxModel, bound: Bindings = new Map()): Shape {
  const r = parseExpr(src)
  if (!r.ast) return ANY
  return shapeOf(r.ast, { model, bound: new Map(bound), src, out: [], seen: new Set() }, false)
}

// ───────────────────────── completion ─────────────────────────

export interface ExprCompletion {
  name: string
  kind: 'variable' | 'property' | 'function' | 'filter' | 'keyword' | 'value'
  detail?: string
  /** Text to insert (defaults to name). */
  insert?: string
  sort?: string
}

export interface CompletionResult {
  entries: ExprCompletion[]
  /** Offset range inside the expression being replaced (the partial word). */
  start: number
  end: number
}

function inQuote(prefix: string): '"' | "'" | undefined {
  let q: '"' | "'" | undefined
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i]
    if (ch === '\\') { i++; continue }
    if (q) { if (ch === q) q = undefined } else if (ch === '"' || ch === "'") q = ch
  }
  return q
}

function resolvePath(segs: string[], model: CtxModel, bound: Bindings): Shape | undefined {
  let s: Shape | undefined = bound.get(segs[0]!) ?? model.roots[segs[0]!]
  for (const seg of segs.slice(1)) {
    if (!s) return undefined
    if (s.k === 'fn') s = s.ret
    s = memberShape(s, seg)
  }
  return s
}

const docOf = (s: Shape): string => [shapeText(s), s.doc].filter(Boolean).join(' — ')

/** Completions at `offset` inside expression `src`. */
export function completeExpr(src: string, offset: number, model: CtxModel, bound: Bindings = new Map()): CompletionResult {
  const prefix = src.slice(0, offset)
  const word = /[\w$-]*$/.exec(prefix)![0]
  const start = offset - word.length
  const end = offset + (/^[\w$-]*/.exec(src.slice(offset))![0].length)
  const quote = inQuote(prefix)

  // Profile / tier values: gate.profile == "fr|, gate.tier in ["q|, gate.profile.in(["…
  const valueCtx = /\bgate\.(profile|tier)\s*(?:==|!=|\s+in\s*\[[^\]]*|\.in\(\s*\[[^\]]*)\s*(["']?)([\w-]*)$/.exec(prefix)
  if (valueCtx) {
    const values = valueCtx[1] === 'profile' ? model.profiles : model.tiers
    const q = valueCtx[2] || ''
    const word2 = valueCtx[3]!
    return {
      start: offset - word2.length,
      end,
      entries: values.map((v) => ({ name: v, kind: 'value' as const, detail: valueCtx[1] === 'profile' ? 'профіль' : 'tier', insert: q ? v : `"${v}"` })),
    }
  }
  if (quote) return { entries: [], start, end }

  // Filters after `|`.
  if (/\|\s*[\w]*$/.test(prefix) && !/\|\|\s*[\w]*$/.test(prefix)) {
    return { start, end, entries: FILTERS.map((f) => ({ name: f, kind: 'filter' as const, detail: FILTER_DOCS[f] })) }
  }

  // Members after `a.b.`
  const mem = /((?:[A-Za-z_$][\w$]*)(?:\??\.[\w$-]+)*)\??\.([\w$-]*)$/.exec(prefix)
  if (mem) {
    const segs = mem[1]!.split(/\??\./)
    const s = resolvePath(segs, model, bound)
    if (!s) return { entries: [], start, end }
    const target = s.k === 'fn' ? s.ret : s
    const entries: ExprCompletion[] = membersOf(target).map(([k, v]) => ({ name: k, kind: v.k === 'fn' ? 'function' as const : 'property' as const, detail: docOf(v), ...(v.k === 'fn' ? { insert: `${k}(` } : {}) }))
    if (target.k === 'array' || (target.k === 'prim' && target.t === 'string')) entries.push({ name: 'at', kind: 'function', detail: '.at(i) — елемент за індексом', insert: 'at(' })
    entries.push({ name: 'in', kind: 'function', detail: '.in(список) — входження', insert: 'in(' })
    return { start, end, entries }
  }

  // Identifiers.
  const entries: ExprCompletion[] = []
  for (const [name, s] of bound) entries.push({ name, kind: 'variable', detail: `локальна — ${docOf(s)}`, sort: '0' })
  for (const [name, s] of Object.entries(model.roots)) if (!bound.has(name)) entries.push({ name, kind: 'variable', detail: docOf(s), sort: '1' })
  for (const b of BUILTINS) entries.push({ name: b, kind: 'function', detail: BUILTIN_DOCS[b], insert: `${b}(`, sort: '2' })
  for (const k of KEYWORDS) entries.push({ name: k, kind: 'keyword', sort: '3' })
  return { start, end, entries }
}

// ───────────────────────── hover ─────────────────────────

export interface ExprHover {
  start: number
  end: number
  /** Expression text the hover is about. */
  text: string
  type: string
  doc?: string
  /** Value from the last trace scope (JSON, truncated). */
  value?: string
}

function fmtValue(v: Value): string {
  const s = typeof v === 'string' ? JSON.stringify(v) : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : toText(v)
  return s.length > 500 ? s.slice(0, 500) + '…' : s
}

/** Evaluate `src` in a trace scope without host calls (calls give null). */
export function evalInScope(src: string, scope: Scope_): { value?: Value; error?: string } {
  const r = parseExpr(src)
  if (!r.ast) return { error: r.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ') }
  try {
    const diagnostics: Diagnostic[] = []
    const value = evalExpr(r.ast, scope, newBudget(), { diagnostics, now: Date.now() })
    return diagnostics.length ? { value, error: diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ') } : { value }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** Hover at `offset`: the identifier chain under the cursor (or a filter / builtin name). */
export function hoverExpr(src: string, offset: number, model: CtxModel, bound: Bindings = new Map()): ExprHover | undefined {
  if (offset < 0 || offset > src.length) return undefined
  let s = offset
  while (s > 0 && /[\w$.?-]/.test(src[s - 1]!)) s--
  let e = offset
  while (e < src.length && /[\w$-]/.test(src[e]!)) e++
  let text = src.slice(s, e).replace(/^[.?]+/, '')
  s = e - text.length
  if (!text || !/^[A-Za-z_$]/.test(text)) return undefined
  text = text.replace(/[.?]+$/, '')
  const before = src.slice(0, s)
  if (/\|\s*$/.test(before) && FILTER_DOCS[text]) return { start: s, end: e, text, type: 'filter', doc: FILTER_DOCS[text] }
  if (/^\s*\(/.test(src.slice(e)) && BUILTIN_DOCS[text] && !text.includes('.')) return { start: s, end: e, text, type: 'builtin', doc: BUILTIN_DOCS[text] }
  const segs = text.split(/\??\./)
  const shape = resolvePath(segs, model, bound) ?? (segs.length === 1 && ['item', 'i', 'it', 'row'].includes(segs[0]!) ? ANY : undefined)
  const out: ExprHover = { start: s, end: s + text.length, text, type: shape ? shapeText(shape) : 'невідомо' }
  if (shape?.doc) out.doc = shape.doc
  if (model.scope && segs.every((x) => /^[\w$-]+$/.test(x))) {
    const v = evalInScope(text, model.scope)
    if (v.error === undefined) out.value = fmtValue(v.value ?? null)
  }
  return out
}
