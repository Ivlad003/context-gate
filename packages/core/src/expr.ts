// Expression language of the prompt DSL (SPEC "Межі мови", "Змінні, арифметика і простий цикл", Р1).
// One tokenizer + Pratt parser for every expression string in the AST; a total evaluator over JSON values
// with a step budget. Nothing here can reach files, processes or the network: the only callables are
// builtins, whitelisted pipe filters and functions the host injects through `EvalEnv.call`.

import type { Diagnostic, Scope_, Value } from './types.ts'

// ───────────────────────── AST ─────────────────────────

export type BinOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '~' | 'in' | '&&' | '||' | '??'

export type TemplatePart = string | ExprAst

export type ExprAst =
  | { k: 'lit'; v: Value }
  | { k: 'list'; items: ExprAst[] }
  | { k: 'id'; name: string }
  | { k: 'member'; obj: ExprAst; prop: string; optional?: boolean }
  | { k: 'index'; obj: ExprAst; index: ExprAst }
  | { k: 'unary'; op: '!' | '-'; arg: ExprAst }
  | { k: 'bin'; op: BinOp; l: ExprAst; r: ExprAst }
  | { k: 'cond'; test: ExprAst; then: ExprAst; else: ExprAst }
  /** Builtin function: len min max abs round floor ceil. */
  | { k: 'builtin'; fn: string; args: ExprAst[] }
  /** Value method: `.at(i)`, `.in(list)`. */
  | { k: 'method'; obj: ExprAst; fn: 'at' | 'in'; args: ExprAst[] }
  /** Provider / module function call `ns.fn(args, k=v)`, resolved by the host. */
  | { k: 'call'; path: string; args: ExprAst[]; kwargs: Record<string, ExprAst> }
  /** `input | filter(args)`; `tpl` is the pre-parsed template of `map("…{{ item.x }}…")`. */
  | { k: 'pipe'; input: ExprAst; filter: string; args: ExprAst[]; tpl?: TemplatePart[] }

export const BUILTINS = ['len', 'min', 'max', 'abs', 'round', 'floor', 'ceil'] as const
export const FILTERS = ['take', 'sort', 'grep', 'map', 'join', 'truncate', 'fence', 'unique', 'where', 'len', 'round', 'ago'] as const

const BUILTIN_SET = new Set<string>(BUILTINS)
const FILTER_SET = new Set<string>(FILTERS)

// ───────────────────────── Tokenizer ─────────────────────────

interface Tok { t: 'num' | 'str' | 'id' | 'op' | 'eof'; v: string; num?: number; pos: number }

const OPS3 = ['===', '!==']
const OPS2 = ['?.', '??', '&&', '||', '==', '!=', '<=', '>=']
const OPS1 = '!~+-*/%()[],.?:|=<>'

const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c)
const isIdChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)

