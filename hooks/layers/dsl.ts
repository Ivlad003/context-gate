// Layer 3: the prompt DSL (SPEC "Шар 3", "Збірка через mod", "Промпти як skills", "Шар 3а").
// prompt.compose reads `.claude/prompt/.compiled/*.json` and Markdown sections (`<dir>/*.md`, tier variant
// files `<id>.<tier>.md`), renders them with core renderPrompt over a RenderHost built from $, and adds them
// as `session` sections `context-gate:<id>` ordered static → profile → volatile. Stale `.compiled` →
// `node <plugin>/dist/cli.js build --only <file>` when trusted (2 s in compose, else previous + H013).
// Prompt skills render at invocation (skill.prompt, or as tools for `invoke.model: 'tool'`).


import type { CompiledPrompt, Diagnostic, Gate, RenderedSection, Scope_, SectionNode, Value } from '../../packages/core/src/types.ts'
import { DEBUG_LOG_FILE, DEBUG_LOG_MAX, capDebugLog, debugLogLines, renderPrompt, materializeData } from '../../packages/core/src/render.ts'
import type { RenderHostExt, RenderOptionsExt, RenderResultExt } from '../../packages/core/src/render.ts'
import { argsToJsonSchema } from '../../packages/core/src/argparse.ts'
import { tierForModel } from '../../packages/core/src/config.ts'
import { denyText } from '../../packages/core/src/decide.ts'
import { assemblePrompts, buildScope as coreBuildScope, defaultGate, skillArgs, type MarkdownFile, type PromptSet as AssembledSet } from '../../packages/core/src/assemble.ts'
import { parseToolHeader, parseToolHeaders } from '../../packages/core/src/toolheader.ts'
import { missingExports, scriptArgv, scriptLang, shimLang, usedFunctions } from '../../packages/core/src/shims.ts'
import { repoCacheName } from '../../packages/core/src/sha256.ts'
import type { RunJson } from '../../packages/core/src/runjson.ts'
import { computeHealth } from '../../packages/core/src/health.ts'
import { isApplied, json } from '../state.ts'
import { type Io, OWN_TOOL_PREFIX, type PromptSet, type Runtime, type ScriptTool, debug, hash, insideRoot, join, now, stableJson } from '../ctx.ts'
import { ensureEnv, ensureSession } from './config.ts'
import { ensureRules } from './cursor-rules.ts'
import { journal, pushFileEntry } from './journal.ts'
import { snapshotData, snapshotEntry } from '../../packages/core/src/journal.ts'
import { type ModHost, allowedBinary, makeRenderHost, providerConfigs, providerData, runArgv } from './host.ts'
import { ensureTrust, needsTrust, repoKey, trustState } from './trust.ts'
import { budgetSections } from './budgets.ts'
import { readBranch, skillOffMessage } from './skill-gate.ts'
import { refreshStatus } from './ui.ts'
import { gateStats } from './gates.ts'

const SYNC_BUILD_MS = 2000
const FULL_BUILD_MS = 30_000
const SECTION_PREFIX = 'context-gate:'

export function promptDir(rt: Runtime): string {
  return (rt.cfg.prompt?.dir ?? '.claude/prompt').replace(/\/+$/, '')
}

// ───────────────────────── loading ─────────────────────────

function isCompiledPrompt(v: unknown): v is CompiledPrompt {
  return !!v && typeof v === 'object' && (v as CompiledPrompt).version === 1 && Array.isArray((v as CompiledPrompt).sections)
}

type ListEntry = { name: string; kind: string; size: number; mtimeMs: number; isLink?: boolean }

/** mtime of a repo-relative file (undefined when missing): `io.fs.stat`, else the parent dir's listing (memoized per load). */
async function mtimeOf(io: Io, rt: Runtime, rel: string, lists: Map<string, ListEntry[]>): Promise<number | undefined> {
  if (!insideRoot(rel)) return undefined
  if (io.fs.stat) {
    const st = await io.fs.stat(join(rt.root, rel)).catch(() => undefined)
    if (st) return st.mtimeMs
  }
  const i = rel.lastIndexOf('/')
  const dir = i < 0 ? '' : rel.slice(0, i)
  let entries = lists.get(dir)
  if (!entries) {
    entries = [...(await io.fs.list(dir ? join(rt.root, dir) : rt.root).catch(() => []))]
    lists.set(dir, entries)
  }
  return entries.find((e) => e.name === rel.slice(i + 1) && e.kind === 'file')?.mtimeMs
}

/** Per-repo cache dir of the CLI (`~/.cache/context-gate/<name>-<hash12>/`, XDG_CACHE_HOME respected), SPEC Р3. */
export async function repoCacheDir(io: Io, rt: Runtime): Promise<string | undefined> {
  const xdg = await io.env.cacheHome?.().catch(() => undefined)
  const home = xdg ? undefined : await io.env.home().catch(() => undefined)
  const base = xdg ? `${xdg.replace(/[\\/]+$/, '')}/context-gate` : home ? `${home.replace(/[\\/]+$/, '')}/.cache/context-gate` : undefined
  if (!base) return undefined
  const repo = await io.session.repo().catch(() => null)
  const exact = `${base}/${repoCacheName(rt.root, repo?.remote ?? '')}`
  if (await io.fs.exists(`${exact}/compiled`).catch(() => false)) return exact
  // The engine may spell the remote differently from `git config remote.origin.url`: one dir for this repo name is it.
  const name = repoCacheName(rt.root).replace(/-[0-9a-f]{12}$/, '-')
  const dirs = (await io.fs.list(base).catch(() => [])).filter((e) => e.kind === 'dir' && e.name.startsWith(name) && /-[0-9a-f]{12}$/.test(e.name))
  return dirs.length === 1 ? `${base}/${dirs[0].name}` : exact
}

async function readCompiledDir(io: Io, absDir: string, label: string, entries: readonly ListEntry[], diagnostics: Diagnostic[]): Promise<{ prompt: CompiledPrompt; mtimeMs: number }[]> {
  const out: { prompt: CompiledPrompt; mtimeMs: number }[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
    const t = await io.fs.read(`${absDir}/${e.name}`).catch(() => undefined)
    if (typeof t !== 'string') continue
    try {
      const v = JSON.parse(t) as unknown
      if (isCompiledPrompt(v)) out.push({ prompt: v, mtimeMs: e.mtimeMs })
      else diagnostics.push({ code: 'G001', severity: 'warning', message: `${label}/${e.name}: не CompiledPrompt v1`, path: `${label}/${e.name}` })
    } catch (err) {
      diagnostics.push({ code: 'G001', severity: 'warning', message: `${label}/${e.name}: ${String((err as Error).message)}`, path: `${label}/${e.name}` })
    }
  }
  return out
}

