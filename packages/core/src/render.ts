// Total interpreter of the prompt AST (SPEC "Шар 3": рантайм, "Дані скриптів у промпті", "Включення",
// "Налагодження", "Автономний інтерпретатор"). Two passes per section: a data pass that collects every
// run/call/mcp/include need and executes them (parallel inside a wave, `needs=` ordered by rounds), then a
// render pass over ready values. Debug/assert/log/trace never reach the text.

import type {
  CompiledPrompt, Diagnostic, IncludeMode, ItemStatus, Node, RenderHost, RenderOptions, RenderResult, RenderedSection, Scope, Scope_,
  SectionNode, TraceEntry, Value,
} from './types.ts'
import { type Budget, type EvalEnv, StepLimitError, dataKeys, evalExpr, isObj, lookup, newBudget, parseExpr, parseTemplate, renderTemplate, toText, truthy } from './expr.ts'

// ───────────────────────── public extras ─────────────────────────

export interface ProviderCallRequest { path: string; ns: string; fn: string; args: Value[]; kwargs: Record<string, Value> }

/** RenderHost plus optional provider functions (`fs.examples`, `git.log`, …). */
export interface RenderHostExt extends RenderHost {
  /** Call a function of a provider the host exposes. */
  provider?(req: ProviderCallRequest): Promise<Value>
  /** Callable paths (`fs.examples`, `scripts.*`); absent → every path goes to `provider`. Anything else → G157. */
  callables?: string[]
}

export interface RenderOptionsExt extends RenderOptions {
  /** `@assert` false: skip the section (default) or fail the render. */
  assertFail?: 'skip' | 'fail'
  /** Failing @run/@call/@mcp: unverified (default) | skip section | fail. */
  onError?: 'unverified' | 'skip' | 'fail'
  /** Extra `use` bindings (namespace → module path). */
  uses?: Record<string, string>
  /** Default cache duration for @run/@call without `cache=`. */
  runCacheDefault?: string
}

/** Rendered section plus the data it was rendered from that is past its cache window (H006). */
export interface RenderedSectionExt extends RenderedSection {
  /** `data.<key>` read while stale, `run:<name>` served from an expired cache. */
  stale?: string[]
  /** Not emitted standalone because another section includes it (see `suppressIncluded`). */
  includedBy?: string
}

export interface RenderResultExt extends RenderResult {
  sections: RenderedSectionExt[]
  /** `stored` wrapped as data envelopes (`dataEnvelope`) — what the host persists to `data.*`. */
  storedEntries: Record<string, Value>
}

/** Persisted form of a `data.*` value: the value plus when it was fetched and its cache window. */
export interface DataEntry { value: Value; fetchedAt: number; cache?: string }

export function dataEnvelope(value: Value, fetchedAt: number, cache?: string): Value {
  return { __cgData: 1, value, fetchedAt, ...(cache ? { cache } : {}) }
}

export function isDataEnvelope(v: Value | undefined): v is { [k: string]: Value } {
  return isObj(v) && v.__cgData === 1 && typeof v.fetchedAt === 'number'
}

/**
 * Turn persisted envelopes in `data` into the values expressions see. An object value gains `fetchedAt`
 * and `stale` fields next to its own (`data.api-endpoints.count`, `data.api-endpoints.fetchedAt | ago`);
 * any other value (list, string, number) becomes `{ value, fetchedAt, stale }`. `stale` = age > cache
 * window (false when there is no window). Plain (non-envelope) values pass through untouched.
 */
export function materializeData(data: Record<string, Value>, now: number): { data: Record<string, Value>; stale: string[] } {
  const out: Record<string, Value> = {}
  const stale: string[] = []
  for (const [k, v] of Object.entries(data)) {
    if (!isDataEnvelope(v)) { out[k] = v; continue }
    const at = v.fetchedAt as number
    const win = parseDurationMs(typeof v.cache === 'string' ? v.cache : undefined)
    const isStale = win !== undefined && now - at > win
    if (isStale) stale.push(k)
    const inner = v.value ?? null
    out[k] = isObj(inner) ? { ...inner, fetchedAt: at, stale: isStale } : { value: inner, fetchedAt: at, stale: isStale }
  }
  return { data: out, stale }
}

export const TRUNCATION_MARKER = (budget: number): string => `…[обрізано за budget ${budget}]`
const SCOPE_ORDER: Scope[] = ['static', 'profile', 'volatile']
const MAX_ROUNDS = 16
/** SPEC «Продуктивність»: `@run` is cached for 5 minutes unless `cache=` or `runCacheDefault` says otherwise. */
const DEFAULT_RUN_CACHE = '5m'
const MAX_INCLUDE_DEPTH = 3
const MAX_TRACE_PER_SECTION = 500
const DEBUG_VALUE_MAX = 2000

/** Stable 32-bit FNV-1a hash, hex. */
export function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function estimateTokens(text: string): number { return Math.ceil(text.length / 4) }

/** `500ms`, `10s`, `5m`, `1h`, `1d` → ms; undefined when not a duration. */
function parseDurationMs(s: string | undefined): number | undefined {
  if (!s) return undefined
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s.trim())
  if (!m) return undefined
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? 's'] ?? 1000
  return Number(m[1]) * mult
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson((v as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(v ?? null)
}

/** Stub shown in place of a run that was not executed: `[run: python, unverified]`, `[run: python, 0.4 s, 212 B]`. */
export function runStub(lang: string, info: string | { ms: number; bytes: number }): string {
  if (typeof info === 'string') return `[run: ${lang}, ${info}]`
  return `[run: ${lang}, ${(info.ms / 1000).toFixed(1)} s, ${info.bytes} B]`
}

/** Markdown whitespace normalization: trailing spaces, common indent, ≥2 blank lines → 1, outer blank lines. */
export function normalizeMarkdown(text: string): string {
  let lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, ''))
  const indents = lines.filter(l => l.trim()).map(l => /^[ \t]*/.exec(l)![0].length)
  const ind = indents.length ? Math.min(...indents) : 0
  if (ind > 0) lines = lines.map(l => l.slice(Math.min(ind, /^[ \t]*/.exec(l)![0].length)))
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

/** static → profile → volatile, input order inside a scope, `after` moves a section behind its target (same scope). */
export function orderSections<T extends { id: string; scope: Scope; after?: string }>(list: T[], diagnostics?: Diagnostic[]): T[] {
  const out: T[] = []
  for (const scope of SCOPE_ORDER) {
    const inScope = list.filter(s => s.scope === scope)
    const ids = new Set(inScope.map(s => s.id))
    const followers = new Map<string, T[]>()
    const roots: T[] = []
    for (const s of inScope) {
      if (s.after && s.after !== s.id && ids.has(s.after)) {
        const f = followers.get(s.after) ?? []
        f.push(s)
        followers.set(s.after, f)
      } else {
        if (s.after && diagnostics) {
          diagnostics.push({ code: 'G020', severity: 'warning', message: `Секція «${s.id}»: after=«${s.after}» не знайдено у scope ${scope} — лишено на місці` })
        }
        roots.push(s)
      }
    }
    const placed = new Set<string>()
    const visit = (s: T): void => {
      if (placed.has(s.id)) return
      placed.add(s.id)
      out.push(s)
      for (const f of followers.get(s.id) ?? []) visit(f)
    }
    roots.forEach(visit)
    for (const s of inScope) {
      if (!placed.has(s.id)) {
        diagnostics?.push({ code: 'G021', severity: 'warning', message: `Секція «${s.id}»: цикл у after — лишено в порядку джерела` })
        visit(s)
      }
    }
  }
  return out
}

