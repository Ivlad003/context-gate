// Layer 1: Cursor `.mdc` rules (SPEC "Шар 1 — cursor-rules", PROBE prompt.context / tool.call).
// Always → prompt.context instruction files (or a `cursorRules` block after claudeMd);
// Auto Attached → `context` after Read/Edit/Write/NotebookEdit results and for `@file` mentions;
// Manual → `@id` mentions and `/rule <id>`; Agent Requested → listed only (`context-gate sync` makes skills).
// Dedup per agent in io.state `seen` (`<agentId|main>:<ruleId>`), reset on prompt.context.
// Sources (G-04, G-51): `.cursor/rules` plus every `cursor-mdc` `dir`, `markdown-dir` sources and `provider`
// sources from `itemSources`; all yield MdcRule and share delivery, dedup and journaling (`rule-delivered`).


import type { Diagnostic, MdcRule } from '../../packages/core/src/types.ts'
import { detectWindows, normalizePath } from '../../packages/core/src/glob.ts'
import { cursorRuleDirs, frameRule, isFileRule, markdownRuleId, packInjections, parseMarkdownRule, parseMdc, providerRules, ruleIdFromPath, ruleMatches, ruleSourcesOf } from '../../packages/core/src/mdc.ts'
import { isApplied } from '../state.ts'
import type { ContextGateDecision } from '../../types'
import { type Io, type FileCall, type Runtime, type ToolResultLike, debug, join, now } from '../ctx.ts'
import { ensureSession } from './config.ts'
import { journal } from './journal.ts'
import { makeRenderHost, providerData } from './host.ts'
import { repoKey, trustState } from './trust.ts'

const TYPE_LABEL: Record<string, string> = { always: 'Always', auto: 'Auto Attached', agent: 'Agent Requested', manual: 'Manual' }
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', 'vendor', '.venv'])
const MAX_DEPTH = 6
const MAX_DIRS = 400
const RECHECK_MS = 2000
const RECENT_MAX = 50

interface Found { rel: string; mtimeMs: number }

async function listFiles(io: Io, rt: Runtime, dirRel: string, out: Found[], depth: number, ext: RegExp = /\.mdc$/): Promise<void> {
  if (depth > MAX_DEPTH) return
  const entries = await io.fs.list(join(rt.root, dirRel)).catch(() => [])
  for (const e of entries) {
    const rel = `${dirRel}/${e.name}`
    if (e.kind === 'file' && ext.test(e.name)) out.push({ rel, mtimeMs: e.mtimeMs })
    else if (e.kind === 'dir' && !SKIP_DIRS.has(e.name)) await listFiles(io, rt, rel, out, depth + 1, ext)
  }
}

const MD_EXT = /^(?!readme\.md$).+\.(md|markdown)$/i

function trimDir(d: string): string {
  return d.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** Provider rules (G-51) per runtime: recomputed when the config changes or on a forced re-read (prompt.context). */
const providerCache = new WeakMap<Runtime, { cfg: unknown; rules: MdcRule[]; diagnostics: Diagnostic[] }>()

async function loadProviderRules(io: Io, rt: Runtime, force: boolean): Promise<{ rules: MdcRule[]; diagnostics: Diagnostic[] }> {
  const sources = ruleSourcesOf(rt.cfg).filter((s) => s.kind === 'provider' && s.name)
  if (!sources.length) return { rules: [], diagnostics: [] }
  const hit = providerCache.get(rt)
  if (hit && hit.cfg === rt.cfg && !force) return hit
  const trusted = (await trustState(io, rt).catch(() => 'unknown')) === 'trusted'
  const host = makeRenderHost(io, rt, { trusted, repoKey: await repoKey(io, rt), itemBody: async () => undefined, rules: async () => rt.rules?.list ?? [] })
  const rules: MdcRule[] = []
  const diagnostics: Diagnostic[] = []
  for (const src of sources) {
    const data = await providerData(io, rt, host, src.name).catch(() => ({} as Record<string, never>))
    const r = providerRules(data[src.name!], src)
    rules.push(...r.rules)
    diagnostics.push(...r.diagnostics)
  }
  const entry = { cfg: rt.cfg, rules, diagnostics }
  providerCache.set(rt, entry)
  return entry
}

/** Edge case 6: the session root moved (a `cd` into another worktree): drop the caches built for the old root. */
async function checkRoot(io: Io, rt: Runtime): Promise<void> {
  const root = await io.session.root().catch(() => rt.root)
  if (!root || root === rt.root) return
  rt.root = root
  rt.windows = detectWindows(root, await io.env.os().catch(() => undefined))
  rt.rules = undefined
  rt.itemsDirty = true
  providerCache.delete(rt)
}

/** Directories holding `.cursor/rules` below the root (nested option), breadth-first with caps. */
async function nestedRuleDirs(io: Io, rt: Runtime): Promise<string[]> {
  const found: string[] = []
  const queue: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }]
  let visited = 0
  while (queue.length && visited < MAX_DIRS) {
    const { rel, depth } = queue.shift()!
    visited++
    const entries = await io.fs.list(rel ? join(rt.root, rel) : rt.root).catch(() => [])
    for (const e of entries) {
      if (e.kind !== 'dir' || e.isLink) continue
      if (e.name === '.cursor' && rel) found.push(`${rel}/.cursor/rules`)
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || depth + 1 > MAX_DEPTH) continue
      queue.push({ rel: rel ? `${rel}/${e.name}` : e.name, depth: depth + 1 })
    }
  }
  return found
}