/**
 * `.compiled/*.json` (or, when the repo has none, the CLI's per-repo cache, Р3) and the Markdown prompts.
 * Staleness (SPEC "Життєвий цикл"): a `.prompt.tsx` without a compiled prompt, or one whose `sources[]` (the entry
 * and every import: `shared/*.prompt.tsx`, `.md`, `.json`) has a file newer than its compiled JSON (H013).
 */
export async function loadPrompts(io: Io, rt: Runtime, opts: { force?: boolean } = {}): Promise<PromptSet> {
  await ensureSession(io, rt)
  const dir = promptDir(rt)
  const absDir = join(rt.root, dir)
  const entries = await io.fs.list(absDir).catch(() => [])
  let compiledDir = `${absDir}/.compiled`
  let compiledLabel = `${dir}/.compiled`
  let compiledFrom: 'repo' | 'cache' | 'none' = 'repo'
  let compiledEntries: ListEntry[] = [...(await io.fs.list(compiledDir).catch(() => []))]
  if (!compiledEntries.some((e) => e.kind === 'file' && e.name.endsWith('.json'))) {
    const cache = await repoCacheDir(io, rt)
    const cached = cache ? [...(await io.fs.list(`${cache}/compiled`).catch(() => []))] : []
    if (cache && cached.some((e) => e.kind === 'file' && e.name.endsWith('.json'))) {
      compiledDir = `${cache}/compiled`
      compiledLabel = compiledDir
      compiledEntries = cached
      compiledFrom = 'cache'
    } else compiledFrom = 'none'
  }
  // Imported sources outside the listed dir change nothing in the listings: their mtimes join the key.
  const lists = new Map<string, ListEntry[]>()
  const sourceKey: string[] = []
  for (const src of rt.prompts?.sources ?? []) {
    if (!src.includes('/') || src.slice(0, src.lastIndexOf('/')) !== dir) sourceKey.push(`s/${src}:${(await mtimeOf(io, rt, src, lists)) ?? 'missing'}`)
  }
  const key = [`from:${compiledFrom}`, ...entries.map((e) => `${e.name}:${e.mtimeMs}`), ...compiledEntries.map((e) => `c/${e.name}:${e.mtimeMs}`), ...sourceKey].sort().join('|')
  if (rt.prompts && rt.prompts.key === key && !rt.promptsDirty && !opts.force) return rt.prompts
  const diagnostics: Diagnostic[] = []
  const loaded = await readCompiledDir(io, compiledDir, compiledLabel, compiledEntries, diagnostics)
  const compiled = loaded.map((l) => l.prompt)
  // Markdown sources as files; tier variants and parsing are core `assemblePrompts` (same as the CLI).
  const markdown: MarkdownFile[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.md') || /^readme\.md$/i.test(e.name)) continue
    const t = await io.fs.read(`${absDir}/${e.name}`).catch(() => undefined)
    if (typeof t === 'string') markdown.push({ path: `${dir}/${e.name}`, text: t })
  }
  markdown.sort((x, y) => x.path.localeCompare(y.path))
  diagnostics.push(...assemblePrompts([], markdown, '', Object.keys(rt.cfg.tiers ?? {})).diagnostics)
  // Staleness per entry: missing compiled, or any source newer than the compiled JSON.
  const stale = new Set<string>()
  const byEntry = new Map<string, { prompt: CompiledPrompt; mtimeMs: number }>()
  for (const l of loaded) {
    const entry = l.prompt.sources?.[0]?.path
    if (entry) byEntry.set(entry, l)
  }
  const sources = new Set<string>()
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.prompt.tsx')) continue
    const rel = `${dir}/${e.name}`
    const id = e.name.replace(/\.prompt\.tsx$/, '')
    const l = byEntry.get(rel) ?? loaded.find((x) => x.prompt.id === id && !x.prompt.sources?.length)
    if (!l) { stale.add(rel); continue }
    if (e.mtimeMs > l.mtimeMs) { stale.add(rel); continue }
  }
  for (const [entry, l] of byEntry) {
    for (const s of l.prompt.sources ?? []) {
      sources.add(s.path)
      if (stale.has(entry)) continue
      const m = s.path.startsWith(`${dir}/`) && !s.path.slice(dir.length + 1).includes('/') ? entries.find((e) => e.name === s.path.slice(dir.length + 1))?.mtimeMs : await mtimeOf(io, rt, s.path, lists)
      // A source gone missing also needs a rebuild (the build reports it).
      if (m === undefined ? s.path !== entry : m > l.mtimeMs) stale.add(entry)
    }
  }
  const watch = [absDir, `${absDir}/.compiled`, ...entries.filter((e) => e.kind === 'file').map((e) => `${absDir}/${e.name}`), ...[...sources].filter((p) => insideRoot(p)).map((p) => join(rt.root, p))]
  rt.prompts = { key, compiled, markdown, stale: [...stale].sort(), diagnostics, watch: [...new Set(watch)], sources: [...sources].sort(), compiledFrom }
  rt.promptsDirty = false
  return rt.prompts
}

/** prompt.context (after compaction, /clear): the same stat check as prompt.compose; a stale build starts in the background. */
export async function dslContextBefore(io: Io, rt: Runtime): Promise<void> {
  try {
    rt.promptsDirty = true
    const set = await loadPrompts(io, rt)
    if (set.stale.length && rt.interactive && rt.cfg.prompt?.build !== 'never' && (await trustState(io, rt)) === 'trusted') {
      void buildPrompts(io, rt, { timeoutMs: FULL_BUILD_MS }).catch(() => undefined)
    }
  } catch (err) {
    debug(io, `prompt.context: ${String((err as Error)?.message ?? err)}`)
  }
}

// ───────────────────────── build ─────────────────────────

