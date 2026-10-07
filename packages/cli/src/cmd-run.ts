// `context-gate run | render | health`: the standalone interpreter (SPEC «Автономний інтерпретатор»,
// «Промпти як skills», «Prompt health»). Same core renderPrompt as the mod's prompt.compose.

import { join, relative } from 'node:path'
import type { CompiledPrompt, Diagnostic, Node, RenderResult, Value } from '../../core/src/types.ts'
import { renderPrompt, formatTrace, isDataEnvelope, capDebugLog, debugLogLines, secretValues, type RenderOptionsExt } from '../../core/src/render.ts'
import { debugLogPath, maskSecretsDeep } from '../../core/src/config.ts'
import { computeHealth, formatHealth } from '../../core/src/health.ts'
import { fromJsonl, gateStatsFromJournal } from '../../core/src/journal.ts'
import type { RunJson, RunJsonMeta } from '../../core/src/runjson.ts'
import { buildPrompts, checkStale } from './build.ts'
import { sectionText, skillArgs } from '../../core/src/assemble.ts'
import { buildContext, setData, validDataKey, type ContextOptions, type RenderContext } from './context.ts'
import { lineDiff, posix, readJson, safeJoin, sha256, writeJson, writeText, fileExists, readText } from './util.ts'

export interface RunOptions extends ContextOptions {
  id?: string
  only?: string
  trace?: boolean
  json?: boolean
  markers?: boolean
  diff?: string
  argsRaw?: string
  /** Rebuild stale TSX before rendering (default: when trusted and build != never). */
  autoBuild?: boolean
  /** `--debug`: evaluate `@debug` and write `.claude/gate.debug.log`, as `debug: true` in gate.json. */
  debug?: boolean
}

export interface RunOutcome {
  code: number
  stdout: string
  stderr: string
  result?: RenderResult
  ctx?: RenderContext
}

function walkNodes(nodes: Node[], fn: (n: Node) => void): void {
  for (const n of nodes) {
    fn(n)
    if (n.t === 'if') { walkNodes(n.then, fn); if (n.else) walkNodes(n.else, fn) }
    else if ('children' in n && Array.isArray(n.children)) walkNodes(n.children, fn)
  }
}

/** G158: functions called through `use` bindings that the module does not export (asks each shim once). */
export async function validateUses(prompts: CompiledPrompt[], ctx: RenderContext): Promise<Diagnostic[]> {
  if (!ctx.host.trusted || ctx.host.dryScripts) return []
  const out: Diagnostic[] = []
  const want = new Map<string, Set<string>>()
  for (const cp of prompts) {
    const uses: Record<string, string> = { ...(cp.uses ?? {}) }
    const nodes: Node[] = [...cp.sections.flatMap((s) => s.children), ...(cp.skill?.body ?? [])]
    walkNodes(nodes, (n) => { if (n.t === 'use') uses[n.name] = n.path })
    const text = JSON.stringify(nodes)
    for (const [ns, path] of Object.entries(uses)) {
      const set = want.get(path) ?? new Set<string>()
      for (const m of text.matchAll(new RegExp(`(?<![\\w.])${ns.replace(/[$]/g, '\\$')}\\.([A-Za-z_][\\w]*)\\s*\\(`, 'g'))) set.add(m[1]!)
      walkNodes(nodes, (n) => { if (n.t === 'call' && n.fn.startsWith(ns + '.')) set.add(n.fn.slice(ns.length + 1)) })
      want.set(path, set)
    }
  }
  await Promise.all([...want.entries()].map(async ([path, fns]) => {
    if (!fns.size) return
    const exports = await ctx.host.listExports(path)
    if (!exports) return
    for (const fn of fns) if (!exports.includes(fn)) out.push({ code: 'G158', severity: 'error', message: `Функції ${fn} немає в модулі ${path} (експорти: ${exports.join(', ') || '—'})`, path })
  }))
  return out
}

export interface EnsureBuilt {
  /** H013 when the build was not allowed; error diagnostics of the build otherwise. */
  diagnostics: Diagnostic[]
  /** Something was (re)built: `.compiled` changed and the context must be reloaded. */
  built: boolean
}