function tokenize(src: string, diags: Diagnostic[]): Tok[] {
  const toks: Tok[] = []
  let i = 0
  let afterDot = false
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; afterDot = false; continue }
    const start = i
    // Member segment right after `.`/`?.` without spaces: dashes allowed (`data.api-endpoints`).
    if (afterDot && (isIdChar(c))) {
      let j = i
      while (j < src.length && (isIdChar(src[j]) || (src[j] === '-' && j + 1 < src.length && isIdChar(src[j + 1]) && j > i))) j++
      toks.push({ t: 'id', v: src.slice(i, j), pos: start })
      i = j
      afterDot = false
      continue
    }
    afterDot = false
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9]/.test(src[j])) j++
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) { j++; while (j < src.length && /[0-9]/.test(src[j])) j++ }
      const text = src.slice(i, j)
      toks.push({ t: 'num', v: text, num: Number(text), pos: start })
      i = j
      continue
    }
    if (isIdStart(c)) {
      let j = i
      while (j < src.length && isIdChar(src[j])) j++
      toks.push({ t: 'id', v: src.slice(i, j), pos: start })
      i = j
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let out = ''
      let closed = false
      while (j < src.length) {
        const d = src[j]
        if (d === '\\' && j + 1 < src.length) {
          const e = src[j + 1]
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e
          j += 2
          continue
        }
        if (d === c) { closed = true; j++; break }
        out += d
        j++
      }
      if (!closed) diags.push({ code: 'G102', severity: 'error', message: `Незакритий рядок у виразі з позиції ${start}` })
      toks.push({ t: 'str', v: out, pos: start })
      i = j
      continue
    }
    const three = src.slice(i, i + 3)
    if (OPS3.includes(three)) { toks.push({ t: 'op', v: three.slice(0, 2), pos: start }); i += 3; continue }
    const two = src.slice(i, i + 2)
    if (OPS2.includes(two)) {
      toks.push({ t: 'op', v: two, pos: start })
      i += 2
      if (two === '?.') afterDot = true
      continue
    }
    if (OPS1.includes(c)) {
      toks.push({ t: 'op', v: c, pos: start })
      i++
      if (c === '.') afterDot = true
      continue
    }
    diags.push({ code: 'G101', severity: 'error', message: `Неочікуваний символ «${c}» у виразі на позиції ${start}` })
    i++
  }
  toks.push({ t: 'eof', v: '', pos: src.length })
  return toks
}

// ───────────────────────── Pratt parser ─────────────────────────

class ParseFail extends Error {}

const BIN_BP: Record<string, number> = {
  '??': 3, '||': 4, '&&': 5, '==': 6, '!=': 6, '~': 6, '<': 7, '<=': 7, '>': 7, '>=': 7, in: 7, '+': 8, '-': 8, '*': 9, '/': 9, '%': 9,
}

class Parser {
  toks: Tok[]
  i = 0
  diags: Diagnostic[]
  src: string
  constructor(toks: Tok[], diags: Diagnostic[], src: string) {
    this.toks = toks
    this.diags = diags
    this.src = src
  }
  peek(): Tok { return this.toks[this.i] }
  next(): Tok { return this.toks[this.i++] }
  isOp(v: string): boolean { const t = this.peek(); return t.t === 'op' && t.v === v }
  fail(message: string, code: Diagnostic['code'] = 'G101'): never {
    this.diags.push({ code, severity: 'error', message: `${message} у «${this.src}»` })
    throw new ParseFail(message)
  }
  expectOp(v: string): void {
    if (!this.isOp(v)) this.fail(`Очікувалось «${v}», знайдено «${this.peek().v || 'кінець'}»`)
    this.i++
  }

  lbp(t: Tok): number {
    if (t.t === 'op') {
      if (t.v === '|') return 1
      if (t.v === '?') return 2
      if (t.v === '.' || t.v === '?.' || t.v === '[' || t.v === '(') return 11
      return BIN_BP[t.v] ?? 0
    }
    if (t.t === 'id' && t.v === 'in') return 7
    return 0
  }

  expr(rbp: number): ExprAst {
    let left = this.nud()
    while (rbp < this.lbp(this.peek())) left = this.led(left)
    return left
  }