export async function buildPrompts(io: Io, rt: Runtime, opts: { only?: string; timeoutMs: number; ask?: boolean }): Promise<{ ok: boolean; message: string }> {
  if (rt.cfg.prompt?.build === 'never') return { ok: false, message: 'prompt.build: never — збірку вимкнено в gate.json' }
  const trust = opts.ask ? await ensureTrust(io, rt, { ask: true }) : await trustState(io, rt)
  if (trust !== 'trusted') return { ok: false, message: 'Репозиторій не довірений: збірку промптів пропущено (довіра — запит при першому промпті, скасування /gate trust revoke)' }
  const cli = join(io.plugin.root, 'dist/cli.js')
  if (!(await io.fs.exists(cli).catch(() => false))) return { ok: false, message: `Немає ${cli}: виконай npm run build у теці плагіна` }
  if (rt.building) return { ok: false, message: 'Збірка вже йде' }
  rt.building = true
  try {
    const argv = ['node', cli, 'build', ...(opts.only ? ['--only', opts.only] : [])]
    const r = await runArgv(io, rt, argv, { timeoutMs: opts.timeoutMs })
    rt.promptsDirty = true
    if (r.exitCode === 0) {
      const hadError = !!rt.buildError
      rt.buildError = undefined
      if (hadError) await refreshStatus(io, rt)
      await journal(io, rt, { kind: 'debug', trigger: 'build', data: { only: opts.only ?? null, ms: r.ms } })
      return { ok: true, message: `Збірка промптів: ok (${r.ms} мс)` }
    }
    const lines = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3)
    await journal(io, rt, { kind: 'health', trigger: 'H013', data: { only: opts.only ?? null, exitCode: r.exitCode } })
    const message = `Збірка промптів не вдалася (H013, exit ${r.exitCode}), лишаю попередній .compiled${lines.length ? `:\n${lines.join('\n')}` : ''}${r.exitCode === -1 ? '\nПідказка: перевір, що node є в PATH' : ''}`
    // The status line shows `prompt ⚠ build` until a good build (ui.ts `buildErrorOf`); the first G* code wins over H013.
    const code = /\b(G\d{3})\b/.exec(lines.join('\n'))?.[1] ?? 'H013'
    rt.buildError = { code, message: lines[0] ?? `exit ${r.exitCode}`, at: now() }
    await refreshStatus(io, rt)
    try { io.ui.toast(message.split('\n').slice(0, 4).join('\n'), { timeoutMs: 10000 }) } catch { /* no surface */ }
    return { ok: false, message }
  } finally {
    rt.building = false
  }
}

/** Background build on session start / after trust: once, all stale files. */
export async function buildStale(io: Io, rt: Runtime): Promise<void> {
  if (!rt.interactive) return
  const set = await loadPrompts(io, rt)
  if (!set.stale.length) return
  await buildPrompts(io, rt, { timeoutMs: FULL_BUILD_MS })
}

// ───────────────────────── scope ─────────────────────────

/** The render scope: core `buildScope` (the CLI's too) over the session's gate, rules, ctx, data and providers. */
export async function buildScope(io: Io, rt: Runtime, host: RenderHostExt, model: string | undefined): Promise<{ scope: Scope_; tier: string; dataKey: string }> {
  const stateGate = await io.read('gate')
  const tier = model ? tierForModel(rt.cfg, model).tier : stateGate?.tier ?? (await io.read('tier')) ?? 'standard'
  const pct = await io.read('ctxPercent')
  const fired = await io.read('budgetsFired')
  const owned = budgetSections(rt)
  const active = [...owned].filter(([, k]) => fired.includes(k)).map(([id]) => id)
  const repo = await io.session.repo().catch(() => null)
  const rules = await ensureRules(io, rt)
  const key = await repoKey(io, rt)
  const dataKey = `data:${key}`
  const stored = ((await io.store.get(dataKey).catch(() => undefined)) ?? {}) as Record<string, Value>
  const data = materializeData(stored, now()).data
  const branch = await readBranch(io, rt)
  const gate: Gate = stateGate ? { ...(stateGate as unknown as Gate), tier } : defaultGate(tier)
  const providers = await providerData(io, rt, host)
  const scope = coreBuildScope({
    config: rt.cfg,
    gate,
    git: { branch: branch ?? '' },
    rules,
    session: { model: model ?? (await io.read('model')) ?? '', root: rt.root, interactive: rt.interactive },
    ...(pct !== null && pct !== undefined ? { ctxPercent: pct } : {}),
    data: data as Value,
    budgetsFired: fired,
    budgetsActive: active,
    providers: { ...providers, tier, repo: { name: repo?.name ?? null, root: rt.root }, env: await ensureEnv(io, rt) },
  }) as Scope_
  return { scope, tier, dataKey }
}

