// Core of @context-gate/jsx: the JSX factory, expression references, children normalization
// and the build-time diagnostics collector. Build-time only; no Node imports.
//
// Evaluation model: the JSX factory is eager. Children are evaluated before their parent
// (that is how JS evaluates call arguments), builtin components turn props + children into
// AST nodes (`types.ts` `Node`) or marker objects (`Section`, `Prompt`, `Else`), and user
// function components are inlined at the call site under a recursion guard (G151).

import type { Code, Diagnostic, Node, SectionNode, ArgSpec, Tier } from '../../core/src/types.ts'
import { splitTemplate } from '../../core/src/expr.ts'

// ───────────────────────── Diagnostics collector ─────────────────────────

let pending: Diagnostic[] = []
/** Index in `pending` up to which diagnostics are already attributed to a `<Prompt>` (multi-skill packages). */
let claimedUpTo = 0
const claimed = new WeakSet<Diagnostic>()
const promptDiagnostics = new WeakMap<object, Diagnostic[]>()

/** Records a build-time diagnostic, tagged with the caller location (first frame outside this package). */
export function report(code: Code, severity: Diagnostic['severity'], message: string, hint?: string): void {
  const d: Diagnostic = { code, severity, message }
  if (hint) d.hint = hint
  const loc = callerLocation()
  if (loc) { d.path = loc.path; d.line = loc.line }
  pending.push(d)
}

/** Returns and clears every diagnostic recorded since the last call. */
export function takeDiagnostics(): Diagnostic[] {
  const out = pending
  pending = []
  claimedUpTo = 0
  return out
}

/** Diagnostics recorded while an element was built, keyed by what it returned (a node, marker or list). */
const producedBy = new WeakMap<object, Diagnostic[]>()

/** Ties the diagnostics recorded since `from` (an index in `pending`) to `out`, the element they were built for. */
function attach(out: unknown, from: number): void {
  if (pending.length <= from || !out || typeof out !== 'object') return
  producedBy.set(out, [...(producedBy.get(out) ?? []), ...pending.slice(from)])
}

/** Every diagnostic tied to an element reachable from `root` (each element once, cycles cut). */
function diagnosticsWithin(root: unknown): Diagnostic[] {
  const out: Diagnostic[] = []
  const seen = new Set<object>()
  const stack: unknown[] = [root]
  while (stack.length) {
    const v = stack.pop()
    if (!v || typeof v !== 'object' || seen.has(v)) continue
    seen.add(v)
    const own = producedBy.get(v)
    if (own) out.push(...own)
    const nested = promptDiagnostics.get(v) // a nested <Prompt> already claimed its children's
    if (nested) out.push(...nested)
    for (const x of Array.isArray(v) ? v : Object.values(v)) if (x && typeof x === 'object') stack.push(x)
  }
  return out
}

/**
 * Attributes to `marker` every diagnostic recorded since the previous `<Prompt>` (its children are evaluated
 * before it) plus those tied to any element inside `children`: a Section or component constant shared by several
 * skills of one package is built once, and its errors must reach every prompt that contains it (M77).
 */
export function claimDiagnostics(marker: object, children?: unknown): void {
  const mine = [...new Set([...pending.slice(claimedUpTo), ...diagnosticsWithin(children)])]
  claimedUpTo = pending.length
  for (const d of mine) claimed.add(d)
  promptDiagnostics.set(marker, mine)
}

/** Diagnostics of one prompt: its claimed ones plus the not yet claimed rest (module-level code). Drains `pending`. */
export function diagnosticsOf(marker: object | undefined): Diagnostic[] {
  const rest = takeDiagnostics().filter((d) => !claimed.has(d))
  return [...((marker && promptDiagnostics.get(marker)) ?? []), ...rest]
}

const OWN_FRAME = /[\\/](packages[\\/]jsx[\\/]src|@context-gate[\\/]jsx)[\\/]/
const FRAME_LOC = /\(?((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^()]*?):(\d+):(\d+)\)?\s*$/

/** File and line of the first stack frame outside @context-gate/jsx (source-mapped during builds). */
export function callerLocation(): { path: string; line: number } | undefined {
  const stack = new Error().stack
  if (!stack) return undefined
  for (const raw of stack.split('\n').slice(1)) {
    const m = FRAME_LOC.exec(raw.trim())
    if (!m) continue
    let p = m[1]!
    if (p.startsWith('file://')) p = decodeURIComponent(p.slice('file://'.length))
    if (OWN_FRAME.test(p) || p.includes('node:')) continue
    return { path: p.replace(/\\/g, '/'), line: Number(m[2]) }
  }
  return undefined
}