  nud(): ExprAst {
    const t = this.next()
    if (t.t === 'num') return { k: 'lit', v: t.num ?? 0 }
    if (t.t === 'str') return { k: 'lit', v: t.v }
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'lit', v: true }
      if (t.v === 'false') return { k: 'lit', v: false }
      if (t.v === 'null' || t.v === 'undefined') return { k: 'lit', v: null }
      return { k: 'id', name: t.v }
    }
    if (t.t === 'op') {
      if (t.v === '(') { const e = this.expr(0); this.expectOp(')'); return e }
      if (t.v === '[') {
        const items: ExprAst[] = []
        if (!this.isOp(']')) {
          for (;;) { items.push(this.expr(0)); if (this.isOp(',')) { this.i++; if (this.isOp(']')) break; continue } break }
        }
        this.expectOp(']')
        return { k: 'list', items }
      }
      if (t.v === '!' || t.v === '-') return { k: 'unary', op: t.v, arg: this.expr(10) }
      if (t.v === '+') return this.expr(10)
    }
    return this.fail(t.t === 'eof' ? 'Неочікуваний кінець виразу' : `Неочікуваний токен «${t.v}»`)
  }

  args(): { args: ExprAst[]; kwargs: Record<string, ExprAst> } {
    const args: ExprAst[] = []
    const kwargs: Record<string, ExprAst> = {}
    this.expectOp('(')
    if (!this.isOp(')')) {
      for (;;) {
        const t = this.peek()
        const n = this.toks[this.i + 1]
        if (t.t === 'id' && n.t === 'op' && n.v === '=') {
          this.i += 2
          kwargs[t.v] = this.expr(0)
        } else {
          if (Object.keys(kwargs).length) this.fail('Позиційний аргумент після іменованого')
          args.push(this.expr(0))
        }
        if (this.isOp(',')) { this.i++; continue }
        break
      }
    }
    this.expectOp(')')
    return { args, kwargs }
  }

  led(left: ExprAst): ExprAst {
    const t = this.next()
    if (t.t === 'id' && t.v === 'in') return { k: 'bin', op: 'in', l: left, r: this.expr(7) }
    switch (t.v) {
      case '.':
      case '?.': {
        const p = this.next()
        if (p.t !== 'id' && p.t !== 'num') this.fail('Очікувалось ім\'я поля після «.»')
        return { k: 'member', obj: left, prop: p.v, optional: t.v === '?.' || undefined }
      }
      case '[': {
        const index = this.expr(0)
        this.expectOp(']')
        return { k: 'index', obj: left, index }
      }
      case '(': {
        this.i--
        const { args, kwargs } = this.args()
        const hasKw = Object.keys(kwargs).length > 0
        if (left.k === 'id') {
          if (!BUILTIN_SET.has(left.name)) {
            this.diags.push({ code: 'G103', severity: 'error', message: `Невідома функція «${left.name}»`, hint: `Вбудовані: ${BUILTINS.join(', ')}; решта — через провайдер ns.fn(...)` })
            throw new ParseFail('unknown fn')
          }
          if (hasKw) this.fail(`Функція ${left.name} не приймає іменованих аргументів`, 'G108')
          return { k: 'builtin', fn: left.name, args }
        }
        if (left.k === 'member' && (left.prop === 'at' || left.prop === 'in')) {
          if (args.length !== 1 || hasKw) this.fail(`.${left.prop}() приймає один аргумент`, 'G105')
          return { k: 'method', obj: left.obj, fn: left.prop, args }
        }
        const path = pathOf(left)
        if (!path) this.fail('Викликати можна лише функції провайдерів (ns.fn) і вбудовані функції')
        return { k: 'call', path, args, kwargs }
      }
      case '?': {
        const then = this.expr(1)
        this.expectOp(':')
        const els = this.expr(1)
        return { k: 'cond', test: left, then, else: els }
      }
      case '|': {
        const f = this.next()
        if (f.t !== 'id') this.fail('Після «|» очікувалось ім\'я фільтра')
        if (this.isOp('.')) {
          this.diags.push({ code: 'G154', severity: 'error', message: `Виклик провайдера «${f.v}.…» не на початку ланцюжка pipe`, hint: 'перенести виклик на початок; ця логіка має жити в провайдері' })
          throw new ParseFail('G154')
        }
        if (!FILTER_SET.has(f.v)) {
          this.diags.push({ code: 'G104', severity: 'error', message: `Невідомий фільтр «${f.v}»`, hint: `Дозволені: ${FILTERS.join(', ')}` })
          throw new ParseFail('G104')
        }
        let args: ExprAst[] = []
        if (this.isOp('(')) {
          const r = this.args()
          if (Object.keys(r.kwargs).length) this.fail(`Фільтр ${f.v} не приймає іменованих аргументів`, 'G108')
          args = r.args
        }
        const node: ExprAst = { k: 'pipe', input: left, filter: f.v, args }
        if (f.v === 'map' && args[0]?.k === 'lit' && typeof args[0].v === 'string' && args[0].v.includes('{{')) {
          const r = parseTemplate(args[0].v)
          this.diags.push(...r.diagnostics)
          node.tpl = r.parts
        }
        return node
      }
    }
    if (t.t === 'op' && BIN_BP[t.v] !== undefined) {
      return { k: 'bin', op: t.v as BinOp, l: left, r: this.expr(BIN_BP[t.v]) }
    }
    return this.fail(`Неочікуваний токен «${t.v}»`)
  }
}

