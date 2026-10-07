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

const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }

/**
 * Decode one escape whose backslash is at `j`: the JSON/JS escapes the TSX compiler emits (`\uXXXX`, `\u{…}`,
 * `\xHH`, `\b`, `\f`, `\v`, `\0`, …); any other character stands for itself (`\"`, `\\`, `\/`).
 */
function unescape(src: string, j: number): { out: string; next: number } {
  const e = src[j + 1]
  if (e === '0' && /[0-9]/.test(src[j + 2] ?? '')) return { out: e, next: j + 2 }
  if (hasOwn(SIMPLE_ESCAPES, e)) return { out: SIMPLE_ESCAPES[e], next: j + 2 }
  if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(j + 2, j + 4))) return { out: String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)), next: j + 4 }
  if (e === 'u') {
    if (/^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) return { out: String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)), next: j + 6 }
    const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(j + 2, j + 11))
    if (m && parseInt(m[1], 16) <= 0x10ffff) return { out: String.fromCodePoint(parseInt(m[1], 16)), next: j + 2 + m[0].length }
  }
  return { out: e, next: j + 2 }
}

function tokenize(src: string, diags: Diagnostic[]): Tok[] {
  const toks: Tok[] = []
  let i = 0
  let afterDot = false
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; afterDot = false; continue }
    const start = i
    // Member segment right after `.`/`?.` without spaces. Dashes are allowed only in a store key directly under the
    // root `data` (`data.api-endpoints`), so `items.length-1` stays arithmetic; other dashed keys use `x["a-b"]`.
    if (afterDot && (isIdChar(c))) {
      const n = toks.length
      const dashed = n >= 2 && toks[n - 2].t === 'id' && toks[n - 2].v === 'data' && !(n >= 3 && toks[n - 3].t === 'op' && (toks[n - 3].v === '.' || toks[n - 3].v === '?.'))
      let j = i
      while (j < src.length && (isIdChar(src[j]) || (dashed && src[j] === '-' && j + 1 < src.length && isIdChar(src[j + 1]) && j > i))) j++
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
          const u = unescape(src, j)
          out += u.out
          j = u.next
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

const MAX_EXPR_DEPTH = 200
const MAX_EXPR_HEIGHT = 1000

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

  depth = 0
  /** Tree height on the current path: nesting plus left-associative steps (`1+1+…`, `a.b.b…`, `x | f | f…`). */
  height = 0

  expr(rbp: number): ExprAst {
    // Bounded nesting: `((((…` must give a diagnostic, not a stack overflow out of parseExpr.
    if (++this.depth > MAX_EXPR_DEPTH) this.fail(`Вираз вкладений глибше за ${MAX_EXPR_DEPTH} рівнів`)
    const h = this.height
    try {
      let left = this.nud()
      // The led loop builds a left spine iteratively; freeVars/evalExpr walk it recursively, so bound its height too.
      while (rbp < this.lbp(this.peek())) {
        if (++this.height > MAX_EXPR_HEIGHT) this.fail(`Вираз довший за ${MAX_EXPR_HEIGHT} операцій в одному ланцюжку`)
        left = this.led(left)
      }
      return left
    } finally {
      this.depth--
      this.height = h
    }
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

/**
 * Index of the `}}` closing the placeholder whose content starts at `from`, or -1. String literals
 * (`"…"`, `'…'`, with `\\` escapes) are skipped and nested `{{ … }}` outside strings are balanced, so a template
 * argument such as `map("{{ item.from }} → {{ item.to }}")` stays inside the outer placeholder.
 */
export function templateClose(src: string, from: number): number {
  let depth = 0
  let quote: string | undefined
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = undefined
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '{' && src[i + 1] === '{') { depth++; i++; continue }
    if (c === '}' && src[i + 1] === '}') {
      if (depth === 0) return i
      depth--
      i++
    }
  }
  return -1
}