// ───────────────────────── Expression references (Proxy) ─────────────────────────

/** Brand carried by expression references (`ctx.git.branch`, the `Each` item proxy). */
export const EXPR = Symbol.for('context-gate.expr')

/** A runtime expression reference: property access and calls build a path, nothing is evaluated. */
export interface ExprRef { readonly [EXPR]: string }

export function isExprRef(v: unknown): v is ExprRef {
  return (typeof v === 'function' || (typeof v === 'object' && v !== null)) && typeof (v as Record<symbol, unknown>)[EXPR] === 'string'
}

const IDENT = /^[A-Za-z_$][\w$]*$/
/** Dashed store keys are plain members only directly under `data` (core lexer: `data.api-endpoints`). */
const DASHED = /^[A-Za-z_$][\w$]*(?:-[\w$]+)+$/

/** Plain-decimal source of a number: the expression lexer has no exponent form; NaN/Infinity are G160. */
export function numberLiteral(n: number, where = 'Число'): string {
  if (!Number.isFinite(n)) {
    report('G160', 'error', `${where}: ${n} не можна передати у вираз.`, 'рантайм-вирази приймають лише скінченні числа')
    return 'null'
  }
  const s = String(n)
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s)
  if (!m) return s
  const digits = m[2]! + (m[3] ?? '')
  const point = 1 + Number(m[4])
  if (point <= 0) return `${m[1]}0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return `${m[1]}${digits}${'0'.repeat(point - digits.length)}`
  return `${m[1]}${digits.slice(0, point)}.${digits.slice(point)}`
}

/** Expression source for a literal or reference used inside a call/template (`"str"`, `3`, `a.b`). */
export function exprLiteral(v: unknown): string {
  if (isExprRef(v)) return v[EXPR]
  if (v === undefined) return 'null'
  if (typeof v === 'number') return numberLiteral(v)
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(exprLiteral).join(', ')}]`
  report('G160', 'error', `Значення ${describe(v)} не можна передати у вираз.`, HINT_G160)
  return 'null'
}

export const HINT_G160 = 'винести у module-провайдер або pipe-фільтр'

/** JS value methods that a reference call can be mistaken for (`.at`/`.in` are core methods). */
const JS_METHODS = new Set([
  'join', 'map', 'filter', 'slice', 'splice', 'concat', 'includes', 'indexOf', 'lastIndexOf', 'find', 'findIndex', 'some', 'every',
  'reduce', 'flat', 'flatMap', 'sort', 'reverse', 'forEach', 'keys', 'values', 'entries', 'toUpperCase', 'toLowerCase', 'trim',
  'trimStart', 'trimEnd', 'split', 'replace', 'replaceAll', 'startsWith', 'endsWith', 'substring', 'substr', 'charAt', 'padStart',
  'padEnd', 'repeat', 'toFixed',
])

/** Scope roots that hold values, not callable providers (`git.log(3)`, `fs.glob(…)` and module namespaces are). */
const DATA_ROOTS = new Set(['data', 'args', 'git', 'session', 'cursor', 'gate', 'budgets', 'ctx', 'tier'])

/**
 * Creates an expression reference. `ref('r').body` → path `r.body`; `ref('').git.branch` → `git.branch`.
 * Supported: property access, numeric index (`.at(n)`), calls with literal/reference args, template
 * literals and string concatenation (→ `{{ path }}`). JS operators (`>`, `===`, `&&`, `? :`) are NOT
 * intercepted (SPEC Р1): arithmetic/relational use is reported as G160, the rest silently yields a
 * build-time value, so runtime conditions must be written as strings.
 */