function pathOf(e: ExprAst): string | undefined {
  if (e.k === 'id') return e.name
  if (e.k === 'member') { const p = pathOf(e.obj); return p ? `${p}.${e.prop}` : undefined }
  return undefined
}

const parseCache = new Map<string, { ast?: ExprAst; diagnostics: Diagnostic[] }>()

/** Parse one expression string. Never throws; errors come back as G1xx diagnostics with `ast` undefined. */
export function parseExpr(src: string): { ast?: ExprAst; diagnostics: Diagnostic[] } {
  const hit = parseCache.get(src)
  if (hit) return hit
  const diagnostics: Diagnostic[] = []
  let ast: ExprAst | undefined
  if (!src.trim()) {
    diagnostics.push({ code: 'G101', severity: 'error', message: 'Порожній вираз' })
  } else {
    const toks = tokenize(src, diagnostics)
    if (!diagnostics.some(d => d.severity === 'error')) {
      const p = new Parser(toks, diagnostics, src)
      try {
        ast = p.expr(0)
        if (p.peek().t !== 'eof') p.fail(`Зайвий токен «${p.peek().v}»`)
      } catch (e) {
        if (!(e instanceof ParseFail)) throw e
        ast = undefined
      }
    }
  }
  const res = { ast: diagnostics.some(d => d.severity === 'error') ? undefined : ast, diagnostics }
  if (parseCache.size > 5000) parseCache.clear()
  parseCache.set(src, res)
  return res
}

