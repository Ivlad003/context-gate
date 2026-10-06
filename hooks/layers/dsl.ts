// Layer 3: the prompt DSL (SPEC "Шар 3", "Збірка через mod", "Промпти як skills", "Шар 3а").
// prompt.compose reads `.claude/prompt/.compiled/*.json` and Markdown sections (`<dir>/*.md`, tier variant
// files `<id>.<tier>.md`), renders them with core renderPrompt over a RenderHost built from $, and adds them
// as `session` sections `context-gate:<id>` ordered static → profile → volatile. Stale `.compiled` →
// `node <plugin>/dist/cli.js build --only <file>` when trusted (2 s in compose, else previous + H013).
// Prompt skills render at invocation (skill.prompt, or as tools for `invoke.model: 'tool'`).


import type { CompiledPrompt, Diagnostic, Gate, RenderedSection, Scope_, SectionNode, Value } from '../../packages/core/src/types.ts'
import { renderPrompt, materializeData } from '../../packages/core/src/render.ts'
import type { RenderHostExt, RenderOptionsExt, RenderResultExt } from '../../packages/core/src/render.ts'
import { argsToJsonSchema } from '../../packages/core/src/argparse.ts'
import { tierForModel } from '../../packages/core/src/config.ts'
import { assemblePrompts, buildScope as coreBuildScope, defaultGate, skillArgs, type MarkdownFile, type PromptSet as AssembledSet } from '../../packages/core/src/assemble.ts'
import { parseToolHeader } from '../../packages/core/src/toolheader.ts'
import { computeHealth } from '../../packages/core/src/health.ts'
import { isApplied, json } from '../state.ts'
import { type Io, OWN_TOOL_PREFIX, type PromptSet, type Runtime, type ScriptTool, debug, hash, insideRoot, join, now, stableJson } from '../ctx.ts'
import { ensureSession } from './config.ts'
import { ensureRules } from './cursor-rules.ts'
import { journal, pushFileEntry } from './journal.ts'
import { snapshotData, snapshotEntry } from '../../packages/core/src/journal.ts'
import { allowedBinary, makeRenderHost, providerData, runArgv } from './host.ts'
import { ensureTrust, needsTrust, repoKey, trustState } from './trust.ts'
import { budgetSections } from './budgets.ts'
import { readBranch, skillOffMessage } from './skill-gate.ts'
import { refreshStatus } from './ui.ts'

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

export async function loadPrompts(io: Io, rt: Runtime, opts: { force?: boolean } = {}): Promise<PromptSet> {
  await ensureSession(io, rt)
  const dir = promptDir(rt)
  const absDir = join(rt.root, dir)
  const entries = await io.fs.list(absDir).catch(() => [])
  const compiledEntries = await io.fs.list(`${absDir}/.compiled`).catch(() => [])
  const key = [...entries.map((e) => `${e.name}:${e.mtimeMs}`), ...compiledEntries.map((e) => `c/${e.name}:${e.mtimeMs}`)].sort().join('|')
  if (rt.prompts && rt.prompts.key === key && !rt.promptsDirty && !opts.force) return rt.prompts
  const diagnostics: Diagnostic[] = []
  const compiled: CompiledPrompt[] = []
  const compiledMtime = new Map<string, number>()
  for (const e of compiledEntries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
    const t = await io.fs.read(`${absDir}/.compiled/${e.name}`).catch(() => undefined)
    if (typeof t !== 'string') continue
    try {
      const v = JSON.parse(t) as unknown
      if (isCompiledPrompt(v)) {
        compiled.push(v)
        compiledMtime.set(v.id, e.mtimeMs)
        for (const s of v.sources ?? []) compiledMtime.set(s.path, Math.min(compiledMtime.get(s.path) ?? Infinity, e.mtimeMs))
      } else diagnostics.push({ code: 'G001', severity: 'warning', message: `${dir}/.compiled/${e.name}: не CompiledPrompt v1`, path: `${dir}/.compiled/${e.name}` })
    } catch (err) {
      diagnostics.push({ code: 'G001', severity: 'warning', message: `${dir}/.compiled/${e.name}: ${String((err as Error).message)}`, path: `${dir}/.compiled/${e.name}` })
    }
  }
  // Markdown sources as files; tier variants and parsing are core `assemblePrompts` (same as the CLI).
  const markdown: MarkdownFile[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.md') || /^readme\.md$/i.test(e.name)) continue
    const t = await io.fs.read(`${absDir}/${e.name}`).catch(() => undefined)
    if (typeof t === 'string') markdown.push({ path: `${dir}/${e.name}`, text: t })
  }
  markdown.sort((x, y) => x.path.localeCompare(y.path))
  diagnostics.push(...assemblePrompts([], markdown, '', Object.keys(rt.cfg.tiers ?? {})).diagnostics)
  // Staleness: a `.prompt.tsx` newer than its `.compiled` (or without one).
  const stale: string[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.prompt.tsx')) continue
    const rel = `${dir}/${e.name}`
    const id = e.name.replace(/\.prompt\.tsx$/, '')
    const cm = compiledMtime.get(rel) ?? compiledMtime.get(id)
    if (cm === undefined || cm < e.mtimeMs) stale.push(rel)
  }
  const watch = [absDir, `${absDir}/.compiled`, ...entries.filter((e) => e.kind === 'file').map((e) => `${absDir}/${e.name}`)]
  rt.prompts = { key, compiled, markdown, stale, diagnostics, watch }
  rt.promptsDirty = false
  return rt.prompts
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
      await journal(io, rt, { kind: 'debug', trigger: 'build', data: { only: opts.only ?? null, ms: r.ms } })
      return { ok: true, message: `Збірка промптів: ok (${r.ms} мс)` }
    }
    const lines = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3)
    await journal(io, rt, { kind: 'health', trigger: 'H013', data: { only: opts.only ?? null, exitCode: r.exitCode } })
    const message = `Збірка промптів не вдалася (H013, exit ${r.exitCode}), лишаю попередній .compiled${lines.length ? `:\n${lines.join('\n')}` : ''}${r.exitCode === -1 ? '\nПідказка: перевір, що node є в PATH' : ''}`
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
    providers: { ...providers, tier, repo: { name: repo?.name ?? null, root: rt.root } },
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

