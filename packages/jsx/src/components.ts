// Builtin components of @context-gate/jsx. Each returns a canonical AST node (types.ts `Node`)
// or a marker (`Section`, `Prompt`, `Else`) that its container consumes. Expressions are strings
// (SPEC Р1, level 1); `exprOf` accepts strings, `ctx`/`Each` references and number literals.

import type { ArgSpec, IncludeMode, Node, Scope, SectionNode, Tier as TierName } from '../../core/src/types.ts'
import {
  builtin, callerLocation, dedentBlock, exprLiteral, exprOf, interpolate, isExprRef, isMarker, normalize, rawText, ref, report, toNodes, EXPR,
  type Child, type ExprRef, type JsxValue, type PromptMarker, type SectionMarker, type ElseMarker,
} from './core.ts'

/** A runtime expression: a string in the expression language, or a `ctx`/`Each` reference. */
export type Expr = string | ExprRef

/**
 * A runtime condition. Level 1: an `Expr`. Level 2 (`prompt.transform: "level2"` or `// @context-gate level2`):
 * also a native TS boolean expression over `ctx` (`ctx.ctx.percent > ctx.budgets.soft`), rewritten at build.
 */
export type Cond = Expr | boolean

type WithChildren = { children?: Child }

function req(v: string | undefined, comp: string, prop: string): string {
  if (v === undefined || v === '') {
    report('G001', 'error', `<${comp}>: обов'язковий проп \`${prop}\` відсутній.`)
    return ''
  }
  return v
}

function stringProp(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (isExprRef(v)) return `{{ ${v[EXPR]} }}`
  return String(v)
}

function tierList(v: TierName | TierName[] | undefined): TierName[] | undefined {
  if (v === undefined) return undefined
  return (Array.isArray(v) ? v : String(v).split(',')).map((t) => t.trim()).filter(Boolean)
}

// ───────────────────────── Prompt / Section ─────────────────────────

export interface PromptProps extends WithChildren {
  /** `skill`: the prompt is a skill rendered at invocation time with parsed `args`. */
  as?: 'skill'
  /** Prompt id (default: file name without `.prompt.tsx`); for skills the `name`. */
  id?: string
  name?: string
  description?: string
  args?: Record<string, ArgSpec>
  /** Default `{ user: true, model: 'skill' }`. */
  invoke?: { user?: boolean; model?: 'tool' | 'skill' | false }
  tiers?: TierName[]
}

export const Prompt = builtin('Prompt', (props: PromptProps): PromptMarker => {
  const sections: SectionNode[] = []
  const uses: Record<string, string> = {}
  const body: Node[] = []
  for (const n of normalize(props.children, '<Prompt>')) {
    if (isMarker(n)) {
      if (n.$cg === 'section') sections.push(n.section)
      else if (n.$cg === 'else') report('G001', 'error', '<Else> поза <If>.')
      else report('G001', 'error', '<Prompt> не може бути вкладеним.')
      continue
    }
    if (n.t === 'use') { uses[n.name] = n.path; continue }
    if (props.as === 'skill') { body.push(n); continue }
    if (n.t === 'text' && !n.value.trim()) continue
    report('G001', 'error', `Вміст <${n.t === 'text' ? 'текст' : n.t}> поза <Section> у звичайному промпті.`, 'загорни його в <Section id="…" scope="…">')
  }
  // Removing top-level <Use> leaves formatting whitespace behind: merge it and trim the edges.
  for (let i = body.length - 1; i > 0; i--) {
    const a = body[i - 1]!, b = body[i]!
    if (a.t === 'text' && b.t === 'text') { a.value = !a.value.trim() && !b.value.trim() ? (a.value + b.value).includes('\n\n') ? '\n\n' : '\n' : a.value + b.value; body.splice(i, 1) }
  }
  while (body[0]?.t === 'text' && !body[0].value.trim()) body.shift()
  const lastNode = body[body.length - 1]
  if (lastNode?.t === 'text' && !lastNode.value.trim()) body.pop()
  if (body[0]?.t === 'text') body[0].value = body[0].value.replace(/^\s+/, '')
  const out: PromptMarker = { $cg: 'prompt', sections, uses }
  const id = props.id ?? (props.as === 'skill' ? props.name : undefined)
  if (id) out.id = id
  if (props.as === 'skill') {
    const name = req(props.name, 'Prompt as="skill"', 'name')
    if (!props.description) report('G001', 'warning', `Skill "${name}" без description: модель не знатиме, коли його викликати.`)
    const invoke = { user: props.invoke?.user ?? true, model: props.invoke?.model ?? ('skill' as const) }
    out.skill = { name, description: props.description ?? '', args: props.args ?? {}, invoke, body }
    if (props.tiers) out.skill.tiers = tierList(props.tiers)
  }
  return out
})