/** Split `text {{ expr }} text` into literal and expression source parts (no parsing). */
export function splitTemplate(src: string): ({ text: string } | { expr: string })[] {
  const out: ({ text: string } | { expr: string })[] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{{', i)
    if (open < 0) { out.push({ text: src.slice(i) }); break }
    const close = src.indexOf('}}', open + 2)
    if (close < 0) { out.push({ text: src.slice(i) }); break }
    if (open > i) out.push({ text: src.slice(i, open) })
    out.push({ expr: src.slice(open + 2, close).trim() })
    i = close + 2
  }
  return out
}

/** Parse a `{{ }}` template into literal strings and expression ASTs. */
export function parseTemplate(src: string): { parts: TemplatePart[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const parts: TemplatePart[] = []
  for (const p of splitTemplate(src)) {
    if ('text' in p) { parts.push(p.text); continue }
    const r = parseExpr(p.expr)
    diagnostics.push(...r.diagnostics)
    parts.push(r.ast ?? { k: 'lit', v: null })
  }
  return { parts, diagnostics }
}

// ───────────────────────── Evaluation ─────────────────────────

export interface Budget { steps: number; limit: number }
export const DEFAULT_STEP_LIMIT = 10_000

export function newBudget(limit: number = DEFAULT_STEP_LIMIT): Budget { return { steps: 0, limit } }

/** Thrown internally when the step budget is exhausted; the renderer turns it into G155. */
export class StepLimitError extends Error {
  constructor(limit: number) { super(`G155: перевищено ліміт кроків ${limit}`) }
}

export interface EvalEnv {
  /** Resolver for `ns.fn(...)` calls. Absent → G157. Returns null while a value is not ready. */
  call?: (path: string, args: Value[], kwargs: Record<string, Value>) => Value
  diagnostics?: Diagnostic[]
  /** Current time (ms) for `ago`. */
  now?: number
}

function step(b: Budget, n = 1): void {
  b.steps += n
  if (b.steps > b.limit) throw new StepLimitError(b.limit)
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
export const isObj = (v: Value | undefined): v is { [k: string]: Value } => v !== null && typeof v === 'object' && !Array.isArray(v)

export function truthy(v: Value): boolean {
  if (v === null || v === false || v === 0 || v === '') return false
  if (Array.isArray(v) && v.length === 0) return false
  if (typeof v === 'number' && Number.isNaN(v)) return false
  return true
}

/** Text form of a value inside the prompt. */
export function toText(v: Value | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) return v.map(x => (isObj(x) || Array.isArray(x) ? JSON.stringify(x) : toText(x))).join(', ')
  return JSON.stringify(v)
}

export function deepEqual(a: Value, b: Value): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a), kb = Object.keys(b)
    return ka.length === kb.length && ka.every(k => hasOwn(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

function getProp(v: Value, prop: string): Value {
  if (Array.isArray(v)) {
    if (prop === 'length') return v.length
    if (/^-?\d+$/.test(prop)) return v[Number(prop)] ?? null
    return null
  }
  if (typeof v === 'string') return prop === 'length' ? v.length : null
  if (isObj(v)) return hasOwn(v, prop) ? (v[prop] ?? null) : null
  return null
}

/** Dotted path lookup on a value (`cost.chars`); '' → the value itself. */
export function getPath(v: Value, path: string): Value {
  if (!path) return v
  let cur: Value = v
  for (const seg of path.split('.')) { cur = getProp(cur, seg); if (cur === null) return null }
  return cur
}

/** Variable lookup along the frame chain (frames are prototype-linked objects); never reaches Object.prototype. */
export function lookup(scope: Scope_, name: string): Value {
  let o: object | null = scope
  while (o && o !== Object.prototype) {
    if (hasOwn(o, name)) return (o as Scope_)[name] ?? null
    o = Object.getPrototypeOf(o) as object | null
  }
  return null
}

function compare(a: Value, b: Value): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = typeof a === 'string' ? a : toText(a)
  const sb = typeof b === 'string' ? b : toText(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

const regexCache = new Map<string, RegExp | null>()
function regex(pattern: string, env: EvalEnv): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern) ?? null
  let re: RegExp | null = null
  if (pattern.length > 500) {
    env.diagnostics?.push({ code: 'G107', severity: 'warning', message: 'Регулярний вираз довший за 500 символів' })
  } else {
    try { re = new RegExp(pattern) } catch {
      env.diagnostics?.push({ code: 'G107', severity: 'warning', message: `Невірний регулярний вираз «${pattern}»` })
    }
  }
  regexCache.set(pattern, re)
  return re
}

function num(v: Value): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null }

function roundTo(n: number, digits: number): number {
  const f = 10 ** Math.max(0, Math.min(10, Math.trunc(digits)))
  return Math.round(n * f) / f
}

function arith(op: BinOp, a: Value, b: Value, env: EvalEnv): Value {
  if (op === '+') {
    if (typeof a === 'string' || typeof b === 'string') return toText(a) + toText(b)
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  }
  const x = num(a), y = num(b)
  if (x === null || y === null) return null
  switch (op) {
    case '+': return x + y
    case '-': return x - y
    case '*': return x * y
    case '/':
    case '%':
      if (y === 0) {
        env.diagnostics?.push({ code: 'G106', severity: 'warning', message: 'Ділення на нуль — результат null' })
        return null
      }
      return op === '/' ? x / y : x % y
  }
  return null
}

function evalBuiltin(fn: string, args: Value[]): Value {
  const a0 = args[0] ?? null
  switch (fn) {
    case 'len':
      if (Array.isArray(a0) || typeof a0 === 'string') return a0.length
      if (isObj(a0)) return Object.keys(a0).length
      return 0
    case 'min':
    case 'max': {
      const list = args.length === 1 && Array.isArray(a0) ? a0 : args
      const ns = list.map(num).filter((n): n is number => n !== null)
      if (!ns.length) return null
      return fn === 'min' ? Math.min(...ns) : Math.max(...ns)
    }
    case 'abs': { const n = num(a0); return n === null ? null : Math.abs(n) }
    case 'round': { const n = num(a0); return n === null ? null : roundTo(n, num(args[1] ?? 0) ?? 0) }
    case 'floor': { const n = num(a0); return n === null ? null : Math.floor(n) }
    case 'ceil': { const n = num(a0); return n === null ? null : Math.ceil(n) }
  }
  return null
}

function agoText(input: Value, now: number): Value {
  const t = typeof input === 'number' ? input : typeof input === 'string' ? Date.parse(input) : NaN
  if (!Number.isFinite(t)) return null
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 5) return 'щойно'
  if (s < 60) return `${s} с тому`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} хв тому`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} год тому`
  return `${Math.round(h / 24)} дн тому`
}

