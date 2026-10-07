// Ctx model for the editor tooling: the shape of everything a level-1 string expression can read
// (SPEC Р1, Р4, "Редактор DSL та індекс автокомпліту"). Built from gate.json, gate.index.json,
// `.types/ctx.d.ts` (fallback for profile/tier unions) and the last trace. Pure: callers pass the
// parsed JSON / text; no Node imports here.

import type { Diagnostic, GateConfig, Scope_, TraceEntry, Value } from '../../core/src/types.ts'
import type { RunJson } from '../../core/src/runjson.ts'

export type Shape =
  | { k: 'any'; doc?: string }
  /** Provider without `schema` (Р4): field access gives G170. */
  | { k: 'unknown'; provider: string; doc?: string }
  | { k: 'prim'; t: 'string' | 'number' | 'boolean' | 'null'; values?: string[]; doc?: string }
  | { k: 'array'; item: Shape; doc?: string }
  | { k: 'object'; props: Record<string, Shape>; open?: boolean; doc?: string }
  | { k: 'fn'; ret: Shape; sig: string; doc?: string }

const any = (doc?: string): Shape => (doc ? { k: 'any', doc } : { k: 'any' })
const str = (doc?: string, values?: string[]): Shape => ({ k: 'prim', t: 'string', ...(values ? { values } : {}), ...(doc ? { doc } : {}) })
const num = (doc?: string): Shape => ({ k: 'prim', t: 'number', ...(doc ? { doc } : {}) })
const bool = (doc?: string): Shape => ({ k: 'prim', t: 'boolean', ...(doc ? { doc } : {}) })
const arr = (item: Shape, doc?: string): Shape => ({ k: 'array', item, ...(doc ? { doc } : {}) })
const obj = (props: Record<string, Shape>, doc?: string, open?: boolean): Shape => ({ k: 'object', props, ...(open ? { open } : {}), ...(doc ? { doc } : {}) })
const fn = (sig: string, ret: Shape, doc?: string): Shape => ({ k: 'fn', sig, ret, ...(doc ? { doc } : {}) })

const RULE_REF = obj({ id: str(), name: str(), description: str(), body: str('тіло правила'), globs: arr(str()), cost: obj({ chars: num() }) }, 'правило Cursor')
const COMMIT = obj({ hash: str(), subject: str(), author: str(), date: str(), type: str(), scope: str() }, 'коміт')
const EXAMPLE = obj({ path: str(), body: str(), chars: num() }, 'файл-приклад')

/** Shapes of the builtin roots (mirror of `@context-gate/jsx` `DefaultCtx`). */
export function builtinRoots(profiles: string[] = [], tiers: string[] = []): Record<string, Shape> {
  return {
    gate: obj({
      profile: str('активний профіль', profiles.length ? profiles : undefined),
      tier: str('tier моделі', tiers.length ? tiers : undefined),
      groups: arr(str(), 'активні групи'),
      off: bool('фільтрацію вимкнено (/gate off)'),
      skills: obj({ on: arr(str()), nameOnly: arr(str()), off: arr(str()), preload: arr(str()) }),
    }, 'рішення gate'),
    git: obj({
      branch: str('поточна гілка'), head: str(), dirty: bool(), ahead: num(), behind: num(), changed: arr(str(), 'змінені файли'),
      log: fn('log(n?: number)', arr(COMMIT), 'останні коміти'),
    }, 'провайдер git'),
    fs: obj({
      examples: fn('examples(glob: string, n?: number)', arr(EXAMPLE), 'найменші файли за glob'),
      glob: fn('glob(pattern: string)', arr(str())),
      exists: fn('exists(path: string)', bool()),
    }, 'провайдер fs'),
    cursor: obj({
      always: arr(RULE_REF, 'Always-правила'), auto: arr(RULE_REF, 'Auto Attached-правила'), agent: arr(RULE_REF), manual: arr(RULE_REF),
      match: fn('match(path: string)', arr(RULE_REF), 'правила для шляху'),
    }, 'правила Cursor'),
    session: obj({ id: str(), model: str('id моделі'), cwd: str(), root: str(), turn: num('номер ходу'), agentId: str() }, 'сесія Claude Code'),
    ctx: obj({ percent: num('заповнення контексту, %'), tokens: num(), limit: num() }, 'вікно контексту'),
    budgets: obj({ soft: num('softContextPct'), hard: num('hardContextPct') }, 'бюджети контексту'),
    args: obj({}, 'аргументи skill', true),
    data: obj({}, 'збережені дані (Store, store=)', true),
    scripts: any('скрипти з <promptDir>/scripts: scripts.f(...) (Р5)'),
  }
}