export function ref(path: string, item = false): any {
  const target = function exprRef() {}
  return new Proxy(target, {
    get(_t, key) {
      if (key === EXPR) return path
      if (key === Symbol.toPrimitive) {
        return (hint: string) => {
          if (hint === 'number') {
            report('G160', 'error', `Оператор над виразом \`${path}\` обчислюється на збірці, а не в рантаймі.`, `запиши умову рядком, напр. when="${path} > 0"; або ${HINT_G160}`)
            return Number.NaN
          }
          return `{{ ${path} }}`
        }
      }
      if (key === 'toJSON' || key === 'toString') return () => `{{ ${path} }}`
      if (typeof key === 'symbol' || key === 'then') return undefined
      if (/^\d+$/.test(key)) return ref(`${path}.at(${key})`, item)
      if (!path) {
        if (!IDENT.test(key)) report('G160', 'error', `Корінь контексту «${key}» не є ідентифікатором: у виразі це стане «${key.split('-').join(' - ')}».`, 'назви провайдер без дефісів (напр. arch_info)')
        return ref(key)
      }
      return ref(IDENT.test(key) || (path === 'data' && DASHED.test(key)) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`, item)
    },
    apply(_t, _this, args: unknown[]) {
      // `a.b.fn(...)` is a provider/module call at render. JS methods on values (`c.items.join(', ')`) are not:
      // they fail there with G157, so they are reported here.
      const dot = path.lastIndexOf('.')
      const method = dot >= 0 ? path.slice(dot + 1) : ''
      // Only on values: an Each item or a field under a builtin data root. A provider or module namespace
      // (`tools.todo.find(…)`, from gate.json or <Use>) may well export a function named like a JS method.
      if (JS_METHODS.has(method) && (item || (DATA_ROOTS.has(path.split('.')[0]!) && path.split('.').length >= 3))) {
        report('G160', 'error', `\`${path}(…)\` — метод JavaScript над значенням не виконується в рантаймі.`, `використай pipe-фільтр (напр. "${path.slice(0, dot)} | join(\", \")") або ${HINT_G160}`)
      }
      return ref(`${path}(${args.map(exprLiteral).join(', ')})`, item)
    },
    has(_t, key) { return key === EXPR },
  })
}

/** `{{ }}` placeholders: core `splitTemplate` (string literals and nested `{{ }}` inside a placeholder are skipped). */
function unwrapPlaceholders(s: string): string {
  return splitTemplate(s).map((p) => ('text' in p ? p.text : p.expr)).join('')
}

/**
 * Normalizes a value in an expression position (`when`, `test`, `of`, `value`, `expr`, `n`, ...)
 * to an expression string. Strings are expression sources (`{{ x }}` placeholders are unwrapped,
 * so template literals over `ctx` work); references give their path; numbers/null are literals.
 * Booleans and objects are build-time values that leaked into a runtime position → G160.
 */
export function exprOf(v: unknown, where: string): string | undefined {
  if (v === undefined) return undefined
  if (typeof v === 'string') return unwrapPlaceholders(v).trim()
  if (isExprRef(v)) return v[EXPR]
  if (typeof v === 'number') return numberLiteral(v, where)
  if (v === null) return 'null'
  if (typeof v === 'boolean') {
    report('G160', 'error', `${where}: отримано обчислене на збірці значення ${v}; рантайм-вираз має бути рядком (SPEC Р1).`, `напр. when="ctx.percent > budgets.soft"; або ${HINT_G160}`)
    return String(v)
  }
  report('G160', 'error', `${where}: ${describe(v)} не є рядковим виразом.`, HINT_G160)
  return 'null'
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return 'масив'
  if (typeof v === 'function') return 'функція'
  if (typeof v === 'object') return "об'єкт"
  return typeof v
}

// ───────────────────────── Markers and JSX values ─────────────────────────

export interface SectionMarker { $cg: 'section'; section: SectionNode }
export interface ElseMarker { $cg: 'else'; children: Node[] }
export interface PromptMarker {
  $cg: 'prompt'
  id?: string
  sections: SectionNode[]
  uses: Record<string, string>
  skill?: {
    name: string
    description: string
    args: Record<string, ArgSpec>
    invoke: { user: boolean; model: 'tool' | 'skill' | false }
    tiers?: Tier[]
    body: Node[]
  }
}
export type Marker = SectionMarker | ElseMarker | PromptMarker

/** What the JSX factory returns. Fragments and inlined components may yield arrays. */
export type JsxValue = Node | Marker | JsxValue[]

/** Anything accepted as a JSX child. Functions are only valid as the child of `Each`. */
export type Child = JsxValue | string | number | boolean | null | undefined | ExprRef | Child[]

export function isMarker(v: unknown): v is Marker {
  return typeof v === 'object' && v !== null && typeof (v as { $cg?: unknown }).$cg === 'string'
}

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { t?: unknown }).t === 'string' && !isExprRef(v)
}