function evalFilter(node: Extract<ExprAst, { k: 'pipe' }>, input: Value, scope: Scope_, budget: Budget, env: EvalEnv): Value {
  const args = node.args.map(a => evalExpr(a, scope, budget, env))
  const list = Array.isArray(input) ? input : null
  if (list) step(budget, list.length)
  switch (node.filter) {
    case 'take': {
      const n = Math.max(0, Math.trunc(num(args[0] ?? null) ?? 0))
      if (list) return list.slice(0, n)
      if (typeof input === 'string') return input.slice(0, n)
      return null
    }
    case 'sort': {
      if (!list) return input
      const key = typeof args[0] === 'string' ? args[0] : ''
      const desc = args[1] === 'desc' || key.startsWith('-')
      const k = key.replace(/^-/, '')
      const sorted = list.map((v, i) => ({ v, i })).sort((a, b) => compare(getPath(a.v, k), getPath(b.v, k)) || a.i - b.i).map(x => x.v)
      return desc ? sorted.reverse() : sorted
    }
    case 'grep': {
      const re = regex(toText(args[0] ?? ''), env)
      if (!re) return list ? [] : null
      const key = typeof args[1] === 'string' ? args[1] : ''
      if (list) return list.filter(x => re.test(toText(getPath(x, key))))
      if (typeof input === 'string') return input.split('\n').filter(l => re.test(l)).join('\n')
      return null
    }
    case 'map': {
      if (!list) return input === null ? null : input
      let tpl = node.tpl
      if (!tpl && typeof args[0] === 'string' && args[0].includes('{{')) tpl = parseTemplate(args[0]).parts
      if (tpl) {
        const parts = tpl
        return list.map(item => {
          const sub = Object.create(scope) as Scope_
          sub.item = item
          return renderTemplate(parts, sub, budget, env)
        })
      }
      const key = typeof args[0] === 'string' ? args[0] : ''
      return list.map(x => getPath(x, key))
    }
    case 'join': {
      const sep = args.length ? toText(args[0]) : ', '
      if (list) return list.map(x => toText(x)).join(sep)
      return input === null ? '' : toText(input)
    }
    case 'truncate': {
      const n = Math.max(1, Math.trunc(num(args[0] ?? null) ?? 0))
      const s = toText(input)
      return s.length > n ? s.slice(0, n - 1) + '…' : s
    }
    case 'fence': {
      const lang = args.length ? toText(args[0]) : ''
      return '```' + lang + '\n' + toText(input).replace(/\n+$/, '') + '\n```'
    }
    case 'unique': {
      if (!list) return input
      const key = typeof args[0] === 'string' ? args[0] : ''
      const seen = new Set<string>()
      return list.filter(x => { const s = JSON.stringify(getPath(x, key)); if (seen.has(s)) return false; seen.add(s); return true })
    }
    case 'where': {
      if (!list) return list === null && input === null ? [] : input
      const key = toText(args[0] ?? '')
      if (args.length < 2) return list.filter(x => truthy(getPath(x, key)))
      return list.filter(x => deepEqual(getPath(x, key), args[1]))
    }
    case 'len': return evalBuiltin('len', [input])
    case 'round': return evalBuiltin('round', [input, args[0] ?? 0])
    case 'ago': return agoText(input, env.now ?? Date.now())
  }
  return null
}