export interface SectionProps extends WithChildren {
  id: string
  scope: Scope
  /** Section is present only when the expression is true. */
  when?: Cond
  /** Max characters; overflow is truncated with a marker. */
  budget?: number
  /** Insert after this section id (within the scope). */
  after?: string
  /** Shorthand for `<Tier>` around the whole section. */
  tier?: TierName | TierName[]
}

export const Section = builtin('Section', (props: SectionProps): SectionMarker => {
  const section: SectionNode = { id: req(props.id, 'Section', 'id'), scope: props.scope ?? 'profile', children: toNodes(props.children, `<Section id="${props.id}">`) }
  if (!['static', 'profile', 'volatile'].includes(section.scope)) report('G001', 'error', `<Section id="${props.id}">: невідомий scope "${section.scope}".`, 'static | profile | volatile')
  const when = exprOf(props.when, `<Section id="${props.id}"> when`)
  if (when !== undefined) section.when = when
  if (props.budget !== undefined) section.budget = props.budget
  if (props.after !== undefined) section.after = props.after
  const tier = tierList(props.tier)
  if (tier) section.tier = tier
  const loc = callerLocation()
  if (loc) section.source = loc
  return { $cg: 'section', section }
})

// ───────────────────────── Control flow ─────────────────────────

export interface IfProps extends WithChildren { test: Cond }

export const If = builtin('If', (props: IfProps): Node => {
  const then: Node[] = []
  let els: Node[] | undefined
  for (const n of normalize(props.children, '<If>')) {
    if (!isMarker(n)) { (els ?? then).push(n); continue }
    if (n.$cg === 'else' && !els) { els = n.children; continue }
    report('G001', 'error', n.$cg === 'else' ? 'Друге <Else> в одному <If>.' : `<${n.$cg === 'section' ? 'Section' : 'Prompt'}> всередині <If>.`)
  }
  // Text between `then` content and <Else> is whitespace; trim the tail of `then`.
  const tail = then[then.length - 1]
  if (tail && tail.t === 'text') { tail.value = tail.value.replace(/\s+$/, ''); if (!tail.value) then.pop() }
  const node: Node = { t: 'if', test: req(exprOf(props.test, '<If> test'), 'If', 'test'), then }
  if (els) node.else = els
  return node
})

export const Else = builtin('Else', (props: WithChildren): ElseMarker => ({ $cg: 'else', children: toNodes(props.children, '<Else>') }))

export type EachChild = Child | ((item: any, index: any) => Child)

export interface EachProps {
  /** List expression (`"cursor.always"`), a reference, or a build-time array (unrolled at build time). */
  of: Expr | readonly unknown[]
  /** Item variable name; default: the function child's parameter name, else `it`. */
  as?: string
  index?: string
  children?: EachChild
}

function paramNames(fn: Function): string[] {
  const src = fn.toString()
  const m = /^\s*(?:async\s*)?(?:function\b[^(]*)?\(([^)]*)\)/.exec(src) ?? /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(src)
  if (!m) return []
  return m[1]!.split(',').map((s) => s.trim().split(/[\s=:]/)[0]!).map((s) => (/^[A-Za-z_$][\w$]*$/.test(s) ? s : ''))
}