/** Split `text {{ expr }} text` into literal and expression source parts (no parsing). */
export function splitTemplate(src: string): ({ text: string } | { expr: string })[] {
  const out: ({ text: string } | { expr: string })[] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{{', i)
    if (open < 0) { out.push({ text: src.slice(i) }); break }
    let close = templateClose(src, open + 2)
    // An unbalanced quote inside the placeholder (an apostrophe in prose): fall back to the first `}}`.
    if (close < 0) close = src.indexOf('}}', open + 2)
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

/**
 * A value or string past the size limits (`MAX_VALUE_CELLS`, `MAX_STRING_LENGTH`, `MAX_VALUE_DEPTH`). A StepLimitError,
 * so every host that already turns the step limit into G155 stops the section instead of hanging or hitting a RangeError.
 */
export class ValueLimitError extends StepLimitError {
  constructor(what: string) {
    super(0)
    this.message = `G155: ${what}`
  }
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

// ───────────────────────── Value size ─────────────────────────
// The budget charges one step per AST node, but a value can be far bigger than the steps that built it: `[x, x]`
// shares `x`, so 40 doublings make a DAG with 2^40 leaves in ~120 steps. Every value the evaluator builds is
// therefore measured in cells (its size as a tree, shared parts counted per use) and capped, and code that walks a
// value (==, in, where, sort/unique keys, text output) is charged by its cells. Measures of composites (evaluator-built
// and host values alike) are memoized, so measuring a DAG costs its distinct nodes, not its tree size.

/** Cells of the largest value an expression may build (1 per scalar, list, object and key; strings per 64 chars). */
export const MAX_VALUE_CELLS = 1 << 20
/** Longest string an expression may build; V8's own limit (~2^29) throws a RangeError far above it. */
export const MAX_STRING_LENGTH = 1 << 26
/** Deepest value an expression may build or walk: deeper values would overflow the walkers' recursion. */
export const MAX_VALUE_DEPTH = 256
const CHARS_PER_CELL = 64
/** Cells walked per budget step. */
const CELLS_PER_STEP = 64

const sizeMemo = new WeakMap<object, { cells: number; height: number }>()

function strCells(s: string): number { return 1 + Math.floor(s.length / CHARS_PER_CELL) }

/** Tree size and height of a value; Infinity past MAX_VALUE_DEPTH. Memoized (a host value is walked once). */
function measure(v: Value, depth = 0): { cells: number; height: number } {
  if (v === null || typeof v !== 'object') return { cells: typeof v === 'string' ? strCells(v) : 1, height: 0 }
  const hit = sizeMemo.get(v)
  if (hit) return hit
  if (depth >= MAX_VALUE_DEPTH) return { cells: Infinity, height: Infinity }
  let cells = 1, height = 0
  if (Array.isArray(v)) {
    for (const x of v) { const m = measure(x, depth + 1); cells += m.cells; height = Math.max(height, m.height + 1) }
  } else {
    for (const k of Object.keys(v)) { const m = measure(v[k] ?? null, depth + 1); cells += strCells(k) + m.cells; height = Math.max(height, m.height + 1) }
  }
  const r = { cells, height }
  // Host values (store, @run data) are never mutated either (@set rebinds), so their measure is memoized too and each
  // is walked once per process, not once per pipe stage. Over-cap measures are not memoized: own() must still refuse them.
  if (height < MAX_VALUE_DEPTH && cells <= MAX_VALUE_CELLS) sizeMemo.set(v, r)
  return r
}

/** Cells of a value (see MAX_VALUE_CELLS); Infinity when it is deeper than MAX_VALUE_DEPTH. */
export function valueCells(v: Value): number { return measure(v).cells }

/**
 * Charge the budget for walking `v` (serializing, hashing, comparing it): one step per CELLS_PER_STEP cells.
 * Hosts call it before `toText`/`JSON.stringify` of a value an expression produced. Too deep → ValueLimitError.
 */
export function chargeValue(budget: Budget, v: Value): void {
  if (v === null || typeof v !== 'object') return
  const { cells, height } = measure(v)
  if (height > MAX_VALUE_DEPTH) throw new ValueLimitError(`значення глибше за ${MAX_VALUE_DEPTH} рівнів`)
  step(budget, Math.floor(cells / CELLS_PER_STEP))
}

/**
 * Register a composite the evaluator just built: measure it from its items (memoized ones cost nothing, host ones
 * are charged), enforce the size and depth caps, memoize. Scalars and strings pass through.
 */
function own(v: Value, budget: Budget): Value {
  if (v === null || typeof v !== 'object' || sizeMemo.has(v)) {
    if (typeof v === 'string' && v.length > MAX_STRING_LENGTH) throw new ValueLimitError(`рядок довший за ${MAX_STRING_LENGTH} символів`)
    return v
  }
  let cells = 1, height = 0, walked = 0
  const add = (x: Value, keyCells: number): void => {
    const fresh = x !== null && typeof x === 'object' && !sizeMemo.has(x)
    const m = measure(x)
    if (fresh) walked += m.cells
    cells += keyCells + m.cells
    height = Math.max(height, m.height + 1)
  }
  if (Array.isArray(v)) for (const x of v) add(x, 0)
  else for (const k of Object.keys(v)) add(v[k] ?? null, strCells(k))
  step(budget, Math.floor(walked / CELLS_PER_STEP))
  if (height > MAX_VALUE_DEPTH) throw new ValueLimitError(`значення глибше за ${MAX_VALUE_DEPTH} рівнів`)
  if (cells > MAX_VALUE_CELLS) throw new ValueLimitError(`значення більше за ${MAX_VALUE_CELLS} комірок`)
  sizeMemo.set(v, { cells, height })
  return v
}

/** Throw before building a string longer than MAX_STRING_LENGTH (instead of V8's RangeError); charge its copy. */
function checkLength(len: number, budget: Budget): void {
  if (len > MAX_STRING_LENGTH) throw new ValueLimitError(`рядок довший за ${MAX_STRING_LENGTH} символів`)
  step(budget, Math.floor(len / (CHARS_PER_CELL * CELLS_PER_STEP)))
}

/** `toText` with the walk charged to the budget. */
function text(v: Value | undefined, budget: Budget): string {
  if (v !== null && v !== undefined && typeof v === 'object') chargeValue(budget, v)
  return toText(v)
}

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

/** Structural equality. With a budget, comparing two composites is charged by their cells (see chargeValue). */
export function deepEqual(a: Value, b: Value, budget?: Budget): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (budget && typeof a === 'object') { chargeValue(budget, a); chargeValue(budget, b) }
  return eq(a, b)
}

function eq(a: Value, b: Value): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => eq(x, b[i]))
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a), kb = Object.keys(b)
    return ka.length === kb.length && ka.every(k => hasOwn(b, k) && eq(a[k], b[k]))
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

/** Order of two non-null values: numbers numerically, anything else by text form. */
function compareKeys(a: Value, b: Value, budget: Budget): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = typeof a === 'string' ? a : text(a, budget)
  const sb = typeof b === 'string' ? b : text(b, budget)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

// ───────────────────────── Linear-time regex ─────────────────────────
// `~` and `grep` take patterns and subjects from prompts and data, so V8's backtracking RegExp could hang the render
// on `(a+)+$` with no way to preempt it. A pattern is validated by RegExp (same syntax errors), then compiled for a
// Pike VM: one pass over the subject, O(subject × program), charged to the step budget. Supported: the JS syntax
// without flags except backreferences and lookaround (G107).

/** Flat [lo, hi, lo, hi, …] UTF-16 code unit ranges. */
type Ranges = number[]
type RNode =
  | { t: 'set'; r: Ranges; neg: boolean }
  | { t: 'assert'; a: 'bol' | 'eol' | 'wb' | 'nwb' }
  | { t: 'cat'; xs: RNode[] }
  | { t: 'alt'; xs: RNode[] }
  | { t: 'rep'; x: RNode; min: number; max: number }
type Inst =
  | { op: 'set'; r: Ranges; neg: boolean }
  | { op: 'assert'; a: 'bol' | 'eol' | 'wb' | 'nwb' }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'match' }