export function rulesActive(rt: Runtime): boolean {
  return rt.disabled.rules === undefined
}

/** Parse rules once; re-list when dirty (FileChanged), on force, or at most every 2 s. */
export async function ensureRules(io: Io, rt: Runtime, opts: { force?: boolean } = {}): Promise<MdcRule[]> {
  await ensureSession(io, rt)
  if (!rulesActive(rt)) return []
  const t = now()
  if (rt.rules && !rt.rulesDirty && !opts.force && t - rt.rules.checkedAt < RECHECK_MS) return rt.rules.list
  await checkRoot(io, rt)
  const { dirs, nested } = cursorRuleDirs(rt.cfg)
  const files: Found[] = []
  for (const d of dirs) await listFiles(io, rt, trimDir(d), files, 0)
  if (nested) for (const d of await nestedRuleDirs(io, rt)) await listFiles(io, rt, d, files, 0)
  const mdSources = ruleSourcesOf(rt.cfg).filter((s) => s.kind === 'markdown-dir' && s.dir)
  const mdFiles: { rel: string; mtimeMs: number; src: (typeof mdSources)[number] }[] = []
  for (const src of mdSources) {
    const found: Found[] = []
    await listFiles(io, rt, trimDir(src.dir!), found, 0, MD_EXT)
    for (const f of found) mdFiles.push({ ...f, src })
  }
  const prov = await loadProviderRules(io, rt, !!opts.force)
  const uniqueFiles = [...new Map(files.map((f) => [f.rel, f])).values()]
  const key = [...uniqueFiles, ...mdFiles].map((f) => `${f.rel}:${f.mtimeMs}`).sort().join('|') + `#${prov.rules.map((r) => `${r.id}:${r.body.length}`).join(',')}`
  if (rt.rules && rt.rules.key === key) {
    rt.rules.checkedAt = t
    rt.rulesDirty = false
    return rt.rules.list
  }
  const list: MdcRule[] = []
  const diagnostics: Diagnostic[] = []
  for (const f of uniqueFiles.sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    const text = await io.fs.read(join(rt.root, f.rel)).catch(() => undefined)
    if (typeof text !== 'string') continue
    const { id, dirPrefix } = ruleIdFromPath(f.rel)
    const r = parseMdc(text, { path: f.rel, id, dirPrefix })
    list.push(r.rule)
    diagnostics.push(...r.diagnostics)
  }
  for (const f of mdFiles.sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    const text = await io.fs.read(join(rt.root, f.rel)).catch(() => undefined)
    if (typeof text !== 'string') continue
    const r = parseMarkdownRule(text, { path: f.rel, id: markdownRuleId(f.rel, trimDir(f.src.dir!)), ...(f.src.frontmatter ? { frontmatter: f.src.frontmatter } : {}), ...(f.src.as ? { as: f.src.as } : {}) })
    if (!list.some((x) => x.id === r.rule.id)) list.push(r.rule)
    diagnostics.push(...r.diagnostics)
  }
  for (const r of prov.rules) if (!list.some((x) => x.id === r.id)) list.push(r)
  diagnostics.push(...prov.diagnostics)
  rt.rules = { key, list, diagnostics, checkedAt: t }
  rt.rulesDirty = false
  rt.itemsDirty = true
  if (diagnostics.length) debug(io, `${diagnostics.length} .mdc diagnostics: ${diagnostics.slice(0, 3).map((d) => `${d.code} ${d.path ?? ''}`).join(', ')}`)
  return list
}