// ───────────────────────── Children normalization ─────────────────────────

type Piece = { raw: string } | Node | Marker

function flatten(children: unknown, out: Piece[], where: string): void {
  if (children === null || children === undefined || typeof children === 'boolean') return
  if (Array.isArray(children)) { for (const c of children) flatten(c, out, where); return }
  if (isExprRef(children)) { out.push({ t: 'expr', expr: children[EXPR] }); return }
  if (typeof children === 'string') { out.push({ raw: children }); return }
  if (typeof children === 'number' || typeof children === 'bigint') { out.push({ raw: String(children) }); return }
  if (isMarker(children) || isNode(children)) { out.push(children); return }
  if (typeof children === 'function') {
    report('G001', 'error', `${where}: функція як дочірній елемент дозволена лише в <Each>.`)
    return
  }
  report('G160', 'error', `${where}: ${describe(children)} не можна вставити в текст.`, HINT_G160)
}

/** Splits a string into text and `{{ expr }}` nodes. */
export function interpolate(s: string): Node[] {
  const out: Node[] = []
  for (const p of splitTemplate(s)) {
    if ('text' in p) { if (p.text) out.push({ t: 'text', value: p.text }) }
    else out.push({ t: 'expr', expr: p.expr })
  }
  return out
}

/**
 * Markdown-rule dedent of raw pieces. The indentation to strip is the common indentation of the lines after a
 * newline in pieces that start on their own line (`\n  text`: authored JSX text and template blocks). A piece
 * that starts mid-line (a data string such as imported code or YAML, or text after an expression) is dedented
 * by that amount only when all its lines are indented at least as much, so its own nesting is never lost.
 */
function dedentPieces(pieces: Piece[]): void {
  const lineIndents = (raw: string): number => {
    let min = Infinity
    const lines = raw.split('\n')
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!
      if (line.trim()) min = Math.min(min, /^[ \t]*/.exec(line)![0].length)
    }
    return min
  }
  let anchor = Infinity
  for (const p of pieces) if ('raw' in p && p.raw.startsWith('\n')) anchor = Math.min(anchor, lineIndents(p.raw))
  for (const p of pieces) {
    if (!('raw' in p) || !p.raw.includes('\n')) continue
    const own = p.raw.startsWith('\n')
    const cut = anchor === Infinity ? 0 : own || lineIndents(p.raw) >= anchor ? anchor : 0
    const lines = p.raw.split('\n')
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!
      lines[i] = line.trim() ? line.slice(cut) : ''
    }
    // Trailing whitespace before a newline carries no meaning in the prompt.
    p.raw = lines.join('\n').replace(/[ \t]+\n/g, '\n')
  }
}

/**
 * Normalizes children of one container: flattens arrays/fragments, dedents the raw text authored in
 * this container (Markdown rules, not JSX rules), parses `{{ }}` placeholders, merges adjacent
 * text, collapses whitespace-only runs between blocks to `\n`/`\n\n`, trims the container edges.
 * Markers (Section, Else, Prompt) are passed through for the container to validate.
 */
export function normalize(children: unknown, where: string): (Node | Marker)[] {
  const pieces: Piece[] = []
  flatten(children, pieces, where)
  dedentPieces(pieces)
  const out: (Node | Marker)[] = []
  const pushText = (value: string) => {
    if (!value) return
    const prev = out[out.length - 1]
    if (prev && !isMarker(prev) && prev.t === 'text') prev.value += value
    else out.push({ t: 'text', value })
  }
  for (const p of pieces) {
    if ('raw' in p) {
      for (const n of interpolate(p.raw)) {
        if (n.t === 'text') pushText(n.value)
        else out.push(n)
      }
    } else if (!isMarker(p) && p.t === 'text') pushText(p.value)
    else out.push(p)
  }
  // Collapse whitespace-only text between blocks, trim the edges of the container.
  for (let i = 0; i < out.length; i++) {
    const n = out[i]!
    if (isMarker(n) || n.t !== 'text') continue
    if (!n.value.trim() && n.value.includes('\n')) n.value = (n.value.match(/\n/g)!.length >= 2 ? '\n\n' : '\n')
    n.value = n.value.replace(/\n{3,}/g, '\n\n')
  }
  const first = out[0]
  if (first && !isMarker(first) && first.t === 'text' && /^\s*\n/.test(first.value)) first.value = first.value.replace(/^\s+/, '')
  const last = out[out.length - 1]
  if (last && !isMarker(last) && last.t === 'text' && /\n\s*$/.test(last.value)) last.value = last.value.replace(/\s+$/, '')
  return out.filter((n) => isMarker(n) || n.t !== 'text' || n.value !== '')
}