const RE_DIGIT: Ranges = [48, 57]
const RE_WORD: Ranges = [48, 57, 65, 90, 95, 95, 97, 122]
const RE_SPACE: Ranges = [9, 13, 32, 32, 160, 160, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff]
const RE_LINE_END: Ranges = [10, 10, 13, 13, 0x2028, 0x2029]
const RE_MAX_PATTERN = 500
/** Instructions after expanding counted repeats (`(a{100}){100}`). */
const RE_MAX_PROGRAM = 5000
/** Subject chars × program instructions per budget step. */
const RE_COST_PER_STEP = 1 << 10

class ReUnsupported extends Error {}

function complement(r: Ranges): Ranges {
  const out: Ranges = []
  let lo = 0
  for (let i = 0; i < r.length; i += 2) { if (r[i] > lo) out.push(lo, r[i] - 1); lo = r[i + 1] + 1 }
  if (lo <= 0xffff) out.push(lo, 0xffff)
  return out
}

function reParse(p: string): RNode {
  let i = 0
  const hex = (n: number): number | undefined => {
    const h = p.slice(i, i + n)
    if (h.length !== n || !/^[0-9a-fA-F]+$/.test(h)) return undefined
    i += n
    return parseInt(h, 16)
  }
  /** Escape after `\`: a code unit, a set (\d \w \s and negations) or, outside classes, \b / \B. */
  const escape = (inClass: boolean): number | { r: Ranges; neg: boolean } | 'wb' | 'nwb' => {
    const c = p[i++]
    switch (c) {
      case 'd': return { r: RE_DIGIT, neg: false }
      case 'D': return { r: RE_DIGIT, neg: true }
      case 'w': return { r: RE_WORD, neg: false }
      case 'W': return { r: RE_WORD, neg: true }
      case 's': return { r: RE_SPACE, neg: false }
      case 'S': return { r: RE_SPACE, neg: true }
      case 'b': return inClass ? 8 : 'wb'
      case 'B': return inClass ? 66 : 'nwb'
      case 'n': return 10
      case 'r': return 13
      case 't': return 9
      case 'v': return 11
      case 'f': return 12
      case 'x': return hex(2) ?? 120
      case 'u': return hex(4) ?? 117
      case 'c': {
        const l = p[i]
        if (l && /[A-Za-z]/.test(l)) { i++; return l.charCodeAt(0) % 32 }
        i--
        return 92
      }
      case 'k': throw new ReUnsupported('\\k')
    }
    if (/[0-9]/.test(c)) {
      if (c === '0' && !/[0-9]/.test(p[i] ?? '')) return 0
      throw new ReUnsupported('backreference')
    }
    return c.charCodeAt(0)
  }
  const classSet = (): RNode => {
    let neg = false
    if (p[i] === '^') { neg = true; i++ }
    const r: Ranges = []
    const push = (x: number | { r: Ranges; neg: boolean }): void => {
      if (typeof x === 'number') r.push(x, x)
      else r.push(...(x.neg ? complement(x.r) : x.r))
    }
    const atom = (): number | { r: Ranges; neg: boolean } => {
      const c = p[i++]
      if (c !== '\\') return c.charCodeAt(0)
      const e = escape(true)
      return e === 'wb' || e === 'nwb' ? 0 : e
    }
    while (i < p.length && p[i] !== ']') {
      const a = atom()
      if (p[i] === '-' && i + 1 < p.length && p[i + 1] !== ']') {
        i++
        const b = atom()
        if (typeof a === 'number' && typeof b === 'number') { r.push(a, b); continue }
        push(a); r.push(45, 45); push(b)
        continue
      }
      push(a)
    }
    i++
    // Sort and merge so the set can be complemented and scanned in order.
    const pairs: [number, number][] = []
    for (let k = 0; k < r.length; k += 2) pairs.push([r[k], r[k + 1]])
    pairs.sort((x, y) => x[0] - y[0])
    const merged: Ranges = []
    for (const [lo, hi] of pairs) {
      const n = merged.length
      if (n && lo <= merged[n - 1] + 1) merged[n - 1] = Math.max(merged[n - 1], hi)
      else merged.push(lo, hi)
    }
    return { t: 'set', r: merged, neg }
  }
  const quant = (): [number, number] | undefined => {
    const c = p[i]
    let q: [number, number]
    if (c === '*') q = [0, Infinity]
    else if (c === '+') q = [1, Infinity]
    else if (c === '?') q = [0, 1]
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i))
      if (!m) return undefined
      const min = Number(m[1])
      q = [min, m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3])]
      i += m[0].length - 1
    } else return undefined
    i++
    if (p[i] === '?') i++
    return q
  }
  const atom = (): RNode => {
    const c = p[i++]
    if (c === '.') return { t: 'set', r: RE_LINE_END, neg: true }
    if (c === '^') return { t: 'assert', a: 'bol' }
    if (c === '$') return { t: 'assert', a: 'eol' }
    if (c === '[') return classSet()
    if (c === '(') {
      if (p[i] === '?') {
        if (p[i + 1] === ':') i += 2
        else if (p[i + 1] === '<' && p[i + 2] !== '=' && p[i + 2] !== '!') i = p.indexOf('>', i) + 1
        else throw new ReUnsupported('lookaround')
      }
      const x = alt()
      i++
      return x
    }
    if (c === '\\') {
      const e = escape(false)
      if (e === 'wb' || e === 'nwb') return { t: 'assert', a: e }
      return typeof e === 'number' ? { t: 'set', r: [e, e], neg: false } : { t: 'set', ...e }
    }
    const code = c.charCodeAt(0)
    return { t: 'set', r: [code, code], neg: false }
  }
  const cat = (): RNode => {
    const xs: RNode[] = []
    while (i < p.length && p[i] !== '|' && p[i] !== ')') {
      const a = atom()
      const q = quant()
      xs.push(q ? { t: 'rep', x: a, min: q[0], max: q[1] } : a)
    }
    return { t: 'cat', xs }
  }
  function alt(): RNode {
    const xs = [cat()]
    while (p[i] === '|') { i++; xs.push(cat()) }
    return xs.length === 1 ? xs[0] : { t: 'alt', xs }
  }
  return alt()
}