/** A rule the applied gate switched off is not delivered. */
export function ruleOn(gate: ContextGateDecision | null, id: string): boolean {
  if (!isApplied(gate)) return true
  return gate.items[`rule:${id}`] !== 'off'
}

function readGate(io: Io): Promise<ContextGateDecision | null> {
  return io.read('gate')
}

export function relPath(rt: Runtime, file: string): string {
  return normalizePath(file, rt.root, { windows: rt.windows })
}

export async function pushRecent(io: Io, paths: string[]): Promise<void> {
  if (!paths.length) return
  await io.update('recentPaths', (list) => {
    const out = list.filter((p) => !paths.includes(p))
    out.push(...paths)
    return out.slice(-RECENT_MAX)
  })
}

/** Auto rules matching `rel`, not yet seen by `agent`, not gated off. */
async function autoHits(io: Io, rt: Runtime, rels: string[], agent: string): Promise<MdcRule[]> {
  const rules = await ensureRules(io, rt)
  if (!rules.length) return []
  const seen = new Set(await io.read('seen'))
  const gate = await readGate(io)
  const opts = { nocase: rt.windows }
  return rules.filter((r) => r.type === 'auto' && !seen.has(`${agent}:${r.id}`) && ruleOn(gate, r.id) && rels.some((p) => ruleMatches(r, p, opts)))
}

async function markSeen(io: Io, keys: string[]): Promise<void> {
  if (!keys.length) return
  await io.update('seen', (s) => [...new Set([...s, ...keys])])
}

/** Journal one `rule-delivered` entry per rule (G-05): `report` and `observe --status never` count these. */
async function journalDelivered(io: Io, rt: Runtime, ids: readonly string[], agent: string, via: string, extra: Record<string, unknown> = {}): Promise<void> {
  for (const id of ids) {
    await journal(io, rt, { kind: 'rule-delivered', trigger: via, enabled: [`rule:${id}`], reason: [`${via}: ${id} → ${agent}`], data: { rule: id, ruleId: id, agent, via, ...extra } })
  }
}

function maxChars(rt: Runtime): number {
  return rt.cfg.cursorRules?.maxCharsPerInjection ?? 30000
}

/** Layer-1 part of prompt.submit: `@file` → Auto Attached, `@id` → Manual/any rule. Returns context blocks. */
export async function rulesForPrompt(io: Io, rt: Runtime, files: string[], ruleIds: string[]): Promise<string[]> {
  const rels = files.map((f) => relPath(rt, f))
  await pushRecent(io, rels)
  if (!rulesActive(rt)) return []
  const blocks: string[] = []
  const hits = rels.length ? await autoHits(io, rt, rels, 'main') : []
  const seen = new Set(await io.read('seen'))
  const all = await ensureRules(io, rt)
  const mentioned = ruleIds.map((id) => all.find((r) => r.id === id)).filter((r): r is MdcRule => !!r && !seen.has(`main:${r.id}`) && !hits.includes(r))
  const packed = packInjections([...hits, ...mentioned], maxChars(rt))
  if (packed.text) blocks.push(packed.text)
  await markSeen(io, packed.included.map((id) => `main:${id}`))
  const byFile = hits.filter((r) => packed.included.includes(r.id)).map((r) => r.id)
  const byId = mentioned.filter((r) => packed.included.includes(r.id)).map((r) => r.id)
  await journalDelivered(io, rt, byFile, 'main', '@file', { paths: rels })
  await journalDelivered(io, rt, byId, 'main', '@mention')
  return blocks
}

/** `/rule <id>`. */
export async function ruleCommand(io: Io, rt: Runtime, args: string): Promise<{ text: string; context?: string[] }> {
  const id = args.trim().replace(/^@/, '')
  const rules = await ensureRules(io, rt)
  const manualIds = rules.filter((r) => r.type === 'manual' || r.type === 'agent').map((r) => r.id)
  if (!rulesActive(rt)) return { text: `Шар cursor-rules вимкнено: ${rt.disabled.rules}` }
  const usage = `Використання: /rule <id>${manualIds.length ? `. Manual/Agent-правила: ${manualIds.join(', ')}` : ''}`
  if (!id) return { text: usage }
  const rule = rules.find((r) => r.id === id)
  if (!rule) return { text: `Правило «${id}» не знайдено. ${usage}` }
  await markSeen(io, [`main:${rule.id}`])
  await journalDelivered(io, rt, [rule.id], 'main', '/rule')
  return { text: `Застосовано правило ${rule.id}`, context: [frameRule(rule)] }
}