/** Render a parsed template to text in `scope`. */
export function renderTemplate(parts: TemplatePart[], scope: Scope_, budget: Budget, env: EvalEnv = {}): string {
  let out = ''
  for (const p of parts) out += typeof p === 'string' ? p : toText(evalExpr(p, scope, budget, env))
  return out
}

/** Evaluate an expression AST. Total: every step counts against `budget` (StepLimitError past the limit). */
export function evalExpr(ast: ExprAst, scope: Scope_, budget: Budget, env: EvalEnv = {}): Value {
  step(budget)
  switch (ast.k) {
    case 'lit': return ast.v
    case 'list': return ast.items.map(i => evalExpr(i, scope, budget, env))
    case 'id': return lookup(scope, ast.name)
    case 'member': return getProp(evalExpr(ast.obj, scope, budget, env), ast.prop)
    case 'index': {
      const o = evalExpr(ast.obj, scope, budget, env)
      const i = evalExpr(ast.index, scope, budget, env)
      if (Array.isArray(o) && typeof i === 'number') return o[Math.trunc(i)] ?? null
      if (typeof i === 'string' || typeof i === 'number') return getProp(o, String(i))
      return null
    }
    case 'unary': {
      const v = evalExpr(ast.arg, scope, budget, env)
      if (ast.op === '!') return !truthy(v)
      const n = num(v)
      return n === null ? null : -n
    }
    case 'cond': return truthy(evalExpr(ast.test, scope, budget, env)) ? evalExpr(ast.then, scope, budget, env) : evalExpr(ast.else, scope, budget, env)
    case 'bin': {
      const { op } = ast
      if (op === '&&') { const l = evalExpr(ast.l, scope, budget, env); return truthy(l) ? evalExpr(ast.r, scope, budget, env) : l }
      if (op === '||') { const l = evalExpr(ast.l, scope, budget, env); return truthy(l) ? l : evalExpr(ast.r, scope, budget, env) }
      if (op === '??') { const l = evalExpr(ast.l, scope, budget, env); return l !== null ? l : evalExpr(ast.r, scope, budget, env) }
      const l = evalExpr(ast.l, scope, budget, env)
      const r = evalExpr(ast.r, scope, budget, env)
      switch (op) {
        case '==': return deepEqual(l, r)
        case '!=': return !deepEqual(l, r)
        case '<': return l !== null && r !== null && typeof l === typeof r && compare(l, r) < 0
        case '<=': return l !== null && r !== null && typeof l === typeof r && compare(l, r) <= 0
        case '>': return l !== null && r !== null && typeof l === typeof r && compare(l, r) > 0
        case '>=': return l !== null && r !== null && typeof l === typeof r && compare(l, r) >= 0
        case '~': { if (l === null) return false; const re = regex(toText(r), env); return re ? re.test(toText(l)) : false }
        case 'in': return inOp(l, r, budget)
        default: return arith(op, l, r, env)
      }
    }
    case 'builtin': return evalBuiltin(ast.fn, ast.args.map(a => evalExpr(a, scope, budget, env)))
    case 'method': {
      const o = evalExpr(ast.obj, scope, budget, env)
      const a = evalExpr(ast.args[0], scope, budget, env)
      if (ast.fn === 'in') return inOp(o, a, budget)
      if (typeof a !== 'number') return null
      if (Array.isArray(o) || typeof o === 'string') { const v = o.at(Math.trunc(a)); return v === undefined ? null : v }
      return null
    }
    case 'call': {
      const args = ast.args.map(a => evalExpr(a, scope, budget, env))
      const kwargs: Record<string, Value> = {}
      for (const [k, v] of Object.entries(ast.kwargs)) kwargs[k] = evalExpr(v, scope, budget, env)
      if (!env.call) {
        env.diagnostics?.push({ code: 'G157', severity: 'error', message: `«${ast.path}» не є функцією, яку відкриває хост; доступ до файлів, процесів і мережі з виразу неможливий`, hint: 'використати @run або провайдер' })
        return null
      }
      return env.call(ast.path, args, kwargs)
    }
    case 'pipe': return evalFilter(ast, evalExpr(ast.input, scope, budget, env), scope, budget, env)
  }
}