async function itemBodyOf(io: Io, rt: Runtime, kind: 'skill' | 'rule', name: string): Promise<{ description?: string; body?: string; path?: string } | undefined> {
  if (kind === 'rule') {
    const r = (await ensureRules(io, rt)).find((x) => x.id === name)
    return r ? { body: r.body, path: r.path, ...(r.description ? { description: r.description } : {}) } : undefined
  }
  if (!/^[\w.:@-]+$/.test(name)) return undefined
  const rel = `.claude/skills/${name.replace(/^[^:]+:/, '')}/SKILL.md`
  const t = await io.fs.read(join(rt.root, rel)).catch(() => undefined)
  if (typeof t !== 'string') return undefined
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t.replace(/\r\n?/g, '\n'))
  const desc = m ? /^description:\s*(.+)$/m.exec(m[1])?.[1]?.replace(/^["']|["']$/g, '') : undefined
  return { body: (m ? t.slice(m[0].length) : t).trim(), path: rel, ...(desc ? { description: desc } : {}) }
}

export async function hostFor(io: Io, rt: Runtime): Promise<ModHost> {
  const trusted = (await trustState(io, rt)) === 'trusted'
  const dir = promptDir(rt)
  return makeRenderHost(io, rt, { trusted, repoKey: await repoKey(io, rt), itemBody: (kind, name) => itemBodyOf(io, rt, kind, name), rules: () => ensureRules(io, rt), promptDir: dir, providers: await providerConfigs(io, rt, dir) })
}

/** `data.*` keys a render may write as files (CLI `validDataKey`). */
const DATA_KEY = /^[\w][\w.-]{0,127}$/

/** `store=` values: always to `$.store` (`data:<repo>`); with gate.json `prompt.persist` also `<prompt dir>/data/<key>.json`, as the CLI. */
async function persistData(io: Io, rt: Runtime, dataKey: string, res: RenderResultExt): Promise<void> {
  if (!Object.keys(res.storedEntries ?? {}).length) return
  const prev = ((await io.store.get(dataKey).catch(() => undefined)) ?? {}) as Record<string, Value>
  await io.store.set(dataKey, { ...prev, ...res.storedEntries }).catch(() => undefined)
  if (!rt.cfg.prompt?.persist) return
  for (const [k, v] of Object.entries(res.stored ?? {})) {
    if (!DATA_KEY.test(k) || k.includes('..')) continue
    await io.fs.write(join(rt.root, `${promptDir(rt)}/data/${k}.json`), JSON.stringify(v, null, 2) + '\n').catch((err: unknown) => debug(io, `data ${k}: ${String(err)}`))
  }
}

// ───────────────────────── compose ─────────────────────────

/** Sections to render: core `assemblePrompts` (compiled system prompts, then Markdown resolved for the tier; skills apart). */
export function sectionsFor(rt: Runtime, set: PromptSet, tier: string): AssembledSet {
  return assemblePrompts(set.compiled, set.markdown, tier, Object.keys(rt.cfg.tiers ?? {}))
}

/** Render options shared with `context-gate run` (`renderWith`), plus the mod's 2 s script budget. */
export function renderOptions(rt: Runtime, tier: string): RenderOptionsExt {
  return { tier, runBudgetMs: 2000, ...(rt.cfg.prompt?.runCacheDefault ? { runCacheDefault: rt.cfg.prompt.runCacheDefault } : {}), ...(rt.cfg.debug ? { debug: true } : {}), ...(rt.cfg.assertFail ? { assertFail: rt.cfg.assertFail } : {}) }
}

async function preloadSection(io: Io, rt: Runtime): Promise<{ id: string; text: string } | undefined> {
  const gate = await io.read('gate')
  if (!isApplied(gate) || !gate.skills.preload.length) return undefined
  const parts: string[] = []
  for (const name of gate.skills.preload) {
    const it = await itemBodyOf(io, rt, 'skill', name)
    if (it?.body) parts.push(`## ${name}\n\n${it.body}`)
  }
  if (!parts.length) return undefined
  return { id: 'preload', text: `Skills, вбудовані для tier ${gate.tier} (не викликай їх окремо):\n\n${parts.join('\n\n')}` }
}

/** Sync rebuild of stale files when it fits in 2 s; once per source mtime. */
async function syncBuild(io: Io, rt: Runtime, set: PromptSet): Promise<PromptSet> {
  if (!set.stale.length || !rt.interactive || rt.cfg.prompt?.build === 'never') return set
  if ((await trustState(io, rt)) !== 'trusted') return set
  let rebuilt = false
  for (const file of set.stale) {
    const k = `${file}@${set.key}`
    if (rt.buildAttempted.has(k)) continue
    rt.buildAttempted.add(k)
    const r = await buildPrompts(io, rt, { only: file, timeoutMs: SYNC_BUILD_MS })
    if (r.ok) rebuilt = true
  }
  return rebuilt ? loadPrompts(io, rt, { force: true }) : set
}

export async function composeSections(io: Io, rt: Runtime, model: string | undefined): Promise<{ sections: { id: string; text: string; scope: 'session' }[]; result?: RenderResultExt }> {
  let set = await loadPrompts(io, rt)
  set = await syncBuild(io, rt, set)
  const out: { id: string; text: string; scope: 'session' }[] = []
  const preload = await preloadSection(io, rt)
  const hasSections = set.compiled.some((p) => !p.skill && p.sections.length) || set.markdown.length > 0
  if (!hasSections) {
    if (preload) out.push({ id: SECTION_PREFIX + preload.id, text: preload.text, scope: 'session' })
    rt.lastSections = out
    return { sections: out }
  }
  const host = await hostFor(io, rt)
  const { scope, tier, dataKey } = await buildScope(io, rt, host, model)
  const tiered = sectionsFor(rt, set, tier)
  const g158 = await checkExports(io, rt, host, [...tiered.system, ...Object.values(tiered.skills)])
  const res = await renderPrompt(tiered.system, scope, host, renderOptions(rt, tier))
  res.diagnostics.push(...g158)
  await persistData(io, rt, dataKey, res)
  // Budget-owned sections appear only while their threshold is crossed.
  const owned = budgetSections(rt)
  const fired = await io.read('budgetsFired')
  let staticDone = false
  for (const s of res.sections) {
    if (!s.included || !s.text) continue
    const k = owned.get(s.id)
    if (k && !fired.includes(k)) continue
    if (s.scope !== 'static' && !staticDone) {
      staticDone = true
      if (preload) out.push({ id: SECTION_PREFIX + preload.id, text: preload.text, scope: 'session' })
    }
    out.push({ id: SECTION_PREFIX + s.id, text: staticText(rt, s, tier), scope: 'session' })
  }
  if (!staticDone && preload) out.push({ id: SECTION_PREFIX + preload.id, text: preload.text, scope: 'session' })
  await recordHealth(io, rt, res, set)
  await writeSnapshot(io, rt, scope, tier, out)
  await recordDebug(io, rt, res, tier)
  await writeLastTrace(io, rt, res, scope, tier, host.trusted)
  rt.lastSections = out
  return { sections: out, result: res }
}

/**
 * G158 (SPEC «Виклик функцій»): functions the prompts call through `use` that the module does not export. The
 * shim is asked for `__exports__` once per session per module (`host.listExports`); trusted repos only.
 */
async function checkExports(io: Io, rt: Runtime, host: ModHost, prompts: readonly CompiledPrompt[]): Promise<Diagnostic[]> {
  if (!host.trusted) return []
  const out: Diagnostic[] = []
  for (const [path, fns] of usedFunctions(prompts)) {
    if (!fns.size) continue
    const known = rt.moduleExports.has(path)
    const exports = await host.listExports(path)
    if (!exports) continue
    const missing = missingExports(path, fns, exports)
    out.push(...missing)
    if (!known && missing.length) await journal(io, rt, { kind: 'health', trigger: 'G158', data: { path, missing: missing.map((d) => d.message) } })
  }
  return out
}

/**
 * `@debug` / `@log` / `@assert` and D001 never reach the prompt (SPEC «Налагодження»): they go to the session debug
 * log (`$.ui.log`, `to: 'debug'`), the journal (`kind: 'debug'`, `/gate why | where kind=debug`) and, with
 * `debug: true`, `.claude/gate.debug.log` (cut to 1 MB). A batch identical to the previous render's is skipped.
 */
async function recordDebug(io: Io, rt: Runtime, res: RenderResultExt, tier: string): Promise<void> {
  try {
    const entries = res.trace.filter((t) => (t.kind === 'debug' || t.kind === 'log' || t.kind === 'assert') && t.source !== 'build-time')
    const asserts = res.diagnostics.filter((d) => d.code === 'D001')
    if (!entries.length && !asserts.length) { rt.lastDebug = undefined; return }
    const key = hash(stableJson([entries.map((t) => [t.section, t.kind, t.detail]), asserts.map((d) => d.message)]))
    if (rt.lastDebug === key) return
    rt.lastDebug = key
    for (const t of entries) debug(io, `${t.kind} ${t.section}: ${t.detail}`)
    const lines = entries.slice(0, 20).map((t) => ({ section: t.section, kind: t.kind, detail: t.detail.slice(0, 500) }))
    if (lines.length) await journal(io, rt, { kind: 'debug', trigger: 'render', tier, data: { entries: lines, count: entries.length } })
    if (asserts.length) await journal(io, rt, { kind: 'debug', trigger: 'assert', tier, data: { code: 'D001', assertFail: rt.cfg.assertFail ?? 'skip', messages: asserts.slice(0, 10).map((d) => d.message) } })
    if (rt.cfg.debug) await writeDebugLog(io, rt, res, tier)
  } catch (err) {
    debug(io, `debug entries: ${String((err as Error)?.message ?? err)}`)
  }
}

/** `.claude/gate.debug.log` (only with `debug: true`): core `debugLogLines` / `capDebugLog`, as `context-gate run --debug`. */
async function writeDebugLog(io: Io, rt: Runtime, res: RenderResultExt, tier: string): Promise<void> {
  const turn = (await io.read('gateState').catch(() => ({ turn: 0 }))).turn
  const add = debugLogLines(res, now(), { turn, tier })
  if (!add) return
  const rel = rt.cfg.debugLog?.path ?? DEBUG_LOG_FILE
  if (!insideRoot(rel)) return
  const path = join(rt.root, rel)
  if (rt.debugLogText === undefined) {
    const t = await io.fs.read(path).catch(() => '')
    rt.debugLogText = typeof t === 'string' ? t : ''
  }
  rt.debugLogText = capDebugLog(rt.debugLogText, add, rt.cfg.debugLog?.maxBytes ?? DEBUG_LOG_MAX)
  await io.fs.write(path, rt.debugLogText).catch((err: unknown) => debug(io, `debug log: ${String(err)}`))
}

const TRACE_EVERY_MS = 5000

/**
 * `<prompt dir>/.trace/last.json` after prompt.compose (core RunJson, as `context-gate run --json` writes it), for
 * the LSP hover «значення з останнього trace». Throttled: changed content, at most once per 5 s.
 */
async function writeLastTrace(io: Io, rt: Runtime, res: RenderResultExt, scope: Scope_, tier: string, trusted: boolean): Promise<void> {
  try {
    const gate = await io.read('gate')
    const lazies = [...rt.tools.entries()].filter(([, t]) => t.kind === 'lazy').map(([name, t]) => ({ name: name.slice(OWN_TOOL_PREFIX.length), ref: (t as { ref: string }).ref, description: (t as { description: string }).description }))
    const body = { sections: res.sections, text: res.text, trace: res.trace, diagnostics: res.diagnostics, scope }
    const key = hash(stableJson(body))
    const t = now()
    if (rt.traceWrite && (rt.traceWrite.hash === key || t - rt.traceWrite.at < TRACE_EVERY_MS)) return
    rt.traceWrite = { at: t, hash: key }
    const j: RunJson = {
      ...body,
      ms: res.ms,
      ...(rt.lastHealth ? { health: rt.lastHealth } : {}),
      meta: {
        ok: !res.diagnostics.some((d) => d.severity === 'error'),
        mode: 'prompt',
        tier,
        profile: gate?.profile ?? null,
        source: 'live',
        trusted,
        stored: res.stored,
        lazies,
        gate: { profile: gate?.profile ?? null, tier: gate?.tier ?? tier, trigger: gate?.trigger ?? 'default', groups: gate?.groups ?? [], reason: gate?.reason ?? [] },
        at: t,
      },
    }
    await io.fs.write(join(rt.root, `${promptDir(rt)}/.trace/last.json`), JSON.stringify(j, null, 2) + '\n')
  } catch (err) {
    debug(io, `trace: ${String((err as Error)?.message ?? err)}`)
  }
}

/** Session id, model and ctx percent for journal snapshots (`context-gate run --ctx-from session:…`). */
async function snapshotMeta(io: Io, rt: Runtime): Promise<{ sessionId: string; model: string; ctxPercent: number }> {
  const sessionId = await io.session.id().catch(() => '')
  const model = (await io.read('model')) ?? (await io.session.model().catch(() => '')) ?? ''
  return { sessionId, model, ctxPercent: (await io.read('ctxPercent')) ?? 0 }
}

/** With `log.file`: a `snapshot` entry (core contract) per changed compose; file only, never the state ring. */
async function writeSnapshot(io: Io, rt: Runtime, scope: Scope_, tier: string, sections: readonly { text: string }[]): Promise<void> {
  if (!rt.cfg?.log?.file) return
  try {
    const meta = await snapshotMeta(io, rt)
    const gate = await io.read('gate')
    const data = snapshotData({ ...meta, tier, profile: gate?.profile ?? null, scope: scope as Record<string, Value>, text: sections.map((s) => s.text).join('\n\n') })
    const key = hash(stableJson(data))
    if (rt.lastSnapshot === key) return
    rt.lastSnapshot = key
    const turn = (await io.read('gateState')).turn
    await pushFileEntry(io, rt, snapshotEntry(data, { ts: now(), turn }))
  } catch (err) {
    debug(io, `snapshot: ${String((err as Error)?.message ?? err)}`)
  }
}

/** Static sections render once per session per node hash: the first text is kept (prompt cache). */
function staticText(rt: Runtime, s: RenderedSection, tier: string): string {
  if (s.scope !== 'static') return s.text
  const node = rt.prompts ? sectionsFor(rt, rt.prompts, tier).system.flatMap((p) => p.sections).find((x) => x.id === s.id) : undefined
  const key = hash(stableJson(node ?? s.id) + '|' + tier)
  const c = rt.staticCache.get(s.id)
  if (c && c.hash === key) return c.text
  rt.staticCache.set(s.id, { hash: key, text: s.text, chars: s.chars, tokens: s.tokens })
  return s.text
}

async function recordHealth(io: Io, rt: Runtime, res: RenderResultExt, set: PromptSet): Promise<void> {
  try {
    const usage = await io.session.usage().catch(() => undefined)
    const report = computeHealth(res, rt.lastRender, {
      unverified: res.sections.filter((s) => s.included && s.status === 'unverified').length,
      ...(usage?.context.percent !== undefined ? { contextPct: usage.context.percent } : {}),
      ...(rt.listingText ? { skillListingChars: rt.listingText.length } : {}),
      ...(usage?.context.window ? { contextWindow: usage.context.window } : {}),
      denies: rt.denies,
      compiledStale: set.stale,
      gates: gateStats(rt), // H011 (gates.ts)
      ...(rt.stepUsage?.last ? { usage: { inputTokens: rt.stepUsage.last.input, cacheReadTokens: rt.stepUsage.last.cacheRead, cacheCreationTokens: rt.stepUsage.last.cacheCreation, outputTokens: rt.stepUsage.last.output, sessionInputTokens: rt.stepUsage.input + rt.stepUsage.cacheRead + rt.stepUsage.cacheCreation } } : {}), // H002/H012
      ...(typeof usage?.cost?.usd === 'number' ? { costUsd: usage.cost.usd } : {}),
    }, rt.cfg.health ?? {})
    const prevCodes = (rt.lastHealth?.diagnostics ?? []).map((d) => d.code).sort().join()
    rt.lastRender = res
    rt.lastHealth = report
    const sections: Record<string, { hash: string; chars: number; tokens: number; scope: string; status: string; truncated: boolean }> = {}
    for (const s of res.sections) if (s.included) sections[s.id] = { hash: s.hash, chars: s.chars, tokens: s.tokens, scope: s.scope, status: s.status, truncated: !!s.truncated }
    const stable = report.metrics.find((m) => m.code === 'H002')?.value
    await io.update('health', () => json({ at: now(), ms: res.ms, stablePct: typeof stable === 'number' ? stable : 100, unverified: Object.values(sections).filter((s) => s.status === 'unverified').length, sections }))
    const codes = report.diagnostics.map((d) => d.code).sort().join()
    if (codes && codes !== prevCodes) await journal(io, rt, { kind: 'health', trigger: 'health', data: { codes: report.diagnostics.map((d) => d.code) } })
    await refreshStatus(io, rt)
  } catch (err) {
    debug(io, `health: ${String((err as Error)?.message ?? err)}`)
  }
}

// ───────────────────────── prompt skills & our tools ─────────────────────────

export function findPromptSkill(rt: Runtime, name: string): CompiledPrompt | undefined {
  const bare = name.replace(/^[^:]+:/, '')
  return rt.prompts?.compiled.find((p) => p.skill && (p.skill.name === name || p.skill.name === bare))
}

/** Raw args from the SKILL.md render line: `--args "…"` (the fallback when no tool.call/command.run carried them). */
export function argsFromText(text: string): string | undefined {
  const m = /--args\s+"((?:[^"\\]|\\.)*)"/.exec(text)
  return m ? m[1].replace(/\\(.)/g, '$1') : undefined
}