/** Split a `seen` key `<agent>:<ruleId>` (rule ids never contain `:`; agent ids may). */
function splitSeen(k: string): { agent: string; id: string } {
  const i = k.lastIndexOf(':')
  return { agent: k.slice(0, i), id: k.slice(i + 1) }
}

/** `/gate rules` (G-06, SPEC scenario 5): one row per rule with its type, globs, source and gate decision,
 * and «доставлено: так/ні» per agent (main plus every subagent seen in this conversation). */
export async function rulesReport(io: Io, rt: Runtime): Promise<string> {
  const rules = await ensureRules(io, rt)
  if (!rulesActive(rt)) return `Шар cursor-rules вимкнено: ${rt.disabled.rules}`
  const seen = new Set(await io.read('seen'))
  const agents = new Set<string>(['main'])
  for (const k of seen) agents.add(splitSeen(k).agent)
  for (const a of Object.keys(await io.read('agentTiers').catch(() => ({})))) agents.add(a)
  const gate = await readGate(io)
  const lines = [`**Правила** (${rules.length})`]
  if (!rules.length) lines.push('- (немає: .cursor/rules порожній, itemSources без правил)')
  for (const t of ['always', 'auto', 'agent', 'manual']) {
    for (const r of rules.filter((x) => x.type === t)) {
      const parts = [`\`${r.id}\``, TYPE_LABEL[r.type] ?? r.type]
      if (r.globs.length || r.negGlobs.length) parts.push(`globs ${[...r.globs, ...r.negGlobs.map((g) => `!${g}`)].join(', ')}`)
      if (r.source && r.source !== 'cursor-mdc') parts.push(`джерело ${r.source}`)
      if (!ruleOn(gate, r.id)) parts.push('вимкнено профілем')
      const delivered = [...agents].map((a) => `${a} — ${seen.has(`${a}:${r.id}`) ? 'так' : 'ні'}`).join(', ')
      parts.push(r.type === 'agent' ? `доставлено: ${delivered} (Agent Requested: через skill cursor-*, \`context-gate sync\`)` : `доставлено: ${delivered}`)
      lines.push(`- ${parts.join(' · ')}`)
    }
  }
  const manual = rules.filter((r) => r.type === 'manual').map((r) => r.id)
  if (manual.length) lines.push('', `Manual: @id або /rule <id> (${manual.join(', ')})`)
  if (rt.rules?.diagnostics.length) lines.push('', `Діагностика правил: ${rt.rules.diagnostics.map((d) => `${d.code} ${d.path ?? ''}${d.line ? `:${d.line}` : ''}`).join(', ')}`)
  return lines.join('\n')
}

type ReadLike = { offset?: unknown; limit?: unknown; pages?: unknown }

function isPartial(e: ReadLike, r: unknown): boolean {
  if ([e.offset, e.limit, e.pages].some((v) => v !== undefined && v !== null && v !== '')) return true
  const res = (r as { result?: { type?: string; file?: { truncatedByTokenCap?: boolean } } }).result
  return res?.type === 'file_unchanged' || res?.file?.truncatedByTokenCap === true
}

/** prompt.context, before `next`: reset dedup (re-delivery after compaction and /clear), re-read rules. */
export async function rulesContextBefore(io: Io, rt: Runtime): Promise<void> {
  await ensureSession(io, rt)
  await io.update('seen', () => [])
  await ensureRules(io, rt, { force: true })
}

type ContextBlock = { name: string; text: string }
type InstructionFile = { path: string; kind: 'managed' | 'user' | 'project' | 'local' | 'memory'; content: string; parent?: string }