function reCompile(root: RNode): Inst[] {
  const prog: Inst[] = []
  const emit = (inst: Inst): number => {
    if (prog.length >= RE_MAX_PROGRAM) throw new ReUnsupported('too big')
    return prog.push(inst) - 1
  }
  const comp = (n: RNode): void => {
    switch (n.t) {
      case 'set': emit({ op: 'set', r: n.r, neg: n.neg }); return
      case 'assert': emit({ op: 'assert', a: n.a }); return
      case 'cat': for (const x of n.xs) comp(x); return
      case 'alt': {
        const ends: number[] = []
        n.xs.forEach((x, k) => {
          if (k === n.xs.length - 1) { comp(x); return }
          const s = emit({ op: 'split', x: prog.length + 1, y: -1 })
          comp(x)
          ends.push(emit({ op: 'jmp', x: -1 }))
          ;(prog[s] as { y: number }).y = prog.length
        })
        for (const e of ends) (prog[e] as { x: number }).x = prog.length
        return
      }
      case 'rep': {
        for (let k = 0; k < n.min; k++) comp(n.x)
        if (n.max === Infinity) {
          const s = emit({ op: 'split', x: prog.length + 1, y: -1 })
          comp(n.x)
          emit({ op: 'jmp', x: s })
          ;(prog[s] as { y: number }).y = prog.length
          return
        }
        const splits: number[] = []
        for (let k = n.min; k < n.max; k++) { splits.push(emit({ op: 'split', x: prog.length + 1, y: -1 })); comp(n.x) }
        for (const s of splits) (prog[s] as { y: number }).y = prog.length
      }
    }
  }
  comp(root)
  emit({ op: 'match' })
  return prog
}