// ───────────────────────── internals ─────────────────────────

interface Ready {
  value: Value
  status: ItemStatus
  source: NonNullable<TraceEntry['source']>
  ms?: number
  bytes?: number
  /** onError outcome that affects the section. */
  error?: 'skip' | 'fail'
  detail?: string
  /** When the value was produced (cache entry time for cache hits). */
  at?: number
  /** Served from an expired cache entry. */
  stale?: boolean
}

type Need =
  | { kind: 'run'; key: string; lang: string; code: string; stdin: string; cacheMs?: number; label: string }
  | { kind: 'call'; key: string; module: string; fn: string; label: string; args: Value[]; kwargs: Record<string, Value>; cacheMs?: number }
  | { kind: 'provider'; key: string; path: string; args: Value[]; kwargs: Record<string, Value> }
  | { kind: 'mcp'; key: string; server: string; tool: string; args: Record<string, Value> }
  | { kind: 'file'; key: string; path: string }
  | { kind: 'item'; key: string; itemKind: 'skill' | 'rule'; name: string }

interface SectionOut {
  rendered: RenderedSectionExt
  trace: TraceEntry[]
  diagnostics: Diagnostic[]
  stored: Record<string, Value>
  storedMeta: Record<string, { fetchedAt: number; cache?: string }>
  /** `@section` includes made by this section. */
  refs: { id: string; mode: IncludeMode }[]
}

type Signal = 'break' | 'continue' | 'stop' | undefined

class Stop extends Error {}

function wrapCache(value: Value, ms: number, bytes: number): Value { return { __cg: 1, v: value, ms, bytes } }
function unwrapCache(v: Value): { value: Value; ms?: number; bytes?: number } {
  if (isObj(v) && v.__cg === 1) return { value: v.v ?? null, ms: typeof v.ms === 'number' ? v.ms : undefined, bytes: typeof v.bytes === 'number' ? v.bytes : undefined }
  return { value: v }
}

function parseStdout(stdout: string): Value {
  const t = stdout.replace(/\n+$/, '')
  const s = t.trim()
  if (s && (s[0] === '{' || s[0] === '[' || s[0] === '"' || /^-?\d/.test(s) || s === 'true' || s === 'false' || s === 'null')) {
    try { return JSON.parse(s) as Value } catch { /* plain text */ }
  }
  return t
}

function matchCallable(patterns: string[], path: string): boolean {
  return patterns.some(p => p === path || (p.endsWith('.*') && path.startsWith(p.slice(0, -1))) || p === '*')
}

function basename(p: string): string { return (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '') }

function truncate(text: string, budget: number | undefined): { text: string; truncated: boolean } {
  if (!budget || text.length <= budget) return { text, truncated: false }
  return { text: text.slice(0, budget).replace(/\s+$/, '') + '\n' + TRUNCATION_MARKER(budget), truncated: true }
}

const escCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ')

class Renderer {
  host: RenderHostExt
  opts: RenderOptionsExt
  root: Scope_
  sections = new Map<string, SectionNode>()
  uses: Record<string, string>
  results = new Map<string, Ready>()
  memo = new Map<string, SectionOut>()
  /** Sections still being interpreted, in a stable order (top-level first, then by first request). */
  active: string[] = []
  /** Include graph `from → to` for cycle detection, and include depth per section. */
  edges = new Map<string, Set<string>>()
  depth = new Map<string, number>()
  runSpentMs = 0
  lazies = new Map<string, { description: string; ref: string }>()
  staleData = new Set<string>()

  constructor(host: RenderHostExt, opts: RenderOptionsExt, scope: Scope_, uses: Record<string, string>) {
    this.host = host
    this.opts = opts
    this.uses = uses
    const root = Object.create(null) as Scope_
    for (const [k, v] of Object.entries(scope)) root[k] = v
    if (isObj(root.data)) {
      const m = materializeData(root.data, host.now())
      root.data = m.data
      for (const k of m.stale) this.staleData.add(k)
    }
    this.root = root
  }

  reaches(from: string, to: string): boolean {
    const seen = new Set<string>()
    const stack = [from]
    while (stack.length) {
      const x = stack.pop()!
      if (x === to) return true
      if (seen.has(x)) continue
      seen.add(x)
      for (const y of this.edges.get(x) ?? []) stack.push(y)
    }
    return false
  }

  /** Register that `from` includes section `id` inline; schedules `id` for interpretation. */
  request(from: string, id: string): 'ok' | 'cycle' | 'depth' {
    if (id === from || this.reaches(id, from)) return 'cycle'
    const d = (this.depth.get(from) ?? 0) + 1
    if (d > MAX_INCLUDE_DEPTH) return 'depth'
    const e = this.edges.get(from) ?? new Set<string>()
    e.add(id)
    this.edges.set(from, e)
    this.depth.set(id, Math.max(this.depth.get(id) ?? 0, d))
    if (!this.memo.has(id) && !this.active.includes(id)) this.active.push(id)
    return 'ok'
  }

  /**
   * Global data pass: every round interprets every unfinished section in a fixed order, merges their needs
   * (insertion order = section order, then source order), executes them in one parallel wave, and repeats.
   * A section with no open needs is final; its text becomes available to sections that include it. Output
   * depends only on data and order, never on timing.
   */
  async renderAll(top: SectionNode[]): Promise<void> {
    for (const s of top) { this.depth.set(s.id, 0); this.active.push(s.id) }
    const last = new Map<string, Interp>()
    for (let round = 0; round < MAX_ROUNDS && this.active.length; round++) {
      const needs = new Map<string, Need>()
      let progressed = false
      for (let i = 0; i < this.active.length; i++) {
        const id = this.active[i]
        const sec = this.sections.get(id)
        if (!sec || this.memo.has(id)) continue
        const interp = new Interp(this, sec)
        interp.run()
        last.set(id, interp)
        if (!interp.needs.size && !interp.waitingSections) {
          this.complete(id, interp.finish())
          progressed = true
        } else for (const [k, n] of interp.needs) if (!needs.has(k)) needs.set(k, n)
      }
      this.active = this.active.filter(id => !this.memo.has(id))
      if (needs.size) await this.execute([...needs.values()])
      else if (!progressed) break
    }
    for (const id of this.active) {
      const interp = last.get(id)
      if (interp) this.complete(id, interp.finish())
    }
    this.active = []
  }