export const Each = builtin('Each', (props: EachProps): JsxValue => {
  let child: unknown = props.children
  // Formatting whitespace around a function child (`{r => …}` on its own line) is not content.
  if (Array.isArray(child)) {
    const meaningful = child.filter((c) => !(typeof c === 'string' && !c.trim()))
    if (meaningful.length === 1 && typeof meaningful[0] === 'function') child = meaningful[0]
  }
  const fn = typeof child === 'function' && !isExprRef(child) ? (child as (item: unknown, index: unknown) => Child) : undefined
  if (Array.isArray(props.of)) {
    // Build-time data: unroll now, the AST gets constants (SPEC «Імпорти»).
    if (!fn) {
      report('G160', 'error', '<Each of={масив}> з дочірніми вузлами: дані збірки не можна передати в рантайм-цикл.', 'передай функцію-дитину або винеси дані у провайдер')
      return []
    }
    return props.of.map((item, i) => normalize(fn(item, i), '<Each>')) as JsxValue
  }
  const names = fn ? paramNames(fn) : []
  const as = props.as ?? (names[0] || 'it')
  const node: Node = { t: 'each', of: req(exprOf(props.of, '<Each> of'), 'Each', 'of'), as, children: [] }
  const index = props.index ?? (fn && fn.length >= 2 ? names[1] || 'i' : undefined)
  if (index) node.index = index
  node.children = toNodes(fn ? fn(ref(as), index ? ref(index) : undefined) : child, '<Each>')
  return node
})

export const Let = builtin('Let', (props: { name: string; value: Expr | number | boolean | object | null }): Node => ({ t: 'let', name: req(props.name, 'Let', 'name'), value: req(exprOf(props.value, '<Let> value'), 'Let', 'value') }))

export const Set = builtin('Set', (props: { name: string; value: Expr | number | boolean | object | null }): Node => ({ t: 'set', name: req(props.name, 'Set', 'name'), value: req(exprOf(props.value, '<Set> value'), 'Set', 'value') }))

/** Persist a section variable to `data.<name>`. */
/** `<Store name="api" />` persists `api` to `data.api`; `to="api-endpoints"` picks another data key. After a
 * `Run`/`Call` it keeps that result's `fetchedAt` and `cache` (the renderer carries the metadata). */
export const Store = builtin('Store', (props: { name: string; to?: string }): Node => {
  const name = req(props.name, 'Store', 'name')
  return { t: 'store', name, ...(props.to && props.to !== name ? { key: props.to } : {}) }
})

export const Repeat = builtin('Repeat', (props: { n: Expr | number; children?: Child }): Node => {
  if (typeof props.n === 'number' && props.n > 1000) report('G152', 'error', `<Repeat n={${props.n}}>: понад 1 000 ітерацій.`, 'провайдер повертає готовий список')
  return { t: 'repeat', n: req(exprOf(props.n, '<Repeat> n'), 'Repeat', 'n'), children: toNodes(props.children, '<Repeat>') }
})

export const Break = builtin('Break', (): Node => ({ t: 'break' }))
export const Continue = builtin('Continue', (): Node => ({ t: 'continue' }))

// ───────────────────────── Scripts ─────────────────────────

export interface RunProps {
  lang: string
  /** Duration (`5m`). Required inside `static` sections (build error G163). */
  cache?: string
  as?: string
  store?: string
  needs?: string[]
  /** Code. Use a template literal when it contains `{`/`}`: `{\`...\`}`. */
  children?: Child
}

export const Run = builtin('Run', (props: RunProps): Node => {
  const node: Node = { t: 'run', lang: req(props.lang, 'Run', 'lang'), code: rawText(props.children, '<Run>') }
  if (!node.code) report('G001', 'error', '<Run> без коду.')
  if (props.as) node.as = props.as
  if (props.cache) node.cache = props.cache
  if (props.store) { node.store = props.store; legacyStore('Run', props.store, node.as) }
  if (props.needs?.length) node.needs = [...props.needs]
  return node
})