function inSet(r: Ranges, c: number): boolean {
  for (let k = 0; k < r.length; k += 2) { if (c < r[k]) return false; if (c <= r[k + 1]) return true }
  return false
}

const isWordAt = (s: string, i: number): boolean => i >= 0 && i < s.length && inSet(RE_WORD, s.charCodeAt(i))

/** Does `prog` match anywhere in `s` (RegExp.prototype.test without flags)? Pike VM, O(|s| × |prog|). */
function reTest(prog: Inst[], s: string): boolean {
  const n = prog.length
  const mark = new Int32Array(n).fill(-1)
  let cur: number[] = [], next: number[] = []
  const stack: number[] = []
  /** Follow epsilon edges from `pc` at position `i` into `list`; true when `match` is reached. */
  const add = (list: number[], pc0: number, i: number): boolean => {
    stack.push(pc0)
    while (stack.length) {
      const pc = stack.pop()!
      if (mark[pc] === i) continue
      mark[pc] = i
      const inst = prog[pc]
      switch (inst.op) {
        case 'match': stack.length = 0; return true
        case 'jmp': stack.push(inst.x); break
        case 'split': stack.push(inst.y, inst.x); break
        case 'assert': {
          const ok = inst.a === 'bol' ? i === 0 : inst.a === 'eol' ? i === s.length : (isWordAt(s, i - 1) !== isWordAt(s, i)) === (inst.a === 'wb')
          if (ok) stack.push(pc + 1)
          break
        }
        default: list.push(pc)
      }
    }
    return false
  }
  if (add(cur, 0, 0)) return true
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    next.length = 0
    for (const pc of cur) {
      const inst = prog[pc] as Extract<Inst, { op: 'set' }>
      if (inSet(inst.r, c) !== inst.neg && add(next, pc + 1, i + 1)) return true
    }
    if (add(next, 0, i + 1)) return true
    const t = cur; cur = next; next = t
  }
  return false
}