/** prompt.context, after `next`: Always rules as instruction files after CLAUDE.md (or a `cursorRules` block). */
export async function rulesContextAfter<R extends { blocks: readonly ContextBlock[]; instructionFiles?: readonly InstructionFile[] }>(
  io: Io, rt: Runtime, input: { instructionFiles?: readonly InstructionFile[] }, r: R,
): Promise<R> {
  const rules = rt.rules?.list ?? []
  if (!rulesActive(rt) || !rules.length) return r
  const gate = await readGate(io)
  const always = rules.filter((x) => x.type === 'always' && ruleOn(gate, x.id))
  if (!always.length) return r
  const packed = packInjections(always, maxChars(rt))
  await markSeen(io, packed.included.map((id) => `main:${id}`))
  await journalDelivered(io, rt, packed.included, 'main', 'prompt.context')
  const files = r.instructionFiles ?? input.instructionFiles
  if (files !== undefined) {
    // File rules become instruction files; provider rules (no file) and pointer lines go in the block.
    const included = always.filter((x) => packed.included.includes(x.id))
    const added: InstructionFile[] = included.filter(isFileRule).map((x) => ({ path: join(rt.root, x.path), kind: 'project', content: x.body }))
    const inBlock = included.filter((x) => !isFileRule(x))
    const pointers = packed.deferred.length ? packInjections(always.filter((x) => packed.deferred.includes(x.id)), 0).text : ''
    const text = [inBlock.length ? packInjections(inBlock, Number.MAX_SAFE_INTEGER).text : '', pointers].filter(Boolean).join('\n\n')
    const blocks = text ? insertAfterClaudeMd(r.blocks, { name: 'cursorRules', text }) : r.blocks
    return { ...r, blocks, instructionFiles: [...files, ...added] }
  }
  return { ...r, blocks: insertAfterClaudeMd(r.blocks, { name: 'cursorRules', text: packed.text }) }
}

/** Before a file tool runs: recent paths; strictWrite deny for a new file with an undelivered rule. */
export async function rulesBeforeFile(io: Io, rt: Runtime, c: FileCall): Promise<{ deny: string } | undefined> {
  await pushRecent(io, [c.rel])
  if (!rulesActive(rt) || c.tool !== 'Write' || !rt.cfg.cursorRules?.strictWrite) return undefined
  const exists = await io.fs.exists(c.file).catch(() => true)
  if (exists) return undefined
  const hits = await autoHits(io, rt, [c.rel], c.agent)
  if (!hits.length) return undefined
  const packed = packInjections(hits, maxChars(rt))
  await markSeen(io, packed.included.map((id) => `${c.agent}:${id}`))
  await journal(io, rt, { kind: 'deny', trigger: 'strictWrite', data: { rules: packed.included, path: c.rel } })
  await journalDelivered(io, rt, packed.included, c.agent, 'strictWrite', { path: c.rel, tool: c.tool })
  return { deny: `${packed.text}\n\nДо цього файлу діє правило Cursor, яке ще не було застосоване. Повтори запис з урахуванням правила.` }
}

/** After a successful file tool: Auto Attached rules as `context` after the result (per-agent dedup). */
export async function rulesAfterFile<R extends ToolResultLike>(io: Io, rt: Runtime, c: FileCall, r: R): Promise<R> {
  if (!rulesActive(rt) || r.deny !== undefined || r.isError) return r
  // A full Read of the .mdc itself counts as delivering that rule; a partial or token-capped one does not.
  if (c.tool === 'Read' && c.rel.endsWith('.mdc') && !isPartial(c.input as ReadLike, r)) {
    const own = (await ensureRules(io, rt)).find((x) => x.path === c.rel)
    if (own && !(await io.read('seen')).includes(`${c.agent}:${own.id}`)) {
      await markSeen(io, [`${c.agent}:${own.id}`])
      await journalDelivered(io, rt, [own.id], c.agent, 'read-mdc', { path: c.rel })
    }
  }
  const hits = await autoHits(io, rt, [c.rel], c.agent)
  if (!hits.length) return r
  const packed = packInjections(hits, maxChars(rt))
  await markSeen(io, packed.included.map((id) => `${c.agent}:${id}`))
  await journalDelivered(io, rt, packed.included, c.agent, 'tool.call', { path: c.rel, tool: c.tool })
  return { ...r, context: [...(r.context ?? []), packed.text] }
}

export function rulesFileChanged(rt: Runtime, path: string): void {
  const p = path.replace(/\\/g, '/')
  const dirs = rt.cfg ? [...cursorRuleDirs(rt.cfg).dirs, ...ruleSourcesOf(rt.cfg).filter((s) => s.kind === 'markdown-dir' && s.dir).map((s) => s.dir!)] : []
  if (/\/\.cursor\/rules\//.test(p) || dirs.some((d) => p.includes(`/${trimDir(d)}/`) || p.startsWith(`${trimDir(d)}/`))) {
    rt.rulesDirty = true
    rt.itemsDirty = true
  }
}

function insertAfterClaudeMd<B extends { name: string; text: string }>(blocks: readonly B[], block: B): B[] {
  const out = [...blocks]
  const i = out.findIndex((b) => b.name === 'claudeMd')
  out.splice(i < 0 ? out.length : i + 1, 0, block)
  return out
}