/** `normalize` for containers that accept only AST nodes; markers are reported (G001) and dropped. */
export function toNodes(children: unknown, where: string): Node[] {
  const out: Node[] = []
  for (const n of normalize(children, where)) {
    if (!isMarker(n)) { out.push(n); continue }
    if (n.$cg === 'section') report('G001', 'error', `<Section id="${n.section.id}"> не може бути вкладеною (${where}).`, 'секції — лише прямі нащадки <Prompt>')
    else if (n.$cg === 'else') report('G001', 'error', `<Else> поза <If> (${where}).`)
    else report('G001', 'error', `<Prompt> не може бути вкладеним (${where}).`)
  }
  return out
}

/** Raw string content of children (for `Run` code): text concatenated as authored, then dedented. */
export function rawText(children: unknown, where: string): string {
  const parts: string[] = []
  const walk = (c: unknown) => {
    if (c === null || c === undefined || typeof c === 'boolean') return
    if (Array.isArray(c)) { c.forEach(walk); return }
    if (typeof c === 'string' || typeof c === 'number') { parts.push(String(c)); return }
    if (isExprRef(c)) {
      // SPEC: code is never interpolated; the script would get literal braces.
      report('G160', 'error', `${where}: \`${c[EXPR]}\` у коді не підставляється в рантаймі — скрипт отримає «{{ ${c[EXPR]} }}».`, 'скрипт читає контекст зі stdin (CONTEXT_GATE_INPUT) або передай значення через <Call>')
      parts.push(`{{ ${c[EXPR]} }}`)
      return
    }
    if (isNode(c) && c.t === 'text') { parts.push(c.value); return }
    report('G001', 'error', `${where}: очікується текст коду, отримано ${isNode(c) ? `<${c.t}>` : describe(c)}.`, 'код передавай шаблонним рядком: {`...`}')
  }
  walk(children)
  // Formatting whitespace around `{`code`}` (leading/trailing, or a line break between parts) is not part of
  // the code; a single-line separator between parts (`{`grep -rn`} {PATTERN}`) is.
  let a = 0
  let b = parts.length
  if (parts.length > 1) {
    while (a < b && !parts[a]!.trim()) a++
    while (b > a && !parts[b - 1]!.trim()) b--
  }
  const meaningful = parts.slice(a, b).map((x) => (parts.length > 1 && !x.trim() && x.includes('\n') ? x.replace(/[ \t]+/g, '') : x))
  return dedentBlock(meaningful.join(''))
}