/**
 * Core `skillArgs` with `path` args checked against the repo (SPEC: «`path` (перевіряється існування відносно
 * кореня)»). The parser's check is synchronous, so the path values of a first parse are stat'ed, then it parses again.
 */
export async function parseSkillArgs(io: Io, rt: Runtime, prompt: CompiledPrompt, input: string | Record<string, unknown>): Promise<ReturnType<typeof skillArgs>> {
  await ensureSession(io, rt)
  const first = skillArgs(prompt, input)
  if (!first.ok) return first
  const paths = Object.entries(prompt.skill!.args).filter(([, a]) => a.type === 'path').map(([k]) => first.args[k]).filter((v): v is string => typeof v === 'string' && v !== '')
  if (!paths.length) return first
  const existing = new Set<string>()
  for (const p of paths) if (insideRoot(p) && (await io.fs.exists(join(rt.root, p)).catch(() => false))) existing.add(p)
  return skillArgs(prompt, input, (p) => existing.has(p))
}

export async function renderSkill(io: Io, rt: Runtime, prompt: CompiledPrompt, input: string | Record<string, unknown>): Promise<string> {
  const skill = prompt.skill!
  const parsed = await parseSkillArgs(io, rt, prompt, input)
  if (!parsed.ok) return parsed.text
  const host = await hostFor(io, rt)
  const { scope, tier } = await buildScope(io, rt, host, undefined)
  scope.args = parsed.args
  // `tiers={[…]}` on `<Prompt as="skill">` limits the skill like a section's `tier` (as `context-gate run <skill>`).
  const section: SectionNode = { id: skill.name, scope: 'volatile', children: skill.body, ...(skill.tiers ? { tier: skill.tiers } : {}) }
  const res = await renderPrompt([section], scope, host, { ...renderOptions(rt, tier), uses: prompt.uses ?? {} })
  const s = res.sections[0]
  await journal(io, rt, { kind: 'skill-render', trigger: 'skill', tier, data: { ...(await snapshotMeta(io, rt)), skill: skill.name, args: parsed.args, ms: res.ms, chars: s?.chars ?? 0, status: s?.status ?? 'fail' } })
  if (!s || !s.included) return `Skill ${skill.name}: ${s?.reason ?? 'не відрендерено'}${res.diagnostics.length ? ` (${res.diagnostics.slice(0, 3).map((d) => `${d.code} ${d.message}`).join('; ')})` : ''}`
  return s.text
}