export async function hostFor(io: Io, rt: Runtime): Promise<RenderHostExt> {
  const trusted = (await trustState(io, rt)) === 'trusted'
  return makeRenderHost(io, rt, { trusted, repoKey: await repoKey(io, rt), itemBody: (kind, name) => itemBodyOf(io, rt, kind, name), rules: () => ensureRules(io, rt) })
}

async function persistData(io: Io, dataKey: string, res: RenderResultExt): Promise<void> {
  if (!Object.keys(res.storedEntries ?? {}).length) return
  const prev = ((await io.store.get(dataKey).catch(() => undefined)) ?? {}) as Record<string, Value>
  await io.store.set(dataKey, { ...prev, ...res.storedEntries }).catch(() => undefined)
}

// ───────────────────────── compose ─────────────────────────

/** Sections to render: core `assemblePrompts` (compiled system prompts, then Markdown resolved for the tier; skills apart). */
export function sectionsFor(rt: Runtime, set: PromptSet, tier: string): AssembledSet {
  return assemblePrompts(set.compiled, set.markdown, tier, Object.keys(rt.cfg.tiers ?? {}))
}

/** Render options shared with `context-gate run` (`renderWith`), plus the mod's 2 s script budget. */
export function renderOptions(rt: Runtime, tier: string): RenderOptionsExt {
  return { tier, runBudgetMs: 2000, ...(rt.cfg.prompt?.runCacheDefault ? { runCacheDefault: rt.cfg.prompt.runCacheDefault } : {}), ...(rt.cfg.debug ? { debug: true } : {}) }
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
  const res = await renderPrompt(tiered.system, scope, host, renderOptions(rt, tier))
  await persistData(io, dataKey, res)
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
  rt.lastSections = out
  return { sections: out, result: res }
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

export async function renderSkill(io: Io, rt: Runtime, prompt: CompiledPrompt, input: string | Record<string, unknown>): Promise<string> {
  const skill = prompt.skill!
  const parsed = skillArgs(prompt, input)
  if (!parsed.ok) return parsed.text
  const host = await hostFor(io, rt)
  const { scope, tier } = await buildScope(io, rt, host, undefined)
  scope.args = parsed.args
  const section: SectionNode = { id: skill.name, scope: 'volatile', children: skill.body }
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
    if (!tool) continue
    const full = OWN_TOOL_PREFIX + tool.name
    if (rt.tools.has(full)) continue
    rt.tools.set(full, { kind: 'script', tool })
    await io.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).catch((err: unknown) => debug(io, `script tool ${tool.name}: ${String(err)}`))
  }
}

async function scriptArgv(io: Io, rt: Runtime, rel: string): Promise<string[]> {
  const abs = join(rt.root, rel)
  if (/\.py$/.test(rel)) return ['python3', abs]
  if (/\.(m?js|cjs)$/.test(rel)) return ['node', abs]
  if (/\.(sh|bash)$/.test(rel)) return ['bash', abs]
  const t = await io.fs.read(abs).catch(() => '')
  const m = typeof t === 'string' ? /^#!\s*(\S+)(?:\s+(\S+))?/.exec(t) : null
  if (m) return m[1].endsWith('/env') && m[2] ? [m[2], abs] : [m[1].split('/').pop() ?? m[1], abs]
  return ['bash', abs]
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
    if (entry.kind === 'lazy') return { result: await lazyText(io, rt, entry.ref) }
    const tool = entry.tool
    const tier = (await io.read('gate'))?.tier ?? (await io.read('tier')) ?? 'standard'
    if (tool.tiers && !tool.tiers.includes(tier)) return { deny: `Інструмент ${tool.name} недоступний для tier ${tier} (tiers: ${tool.tiers.join(', ')})` }
    if ((await trustState(io, rt)) !== 'trusted') return { deny: `Інструмент ${tool.name}: репозиторій не довірений` }
    const argv = await scriptArgv(io, rt, tool.path)
    if (!(await allowedBinary(io, rt, argv))) return { deny: `Інструмент ${tool.name}: ${argv[0]} не в білому списку бінарників або allowScripts вимкнено` }
    const gate = await io.read('gate')
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

export async function dslFileChanged(io: Io, rt: Runtime, path: string): Promise<void> {
  const dir = rt.root ? join(rt.root, promptDir(rt)) : undefined
  if (!dir || !path.startsWith(dir)) return
  rt.promptsDirty = true
  const rel = path.slice(rt.root.length + 1)
  if (rel.endsWith('.prompt.tsx') && rt.interactive && (await trustState(io, rt)) === 'trusted') void buildPrompts(io, rt, { only: rel, timeoutMs: FULL_BUILD_MS }).catch(() => undefined)
}