function inOp(l: Value, r: Value, budget: Budget): boolean {
  if (Array.isArray(r)) { step(budget, r.length); return r.some(x => deepEqual(x, l)) }
  if (typeof r === 'string') return typeof l === 'string' && r.includes(l)
  if (isObj(r)) return typeof l === 'string' && hasOwn(r, l)
  return false
}

/** Parse and evaluate in one go; parse diagnostics are appended to env.diagnostics. */
export function evalSource(src: string, scope: Scope_, budget: Budget, env: EvalEnv = {}): Value {
  const r = parseExpr(src)
  if (!r.ast) { env.diagnostics?.push(...r.diagnostics); return null }
  return evalExpr(r.ast, scope, budget, env)
}

// ───────────────────────── Static analysis ─────────────────────────

function walk(ast: ExprAst, f: (e: ExprAst, inTpl: boolean) => void, inTpl = false): void {
  f(ast, inTpl)
  switch (ast.k) {
    case 'list': ast.items.forEach(i => walk(i, f, inTpl)); break
    case 'member': walk(ast.obj, f, inTpl); break
    case 'index': walk(ast.obj, f, inTpl); walk(ast.index, f, inTpl); break
    case 'unary': walk(ast.arg, f, inTpl); break
    case 'bin': walk(ast.l, f, inTpl); walk(ast.r, f, inTpl); break
    case 'cond': walk(ast.test, f, inTpl); walk(ast.then, f, inTpl); walk(ast.else, f, inTpl); break
    case 'builtin': ast.args.forEach(a => walk(a, f, inTpl)); break
    case 'method': walk(ast.obj, f, inTpl); ast.args.forEach(a => walk(a, f, inTpl)); break
    case 'call': ast.args.forEach(a => walk(a, f, inTpl)); Object.values(ast.kwargs).forEach(a => walk(a, f, inTpl)); break
    case 'pipe':
      walk(ast.input, f, inTpl)
      ast.args.forEach(a => walk(a, f, inTpl))
      ast.tpl?.forEach(p => { if (typeof p !== 'string') walk(p, f, true) })
      break
  }
}

/** Root identifiers an expression reads (sorted, unique). `item` inside map templates is bound, not free. */
export function freeVars(ast: ExprAst): string[] {
  const out = new Set<string>()
  walk(ast, (e, inTpl) => { if (e.k === 'id' && !(inTpl && e.name === 'item')) out.add(e.name) })
  return [...out].sort()
}

/** Provider/module function paths an expression calls (`util.next_version`). */
export function callPaths(ast: ExprAst): string[] {
  const out = new Set<string>()
  walk(ast, e => { if (e.k === 'call') out.add(e.path) })
  return [...out].sort()
}

/** Keys of `data.*` an expression reads (`data.api-endpoints.count` → `api-endpoints`). */
export function dataKeys(ast: ExprAst): string[] {
  const out = new Set<string>()
  walk(ast, e => { if (e.k === 'member' && e.obj.k === 'id' && e.obj.name === 'data') out.add(e.prop) })
  return [...out].sort()
}

/** True when the expression is a compile-time constant (no identifiers, no calls). */
export function isStatic(ast: ExprAst): boolean {
  let ok = true
  walk(ast, e => { if (e.k === 'id' || e.k === 'call' || (e.k === 'pipe' && e.filter === 'ago')) ok = false })
  return ok
}