/**
 * Р5: `store=` on `Run`/`Call` is the legacy form of `<Store>`; accepted until 1.0 with G180. `compilePrompt`
 * (core `canonicalNodes`) splits it into the node plus `{ t: 'store', name, key }`; the store node carries the
 * run's `fetchedAt` / `cache` metadata, so `data.*` freshness is unchanged.
 */
function legacyStore(comp: string, key: string, as: string | undefined): void {
  report('G180', 'warning', `<${comp} store="${key}"> — застаріла форма збереження.`, `використай <${comp} as="${as ?? key}" … /> і <Store name="${as ?? key}"${as && as !== key ? ` to="${key}"` : ''} />`)
}

/** Bind a script module to a namespace (`gitx` → `scripts/git-extra.js`). */
export const Use = builtin('Use', (props: { name: string; path: string }): Node => ({ t: 'use', name: req(props.name, 'Use', 'name'), path: req(props.path, 'Use', 'path') }))

export interface CallProps {
  /** `ns.fn`, namespace bound by `<Use>`. */
  fn: string
  args?: (Expr | number)[]
  kwargs?: Record<string, Expr | number>
  as?: string
  cache?: string
  store?: string
}

export const Call = builtin('Call', (props: CallProps): Node => {
  const fn = req(props.fn, 'Call', 'fn')
  const node: Node = { t: 'call', fn, args: (props.args ?? []).map((a, i) => exprOf(a, `<Call> args[${i}]`) ?? 'null'), as: props.as ?? fn.split('.').pop()! }
  if (props.kwargs) node.kwargs = Object.fromEntries(Object.entries(props.kwargs).map(([k, v]) => [k, exprOf(v, `<Call> kwargs.${k}`) ?? 'null']))
  if (props.cache) node.cache = props.cache
  if (props.store) { node.store = props.store; legacyStore('Call', props.store, node.as) }
  return node
})

// ───────────────────────── Inclusion ─────────────────────────

export interface IncludeProps {
  /** Repo file (repo-relative). */
  path?: string
  /** Literal text (e.g. an imported `.md`). */
  text?: string | { text: string }
  /** Another section id (`prompt://<id>`). */
  section?: string
  mode?: IncludeMode
  budget?: number
  description?: string
}

export const Include = builtin('Include', (props: IncludeProps): Node => {
  const mode = props.mode ?? 'inline'
  const set = [props.path !== undefined, props.text !== undefined, props.section !== undefined].filter(Boolean).length
  if (set !== 1) report('G001', 'error', '<Include>: потрібен рівно один із `path`, `text`, `section`.')
  let node: Node
  if (props.text !== undefined) {
    const text = typeof props.text === 'string' ? props.text : props.text.text
    node = { t: 'include', source: 'text', ref: 'text', mode, text: dedentBlock(text) }
  } else if (props.section !== undefined) node = { t: 'include', source: 'section', ref: props.section, mode }
  else node = { t: 'include', source: 'file', ref: props.path ?? '', mode }
  if (props.budget !== undefined) node.budget = props.budget
  if (props.description) node.description = props.description
  return node
})

export const Skill = builtin('Skill', (props: { name: string; mode?: IncludeMode; budget?: number }): Node => {
  const node: Node = { t: 'include', source: 'skill', ref: req(props.name, 'Skill', 'name'), mode: props.mode ?? 'ref' }
  if (props.budget !== undefined) node.budget = props.budget
  return node
})

export const Rule = builtin('Rule', (props: { id: string; mode?: IncludeMode; budget?: number }): Node => {
  const node: Node = { t: 'include', source: 'rule', ref: req(props.id, 'Rule', 'id'), mode: props.mode ?? 'ref' }
  if (props.budget !== undefined) node.budget = props.budget
  return node
})