/** Builds stale/missing TSX when allowed (trusted, `prompt.build` != never). */
export async function ensureBuilt(ctxRoot: string, promptDir: string, trusted: boolean, mode: string | undefined): Promise<EnsureBuilt> {
  const st = checkStale({ root: ctxRoot, dir: promptDir })
  const todo = [...st.stale, ...st.missing]
  if (!todo.length) return { diagnostics: [], built: false }
  if (!trusted || mode === 'never') {
    return { built: false, diagnostics: [{ code: 'H013', severity: 'warning', message: `Застарілий або відсутній .compiled: ${todo.join(', ')}`, hint: trusted ? 'context-gate build' : 'context-gate build (або trust grant / --trust-repo для автозбірки)' }] }
  }
  const r = await buildPrompts({ root: ctxRoot, dir: promptDir, only: todo })
  return { built: r.written.length > 0, diagnostics: r.diagnostics.filter((d) => d.severity === 'error') }
}

export interface Rendered { result: RenderResult; mode: 'prompt' | 'skill' | 'section'; id?: string; usage?: string; prompts: CompiledPrompt[] }

/** `assertFail` from gate.json (top level, or under `prompt`): `skip` (default) or `fail` (SPEC «Налагодження»). */
export function assertFailOf(config: RenderContext['repo']['config']): 'skip' | 'fail' | undefined {
  const c = config as { assertFail?: unknown; prompt?: { assertFail?: unknown } } // typed top-level; `prompt.assertFail` tolerated
  const v = c.assertFail ?? c.prompt?.assertFail
  return v === 'fail' || v === 'skip' ? v : undefined
}