  complete(id: string, out: SectionOut): void {
    this.memo.set(id, out)
    this.results.set(`section:${id}`, { value: out.rendered.included ? out.rendered.text : '', status: out.rendered.status, source: 'run' })
  }

  async execute(needs: Need[]): Promise<void> {
    const fresh = needs.filter(n => !this.results.has(n.key))
    const runs = fresh.filter((n): n is Extract<Need, { kind: 'run' }> => n.kind === 'run')
    const calls = fresh.filter((n): n is Extract<Need, { kind: 'call' }> => n.kind === 'call')
    const others = fresh.filter(n => n.kind !== 'run' && n.kind !== 'call')

    // One budget for all @run of the render (SPEC «Продуктивність»: 2 s per prompt.compose).
    const remaining = Math.max(0, (this.opts.runBudgetMs ?? 2000) - this.runSpentMs)
    const spent: number[] = []
    const byModule = new Map<string, Extract<Need, { kind: 'call' }>[]>()
    for (const c of calls) { const l = byModule.get(c.module) ?? []; l.push(c); byModule.set(c.module, l) }
    await Promise.all([
      ...runs.map(n => this.execRun(n, remaining, spent)),
      ...[...byModule.entries()].map(([mod, list]) => this.execCalls(mod, list, remaining, spent)),
      ...others.map(n => this.execOther(n)),
    ])
    this.runSpentMs += spent.length ? Math.max(...spent) : 0
  }

  async cached(key: string): Promise<{ value: Value; at: number; ms?: number; bytes?: number } | undefined> {
    try {
      const e = await this.host.cacheGet?.(key)
      if (!e) return undefined
      return { ...unwrapCache(e.value), at: e.at }
    } catch { return undefined }
  }

  failure(prev: { value: Value; at?: number } | undefined, detail: string): Ready {
    const mode = this.opts.onError ?? 'unverified'
    return { value: prev?.value ?? null, status: mode === 'fail' ? 'fail' : 'unverified', source: prev ? 'cache' : 'stub', ...(mode !== 'unverified' ? { error: mode } : {}), ...(prev ? { stale: true, ...(prev.at !== undefined ? { at: prev.at } : {}) } : {}), detail }
  }