interface Compiled { prog?: Inst[]; error?: string }
const regexCache = new Map<string, Compiled>()

function compileRegex(pattern: string): Compiled {
  if (pattern.length > RE_MAX_PATTERN) return { error: `Регулярний вираз довший за ${RE_MAX_PATTERN} символів` }
  try { new RegExp(pattern) } catch { return { error: `Невірний регулярний вираз «${pattern}»` } }
  try { return { prog: reCompile(reParse(pattern)) } } catch (e) {
    if (!(e instanceof ReUnsupported)) throw e
    return { error: e.message === 'too big' ? `Регулярний вираз «${pattern}» надто складний (повтори {n,m})` : `Регулярний вираз «${pattern}»: зворотні посилання, lookaround і модифікатори не підтримуються` }
  }
}

/** Compiled pattern, or null with a G107 warning (on every use, not just the first compile; cache bounded). */
function regex(pattern: string, env: EvalEnv): Inst[] | null {
  let c = regexCache.get(pattern)
  if (!c) {
    c = compileRegex(pattern)
    if (regexCache.size >= 500) regexCache.clear()
    regexCache.set(pattern, c)
  }
  if (c.error) {
    const msg = c.error
    if (env.diagnostics && !env.diagnostics.some(d => d.code === 'G107' && d.message === msg)) env.diagnostics.push({ code: 'G107', severity: 'warning', message: msg })
    return null
  }
  return c.prog ?? null
}