export interface McpProps {
  server: string
  tool: string
  /** Literals (`'open'`, `3`, `true`) or expressions (`'{{ args.pr }}'`, a `ctx` reference). */
  args?: Record<string, unknown>
  /** Variable for the result (data, not text). Default `<tool>`. */
  as?: string
  mode?: IncludeMode
}

function mcpArg(v: unknown, key: string): string {
  if (typeof v === 'string') {
    const m = /^\s*\{\{\s*([\s\S]*?)\s*\}\}\s*$/.exec(v)
    return m ? m[1]! : JSON.stringify(v)
  }
  if (isExprRef(v)) return v[EXPR]
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return JSON.stringify(v)
  if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
    try { return JSON.stringify(v) } catch { /* fallthrough */ }
  }
  return exprOf(v, `<Mcp> args.${key}`) ?? 'null'
}

export const Mcp = builtin('Mcp', (props: McpProps): Node => {
  const server = req(props.server, 'Mcp', 'server')
  const tool = req(props.tool, 'Mcp', 'tool')
  const node: Node = { t: 'include', source: 'mcp', ref: `${server}.${tool}`, mode: props.mode ?? 'inline', as: props.as ?? tool }
  if (props.args) node.args = Object.fromEntries(Object.entries(props.args).map(([k, v]) => [k, mcpArg(v, k)]))
  return node
})

/** Legacy: `<Lazy name path>description</Lazy>` → `include mode=lazy` + G180 (SPEC Р5). */
export const Lazy = builtin('Lazy', (props: { name: string; path: string; children?: Child }): Node => {
  report('G180', 'warning', `<Lazy name="${props.name}"> — застаріла форма.`, `використай <Include path="${props.path}" mode="lazy" description="…" />`)
  const node: Node = { t: 'include', source: 'file', ref: req(props.path, 'Lazy', 'path'), mode: 'lazy', as: req(props.name, 'Lazy', 'name') }
  const description = toNodes(props.children, '<Lazy>').map((n) => (n.t === 'text' ? n.value : n.t === 'expr' ? `{{ ${n.expr} }}` : '')).join('').trim()
  if (description) node.description = description
  return node
})

// ───────────────────────── Tier and formatting ─────────────────────────

/** Variant for model tiers. Without `is`: every tier except premium. */
export const Tier = builtin('Tier', (props: { is?: TierName | TierName[] | 'non-premium'; children?: Child }): Node => {
  const is = props.is === undefined || props.is === 'non-premium' ? 'non-premium' : tierList(props.is as TierName | TierName[])!
  return { t: 'tier', is, children: toNodes(props.children, '<Tier>') }
})

export const Fence = builtin('Fence', (props: { lang?: string; title?: string | ExprRef; children?: Child }): Node => {
  const node: Node = { t: 'fence', children: toNodes(props.children, '<Fence>') }
  if (props.lang) node.lang = props.lang
  const title = stringProp(props.title)
  if (title) node.title = title
  return node
})

export const List = builtin('List', (props: { ordered?: boolean; children?: Child }): Node => {
  const node: Node = { t: 'list', children: toNodes(props.children, '<List>') }
  if (props.ordered) node.ordered = true
  return node
})

export interface TableProps {
  columns: string[]
  /** List expression. */
  rows: Expr
  /** One expression per column, over `row`. */
  cells: Expr[]
}

export const Table = builtin('Table', (props: TableProps): Node => {
  if (props.cells.length !== props.columns.length) report('G001', 'error', `<Table>: ${props.columns.length} колонок, але ${props.cells.length} клітинок.`)
  return { t: 'table', columns: [...props.columns], rows: req(exprOf(props.rows, '<Table> rows'), 'Table', 'rows'), cells: props.cells.map((c, i) => exprOf(c, `<Table> cells[${i}]`) ?? 'null') }
})

/** `{{ expr }}` interpolation. */
export const V = builtin('V', (props: { expr: Expr }): Node => ({ t: 'expr', expr: req(exprOf(props.expr, '<V> expr'), 'V', 'expr') }))