const toolName = (s: string): string => s.replace(/[^\w-]/g, '_')

/** `invoke.model: 'tool'` skills become tools with a schema from their args. */
export async function registerSkillTools(io: Io, rt: Runtime): Promise<void> {
  const set = await loadPrompts(io, rt)
  for (const p of set.compiled) {
    if (!p.skill || p.skill.invoke.model !== 'tool') continue
    const name = toolName(p.skill.name)
    const full = OWN_TOOL_PREFIX + name
    const known = rt.tools.get(full)
    if (known?.kind === 'skill' && known.prompt.sourceHash === p.sourceHash) { rt.tools.set(full, { kind: 'skill', prompt: p }); continue }
    rt.tools.set(full, { kind: 'skill', prompt: p })
    await io.tool.register({ name, description: p.skill.description, inputSchema: argsToJsonSchema(p.skill.args) }).catch((err: unknown) => debug(io, `tool ${name}: ${String(err)}`))
  }
}

/** `# gate-tool: name` headers in `<dir>/scripts/*` (trusted repos only): core `parseToolHeader`, as the CLI. */
export function parseScriptHeader(text: string, path: string): ScriptTool | undefined {
  const { header } = parseToolHeader(text)
  if (!header) return undefined
  return { name: header.name, description: header.description ?? header.name, path, inputSchema: header.inputSchema, ...(header.tiers ? { tiers: header.tiers } : {}) }
}

export async function registerScriptTools(io: Io, rt: Runtime): Promise<void> {
  if ((await trustState(io, rt)) !== 'trusted') return
  const dir = `${promptDir(rt)}/scripts`
  const entries = await io.fs.list(join(rt.root, dir)).catch(() => [])
  for (const e of entries) {
    if (e.kind !== 'file') continue
    const rel = `${dir}/${e.name}`
    const t = await io.fs.read(join(rt.root, rel)).catch(() => undefined)
    if (typeof t !== 'string') continue
    const tool = parseScriptHeader(t, rel)
    if (tool) await registerOwnScriptTool(io, rt, tool)
  }
  await registerFunctionTools(io, rt)
}

async function registerOwnScriptTool(io: Io, rt: Runtime, tool: ScriptTool): Promise<void> {
  const full = OWN_TOOL_PREFIX + tool.name
  if (rt.tools.has(full)) return
  rt.tools.set(full, { kind: 'script', tool })
  await io.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).catch((err: unknown) => debug(io, `script tool ${tool.name}: ${String(err)}`))
}