/** Dedent a multi-line block (all lines, incl. the first) and trim surrounding blank lines. */
export function dedentBlock(s: string): string {
  const lines = s.replace(/\r\n/g, '\n').split('\n')
  while (lines.length && !lines[0]!.trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  let min = Infinity
  for (const l of lines) if (l.trim()) min = Math.min(min, /^[ \t]*/.exec(l)![0].length)
  if (min === Infinity) min = 0
  return lines.map((l) => l.slice(Math.min(min, /^[ \t]*/.exec(l)![0].length)).replace(/[ \t]+$/, '')).join('\n')
}

// ───────────────────────── The factory ─────────────────────────

/** Brand for builtin components: they are not subject to the recursion guard. */
export const BUILTIN = Symbol.for('context-gate.builtin')

export type Component<P = any> = (props: P) => unknown

export function builtin<F extends Component>(name: string, fn: F): F {
  Object.defineProperty(fn, BUILTIN, { value: true })
  Object.defineProperty(fn, 'displayName', { value: name })
  return fn
}

export const INTRINSIC_TAGS = ['ol', 'ul', 'li', 'pre', 'code', 'b', 'i', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br'] as const
export type IntrinsicTag = (typeof INTRINSIC_TAGS)[number]
const INTRINSIC = new Set<string>(INTRINSIC_TAGS)

const stack: Component[] = []
const MAX_DEPTH = 64

function componentName(fn: Component): string {
  return (fn as { displayName?: string }).displayName || fn.name || 'анонімний компонент'
}

function intrinsic(tag: string, props: Record<string, unknown>): Node {
  if (!INTRINSIC.has(tag)) report('G001', 'error', `Невідомий тег <${tag}>.`, `дозволені: ${INTRINSIC_TAGS.join(', ')}`)
  const attrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(props)) {
    if (k === 'children' || k === 'key' || v === undefined || v === null || v === false) continue
    if (isExprRef(v)) report('G160', 'error', `<${tag} ${k}>: атрибути не інтерполюються, \`${v[EXPR]}\` дасть «{{ ${v[EXPR]} }}».`, 'передай значення дочірнім текстом або атрибутом-рядком')
    attrs[k] = isExprRef(v) ? `{{ ${v[EXPR]} }}` : String(v)
  }
  const node: Node = { t: 'el', tag, children: tag === 'br' ? [] : toNodes(props.children, `<${tag}>`) }
  if (Object.keys(attrs).length) node.attrs = attrs
  return node
}

/** Automatic-runtime factory (`jsx`/`jsxs`): builtins build nodes, user components are inlined. */
export function jsx(type: string | Component, props: Record<string, unknown> | null, _key?: unknown): JsxValue {
  const from = pending.length
  const out = build(type, props ?? {})
  attach(out, from)
  return out
}

function build(type: string | Component, p: Record<string, unknown>): JsxValue {
  if (typeof type === 'string') return intrinsic(type, p)
  if (typeof type !== 'function') {
    report('G001', 'error', `Невірний тип JSX-елемента: ${String(type)}.`)
    return []
  }
  if ((type as unknown as Record<symbol, unknown>)[BUILTIN]) return type(p) as JsxValue
  if (stack.includes(type) || stack.length >= MAX_DEPTH) {
    const chain = [...stack.slice(stack.indexOf(type) >= 0 ? stack.indexOf(type) : 0), type].map(componentName).join(' → ')
    report('G151', 'error', `Рекурсія компонентів: ${chain}.`, 'ця логіка має жити в провайдері')
    return []
  }
  stack.push(type)
  try {
    return type(p) as JsxValue
  } finally {
    stack.pop()
  }
}

export const jsxs = jsx

/** Set on a normalized fragment whose authored content ended with a line break (trimmed by `normalize`). */
const TRAILING_NL = Symbol.for('context-gate.trailing-newline')

/**
 * Whether a loop body ends with a line break as authored (`x => `- ${x}\n``, `<>- {f}{'\n'}</>`). `normalize`
 * trims it as container-edge formatting; a loop body keeps it, so text iterations are not glued together.
 */
export function endsWithNewline(v: unknown): boolean {
  if (typeof v === 'string') return /\n[ \t]*$/.test(v)
  if (!Array.isArray(v)) return false
  if ((v as unknown as Record<symbol, unknown>)[TRAILING_NL]) return true
  for (let i = v.length - 1; i >= 0; i--) {
    const c = v[i]
    if (c === null || c === undefined || typeof c === 'boolean') continue
    if (typeof c === 'string' && !c.trim()) return c.includes('\n')
    return endsWithNewline(c)
  }
  return false
}

/** Normalized loop-body nodes, with the authored trailing line break kept after inline content. */
export function loopBody(body: unknown, where: string): Node[] {
  const nodes = toNodes(body, where)
  const last = nodes[nodes.length - 1]
  if (!last || !endsWithNewline(body)) return nodes
  if (last.t === 'text' && !last.value.endsWith('\n')) last.value += '\n'
  else if (last.t === 'expr') nodes.push({ t: 'text', value: '\n' })
  return nodes
}

/** Fragment: normalizes its children in place (text dedented relative to the fragment). */
export const Fragment = builtin('Fragment', (props: { children?: unknown }): JsxValue => {
  const out = normalize(props.children, '<>') as JsxValue[]
  if (endsWithNewline(props.children)) Object.defineProperty(out, TRAILING_NL, { value: true })
  return out as JsxValue
})

/** Classic factory (`h(type, props, ...children)`), e.g. for tests or `jsxFactory: 'h'`. */
export function h(type: string | Component, props: Record<string, unknown> | null, ...children: unknown[]): JsxValue {
  const p: Record<string, unknown> = { ...(props ?? {}) }
  if (children.length === 1) p.children = children[0]
  else if (children.length > 1) p.children = children
  return jsx(type, p)
}