// ───────────────────────── Debug (never reaches the prompt) ─────────────────────────

export const Debug = builtin('Debug', (props: { exprs?: Expr[]; message?: string; children?: Child }): Node => {
  const exprs = (props.exprs ?? []).map((x, i) => exprOf(x, `<Debug> exprs[${i}]`) ?? 'null')
  const kids: unknown[] = Array.isArray(props.children) ? (props.children as unknown[]).flat(8) : props.children === undefined ? [] : [props.children]
  for (const k of kids) {
    if (k === undefined || k === null || typeof k === 'boolean' || (typeof k === 'string' && !k.trim())) continue
    exprs.push(exprOf(k, '<Debug>') ?? 'null')
  }
  const node: Node = { t: 'debug', exprs }
  if (props.message) node.message = props.message
  return node
})

export const Assert = builtin('Assert', (props: { test: Cond; message?: string }): Node => {
  const node: Node = { t: 'assert', test: req(exprOf(props.test, '<Assert> test'), 'Assert', 'test') }
  if (props.message) node.message = props.message
  return node
})

export const Log = builtin('Log', (props: { level?: 'info' | 'warn' | 'error'; message?: string; children?: Child }): Node => {
  const message = props.message ?? toNodes(props.children, '<Log>').map((n) => (n.t === 'text' ? n.value : n.t === 'expr' ? `{{ ${n.expr} }}` : '')).join('')
  return { t: 'log', level: props.level ?? 'info', message }
})

export const Trace = builtin('Trace', (props: { on?: boolean }): Node => ({ t: 'trace', on: props.on ?? true }))

// ───────────────────────── Library components ─────────────────────────

/**
 * Cursor rules as a list. `match` — a path expression: rules attached to that path via the cursor
 * provider (`cursor.match(path)`); without `match` — Always rules (`cursor.always`).
 */
export const CursorRules = builtin('CursorRules', (props: { match?: Expr; heading?: string }): JsxValue => {
  const m = exprOf(props.match, '<CursorRules> match')
  const of = m ? `cursor.match(${m})` : 'cursor.always'
  const out: Node[] = []
  if (props.heading) out.push({ t: 'text', value: `${props.heading}\n` })
  out.push({ t: 'each', of, as: 'r', children: [{ t: 'el', tag: 'li', children: [{ t: 'expr', expr: 'r.body' }] }] })
  return out
})

const EXT_LANG: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'python', sh: 'bash', go: 'go', rs: 'rust', md: 'md', json: 'json' }

/** Repository examples: `fs.examples(glob, n)` (smallest files), each as a fenced block. */
export const Examples = builtin('Examples', (props: { glob: string; n?: number; lang?: string; title?: string }): Node => {
  const glob = req(props.glob, 'Examples', 'glob')
  const ext = /\.([A-Za-z0-9]+)$/.exec(glob)?.[1]
  const lang = props.lang ?? (ext ? EXT_LANG[ext] ?? ext : undefined)
  const fence: Node = { t: 'fence', title: '{{ ex.path }}', children: [{ t: 'expr', expr: 'ex.body' }] }
  if (lang) fence.lang = lang
  const children: Node[] = props.title ? [...interpolate(`${props.title}\n`), fence] : [fence]
  return { t: 'each', of: `fs.examples(${exprLiteral(glob)}, ${props.n ?? 1})`, as: 'ex', children }
})

/** Context-budget warning: shown when `ctx.percent` passes the soft budget. */
export const HealthWarning = builtin('HealthWarning', (props: { threshold?: Expr; children?: Child }): Node => {
  const then = props.children === undefined ? interpolate('Контекст {{ ctx.percent }}% — відповідай стисло, без повторів уже сказаного.') : toNodes(props.children, '<HealthWarning>')
  return { t: 'if', test: `ctx.percent > ${exprOf(props.threshold, '<HealthWarning> threshold') ?? 'budgets.soft'}`, then }
})