  async execRun(n: Extract<Need, { kind: 'run' }>, remaining: number, spent: number[]): Promise<void> {
    const set = (r: Ready): void => { this.results.set(n.key, r) }
    if (!this.host.trusted) return set({ value: runStub(n.lang, 'unverified'), status: 'unverified', source: 'stub', detail: 'репозиторій не довірений' })
    const entry = await this.cached(n.key)
    const now = this.host.now()
    if (entry && n.cacheMs !== undefined && now - entry.at <= n.cacheMs) return set({ value: entry.value, status: 'ok', source: 'cache', ms: entry.ms, bytes: entry.bytes, at: entry.at })
    if (this.host.dryScripts) {
      // Fresh cache was served above. An expired entry with metadata → `[run: python, 0.4 s, 212 B]`.
      if (entry && entry.ms !== undefined && entry.bytes !== undefined) return set({ value: runStub(n.lang, { ms: entry.ms, bytes: entry.bytes }), status: 'unverified', source: 'stub', detail: 'dry-scripts, кеш застарів' })
      if (entry) return set({ value: entry.value, status: 'ok', source: 'cache', at: entry.at, stale: true })
      return set({ value: runStub(n.lang, 'dry'), status: 'unverified', source: 'stub', detail: 'dry-scripts, кешу немає' })
    }
    if (!this.host.run) return set({ value: entry?.value ?? runStub(n.lang, 'no executor'), status: 'unverified', source: entry ? 'cache' : 'stub', detail: 'хост не виконує скрипти', ...(entry ? { at: entry.at, stale: true } : {}) })
    if (remaining <= 0) {
      // Over the render budget: the previous stored value if any (unverified), otherwise skip the section.
      if (entry) return set({ value: entry.value, status: 'unverified', source: 'cache', at: entry.at, stale: true, detail: 'бюджет @run на рендер вичерпано, взято попереднє значення' })
      return set({ value: null, status: 'unverified', source: 'stub', error: 'skip', detail: `бюджет @run ${this.opts.runBudgetMs ?? 2000} мс на рендер вичерпано` })
    }
    try {
      const r = await this.host.run({ lang: n.lang, code: n.code, stdin: n.stdin, timeoutMs: remaining })
      spent.push(r.ms)
      if (r.exitCode !== 0) return set({ ...this.failure(entry, `exit ${r.exitCode}; stderr: ${r.stderr.slice(0, 200)}`), ms: r.ms })
      const value = parseStdout(r.stdout)
      const bytes = r.stdout.length
      try { await this.host.cacheSet?.(n.key, wrapCache(value, r.ms, bytes)) } catch { /* cache is best effort */ }
      set({ value, status: 'ok', source: 'run', ms: r.ms, bytes, at: this.host.now() })
    } catch (e) {
      set(this.failure(entry, `помилка виконавця: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
    }
  }

  async execCalls(module: string, list: Extract<Need, { kind: 'call' }>[], remaining: number, spent: number[]): Promise<void> {
    const pending: { n: Extract<Need, { kind: 'call' }>; entry?: { value: Value; at: number } }[] = []
    for (const n of list) {
      const stub = `[call: ${n.label}, unverified]`
      if (!this.host.trusted) { this.results.set(n.key, { value: stub, status: 'unverified', source: 'stub', detail: 'репозиторій не довірений' }); continue }
      const entry = await this.cached(n.key)
      const now = this.host.now()
      if (entry && n.cacheMs !== undefined && now - entry.at <= n.cacheMs) { this.results.set(n.key, { value: entry.value, status: 'ok', source: 'cache' }); continue }
      if (this.host.dryScripts || !this.host.call || remaining <= 0) {
        this.results.set(n.key, entry ? { value: entry.value, status: this.host.dryScripts ? 'ok' : 'unverified', source: 'cache' } : { value: `[call: ${n.label}, ${this.host.dryScripts ? 'dry' : remaining <= 0 ? 'budget' : 'no executor'}]`, status: 'unverified', source: 'stub' })
        continue
      }
      pending.push({ n, entry })
    }
    if (!pending.length || !this.host.call) return
    const t0 = this.host.now()
    try {
      const values = await this.host.call({ path: module, calls: pending.map(p => ({ fn: p.n.fn, args: p.n.args, ...(Object.keys(p.n.kwargs).length ? { kwargs: p.n.kwargs } : {}) })) })
      spent.push(this.host.now() - t0)
      for (let i = 0; i < pending.length; i++) {
        const v = values[i] ?? null
        this.results.set(pending[i].n.key, { value: v, status: 'ok', source: 'run' })
        try { await this.host.cacheSet?.(pending[i].n.key, wrapCache(v, 0, JSON.stringify(v).length)) } catch { /* best effort */ }
      }
    } catch (e) {
      for (const p of pending) this.results.set(p.n.key, this.failure(p.entry, `виклик ${p.n.label}: ${String((e as Error)?.message ?? e).slice(0, 200)}`))
    }
  }

  async execOther(n: Need): Promise<void> {
    const set = (r: Ready): void => { this.results.set(n.key, r) }
    try {
      switch (n.kind) {
        case 'provider': {
          if (!this.host.provider) return set({ value: null, status: 'unverified', source: 'stub' })
          const [ns, ...rest] = n.path.split('.')
          return set({ value: (await this.host.provider({ path: n.path, ns, fn: rest.join('.'), args: n.args, kwargs: n.kwargs })) ?? null, status: 'ok', source: 'run' })
        }
        case 'mcp': {
          const label = `${n.server}.${n.tool}`
          if (!this.host.trusted || !this.host.mcp) return set({ value: `[mcp: ${label}, unverified]`, status: 'unverified', source: 'stub', detail: this.host.trusted ? 'MCP недоступний' : 'репозиторій не довірений' })
          return set({ value: (await this.host.mcp({ server: n.server, tool: n.tool, args: n.args })) ?? null, status: 'ok', source: 'run' })
        }
        case 'file': {
          const text = await this.host.readFile(n.path)
          return set({ value: text ?? null, status: text === undefined ? 'fail' : 'ok', source: 'run' })
        }
        case 'item': {
          const it = await this.host.itemBody?.(n.itemKind, n.name)
          if (!it) return set({ value: null, status: 'fail', source: 'run' })
          const v: Record<string, Value> = {}
          if (it.description !== undefined) v.description = it.description
          if (it.body !== undefined) v.body = it.body
          if (it.path !== undefined) v.path = it.path
          return set({ value: v, status: 'ok', source: 'run' })
        }
      }
    } catch (e) {
      set(this.failure(undefined, String((e as Error)?.message ?? e).slice(0, 200)))
    }
  }
}

/** One interpretation of one section against the currently ready data. Synchronous and total. */
class Interp {
  r: Renderer
  sec: SectionNode
  budget: Budget
  needs = new Map<string, Need>()
  trace: TraceEntry[] = []
  diags: Diagnostic[] = []
  diagKeys = new Set<string>()
  stored: Record<string, Value> = {}
  status: ItemStatus = 'ok'
  tracing = false
  skip?: string
  failed = false
  pendingData = false
  readyNames = new Set<string>()
  runKeys?: Map<string, string>
  waitingSections = false
  stale = new Set<string>()
  storedMeta: Record<string, { fetchedAt: number; cache?: string }> = {}
  refs: { id: string; mode: IncludeMode }[] = []
  uses: Record<string, string>
  frame: Scope_
  vars = new Set<string>()
  list?: { ordered: boolean; n: number }
  text = ''
  included = true
  reason?: string
  env: EvalEnv

  constructor(r: Renderer, sec: SectionNode) {
    this.r = r
    this.sec = sec
    this.budget = newBudget(r.opts.stepLimit ?? 10_000)
    this.uses = { ...r.uses }
    this.frame = Object.create(r.root) as Scope_
    this.env = { call: (p, a, k) => this.callFn(p, a, k), diagnostics: [], now: r.host.now() }
  }

  diag(code: Diagnostic['code'], severity: Diagnostic['severity'], message: string, hint?: string): void {
    const key = `${code}|${message}`
    if (this.diagKeys.has(key)) return
    this.diagKeys.add(key)
    this.diags.push({ code, severity, message: `[${this.sec.id}] ${message}`, ...(this.sec.source?.path ? { path: this.sec.source.path } : {}), ...(hint ? { hint } : {}) })
  }

  addTrace(kind: TraceEntry['kind'], detail: string, extra: Partial<TraceEntry> = {}): void {
    if (this.trace.length >= MAX_TRACE_PER_SECTION) return
    this.trace.push({ section: this.sec.id, kind, detail, ...extra })
  }

  flushEnvDiags(): void {
    const ds = this.env.diagnostics!
    for (const d of ds) this.diag(d.code, d.severity, d.message, d.hint)
    ds.length = 0
  }

  ev(src: string, frame: Scope_): Value {
    const p = parseExpr(src)
    if (!p.ast) {
      for (const d of p.diagnostics) this.diag(d.code, d.severity, d.message, d.hint)
      return null
    }
    if (this.r.staleData.size) for (const k of dataKeys(p.ast)) if (this.r.staleData.has(k)) this.stale.add(`data.${k}`)
    const v = evalExpr(p.ast, frame, this.budget, this.env)
    this.flushEnvDiags()
    return v
  }

  storeValue(key: string, value: Value, ready?: Ready, cache?: string): void {
    this.stored[key] = value
    this.storedMeta[key] = { fetchedAt: ready?.at ?? this.r.host.now(), ...(cache ? { cache } : {}) }
  }

  useReady(key: string): Ready | undefined {
    const r = this.r.results.get(key)
    if (!r) { this.pendingData = true; return undefined }
    if (r.status === 'unverified') this.status = 'unverified'
    if (r.status === 'fail' && r.error === 'fail') this.status = 'fail'
    if (r.error === 'skip' && !this.skip) this.skip = r.detail ?? 'onError: skip'
    if (r.error === 'fail') { this.failed = true; this.skip = this.skip ?? 'onError: fail' }
    return r
  }

  callFn(path: string, args: Value[], kwargs: Record<string, Value>): Value {
    const [ns, ...rest] = path.split('.')
    const fn = rest.join('.')
    const json = stableJson([args, kwargs])
    if (fn && Object.prototype.hasOwnProperty.call(this.uses, ns)) {
      const module = this.uses[ns]
      const key = `call:${module}:${fn}:${json}`
      const ready = this.useReady(key)
      if (ready) return ready.value
      this.needs.set(key, { kind: 'call', key, module, fn, label: path, args, kwargs, cacheMs: parseDurationMs(this.r.opts.runCacheDefault) })
      return null
    }
    const h = this.r.host
    if (fn && h.provider && (!h.callables || matchCallable(h.callables, path))) {
      const key = `prov:${path}:${json}`
      const ready = this.useReady(key)
      if (ready) return ready.value
      this.needs.set(key, { kind: 'provider', key, path, args, kwargs })
      return null
    }
    this.diag('G157', 'error', `«${path}» не є функцією, яку відкриває хост; доступ до файлів, процесів і мережі з виразу неможливий`, 'використати @run або провайдер')
    return null
  }

  define(name: string, value: Value, frame: Scope_ = this.frame): void {
    frame[name] = value
  }

  assign(name: string, value: Value, frame: Scope_): void {
    let o: object | null = frame
    while (o && o !== this.r.root) {
      if (Object.prototype.hasOwnProperty.call(o, name)) { (o as Scope_)[name] = value; return }
      o = Object.getPrototypeOf(o) as object | null
    }
    this.frame[name] = value
  }

  step(): void {
    this.budget.steps++
    if (this.budget.steps > this.budget.limit) throw new StepLimitError(this.budget.limit)
  }

  run(): void {
    const { sec, r } = this
    try {
      if (sec.tier && sec.tier.length && !sec.tier.includes(r.opts.tier)) {
        this.exclude(`tier: секція для ${sec.tier.join(', ')}`)
        this.addTrace('tier', `${sec.tier.join(', ')} ∌ ${r.opts.tier}`)
        return
      }
      if (sec.when) {
        const v = this.ev(sec.when, this.frame)
        this.addTrace('when', `${sec.when} → ${truthy(v)}`)
        if (!truthy(v)) { this.exclude(`when: ${sec.when}`); return }
      }
      const out: string[] = []
      const sig = this.nodes(sec.children, this.frame, out)
      if (sig === 'stop' || this.skip) { this.exclude(this.skip ?? 'stop'); return }
      this.text = out.join('')
    } catch (e) {
      if (e instanceof StepLimitError) {
        this.diag('G155', 'error', `Перевищено ліміт кроків інтерпретатора (${this.budget.limit} на секцію)`, 'ця логіка має жити в провайдері')
        this.failed = true
        this.exclude('G155: ліміт кроків')
        return
      }
      if (e instanceof Stop) { this.exclude(this.skip ?? 'stop'); return }
      throw e
    }
  }

  exclude(reason: string): void {
    this.included = false
    this.reason = reason
    this.text = ''
  }

  finish(): SectionOut {
    const { sec } = this
    for (const name of this.vars) this.addTrace('let', `${name} = ${JSON.stringify(lookup(this.frame, name)).slice(0, 200)}`)
    if (this.needs.size) {
      this.status = this.status === 'fail' ? 'fail' : 'unverified'
      this.diag('G207', 'warning', `Дані не готові після ${MAX_ROUNDS} проходів (needs=… без джерела?) — рендер з null`)
    }
    let text = normalizeMarkdown(this.text)
    let truncated = false
    if (this.included && sec.budget) {
      const t = truncate(text, sec.budget)
      if (t.truncated) this.addTrace('budget', `${text.length} > ${sec.budget} символів`)
      text = t.text
      truncated = t.truncated
    }
    if (this.failed) this.status = 'fail'
    const rendered: RenderedSectionExt = {
      id: sec.id,
      scope: sec.scope,
      text: this.included ? text : '',
      chars: this.included ? text.length : 0,
      tokens: this.included ? estimateTokens(text) : 0,
      included: this.included,
      hash: hashString(this.included ? text : ''),
      status: this.status,
    }
    if (this.reason) rendered.reason = this.reason
    if (truncated) rendered.truncated = true
    if (sec.after) rendered.after = sec.after
    if (this.included && this.stale.size) rendered.stale = [...this.stale].sort()
    this.addTrace('section', `${this.included ? 'увійшла' : 'пропущена'}${this.reason ? ` (${this.reason})` : ''}, ${rendered.tokens} ток.`)
    return {
      rendered, trace: this.trace, diagnostics: this.diags,
      stored: this.included ? this.stored : {}, storedMeta: this.included ? this.storedMeta : {},
      refs: this.included ? this.refs : [],
    }
  }

  nodes(list: Node[], frame: Scope_, out: string[]): Signal {
    for (const n of list) {
      const s = this.node(n, frame, out)
      if (s) return s
    }
    return undefined
  }

  /** Render children into a fresh buffer (list context suspended). */
  sub(list: Node[], frame: Scope_): { text: string; sig: Signal } {
    const saved = this.list
    this.list = undefined
    const buf: string[] = []
    const sig = this.nodes(list, frame, buf)
    this.list = saved
    return { text: buf.join(''), sig }
  }

  item(text: string): string {
    const l = this.list!
    l.n++
    const prefix = l.ordered ? `${l.n}. ` : '- '
    const pad = ' '.repeat(prefix.length)
    const lines = text.replace(/^\n+|\n+$/g, '').split('\n')
    return prefix + lines.map((x, i) => (i === 0 ? x.trim() : pad + x)).join('\n') + '\n'
  }

  emitLeaf(s: string, out: string[]): void {
    if (!this.list) { out.push(s); return }
    for (const line of s.split('\n')) if (line.trim()) out.push(this.item(line))
  }

  node(n: Node, frame: Scope_, out: string[]): Signal {
    this.step()
    switch (n.t) {
      case 'text': this.emitLeaf(n.value, out); return
      case 'expr': {
        const v = this.ev(n.expr, frame)
        if (this.tracing) this.addTrace('debug', `{{ ${n.expr} }} = ${JSON.stringify(v).slice(0, 200)}`)
        this.emitLeaf(toText(v), out)
        return
      }
      case 'el': return this.el(n, frame, out)
      case 'if': {
        const v = truthy(this.ev(n.test, frame))
        if (n.test !== 'true') this.addTrace('if', `${n.test} → ${v}`)
        const branch = v ? n.then : n.else
        if (!branch) return
        return this.nodes(branch, Object.create(frame) as Scope_, out)
      }
      case 'each': {
        const of = this.ev(n.of, frame)
        if (of === null) return
        let items: Value[]
        if (Array.isArray(of)) items = of
        else if (isObj(of)) items = Object.entries(of).map(([key, value]) => ({ key, value }))
        else { this.diag('G120', 'warning', `@each по не-списку: ${n.of}`); return }
        for (let i = 0; i < items.length; i++) {
          const f = Object.create(frame) as Scope_
          f[n.as] = items[i]
          if (n.index) f[n.index] = i
          const s = this.nodes(n.children, f, out)
          if (s === 'break') break
          if (s === 'stop') return s
        }
        return
      }
      case 'repeat': {
        const v = this.ev(n.n, frame)
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          if (v !== null) this.diag('G152', 'warning', `Межа @repeat не число: ${n.n}`)
          return
        }
        if (v > 1000) { this.diag('G152', 'error', `Межа @repeat ${v} > 1000`, 'ця логіка має жити в провайдері'); return }
        const count = Math.max(0, Math.floor(v))
        for (let i = 0; i < count; i++) {
          const f = Object.create(frame) as Scope_
          f.i = i
          const s = this.nodes(n.children, f, out)
          if (s === 'break') break
          if (s === 'stop') return s
        }
        return
      }
      case 'break': return 'break'
      case 'continue': return 'continue'
      case 'let': this.define(n.name, this.ev(n.value, frame), frame); this.vars.add(n.name); return
      case 'set': this.assign(n.name, this.ev(n.value, frame), frame); this.vars.add(n.name); return
      case 'store': this.storeValue(n.name, lookup(frame, n.name)); return
      case 'use': this.uses[n.name] = n.path; return
      case 'run': return this.runNode(n, frame)
      case 'call': return this.callNode(n, frame)
      case 'include': return this.include(n, frame, out)
      case 'tier': {
        const t = this.r.opts.tier
        const on = n.is === 'non-premium' ? t !== 'premium' : n.is.includes(t)
        this.addTrace('tier', `${n.is === 'non-premium' ? 'не premium' : n.is.join(', ')} → ${on}`)
        if (!on) return
        return this.nodes(n.children, frame, out)
      }
      case 'fence': {
        const { text, sig } = this.sub(n.children, frame)
        const head = '```' + (n.lang ?? '') + (n.title ? ` title="${n.title}"` : '')
        out.push('\n' + head + '\n' + text.replace(/^\n+|\n+$/g, '') + '\n```\n')
        return sig === 'stop' ? sig : undefined
      }
      case 'list': return this.listNode(!!n.ordered, n.children, frame, out)
      case 'table': {
        const rows = this.ev(n.rows, frame)
        const lines = ['| ' + n.columns.map(escCell).join(' | ') + ' |', '| ' + n.columns.map(() => '---').join(' | ') + ' |']
        for (const row of Array.isArray(rows) ? rows : []) {
          this.step()
          const f = Object.create(frame) as Scope_
          f.row = row
          lines.push('| ' + n.cells.map(c => escCell(toText(this.ev(c, f)))).join(' | ') + ' |')
        }
        out.push('\n' + lines.join('\n') + '\n')
        return
      }
      case 'debug': {
        if (!this.r.opts.debug) return
        const parts: string[] = []
        if (n.message) parts.push(this.tpl(n.message, frame))
        for (const e of n.exprs) {
          const v = this.ev(e, frame)
          parts.push(/^["']/.test(e.trim()) ? toText(v) : `${e}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        }
        this.addTrace('debug', `[debug ${this.sec.id}] ${parts.join(' ')}`.slice(0, DEBUG_VALUE_MAX))
        return
      }
      case 'assert': {
        const ok = truthy(this.ev(n.test, frame))
        if (ok) return
        if (this.pendingData) { this.skip = 'assert (дані ще не готові)'; return 'stop' }
        const msg = n.message ? this.tpl(n.message, frame) : n.test
        const fail = (this.r.opts.assertFail ?? 'skip') === 'fail'
        this.diag('D001', fail ? 'error' : 'warning', `assert: ${msg}`)
        this.addTrace('assert', `${n.test} → false: ${msg}`)
        this.skip = `assert: ${msg}`
        if (fail) this.failed = true
        return 'stop'
      }
      case 'log': this.addTrace('log', `${n.level}: ${this.tpl(n.message, frame)}`); return
      case 'trace': this.tracing = n.on; return
    }
    return undefined
  }

  tpl(src: string, frame: Scope_): string {
    const p = parseTemplate(src)
    for (const d of p.diagnostics) this.diag(d.code, d.severity, d.message)
    const s = renderTemplate(p.parts, frame, this.budget, this.env)
    this.flushEnvDiags()
    return s
  }

  listNode(ordered: boolean, children: Node[], frame: Scope_, out: string[]): Signal {
    const saved = this.list
    this.list = { ordered, n: 0 }
    const buf: string[] = []
    const sig = this.nodes(children, frame, buf)
    this.list = saved
    const text = buf.join('')
    out.push(saved ? text.split('\n').map(l => (l ? '  ' + l : l)).join('\n') : '\n' + text + '\n')
    return sig === 'stop' ? sig : undefined
  }

  el(n: Extract<Node, { t: 'el' }>, frame: Scope_, out: string[]): Signal {
    const tag = n.tag.toLowerCase()
    if (tag === 'ul' || tag === 'ol') return this.listNode(tag === 'ol', n.children, frame, out)
    if (tag === 'br') { out.push('\n'); return }
    const { text, sig } = this.sub(n.children, frame)
    if (sig === 'stop') return sig
    if (tag === 'li') {
      if (this.list) out.push(this.item(text))
      else out.push('- ' + text.trim() + '\n')
      return
    }
    let s: string
    const h = /^h([1-6])$/.exec(tag)
    if (h) s = '\n' + '#'.repeat(Number(h[1])) + ' ' + text.trim() + '\n\n'
    else switch (tag) {
      case 'b': case 'strong': s = `**${text}**`; break
      case 'i': case 'em': s = `*${text}*`; break
      case 'code': s = '`' + text + '`'; break
      case 'pre': s = '\n```' + (n.attrs?.lang ?? '') + '\n' + text.replace(/^\n+|\n+$/g, '') + '\n```\n'; break
      case 'p': s = '\n' + text.trim() + '\n\n'; break
      case 'a': s = n.attrs?.href ? `[${text}](${n.attrs.href})` : text; break
      default: s = text
    }
    this.emitLeaf(s, out)
    return
  }

  runNode(n: Extract<Node, { t: 'run' }>, frame: Scope_): Signal {
    const key = 'run:' + hashString(n.lang + '\0' + n.code)
    const name = n.as ?? 'run'
    const ready = this.useReady(key)
    if (ready) {
      this.define(name, ready.value)
      this.readyNames.add(name)
      this.addTrace('run', `${n.lang} as=${name}: ${ready.source}${ready.bytes !== undefined ? `, ${ready.bytes} B` : ''}${ready.detail ? ` — ${ready.detail}` : ''}`, { source: ready.source, ...(ready.ms !== undefined ? { ms: ready.ms } : {}) })
      if (ready.detail && ready.status !== 'ok') this.diag('G203', ready.status === 'fail' ? 'error' : 'warning', `@run ${n.lang} (${name}) не виконано: ${ready.detail.replace(/; stderr:.*$/s, '')}`)
      if (ready.stale) this.stale.add(`run:${name}`)
      if (n.store) this.storeValue(n.store, ready.value, ready, n.cache ?? this.r.opts.runCacheDefault ?? DEFAULT_RUN_CACHE)
      if (ready.error) return 'stop'
      return
    }
    this.define(name, null)
    const waiting = (n.needs ?? []).filter(d => !this.readyNames.has(d) && !this.runReady(d))
    if (waiting.length) return
    const stdin = JSON.stringify({ ctx: snapshot(frame, this.r.root), args: lookup(frame, 'args') })
    this.needs.set(key, { kind: 'run', key, lang: n.lang, code: n.code, stdin, cacheMs: parseDurationMs(n.cache ?? this.r.opts.runCacheDefault ?? DEFAULT_RUN_CACHE), label: name })
    return
  }

  callNode(n: Extract<Node, { t: 'call' }>, frame: Scope_): Signal {
    const args = n.args.map(a => this.ev(a, frame))
    const kwargs: Record<string, Value> = {}
    for (const [k, v] of Object.entries(n.kwargs ?? {})) kwargs[k] = this.ev(v, frame)
    const [ns, ...rest] = n.fn.split('.')
    const fn = rest.join('.')
    let key: string
    if (Object.prototype.hasOwnProperty.call(this.uses, ns)) {
      const module = this.uses[ns]
      key = `call:${module}:${fn}:${stableJson([args, kwargs])}`
      const ready = this.useReady(key)
      if (!ready) {
        this.define(n.as, null)
        this.needs.set(key, { kind: 'call', key, module, fn, label: n.fn, args, kwargs, cacheMs: parseDurationMs(n.cache ?? this.r.opts.runCacheDefault) })
        return
      }
      this.define(n.as, ready.value)
      this.readyNames.add(n.as)
      this.addTrace('call', `${n.fn} as=${n.as}: ${ready.source}${ready.detail ? ` — ${ready.detail}` : ''}`, { source: ready.source })
      if (ready.stale) this.stale.add(`call:${n.as}`)
      if (n.store) this.storeValue(n.store, ready.value, ready, n.cache)
      return ready.error ? 'stop' : undefined
    }
    const v = this.callFn(n.fn, args, kwargs)
    this.define(n.as, v)
    if (!this.needs.has(`prov:${n.fn}:${stableJson([args, kwargs])}`)) {
      this.readyNames.add(n.as)
      this.addTrace('call', `${n.fn} as=${n.as}`, { source: 'run' })
      if (n.store) this.storeValue(n.store, v)
    }
    return
  }

  /** True when a `@run as=<name>` of this section already has a result (independent of source order). */
  runReady(name: string): boolean {
    if (!this.runKeys) {
      this.runKeys = new Map()
      const scan = (list: Node[]): void => {
        for (const x of list) {
          if (x.t === 'run') this.runKeys!.set(x.as ?? 'run', 'run:' + hashString(x.lang + '\0' + x.code))
          if (x.t === 'if') { scan(x.then); if (x.else) scan(x.else) }
          if ('children' in x && Array.isArray(x.children)) scan(x.children)
        }
      }
      scan(this.sec.children)
    }
    const key = this.runKeys.get(name)
    return key !== undefined && this.r.results.has(key)
  }

  refLine(name: string, description: string | undefined, path: string): string {
    return `- ${name}${description ? ` — ${description}` : ''} (${path})\n`
  }

  lazy(name: string, description: string, ref: string, out: string[]): void {
    const tool = `get_${name.replace(/[^\w]/g, '_')}`
    if (!this.r.lazies.has(tool)) this.r.lazies.set(tool, { description, ref })
    this.emitLeaf(`- ${description} — інструмент \`${tool}\`\n`, out)
  }

  include(n: Extract<Node, { t: 'include' }>, frame: Scope_, out: string[]): Signal {
    const budgeted = (text: string): string => {
      const t = truncate(normalizeMarkdown(text), n.budget)
      if (t.truncated) this.addTrace('budget', `include ${n.ref}: > ${n.budget}`)
      return '\n' + t.text + '\n\n'
    }
    switch (n.source) {
      case 'text': {
        const name = n.as ?? 'text'
        if (n.mode === 'inline') { this.emitLeaf(budgeted(n.text ?? ''), out); return }
        if (n.mode === 'lazy') { this.lazy(name, n.description ?? name, `text:${name}`, out); return }
        this.emitLeaf(this.refLine(name, n.description, `text:${name}`), out)
        return
      }
      case 'file': {
        const name = n.as ?? basename(n.ref)
        if (n.mode === 'ref') { this.emitLeaf(this.refLine(name, n.description, n.ref), out); this.addTrace('include', `${n.ref} ref`); return }
        if (n.mode === 'lazy') { this.lazy(name, n.description ?? name, n.ref, out); this.addTrace('include', `${n.ref} lazy`); return }
        const key = `file:${n.ref}`
        const ready = this.useReady(key)
        if (!ready) { this.needs.set(key, { kind: 'file', key, path: n.ref }); return }
        if (typeof ready.value !== 'string') { this.diag('G210', 'warning', `Файл для @include не знайдено: ${n.ref}`); return }
        this.addTrace('include', `${n.ref} inline, ${ready.value.length} символів`)
        this.emitLeaf(budgeted(ready.value), out)
        return
      }
      case 'section': {
        const id = n.ref.replace(/^prompt:\/\//, '')
        if (n.mode === 'ref') { this.refs.push({ id, mode: 'ref' }); this.emitLeaf(this.refLine(id, n.description, `prompt://${id}`), out); return }
        if (n.mode === 'lazy') { this.refs.push({ id, mode: 'lazy' }); this.lazy(id, n.description ?? id, `prompt://${id}`, out); return }
        if (!this.r.sections.has(id)) { this.diag('G211', 'warning', `Секцію prompt://${id} не знайдено`); return }
        const key = `section:${id}`
        const ready = this.r.results.get(key)
        if (!ready) {
          const ok = this.r.request(this.sec.id, id)
          if (ok === 'cycle') { this.diag('G159', 'error', `Цикл включень: ${this.sec.id} → ${id}`); return }
          if (ok === 'depth') { this.diag('G159', 'error', `Глибина включень понад ${MAX_INCLUDE_DEPTH}: ${this.sec.id} → ${id}`); return }
          this.waitingSections = true
          this.pendingData = true
          return
        }
        this.refs.push({ id, mode: 'inline' })
        if (ready.status === 'unverified') this.status = 'unverified'
        this.addTrace('include', `prompt://${id} inline`)
        if (typeof ready.value === 'string' && ready.value) this.emitLeaf(budgeted(ready.value), out)
        return
      }
      case 'skill':
      case 'rule': {
        const key = `item:${n.source}:${n.ref}`
        const ready = this.useReady(key)
        if (!ready) { this.needs.set(key, { kind: 'item', key, itemKind: n.source, name: n.ref }); return }
        if (!isObj(ready.value)) { this.diag('G211', 'warning', `${n.source} «${n.ref}» не знайдено`); return }
        const it = ready.value
        const desc = n.description ?? (typeof it.description === 'string' ? it.description : undefined)
        const path = typeof it.path === 'string' ? it.path : `${n.source}:${n.ref}`
        this.addTrace('include', `${n.source}:${n.ref} ${n.mode}`)
        if (n.mode === 'ref') { this.emitLeaf(this.refLine(n.ref, desc, path), out); return }
        if (n.mode === 'lazy') { this.lazy(n.ref, desc ?? n.ref, `${n.source}:${n.ref}`, out); return }
        this.emitLeaf(budgeted(typeof it.body === 'string' ? it.body : ''), out)
        return
      }
      case 'mcp': {
        const [server, ...rest] = n.ref.split('.')
        const tool = rest.join('.')
        const args: Record<string, Value> = {}
        for (const [k, v] of Object.entries(n.args ?? {})) args[k] = this.ev(v, frame)
        const key = `mcp:${n.ref}:${stableJson(args)}`
        const name = n.as ?? tool
        const ready = this.useReady(key)
        if (!ready) { this.define(name, null); this.needs.set(key, { kind: 'mcp', key, server, tool, args }); return }
        this.define(name, ready.value)
        this.readyNames.add(name)
        this.addTrace('mcp', `${n.ref} as=${name}: ${ready.source}${ready.detail ? ` — ${ready.detail}` : ''}`, { source: ready.source })
        return ready.error ? 'stop' : undefined
      }
    }
    return undefined
  }
}

function snapshot(frame: Scope_, root: Scope_): Record<string, Value> {
  const chain: object[] = []
  let o: object | null = frame
  while (o && o !== Object.prototype) { chain.unshift(o); if (o === root) break; o = Object.getPrototypeOf(o) as object | null }
  const out: Record<string, Value> = {}
  for (const c of chain) for (const [k, v] of Object.entries(c)) out[k] = v as Value
  return out
}

// ───────────────────────── entry point ─────────────────────────

function isCompiled(p: CompiledPrompt | SectionNode): p is CompiledPrompt {
  return (p as CompiledPrompt).version === 1 && Array.isArray((p as CompiledPrompt).sections)
}

/** Render prompts (compiled files or bare sections) for one turn. Never throws for user errors. */
/**
 * SPEC «Включення»: a section included through `@section` is not emitted standalone as well, unless its own
 * scope requires it. The rule:
 * - included `inline` → never standalone: its text is already inside the includer (no duplicate tokens);
 * - included as `ref` / `lazy` → not standalone, except `scope: static` sections — static is the stable
 *   prefix every prompt carries (prompt cache), so a pointer to it never removes it;
 * - only includers that are themselves emitted count; sections are visited in final prompt order and a
 *   section already suppressed suppresses nothing (deterministic even for mutual references);
 * - the `--only` target is always emitted.
 */
export function suppressIncluded(ordered: RenderedSectionExt[], refs: Map<string, { id: string; mode: IncludeMode }[]>, only?: string): void {
  const byId = new Map(ordered.map(s => [s.id, s]))
  const suppressed = new Set<string>()
  for (const s of ordered) {
    if (!s.included || suppressed.has(s.id)) continue
    for (const ref of refs.get(s.id) ?? []) {
      const t = byId.get(ref.id)
      if (!t || t.id === s.id || t.id === only || suppressed.has(t.id) || !t.included) continue
      if (ref.mode !== 'inline' && t.scope === 'static') continue
      suppressed.add(t.id)
      t.included = false
      t.text = ''
      t.chars = 0
      t.tokens = 0
      t.hash = hashString('')
      t.reason = `включена в ${s.id} (${ref.mode})`
      t.includedBy = s.id
    }
  }
}

export async function renderPrompt(prompts: CompiledPrompt[] | SectionNode[], scope: Scope_, host: RenderHostExt, opts: RenderOptionsExt): Promise<RenderResultExt> {
  const t0 = host.now()
  const diagnostics: Diagnostic[] = []
  const all: SectionNode[] = []
  const uses: Record<string, string> = { ...(opts.uses ?? {}) }
  for (const p of prompts as (CompiledPrompt | SectionNode)[]) {
    if (isCompiled(p)) {
      Object.assign(uses, p.uses ?? {})
      all.push(...p.sections)
      if (p.skill) all.push({ id: p.skill.name, scope: 'volatile', children: p.skill.body, ...(p.skill.tiers ? { tier: p.skill.tiers } : {}) })
    } else all.push(p)
  }
  const r = new Renderer(host, opts, scope, uses)
  for (const s of all) {
    if (r.sections.has(s.id)) diagnostics.push({ code: 'G161', severity: 'error', message: `Секцію «${s.id}» оголошено двічі — використано першу` })
    else r.sections.set(s.id, s)
  }
  const top = [...r.sections.values()].filter(s => !opts.only || s.id === opts.only.replace(/^prompt:\/\//, ''))
  if (opts.only && !top.length) diagnostics.push({ code: 'G211', severity: 'error', message: `Секцію «${opts.only}» не знайдено` })

  await r.renderAll(top)
  const outs: SectionOut[] = top.map(s => r.memo.get(s.id)).filter((o): o is SectionOut => !!o)

  const rendered = orderSections(outs.map(o => o.rendered), diagnostics)
  suppressIncluded(rendered, new Map(outs.map(o => [o.rendered.id, o.refs])), opts.only?.replace(/^prompt:\/\//, ''))
  const storedMeta: Record<string, { fetchedAt: number; cache?: string }> = {}
  const trace: TraceEntry[] = []
  const stored: Record<string, Value> = {}
  for (const o of outs) {
    trace.push(...o.trace)
    diagnostics.push(...o.diagnostics)
    Object.assign(stored, o.stored)
    Object.assign(storedMeta, o.storedMeta)
  }
  // Sections reached only through inline includes still contribute diagnostics and stored values.
  for (const [id, o] of r.memo) {
    if (top.some(s => s.id === id)) continue
    diagnostics.push(...o.diagnostics)
    Object.assign(stored, o.stored)
    Object.assign(storedMeta, o.storedMeta)
  }
  for (const [tool, l] of r.lazies) {
    try { host.registerLazy?.(tool, l.description, l.ref) } catch { /* adapter-specific */ }
  }
  const text = rendered
    .filter(s => s.included && s.text)
    .map(s => (opts.markers ? `<!-- section:${s.id} ${s.scope} -->\n${s.text}` : s.text))
    .join('\n\n')
  const storedEntries: Record<string, Value> = {}
  for (const [k, v] of Object.entries(stored)) storedEntries[k] = dataEnvelope(v, storedMeta[k]?.fetchedAt ?? host.now(), storedMeta[k]?.cache)
  return { sections: rendered, text, trace, diagnostics, ms: host.now() - t0, stored, storedEntries }
}

// ───────────────────────── trace formatting ─────────────────────────

/** Table text for `context-gate run --trace`. */
export function formatTrace(result: RenderResult): string {
  const lines: string[] = []
  lines.push('| секція | scope | стан | токени | причина |', '| --- | --- | --- | --- | --- |')
  for (const s of result.sections) {
    const state = s.included ? (s.truncated ? 'обрізана' : 'увійшла') : 'пропущена'
    lines.push(`| ${escCell(s.id)} | ${s.scope} | ${state}${s.status !== 'ok' ? ` (${s.status})` : ''} | ${s.tokens} | ${escCell(s.reason ?? '')} |`)
  }
  if (result.trace.length) {
    lines.push('', '| секція | що | деталі | мс | джерело |', '| --- | --- | --- | --- | --- |')
    for (const t of result.trace) lines.push(`| ${escCell(t.section)} | ${t.kind} | ${escCell(t.detail)} | ${t.ms ?? ''} | ${t.source ?? ''} |`)
  }
  if (result.diagnostics.length) {
    lines.push('')
    for (const d of result.diagnostics) lines.push(`- ${d.code} ${d.severity}: ${d.message}${d.hint ? ` (${d.hint})` : ''}`)
  }
  lines.push('', `рендер ${result.ms} мс, ${result.sections.filter(s => s.included).reduce((a, s) => a + s.tokens, 0)} ток.`)
  return lines.join('\n')
}