/** Test with the subject scan charged to the budget. */
function reMatch(prog: Inst[], s: string, budget: Budget): boolean {
  step(budget, Math.floor((s.length + 1) * prog.length / RE_COST_PER_STEP))
  return reTest(prog, s)
}

/**
 * Linear-time `RegExp#test` (no flags) for hosts that match user patterns outside expressions: null when the pattern
 * is invalid or unsupported (G107 in `env.diagnostics`); the scan is charged to `budget`.
 */
export function regexTest(pattern: string, subject: string, budget: Budget = newBudget(), env: EvalEnv = {}): boolean | null {
  const re = regex(pattern, env)
  return re ? reMatch(re, subject, budget) : null
}

function num(v: Value): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null }

function roundTo(n: number, digits: number): number {
  const f = 10 ** Math.max(0, Math.min(10, Math.trunc(digits)))
  return Math.round(n * f) / f
}

function arith(op: BinOp, a: Value, b: Value, budget: Budget, env: EvalEnv): Value {
  if (op === '+') {
    if (typeof a === 'string' || typeof b === 'string') {
      const x = text(a, budget), y = text(b, budget)
      checkLength(x.length + y.length, budget)
      return x + y
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      step(budget, a.length + b.length)
      return own([...a, ...b], budget)
    }
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

function evalBuiltin(fn: string, args: Value[], budget: Budget): Value {
  const a0 = args[0] ?? null
  switch (fn) {
    case 'len':
      if (Array.isArray(a0) || typeof a0 === 'string') return a0.length
      if (isObj(a0)) return Object.keys(a0).length
      return 0
    case 'min':
    case 'max': {
      const list = args.length === 1 && Array.isArray(a0) ? a0 : args
      step(budget, list.length)
      // A loop, not Math.min(...list): spreading a long list overflows the stack (RangeError).
      let best: number | null = null
      for (const v of list) {
        const n = num(v)
        if (n !== null && (best === null || (fn === 'min' ? n < best : n > best))) best = n
      }
      return best
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

/** Markdown code fence around `body`: one backtick longer than the longest backtick run inside (CommonMark). */
export function fenceText(body: string, lang = ''): string {
  let longest = 0, run = 0
  for (let i = 0; i < body.length; i++) { if (body[i] === '`') { run++; if (run > longest) longest = run } else run = 0 }
  const fence = '`'.repeat(Math.max(3, longest + 1))
  let end = body.length
  while (end > 0 && body[end - 1] === '\n') end--
  return fence + lang + '\n' + body.slice(0, end) + '\n' + fence
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
      // Keys are extracted (and their text forms charged) once; items without a key stay last and ties keep
      // their source order in both directions.
      const dec = list.map((v, i) => {
        const kv = getPath(v, k)
        return { v, i, key: kv === null || typeof kv === 'number' || typeof kv === 'string' ? kv : text(kv, budget) }
      })
      return dec.sort((a, b) => {
        if (a.key === null || b.key === null) return a.key === b.key ? a.i - b.i : a.key === null ? 1 : -1
        const c = compareKeys(a.key, b.key, budget)
        return (desc ? -c : c) || a.i - b.i
      }).map(x => x.v)
    }
    case 'grep': {
      const re = regex(text(args[0] ?? '', budget), env)
      if (!re) return list ? [] : null
      const key = typeof args[1] === 'string' ? args[1] : ''
      if (list) return list.filter(x => reMatch(re, text(getPath(x, key), budget), budget))
      if (typeof input === 'string') return input.split('\n').filter(l => reMatch(re, l, budget)).join('\n')
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
      const sep = args.length ? text(args[0], budget) : ', '
      if (!list) return input === null ? '' : text(input, budget)
      const parts = list.map(x => text(x, budget))
      checkLength(parts.reduce((n, p) => n + p.length, 0) + sep.length * Math.max(0, parts.length - 1), budget)
      return parts.join(sep)
    }
    case 'truncate': {
      const n = Math.max(1, Math.trunc(num(args[0] ?? null) ?? 0))
      const s = text(input, budget)
      return s.length > n ? s.slice(0, n - 1) + '…' : s
    }
    case 'fence': {
      const lang = args.length ? text(args[0], budget) : ''
      const body = text(input, budget)
      checkLength(body.length + lang.length + 64, budget)
      return fenceText(body, lang)
    }
    case 'unique': {
      if (!list) return input
      chargeValue(budget, list)
      const key = typeof args[0] === 'string' ? args[0] : ''
      const seen = new Set<string>()
      return list.filter(x => { const s = JSON.stringify(getPath(x, key)); if (seen.has(s)) return false; seen.add(s); return true })
    }
    case 'where': {
      if (!list) return list === null && input === null ? [] : input
      const key = text(args[0] ?? '', budget)
      if (args.length < 2) return list.filter(x => truthy(getPath(x, key)))
      return list.filter(x => deepEqual(getPath(x, key), args[1], budget))
    }
    case 'len': return evalBuiltin('len', [input], budget)
    case 'round': return evalBuiltin('round', [input, args[0] ?? 0], budget)
    case 'ago': return agoText(input, env.now ?? Date.now())
  }
  return null
}

/** Render a parsed template to text in `scope`. Output and value walks are charged; past MAX_STRING_LENGTH → G155. */
export function renderTemplate(parts: TemplatePart[], scope: Scope_, budget: Budget, env: EvalEnv = {}): string {
  let out = ''
  for (const p of parts) {
    const s = typeof p === 'string' ? p : text(evalExpr(p, scope, budget, env), budget)
    if (out.length + s.length > MAX_STRING_LENGTH) checkLength(out.length + s.length, budget)
    out += s
  }
  return out
}

/** Evaluate an expression AST. Total: every step counts against `budget` (StepLimitError past the limit). */
export function evalExpr(ast: ExprAst, scope: Scope_, budget: Budget, env: EvalEnv = {}): Value {
  step(budget)
  switch (ast.k) {
    case 'lit': return ast.v
    case 'list': return own(ast.items.map(i => evalExpr(i, scope, budget, env)), budget)
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
        case '==': return deepEqual(l, r, budget)
        case '!=': return !deepEqual(l, r, budget)
        case '<': return l !== null && r !== null && typeof l === typeof r && compareKeys(l, r, budget) < 0
        case '<=': return l !== null && r !== null && typeof l === typeof r && compareKeys(l, r, budget) <= 0
        case '>': return l !== null && r !== null && typeof l === typeof r && compareKeys(l, r, budget) > 0
        case '>=': return l !== null && r !== null && typeof l === typeof r && compareKeys(l, r, budget) >= 0
        case '~': { if (l === null) return false; const re = regex(text(r, budget), env); return re ? reMatch(re, text(l, budget), budget) : false }
        case 'in': return inOp(l, r, budget)
        default: return arith(op, l, r, budget, env)
      }
    }
    case 'builtin': return evalBuiltin(ast.fn, ast.args.map(a => evalExpr(a, scope, budget, env)), budget)
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
    case 'pipe': {
      const input = evalExpr(ast.input, scope, budget, env)
      const out = evalFilter(ast, input, scope, budget, env)
      return out === input ? out : own(out, budget)
    }
  }
}

function inOp(l: Value, r: Value, budget: Budget): boolean {
  if (Array.isArray(r)) { step(budget, r.length); return r.some(x => deepEqual(x, l, budget)) }
  if (typeof r === 'string') { step(budget, Math.floor(r.length / (CHARS_PER_CELL * CELLS_PER_STEP))); return typeof l === 'string' && r.includes(l) }
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
