// Core of @context-gate/jsx: the JSX factory, expression references, children normalization
// and the build-time diagnostics collector. Build-time only; no Node imports.
//
// Evaluation model: the JSX factory is eager. Children are evaluated before their parent
// (that is how JS evaluates call arguments), builtin components turn props + children into
// AST nodes (`types.ts` `Node`) or marker objects (`Section`, `Prompt`, `Else`), and user
// function components are inlined at the call site under a recursion guard (G151).

import type { Code, Diagnostic, Node, SectionNode, ArgSpec, Tier } from '../../core/src/types.ts'

// ───────────────────────── Diagnostics collector ─────────────────────────

let pending: Diagnostic[] = []

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
  return out
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

const IDENT = /^[A-Za-z_$][\w$-]*$/

/** Expression source for a literal or reference used inside a call/template (`"str"`, `3`, `a.b`). */
export function exprLiteral(v: unknown): string {
  if (isExprRef(v)) return v[EXPR]
  if (v === undefined) return 'null'
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(exprLiteral).join(', ')}]`
  report('G160', 'error', `Значення ${describe(v)} не можна передати у вираз.`, HINT_G160)
  return 'null'
}

export const HINT_G160 = 'винести у module-провайдер або pipe-фільтр'

/**
 * Creates an expression reference. `ref('r').body` → path `r.body`; `ref('').git.branch` → `git.branch`.
 * Supported: property access, numeric index (`.at(n)`), calls with literal/reference args, template
 * literals and string concatenation (→ `{{ path }}`). JS operators (`>`, `===`, `&&`, `? :`) are NOT
 * intercepted (SPEC Р1): arithmetic/relational use is reported as G160, the rest silently yields a
 * build-time value, so runtime conditions must be written as strings.
 */
export function ref(path: string): any {
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
      if (/^\d+$/.test(key)) return ref(`${path}.at(${key})`)
      if (!path) return ref(key)
      return ref(IDENT.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`)
    },
    apply(_t, _this, args: unknown[]) {
      return ref(`${path}(${args.map(exprLiteral).join(', ')})`)
    },
    has(_t, key) { return key === EXPR },
  })
}

const PLACEHOLDER = /\{\{\s*([\s\S]*?)\s*\}\}/g

/**
 * Normalizes a value in an expression position (`when`, `test`, `of`, `value`, `expr`, `n`, ...)
 * to an expression string. Strings are expression sources (`{{ x }}` placeholders are unwrapped,
 * so template literals over `ctx` work); references give their path; numbers/null are literals.
 * Booleans and objects are build-time values that leaked into a runtime position → G160.
 */
export function exprOf(v: unknown, where: string): string | undefined {
  if (v === undefined) return undefined
  if (typeof v === 'string') return v.replace(PLACEHOLDER, (_m, inner: string) => inner).trim()
  if (isExprRef(v)) return v[EXPR]
  if (typeof v === 'number' || v === null) return String(v)
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
  let last = 0
  for (const m of s.matchAll(PLACEHOLDER)) {
    if (m.index! > last) out.push({ t: 'text', value: s.slice(last, m.index) })
    out.push({ t: 'expr', expr: m[1]!.trim() })
    last = m.index! + m[0].length
  }
  if (last < s.length) out.push({ t: 'text', value: s.slice(last) })
  return out
}

/** Markdown-rule dedent of raw pieces: strip the common indentation of lines that start after a newline. */
function dedentPieces(pieces: Piece[]): void {
  let min = Infinity
  for (const p of pieces) {
    if (!('raw' in p)) continue
    const lines = p.raw.split('\n')
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!
      if (!line.trim()) continue
      const ind = /^[ \t]*/.exec(line)![0].length
      if (ind < min) min = ind
    }
  }
  if (min === Infinity) min = 0
  for (const p of pieces) {
    if (!('raw' in p)) continue
    const lines = p.raw.split('\n')
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!
      lines[i] = line.trim() ? line.slice(min) : ''
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
    if (isExprRef(c)) { parts.push(`{{ ${c[EXPR]} }}`); return }
    if (isNode(c) && c.t === 'text') { parts.push(c.value); return }
    report('G001', 'error', `${where}: очікується текст коду, отримано ${isNode(c) ? `<${c.t}>` : describe(c)}.`, 'код передавай шаблонним рядком: {`...`}')
  }
  walk(children)
  // Formatting whitespace around `{`code`}` is not part of the code.
  const meaningful = parts.length > 1 ? parts.filter((x) => x.trim()) : parts
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
    attrs[k] = isExprRef(v) ? `{{ ${v[EXPR]} }}` : String(v)
  }
  const node: Node = { t: 'el', tag, children: tag === 'br' ? [] : toNodes(props.children, `<${tag}>`) }
  if (Object.keys(attrs).length) node.attrs = attrs
  return node
}

/** Automatic-runtime factory (`jsx`/`jsxs`): builtins build nodes, user components are inlined. */
export function jsx(type: string | Component, props: Record<string, unknown> | null, _key?: unknown): JsxValue {
  const p = props ?? {}
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

/** Fragment: normalizes its children in place (text dedented relative to the fragment). */
export const Fragment = builtin('Fragment', (props: { children?: unknown }): JsxValue => normalize(props.children, '<>') as JsxValue)

/** Classic factory (`h(type, props, ...children)`), e.g. for tests or `jsxFactory: 'h'`. */
export function h(type: string | Component, props: Record<string, unknown> | null, ...children: unknown[]): JsxValue {
  const p: Record<string, unknown> = { ...(props ?? {}) }
  if (children.length === 1) p.children = children[0]
  else if (children.length > 1) p.children = children
  return jsx(type, p)
}