export const BUILTIN_ROOT_NAMES = ['gate', 'git', 'fs', 'cursor', 'session', 'ctx', 'budgets', 'args', 'data', 'scripts'] as const

/** JSON Schema → Shape (type, enum, const, anyOf/oneOf, object, array). */
export function schemaToShape(schema: unknown, depth = 0): Shape {
  if (!schema || typeof schema !== 'object' || depth > 8) return any()
  const s = schema as Record<string, unknown>
  const doc = typeof s.description === 'string' ? s.description : undefined
  if ('const' in s) return typeof s.const === 'string' ? str(doc, [s.const]) : any(doc)
  if (Array.isArray(s.enum)) return s.enum.every((v) => typeof v === 'string') ? str(doc, s.enum as string[]) : any(doc)
  for (const k of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(s[k])) {
      const objs = (s[k] as unknown[]).map((x) => schemaToShape(x, depth + 1)).filter((x) => x.k === 'object')
      if (objs.length === 1) return objs[0]!
      return any(doc)
    }
  }
  const type = Array.isArray(s.type) ? (s.type as unknown[]).find((t) => t !== 'null') : (s.type ?? (s.properties ? 'object' : s.items ? 'array' : undefined))
  switch (type) {
    case 'string': return str(doc)
    case 'number': case 'integer': return num(doc)
    case 'boolean': return bool(doc)
    case 'null': return { k: 'prim', t: 'null' }
    case 'array': return arr(schemaToShape(s.items, depth + 1), doc)
    case 'object': {
      const props: Record<string, Shape> = {}
      for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) props[k] = schemaToShape(v, depth + 1)
      const open = s.additionalProperties !== false && (s.additionalProperties !== undefined || Object.keys(props).length === 0)
      return obj(props, doc, open)
    }
    default: return any(doc)
  }
}

/** Placeholders of the index sampler (core `sampleValue`): a cut object, an array length, a dropped content string. */
const SAMPLE_OBJECT = '{…}'
const SAMPLE_ARRAY = /^\[\d+\]$/
const SAMPLE_CONTENT = /^string\(\d+\)$/

/** Shape inferred from a sample value (index / trace snapshots). Objects stay open: a sample is not a schema. */
export function valueToShape(v: unknown, depth = 0): Shape {
  if (v === null || v === undefined) return any()
  if (v === SAMPLE_OBJECT) return any()
  if (typeof v === 'string' && SAMPLE_ARRAY.test(v)) return arr(any())
  if (typeof v === 'string' && SAMPLE_CONTENT.test(v)) return str()
  if (typeof v === 'string') return str()
  if (typeof v === 'number') return num()
  if (typeof v === 'boolean') return bool()
  if (Array.isArray(v)) return arr(v.length && depth < 6 ? valueToShape(v[0], depth + 1) : any())
  if (typeof v === 'object' && depth < 6) {
    const props: Record<string, Shape> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) props[k] = valueToShape(x, depth + 1)
    return obj(props, undefined, true)
  }
  return any()
}

// ───────────────────────── index / trace ─────────────────────────

/**
 * `.claude/gate.index.json` as the editor reads it. Every field is optional: the index is written by
 * the mod/CLI and the editor tolerates older or partial versions.
 */
export interface GateIndex {
  profiles?: string[] | Record<string, unknown>
  tiers?: string[] | Record<string, unknown>
  groups?: string[] | Record<string, unknown>
  items?: { id: string; kind?: string; name?: string; description?: string }[]
  sections?: { id: string; scope?: string; when?: string; chars?: number; tokens?: number; path?: string }[]
  /** Render-context variables: name → { type?, value? } or a sample value. */
  vars?: Record<string, unknown>
  ctx?: Record<string, unknown>
  providers?: Record<string, { schema?: unknown; functions?: string[]; exposes?: string[]; description?: string } | unknown>
  /** `data.*` keys (core `GateIndex`), or samples by key (older indexes). */
  data?: string[] | Record<string, unknown>
}