/** Modules whose exports may be tools: `<prompt dir>/lib/*`, gate.json `module` providers, and `use` paths of the prompts. */
async function toolModules(io: Io, rt: Runtime): Promise<string[]> {
  const dir = promptDir(rt)
  const out = new Set<string>()
  for (const e of await io.fs.list(join(rt.root, `${dir}/lib`)).catch(() => [])) if (e.kind === 'file' && shimLang(e.name)) out.add(`${dir}/lib/${e.name}`)
  for (const p of Object.values(rt.cfg.providers ?? {})) if (p.kind === 'module' && p.path) out.add(p.path.replace(/^\.\//, ''))
  const set = rt.prompts
  if (set) for (const path of usedFunctions([...set.compiled, ...sectionsFor(rt, set, 'standard').system]).keys()) out.add(path.replace(/^\.\//, ''))
  return [...out].filter((p) => insideRoot(p)).sort()
}

/**
 * SPEC «Функції як інструменти моделі»: `# gate-tool: next_version` (or `// gate-tool:`) over an export of a module
 * makes that function a model tool too, served through the language shim with the tool input as kwargs.
 */
export async function registerFunctionTools(io: Io, rt: Runtime): Promise<void> {
  for (const path of await toolModules(io, rt)) {
    const t = await io.fs.read(join(rt.root, path)).catch(() => undefined)
    if (typeof t !== 'string' || !t.includes('gate-tool')) continue
    for (const h of parseToolHeaders(t).headers) {
      await registerOwnScriptTool(io, rt, { name: h.name, description: h.description ?? h.name, path, inputSchema: h.inputSchema, fn: h.name, ...(h.tiers ? { tiers: h.tiers } : {}) })
    }
  }
}

async function scriptToolArgv(io: Io, rt: Runtime, rel: string): Promise<string[]> {
  const t = await io.fs.read(join(rt.root, rel)).catch(() => '')
  return scriptArgv(join(rt.root, rel), scriptLang(rel, typeof t === 'string' ? t : '') ?? 'bash')
}

async function lazyText(io: Io, rt: Runtime, ref: string): Promise<string> {
  if (ref.startsWith('prompt://')) {
    const id = ref.slice('prompt://'.length)
    const set = await loadPrompts(io, rt)
    const host = await hostFor(io, rt)
    const { scope, tier } = await buildScope(io, rt, host, undefined)
    const res = await renderPrompt(sectionsFor(rt, set, tier).system, scope, host, { ...renderOptions(rt, tier), only: id })
    return res.sections.find((s) => s.id === id)?.text || `Секцію ${id} не знайдено`
  }
  const m = /^(skill|rule):(.+)$/.exec(ref)
  if (m) return (await itemBodyOf(io, rt, m[1] as 'skill' | 'rule', m[2]))?.body ?? `${ref} не знайдено`
  if (ref.startsWith('text:')) return 'Текст цього включення доступний лише в рендері секції.'
  if (!insideRoot(ref)) return `${ref}: шлях поза репозиторієм`
  const t = await io.fs.read(join(rt.root, ref)).catch(() => undefined)
  return typeof t === 'string' ? t : `${ref} не знайдено`
}

function toolArgs(e: Record<string, unknown>): Record<string, unknown> {
  const { tool: _t, tool_use_id: _id, agentId: _a, ...rest } = e
  return rest
}

type ComposeSection = { id: string; text: string; scope: 'shared' | 'session' }

/** prompt.compose, after `next`: our sections (session scope) appended; a same-id engine `session` section is replaced. */
export async function composeAfter(io: Io, rt: Runtime, e: { model: string; traits: readonly string[] }, engine: readonly ComposeSection[]): Promise<ComposeSection[] | undefined> {
  if (e.traits.includes('bare')) return undefined
  await ensureSession(io, rt)
  const ours = e.traits.includes('analysis') ? (rt.lastSections ?? []) : (await composeSections(io, rt, e.model)).sections
  if (!ours.length) return undefined
  const sections = [...engine]
  const rest: ComposeSection[] = []
  for (const s of ours) {
    const bare = s.id.slice(SECTION_PREFIX.length)
    const i = sections.findIndex((x) => x.id === bare && x.scope === 'session')
    if (i >= 0) sections[i] = { ...sections[i], text: s.text }
    else rest.push(s)
  }
  return [...sections, ...rest]
}

/** command.run for a prompt skill typed as `/name args`: keep the args for skill.prompt. */
export function captureSkillArgs(rt: Runtime, command: string, args: string): void {
  if (command !== 'gate' && command !== 'rule' && findPromptSkill(rt, command)) rt.skillArgs.set(command, args)
}

/** skill.prompt: off text for a gated-off skill; our prompt skill rendered with parsed args; else undefined. */
export async function skillPrompt(io: Io, rt: Runtime, skill: string, text: string): Promise<string | undefined> {
  await ensureSession(io, rt)
  const off = await skillOffMessage(io, rt, skill)
  if (off) return off
  await loadPrompts(io, rt)
  const prompt = findPromptSkill(rt, skill)
  if (!prompt) return undefined
  const args = rt.skillArgs.get(skill) ?? argsFromText(text) ?? ''
  rt.skillArgs.delete(skill)
  return renderSkill(io, rt, prompt, args)
}

type OwnToolResult = { result: string } | { deny: string } | { isError: true; result: string }

/** Serve `mcp__context-gate__*`: prompt-skill tools, lazy includes, script tools. undefined → not ours. */
export async function serveOwnTool(io: Io, rt: Runtime, e: { tool: string } & Record<string, unknown>): Promise<OwnToolResult | undefined> {
    await ensureSession(io, rt)
    let entry = rt.tools.get(e.tool)
    if (!entry) {
      await registerSkillTools(io, rt)
      await registerScriptTools(io, rt)
      entry = rt.tools.get(e.tool)
    }
    if (!entry) return undefined
    const args = toolArgs(e)
    if (entry.kind === 'skill') return { result: await renderSkill(io, rt, entry.prompt, args) }
    if (entry.kind === 'lazy') {
      // SPEC «Включення»: the journal shows which section the model asked for, and how many times.
      const count = (rt.lazyCalls.get(entry.ref) ?? 0) + 1
      rt.lazyCalls.set(entry.ref, count)
      await journal(io, rt, { kind: 'debug', trigger: 'lazy', data: { ref: entry.ref, tool: e.tool.slice(OWN_TOOL_PREFIX.length), count } })
      return { result: await lazyText(io, rt, entry.ref) }
    }
    const tool = entry.tool
    const gate = await io.read('gate')
    const tier = gate?.tier ?? (await io.read('tier')) ?? 'standard'
    // `kind: tool` items obey groups and profiles like MCP tools (SPEC «Скрипти як інструменти моделі»).
    if (rt.config && isApplied(gate) && (gate.items[`tool:${tool.name}`] === 'off' || gate.items[`tool:${e.tool}`] === 'off')) {
      rt.denies[e.tool] = (rt.denies[e.tool] ?? 0) + 1
      await journal(io, rt, { kind: 'deny', trigger: 'script-tool', tier, data: { tool: tool.name, count: rt.denies[e.tool] } })
      return { deny: denyText('tool', tool.name, gate as unknown as Gate, rt.config) }
    }
    if (tool.tiers && !tool.tiers.includes(tier)) return { deny: `Інструмент ${tool.name} недоступний для tier ${tier} (tiers: ${tool.tiers.join(', ')})` }
    if ((await trustState(io, rt)) !== 'trusted') return { deny: `Інструмент ${tool.name}: репозиторій не довірений` }
    if (tool.fn) {
      const host = await hostFor(io, rt)
      const t0 = now()
      const r = await host.shim(tool.path, [{ fn: tool.fn, args: [], kwargs: args as Record<string, Value> }], 30_000)
      await journal(io, rt, { kind: 'debug', trigger: 'function-tool', tier, data: { tool: tool.name, path: tool.path, ok: !r.errors[0], ms: now() - t0 } })
      if (r.errors[0]) return { isError: true, result: r.errors[0] }
      const v = r.results[0]
      return { result: typeof v === 'string' ? v : JSON.stringify(v ?? null) }
    }
    const argv = await scriptToolArgv(io, rt, tool.path)
    if (!(await allowedBinary(io, rt, argv))) return { deny: `Інструмент ${tool.name}: ${argv[0]} не в білому списку бінарників або allowScripts вимкнено` }
    const r = await runArgv(io, rt, argv, { stdin: JSON.stringify({ args, ctx: { tier, profile: gate?.profile ?? null } }), timeoutMs: 30_000 })
    await journal(io, rt, { kind: 'debug', trigger: 'script-tool', tier, data: { tool: tool.name, exitCode: r.exitCode, ms: r.ms } })
    if (r.exitCode !== 0) return { isError: true, result: `exit ${r.exitCode}\n${r.stderr.slice(-2000)}` }
    return { result: r.stdout }
}

/** First prompt: ask trust once (Р2) when repo config holds something runnable; then build / register tools. */
export async function trustOnPrompt(io: Io, rt: Runtime, text: string): Promise<void> {
  if (rt.trustAsked || rt.options.trustBuild !== 'ask' || !rt.interactive || text.trimStart().startsWith('/')) return
  if ((await trustState(io, rt)) !== 'unknown') return
  const set = await loadPrompts(io, rt)
  const scripts = await io.fs.exists(join(rt.root, `${promptDir(rt)}/scripts`)).catch(() => false)
  const hasRunnable = set.stale.length > 0 || set.compiled.length > 0 || set.markdown.length > 0
  if (!needsTrust(rt.config, hasRunnable, scripts)) return
  const d = await ensureTrust(io, rt, { ask: true })
  if (d === 'trusted') {
    await registerScriptTools(io, rt)
    void buildStale(io, rt).catch(() => undefined)
  }
}

/** What a changed path means for layer 3 (`classic.FileChanged`): pure, so the routing is testable. */
export type DslChange =
  | { kind: 'none' }
  | { kind: 'config' }
  | { kind: 'compiled' }
  | { kind: 'entry'; rel: string }
  | { kind: 'import'; rel: string; entries: string[] }
  | { kind: 'scripts'; rel: string }
  | { kind: 'module'; rel: string }
  | { kind: 'other'; rel: string }

export function classifyChange(rt: Runtime, path: string): DslChange {
  if (!rt.root) return { kind: 'none' }
  const root = rt.root.replace(/[\\/]+$/, '')
  const norm = path.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/')
  if (!norm.startsWith(r + '/')) return { kind: 'none' }
  const rel = norm.slice(r.length + 1)
  if (rel === '.claude/gate.json') return { kind: 'config' }
  const dir = promptDir(rt)
  // Sources outside the prompt dir count when a compiled prompt imports them.
  const importers = (rt.prompts?.compiled ?? []).filter((cp) => (cp.sources ?? []).slice(1).some((s) => s.path === rel)).map((cp) => cp.sources[0].path)
  if (!rel.startsWith(dir + '/')) return importers.length ? { kind: 'import', rel, entries: importers } : { kind: 'none' }
  const inner = rel.slice(dir.length + 1)
  if (inner.startsWith('.compiled/')) return { kind: 'compiled' }
  if (inner.startsWith('.trace/') || inner.startsWith('data/') || inner.startsWith('proposals/') || inner.startsWith('.types/')) return { kind: 'none' }
  if (inner.startsWith('scripts/')) return { kind: 'scripts', rel }
  if (inner.startsWith('lib/')) return { kind: 'module', rel }
  if (/\.prompt\.tsx$/.test(rel) && !inner.includes('/')) return { kind: 'entry', rel }
  if (importers.length) return { kind: 'import', rel, entries: importers }
  return { kind: 'other', rel }
}

/**
 * classic.FileChanged (SPEC "Життєвий цикл"): `.prompt.tsx` → build that file; an imported source (`shared/*.tsx`,
 * `.md`, `.json`) → build its importers; `gate.json` (ctx types, `when`) → build everything; `scripts/**` and
 * `lib/**` → re-read tool headers and exports. All in the background, picked up by the next prompt.compose.
 */
export async function dslFileChanged(io: Io, rt: Runtime, path: string): Promise<void> {
  const c = classifyChange(rt, path)
  if (c.kind === 'none') return
  rt.promptsDirty = true
  if (c.kind === 'compiled' || c.kind === 'other') return
  const trusted = rt.interactive && (await trustState(io, rt)) === 'trusted'
  if (c.kind === 'scripts' || c.kind === 'module') {
    for (const [name, t] of [...rt.tools]) if (t.kind === 'script' && t.tool.path === c.rel) rt.tools.delete(name)
    rt.moduleExports.delete(c.rel)
    if (trusted) await registerScriptTools(io, rt).catch(() => undefined)
    return
  }
  if (!trusted || rt.cfg.prompt?.build === 'never') return
  if (c.kind === 'entry') void buildPrompts(io, rt, { only: c.rel, timeoutMs: FULL_BUILD_MS }).catch(() => undefined)
  else if (c.kind === 'import') void (async () => { for (const entry of c.entries) await buildPrompts(io, rt, { only: entry, timeoutMs: FULL_BUILD_MS }) })().catch(() => undefined)
  else if (c.kind === 'config') {
    rt.whitelist = undefined
    if ((await loadPrompts(io, rt).catch(() => undefined))?.compiled.length) void buildPrompts(io, rt, { timeoutMs: FULL_BUILD_MS }).catch(() => undefined)
  }
}