/** Values of the gate.json `env` whitelist in this process: masked as `***` in trace and the debug log. */
export function envSecrets(config: RenderContext['repo']['config'], env: Record<string, string | undefined> = process.env): string[] {
  return (config.env ?? []).map((n) => env[n]).filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** Renders the system prompt, one section (`only`) or a skill (`skill` + raw args). */
export async function renderWith(ctx: RenderContext, o: { id?: string; only?: string; argsRaw?: string; debug?: boolean }): Promise<Rendered> {
  const { prompts, repo } = ctx
  const assertFail = assertFailOf(repo.config)
  const secrets = envSecrets(repo.config)
  const opts: RenderOptionsExt = {
    tier: ctx.tier,
    ...(repo.config.prompt?.runCacheDefault ? { runCacheDefault: repo.config.prompt.runCacheDefault } : {}),
    ...(repo.config.debug || o.debug ? { debug: true } : {}),
    ...(assertFail ? { assertFail } : {}),
    ...(secrets.length ? { secrets } : {}),
  }
  const skill = o.id ? prompts.skills[o.id] : undefined
  if (skill) {
    const parsed = skillArgs(skill, o.argsRaw ?? '', (p) => fileExists(join(repo.root, p)))
    if (!parsed.ok) {
      const empty: RenderResult = { sections: [], text: parsed.text, trace: [], diagnostics: [], ms: 0, stored: {} }
      return { result: empty, mode: 'skill', id: o.id, usage: parsed.text, prompts: [skill] }
    }
    ctx.scope.args = parsed.args
    const list = [...prompts.system, skill]
    const result = await renderPrompt(list, ctx.scope, ctx.host, { ...opts, only: skill.skill!.name })
    return { result, mode: 'skill', id: o.id, prompts: list }
  }
  const only = o.only ?? o.id
  const result = await renderPrompt(prompts.system, ctx.scope, ctx.host, { ...opts, ...(only ? { only } : {}) })
  return { result, mode: only ? 'section' : 'prompt', ...(only ? { id: only } : {}), prompts: prompts.system }
}

/**
 * Persist `store=` values: always to the cache data store; to `.claude/prompt/data/` with `prompt.persist`.
 * Keys come from the repo (`<Store name>`, `@store`): one that is not a plain data key (`../x`, `/abs`) is
 * refused with a G001 warning and never written (Р2: untrusted repos write nothing outside `data/`).
 */
export function persistStored(ctx: RenderContext, result: RenderResult, diagnostics: Diagnostic[] = []): string[] {
  const out: string[] = []
  const entries = (result as RenderResult & { storedEntries?: Record<string, Value> }).storedEntries ?? {}
  for (const [k, v] of Object.entries(result.stored)) {
    if (!validDataKey(k)) {
      diagnostics.push({ code: 'G001', severity: 'warning', message: `store «${k}»: невірний ключ даних — значення не збережено`, hint: 'латиниця, цифри, . _ - (без /, .. і абсолютних шляхів)' })
      continue
    }
    const env = isDataEnvelope(entries[k]) ? entries[k] as Record<string, Value> : undefined
    out.push(...setData(ctx.repo, k, v, { persist: !!ctx.repo.config.prompt?.persist, ...(env && typeof env.cache === 'string' ? { cache: env.cache } : {}), ...(env && typeof env.fetchedAt === 'number' ? { fetchedAt: env.fetchedAt } : {}) }))
  }
  return out
}

/** The scope as written to `.trace/last.json`, `run --json` and the index: values of the `env` whitelist masked. */
export function maskedScope(scope: Record<string, Value>): Record<string, Value> {
  const env = scope.env
  if (!env || typeof env !== 'object' || Array.isArray(env)) return scope
  return { ...scope, env: Object.fromEntries(Object.keys(env).map((k) => [k, '***'])) }
}

function outputText(r: Rendered, markers: boolean): string {
  if (r.usage) return r.usage
  if (r.mode === 'skill') return r.result.text
  return markers ? sectionText(r.result.sections, true) : r.result.text
}

/** The `run --json` object (core RunJson): what stdout prints and `.trace/last.json` holds. */
export function jsonOf(ctx: RenderContext, r: Rendered, diagnostics: Diagnostic[], extra: Partial<RunJsonMeta> = {}): RunJson {
  // Structural masking (M04): a secret copied into another scope value or a trace line never reaches the JSON.
  const secrets = secretValues(ctx.scope)
  const out: RunJson = {
    sections: r.result.sections,
    text: outputText(r, false),
    trace: maskSecretsDeep(r.result.trace, secrets),
    diagnostics,
    ms: r.result.ms,
    scope: maskSecretsDeep(maskedScope(ctx.scope), secrets),
    meta: {
      ok: !r.usage && !diagnostics.some((d) => d.severity === 'error'),
      mode: r.mode,
      ...(r.id ? { id: r.id } : {}),
      tier: ctx.tier,
      profile: ctx.gate.profile ?? null,
      source: ctx.source,
      trusted: ctx.host.trusted,
      ...(r.usage ? { usage: r.usage } : {}),
      stored: r.result.stored,
      lazies: ctx.host.lazies,
      gate: { profile: ctx.gate.profile ?? null, tier: ctx.gate.tier, trigger: ctx.gate.trigger, groups: ctx.gate.groups, reason: ctx.gate.reason },
      at: Date.now(),
      ...extra,
    },
  }
  if (r.mode === 'prompt' && !r.usage) out.health = computeHealth(r.result, undefined, {}, ctx.repo.config.health ?? {})
  return out
}

/**
 * `.claude/gate.debug.log` (SPEC «Налагодження»): only with `debug: true` in gate.json or `--debug`; `@debug`,
 * `@log`, `@assert` entries and D0xx, secrets masked, cut to 1 MB from the head. Returns the path when written.
 */
export function writeDebugLog(root: string, result: RenderResult, meta: { tier?: string; secrets?: string[]; now?: number; file?: { path: string; maxBytes: number } } = {}): string | undefined {
  const add = debugLogLines(result, meta.now ?? Date.now(), { ...(meta.tier ? { tier: meta.tier } : {}), ...(meta.secrets ? { secrets: meta.secrets } : {}) })
  if (!add) return undefined
  const file = meta.file ?? debugLogPath({ debug: true })!
  // `debugLog.path` comes from gate.json: only inside the repo (no `..`, absolute paths or symlinks out of it).
  const path = safeJoin(root, file.path)
  if (!path) return undefined
  try {
    writeText(path, capDebugLog(readText(path) ?? '', add, file.maxBytes), root)
    return path
  } catch { return undefined }
}

/** `.claude/prompt/.trace/last.json`: the last run's RunJson (scope included) for the LSP and the editors. */
function writeTrace(ctx: RenderContext, j: RunJson): void {
  const p = safeJoin(ctx.repo.root, join(ctx.repo.promptDir, '.trace', 'last.json'))
  // The whole file is masked (as the mod's .trace/last.json): it lives in the repo and may be shared.
  try { if (p) writeJson(p, maskSecretsDeep(j, secretValues(ctx.scope))) } catch { /* read-only repo */ }
}

/** Warning codes printed to stderr even without `--trace`: the render lacks part of the context. */
const THIN_CONTEXT = new Set(['H013', 'G204', 'G203'])

export async function runCommand(o: RunOptions): Promise<RunOutcome> {
  let ctx = await buildContext(o)
  const pre: Diagnostic[] = []
  if (o.autoBuild !== false) {
    const built = await ensureBuilt(ctx.repo.root, ctx.repo.promptDir, ctx.host.trusted, ctx.repo.config.prompt?.build)
    pre.push(...built.diagnostics)
    // Reload after any build (success or partial): ctx.prompts were read from the old .compiled.
    if (built.built || built.diagnostics.length || ctx.prompts.compiledFrom === 'none') ctx = await buildContext(o)
  }
  const logFile = debugLogPath(ctx.repo.config, !!o.debug)
  const debugOn = !!logFile
  const r = await renderWith(ctx, { ...(o.id ? { id: o.id } : {}), ...(o.only ? { only: o.only } : {}), ...(o.argsRaw !== undefined ? { argsRaw: o.argsRaw } : {}), ...(debugOn ? { debug: true } : {}) })
  if (logFile && !r.usage) writeDebugLog(ctx.repo.root, r.result, { tier: ctx.tier, secrets: envSecrets(ctx.repo.config), file: logFile })
  const g158 = r.usage ? [] : await validateUses(r.prompts, ctx)
  const storeDiags: Diagnostic[] = []
  const written = r.usage ? [] : persistStored(ctx, r.result, storeDiags)
  const diagnostics = [...ctx.diagnostics, ...pre, ...g158, ...r.result.diagnostics, ...storeDiags, ...ctx.host.notes]
  const failedProviders = ctx.providers.failed.filter((f) => f.mode === 'fail')
  // Exit 1 on any error diagnostic (main.ts contract): render, G158, failed providers, and also the context
  // (missing fixture, config errors) and the auto-build (G164), so CI never passes on a stale or wrong render.
  const hasError = diagnostics.some((d) => d.severity === 'error') || failedProviders.length > 0
  const code = hasError ? 1 : 0
  let stdout = ''
  let stderr = ''
  const markers = o.markers ?? true

  if (o.diff) {
    const snapCtx = await buildContext({ ...o, ctxFrom: o.diff })
    const prev = snapCtx.snapshot?.text ?? (await renderWith(snapCtx, { ...(o.id ? { id: o.id } : {}), ...(o.only ? { only: o.only } : {}), ...(o.argsRaw !== undefined ? { argsRaw: o.argsRaw } : {}) })).result.text
    const d = lineDiff(prev, outputText(r, false))
    const j = jsonOf(ctx, r, diagnostics, { diff: d, against: o.diff })
    writeTrace(ctx, j)
    stdout = o.json ? JSON.stringify(j) + '\n' : (d ? d + '\n' : `без змін відносно ${o.diff}\n`)
    return { code, stdout, stderr, result: r.result, ctx }
  }

  const j = jsonOf(ctx, r, diagnostics)
  writeTrace(ctx, j)
  if (o.json) {
    stdout = JSON.stringify(j) + '\n'
    return { code, stdout, stderr, result: r.result, ctx }
  }
  stdout = outputText(r, markers && r.mode === 'prompt')
  if (stdout && !stdout.endsWith('\n')) stdout += '\n'
  if (o.trace) {
    const lines = ['', '---', '', `tier ${ctx.tier} · профіль ${ctx.gate.profile ?? '—'} · контекст ${ctx.source}${ctx.host.trusted ? '' : ' · репозиторій не довірений: скрипти й cli-провайдери не запускались'}`, '', formatTrace({ ...r.result, diagnostics })]
    if (ctx.host.lazies.length) lines.push('', 'Ліниві інструменти: ' + ctx.host.lazies.map((l) => `${l.name} (${l.ref})`).join(', '))
    if (written.length) lines.push('', 'Збережено: ' + written.join(', '))
    stdout += lines.join('\n') + '\n'
  } else {
    // Errors, and the warnings that mean the model got a thinner prompt than the repo describes (stale or missing
    // .compiled, untrusted providers/scripts skipped, git timeout): loud on stderr for `claude -p` and CI (O2).
    for (const d of diagnostics.filter((x) => x.severity === 'error' || THIN_CONTEXT.has(x.code))) stderr += `${d.code} ${d.message}${d.hint ? ` (${d.hint})` : ''}\n`
  }
  return { code, stdout, stderr, result: r.result, ctx }
}

// ───────────────────────── health ─────────────────────────

export async function healthCommand(o: ContextOptions & { json?: boolean; strict?: boolean }): Promise<RunOutcome> {
  const ctx = await buildContext({ ...o, dryScripts: o.dryScripts ?? false })
  const r = await renderWith(ctx, {})
  // H002/H003 compare with the previous render of the same tier, profile and model (not of another tier).
  const prevPath = join(ctx.repo.cacheDir, `last-render.${sha256(JSON.stringify([ctx.tier, ctx.gate.profile ?? null, o.model ?? null])).slice(0, 12)}.json`)
  const previous = readJson<RenderResult>(prevPath)
  const stale = checkStale({ root: ctx.repo.root, dir: ctx.repo.promptDir })
  // H011 from the journal's `gate-attempt` entries (core journal contract; the mod and the hooks adapter write them):
  // one session with --ctx-from session:…, else the whole journal.
  const logText = readText(join(ctx.repo.root, '.claude', 'gate.log.jsonl'))
  const gates = logText ? gateStatsFromJournal(fromJsonl(logText).items, ctx.snapshot?.sessionId ? { sessionId: ctx.snapshot.sessionId } : {}) : {}
  // G-43: compactions and the gate decision from the journal, since its last `/clear` (the mod's conversation).
  const items = logText ? (fromJsonl(logText).items as { trigger?: string; kind?: string; profile?: string | null }[]) : []
  const conv = items.slice(items.map((e) => e.trigger).lastIndexOf('clear') + 1)
  const decisions = conv.filter((e) => (e.kind === undefined || e.kind === 'decision') && 'profile' in e)
  const manualOverrides = conv.filter((e) => e.trigger === 'manual').length
  const sessionExtras = items.length ? {
    compactions: conv.filter((e) => e.trigger === 'compact').length,
    ...(decisions.length ? { decision: { profile: decisions[decisions.length - 1]!.profile ?? null, ...(manualOverrides ? { manualOverrides } : {}) } } : {}),
  } : {}
  const report = computeHealth(r.result, previous, { compiledStale: [...stale.stale, ...stale.missing], ...(Object.keys(gates).length ? { gates } : {}), ...sessionExtras }, ctx.repo.config.health ?? {})
  try { writeJson(prevPath, { ...r.result, trace: [] }) } catch { /* cache best effort */ }
  const diags = [...report.diagnostics, ...r.result.diagnostics, ...ctx.host.notes]
  const bad = report.metrics.some((m) => m.code && !m.ok)
  const code = o.strict && bad ? 1 : 0
  if (o.json) return { code, stdout: JSON.stringify({ ...report, diagnostics: diags, tier: ctx.tier, profile: ctx.gate.profile ?? null }) + '\n', stderr: '', result: r.result, ctx }
  const lines = [`Prompt health · tier ${ctx.tier} · профіль ${ctx.gate.profile ?? '—'}`, '', formatHealth(report)]
  const extra = diags.filter((d) => !/^H/.test(d.code))
  if (extra.length) lines.push('', ...extra.map((d) => `- ${d.code} ${d.severity}: ${d.message}`))
  return { code, stdout: lines.join('\n') + '\n', stderr: '', result: r.result, ctx }
}

export function relPath(root: string, p: string): string {
  return posix(relative(root, p))
}