/** `.claude/prompt/.trace/last.json`: the last `context-gate run --json` (or `prompt.compose`) snapshot. */
/** `.claude/prompt/.trace/last.json`: the last `context-gate run` (core RunJson); partial for hand-written fixtures. */
export type LastTrace = Partial<Pick<RunJson, 'scope' | 'trace' | 'sections' | 'diagnostics' | 'meta'>>

export function traceScope(t: LastTrace | undefined): Scope_ | undefined {
  const s = t && typeof t === 'object' ? t.scope : undefined
  return s && typeof s === 'object' && !Array.isArray(s) ? s as Scope_ : undefined
}

export function traceEntries(t: LastTrace | undefined): TraceEntry[] {
  const e = t && typeof t === 'object' ? t.trace : undefined
  return Array.isArray(e) ? e : []
}

// ───────────────────────── ctx.d.ts fallback ─────────────────────────

/** Minimal reader of the generated ctx.d.ts: profile/tier unions and provider keys of `CtxOverrides`. */
export function parseCtxDts(text: string): { profiles: string[]; tiers: string[]; providers: string[] } {
  const lit = (m: RegExpExecArray | null): string[] => (m ? [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!) : [])
  const profiles = lit(/export type ProfileName\s*=\s*([^\n]+)/.exec(text))
  const tiers = lit(/export type TierName\s*=\s*([^\n]+)/.exec(text))
  const providers: string[] = []
  const body = /interface CtxOverrides\s*\{([\s\S]*?)\n\s{2}\}/.exec(text)?.[1] ?? ''
  for (const m of body.matchAll(/^ {4}("?)([\w$-]+)\1\??:/gm)) if (m[2] !== 'gate') providers.push(m[2]!)
  return { profiles, tiers, providers }
}

// ───────────────────────── the model ─────────────────────────

export interface CtxModel {
  roots: Record<string, Shape>
  profiles: string[]
  tiers: string[]
  groups: string[]
  /** Section ids known from the index (for `Include section=` completions). */
  sections: string[]
  /** Item ids (`skill:tdd`, `rule:react`) from the index. */
  items: string[]
  /** Scope of the last render for hover / REPL. */
  scope?: Scope_
  trace: TraceEntry[]
}

export interface ModelInput {
  config?: Partial<GateConfig>
  index?: GateIndex
  ctxDts?: string
  trace?: LastTrace
  /** Reads a repo-relative file: provider `schema` given as a path (`.schema.json`, `.d.ts`). */
  readFile?: (path: string) => string | undefined
}

const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : v && typeof v === 'object' ? Object.keys(v) : [])
const uniq = (xs: string[]): string[] => [...new Set(xs)]

export function buildModel(input: ModelInput = {}): CtxModel {
  const { config = {}, index = {}, ctxDts, trace } = input
  const dts = ctxDts ? parseCtxDts(ctxDts) : { profiles: [], tiers: [], providers: [] }
  const profiles = uniq([...Object.keys(config.profiles ?? {}), ...keysOf(index.profiles), ...dts.profiles])
  const tiers = uniq([...Object.keys(config.tiers ?? {}), ...keysOf(index.tiers), ...dts.tiers])
  const groups = uniq([...Object.keys(config.groups ?? {}), ...Object.keys(config.skillGroups ?? {}), ...Object.keys(config.mcpGroups ?? {}), ...keysOf(index.groups)])
  const roots = builtinRoots(profiles, tiers)

  // Providers: gate.json first (authoritative schema), then the index, then ctx.d.ts keys.
  const addProvider = (name: string, p: { schema?: unknown; functions?: unknown; description?: unknown } | undefined): void => {
    if (name in roots && BUILTIN_ROOT_NAMES.includes(name as (typeof BUILTIN_ROOT_NAMES)[number])) return
    const doc = typeof p?.description === 'string' ? p.description : `провайдер ${name}`
    const fns = Array.isArray(p?.functions) ? (p.functions as string[]) : p?.functions && typeof p.functions === 'object' ? Object.keys(p.functions) : []
    let shape: Shape
    const schema = resolveSchemaRef(p?.schema, input.readFile)
    if (schema && typeof schema === 'object') shape = schemaToShape(schema)
    else if (fns.length) shape = obj({}, doc)
    else shape = { k: 'unknown', provider: name, doc }
    if (fns.length && shape.k === 'object') for (const f of fns) shape.props[f] = fn(`${f}(...)`, any())
    if (!shape.doc) (shape as { doc?: string }).doc = doc
    roots[name] = shape
  }
  for (const [name, p] of Object.entries(config.providers ?? {})) if (!p.builtin) addProvider(name, p as never)
  for (const [name, p] of Object.entries(index.providers ?? {})) if (!(name in roots)) addProvider(name, (p && typeof p === 'object' ? p : {}) as never)
  for (const name of dts.providers) if (!(name in roots)) addProvider(name, undefined)

  // data.* keys from the index / trace (samples, open objects).
  const dataShape = roots.data as Extract<Shape, { k: 'object' }>
  const scope = traceScope(trace)
  const indexData: Record<string, unknown> = Array.isArray(index.data) ? Object.fromEntries(index.data.filter((k): k is string => typeof k === 'string').map((k) => [k, undefined])) : (index.data ?? {})
  const dataSample = { ...indexData, ...(scope && typeof scope.data === 'object' && scope.data && !Array.isArray(scope.data) ? (scope.data as Record<string, Value>) : {}) }
  for (const [k, v] of Object.entries(dataSample)) dataShape.props[k] = valueToShape(v)

  // Index vars refine unknown providers with sample values (still open).
  const vars = { ...(index.ctx ?? {}), ...(index.vars ?? {}) }
  for (const [name, v] of Object.entries(vars)) {
    const sample = v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as object) ? (v as { value: unknown }).value : v
    const cur = roots[name]
    if (!cur) roots[name] = valueToShape(sample)
    else if (cur.k === 'unknown' && sample !== undefined) roots[name] = { ...valueToShape(sample), doc: cur.doc } as Shape
  }

  return {
    roots,
    profiles,
    tiers,
    groups,
    sections: uniq((index.sections ?? []).map((s) => s.id).filter(Boolean)),
    items: uniq((index.items ?? []).map((i) => i.id).filter(Boolean)),
    ...(scope ? { scope } : {}),
    trace: traceEntries(trace),
  }
}

/** Members of a shape for completion: [name, shape]. Arrays expose `length`. */
export function membersOf(s: Shape): [string, Shape][] {
  if (s.k === 'object') return Object.entries(s.props)
  if (s.k === 'array') return [['length', num('довжина списку')]]
  if (s.k === 'prim' && s.t === 'string') return [['length', num('довжина рядка')]]
  return []
}

/** One member step; `undefined` = no such member on a closed shape. */
export function memberShape(s: Shape, prop: string): Shape | undefined {
  switch (s.k) {
    case 'any': return any()
    case 'unknown': return any()
    case 'object': return s.props[prop] ?? (s.open ? any() : undefined)
    case 'array': return prop === 'length' ? num() : /^\d+$/.test(prop) ? s.item : undefined
    case 'prim': return s.t === 'string' && prop === 'length' ? num() : undefined
    case 'fn': return undefined
  }
}

/** Short type text for hover. */
export function shapeText(s: Shape, depth = 0): string {
  switch (s.k) {
    case 'any': return 'any'
    case 'unknown': return 'unknown'
    case 'prim': return s.values?.length ? s.values.map((v) => JSON.stringify(v)).join(' | ') : s.t
    case 'array': return `${shapeText(s.item, depth + 1)}[]`
    case 'fn': return `${s.sig} → ${shapeText(s.ret, depth + 1)}`
    case 'object': {
      if (depth > 0) return '{…}'
      const keys = Object.keys(s.props)
      return `{ ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}${s.open ? (keys.length ? ', …' : '…') : ''} }`
    }
  }
}

// ───────────────────────── schema files (Р4) ─────────────────────────

/** `schema: "x.schema.json"` / `"types/arch.d.ts"` / `"types/arch.d.ts#ArchResult"` → [path, type name]. */
export function splitSchemaRef(ref: string): { path: string; type?: string } {
  const i = ref.lastIndexOf('#')
  return i > 0 ? { path: ref.slice(0, i), type: ref.slice(i + 1) } : { path: ref }
}

export const isDtsSchema = (ref: string): boolean => /\.d\.[cm]?ts$|\.ts$/.test(splitSchemaRef(ref).path)

/**
 * A small `.d.ts` reader for provider schemas: `export interface X {…}` / `export type X = …` (object
 * literals, `T[]`, `Array<T>`, `Record<string, T>`, unions of literals, primitives, references to other
 * declarations of the same file) → JSON Schema. Picks `typeName`, else the default export, else the first
 * exported declaration. Returns undefined when nothing usable is found.
 */
export function dtsToJsonSchema(text: string, typeName?: string): Record<string, unknown> | undefined {
  const d = readDts(text, typeName)
  return d.pick ? typeToSchema(d.decls.get(d.pick)!, d.decls, 0) : undefined
}

/** Declarations of a `.d.ts` and the type `dtsToJsonSchema` would pick (`'default'` never: the name of the default export). */
export function readDts(text: string, typeName?: string): { decls: Map<string, string>; pick?: string; isDefault: boolean } {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
  const decls = new Map<string, string>()
  const order: string[] = []
  let deflt: string | undefined
  const declRe = /(export\s+)?(default\s+)?(?:declare\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)\s*(?:<[^>{=]*>)?\s*(?:extends\s+[^{]+)?(=)?/g
  for (let m = declRe.exec(src); m; m = declRe.exec(src)) {
    const name = m[4]!
    let i = declRe.lastIndex
    let body: string
    if (m[3] === 'interface') {
      const open = src.indexOf('{', i)
      if (open < 0) continue
      const close = matchBrace(src, open)
      body = src.slice(open, close + 1)
      declRe.lastIndex = close + 1
    } else {
      // type X = …; up to `;` or a new declaration at depth 0.
      let d = 0
      let j = i
      for (; j < src.length; j++) {
        const c = src[j]!
        if ('{[(<'.includes(c)) d++
        // `=>` of a function type is not a closing `>`.
        else if ('}])>'.includes(c) && !(c === '>' && src[j - 1] === '=')) d = Math.max(0, d - 1)
        if (d > 0) continue
        if (c === ';') break
        if (c === '\n' && src.slice(i, j).trim() && !/[|&,:=<({[]\s*$/.test(src.slice(i, j)) && /^\s*(export\b|interface\b|type\b|declare\b|import\b|$)/.test(src.slice(j + 1))) break
      }
      body = src.slice(i, j)
      declRe.lastIndex = j + 1
    }
    decls.set(name, body)
    order.push(name)
    if (m[2]) deflt = name
  }
  const dm = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/.exec(src)
  if (dm && decls.has(dm[1]!)) deflt = dm[1]
  // Without a name: the default export, else the first exported declaration no other declaration refers to.
  const exported = order.filter((n) => new RegExp(`export\\s+(?:declare\\s+)?(?:interface|type)\\s+${n}\\b`).test(src))
  const referenced = (n: string) => order.some((o) => o !== n && new RegExp(`\\b${n}\\b`).test(decls.get(o)!))
  const pick = typeName ?? deflt ?? exported.find((n) => !referenced(n)) ?? exported[0] ?? order[0]
  return { decls, ...(pick && decls.has(pick) ? { pick } : {}), isDefault: !typeName && !!deflt && pick === deflt }
}

function matchBrace(s: string, open: number): number {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d++
    else if (s[i] === '}') { d--; if (d === 0) return i }
  }
  return s.length - 1
}

/** Split on `sep` at depth 0 of (), [], {}, <>. */
function splitDepth(s: string, sep: string): string[] {
  const out: string[] = []
  let d = 0
  let q = ''
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = ''; continue }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue }
    if ('{[(<'.includes(c)) d++
    else if ('}])>'.includes(c) && !(c === '>' && s[i - 1] === '=')) d = Math.max(0, d - 1)
    if (d === 0 && c === sep) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter((x, i, a) => x || i < a.length - 1)
}

function typeToSchema(t0: string, decls: Map<string, string>, depth: number): Record<string, unknown> {
  const t = t0.trim().replace(/;$/, '').trim()
  if (depth > 12 || !t) return {}
  const union = splitDepth(t.replace(/^\|/, ''), '|')
  if (union.length > 1) {
    const parts = union.map((u) => typeToSchema(u, decls, depth + 1))
    const lits = parts.filter((p) => 'const' in p).map((p) => p.const)
    if (lits.length === parts.length) return { enum: lits }
    const nonNull = parts.filter((p) => p.type !== 'null')
    if (nonNull.length === 1) return nonNull[0]!
    return { anyOf: parts }
  }
  const inter = splitDepth(t, '&')
  if (inter.length > 1) return { allOf: inter.map((u) => typeToSchema(u, decls, depth + 1)) }
  if (t.startsWith('(') && t.endsWith(')')) return typeToSchema(t.slice(1, -1), decls, depth + 1)
  if (t.endsWith('[]')) return { type: 'array', items: typeToSchema(t.slice(0, -2), decls, depth + 1) }
  const gen = /^(?:readonly\s+)?(Array|ReadonlyArray|Record|Partial|Readonly)\s*<([\s\S]*)>$/.exec(t)
  if (gen) {
    const args = splitDepth(gen[2]!, ',')
    if (gen[1] === 'Array' || gen[1] === 'ReadonlyArray') return { type: 'array', items: typeToSchema(args[0] ?? '', decls, depth + 1) }
    if (gen[1] === 'Record') return { type: 'object', additionalProperties: typeToSchema(args[1] ?? '', decls, depth + 1) }
    const inner = typeToSchema(args[0] ?? '', decls, depth + 1)
    if (gen[1] === 'Partial') { const { required: _r, ...rest } = inner; return rest }
    return inner
  }
  if (t.startsWith('readonly ')) return typeToSchema(t.slice(9), decls, depth + 1)
  if (/^(['"]).*\1$/.test(t)) return { const: t.slice(1, -1) }
  if (/^-?\d+(\.\d+)?$/.test(t)) return { const: Number(t) }
  if (t === 'true' || t === 'false') return { const: t === 'true' }
  switch (t) {
    case 'string': return { type: 'string' }
    case 'number': case 'bigint': return { type: 'number' }
    case 'boolean': return { type: 'boolean' }
    case 'null': case 'undefined': case 'void': return { type: 'null' }
    case 'any': case 'unknown': case 'object': return {}
  }
  if (t.startsWith('[') && t.endsWith(']')) return { type: 'array', items: {} }
  if (t.startsWith('{')) {
    const close = matchBrace(t, 0)
    const body = t.slice(1, close)
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    let additional: unknown
    for (const raw of splitDepth(body.replace(/;/g, ','), ',').flatMap((x) => splitDepth(x, '\n'))) {
      const m = /^(?:readonly\s+)?(?:(["'])(.+?)\1|([A-Za-z_$][\w$-]*))(\?)?\s*:\s*([\s\S]+)$/.exec(raw.trim())
      if (m) {
        const key = m[2] ?? m[3]!
        properties[key] = typeToSchema(m[5]!, decls, depth + 1)
        if (!m[4]) required.push(key)
        continue
      }
      const idx = /^\[\s*\w+\s*:\s*string\s*\]\s*:\s*([\s\S]+)$/.exec(raw.trim())
      if (idx) additional = typeToSchema(idx[1]!, decls, depth + 1)
      const meth = /^([A-Za-z_$][\w$]*)\??\s*\(/.exec(raw.trim())
      if (meth) properties[meth[1]!] = {}
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}), ...(additional !== undefined ? { additionalProperties: additional } : {}) }
  }
  const ref = /^([A-Za-z_$][\w$]*)(?:<.*>)?$/.exec(t)
  if (ref && decls.has(ref[1]!)) return typeToSchema(decls.get(ref[1]!)!, decls, depth + 1)
  return {}
}

/** Resolves a provider `schema`: inline object as is, `*.json` parsed, `*.d.ts` read; undefined when unreadable. */
export function resolveSchemaRef(schema: unknown, readFile?: (path: string) => string | undefined): unknown {
  if (typeof schema !== 'string') return schema
  if (!readFile) return undefined
  const { path, type } = splitSchemaRef(schema)
  const text = readFile(path)
  if (text === undefined) return undefined
  if (isDtsSchema(schema)) return dtsToJsonSchema(text, type)
  try { return JSON.parse(text) } catch { return undefined }
}
