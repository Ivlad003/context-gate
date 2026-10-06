// Layer 1: Cursor `.mdc` rules (SPEC "Шар 1 — cursor-rules", PROBE prompt.context / tool.call).
// Always → prompt.context instruction files (or a `cursorRules` block after claudeMd);
// Auto Attached → `context` after Read/Edit/Write/NotebookEdit results and for `@file` mentions;
// Manual → `@id` mentions and `/rule <id>`; Agent Requested → listed only (`context-gate sync` makes skills).
// Dedup per agent in io.state `seen` (`<agentId|main>:<ruleId>`), reset on prompt.context.


import type { MdcRule } from '../../packages/core/src/types.ts'
import { matchAny, normalizePath } from '../../packages/core/src/glob.ts'
import { frameRule, packInjections, parseMdc, ruleIdFromPath } from '../../packages/core/src/mdc.ts'
import { isApplied } from '../state.ts'
import type { ContextGateDecision } from '../../types'
import { type Io, type FileCall, type Runtime, type ToolResultLike, debug, join, now } from '../ctx.ts'
import { ensureSession } from './config.ts'
import { journal } from './journal.ts'

const RULES_DIR = '.cursor/rules'
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', 'vendor', '.venv'])
const MAX_DEPTH = 6
const MAX_DIRS = 400
const RECHECK_MS = 2000
const RECENT_MAX = 50

interface Found { rel: string; mtimeMs: number }

async function listMdc(io: Io, rt: Runtime, dirRel: string, out: Found[], depth: number): Promise<void> {
  if (depth > MAX_DEPTH) return
  const entries = await io.fs.list(join(rt.root, dirRel)).catch(() => [])
  for (const e of entries) {
    const rel = `${dirRel}/${e.name}`
    if (e.kind === 'file' && e.name.endsWith('.mdc')) out.push({ rel, mtimeMs: e.mtimeMs })
    else if (e.kind === 'dir') await listMdc(io, rt, rel, out, depth + 1)
  }
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
  const files: Found[] = []
  await listMdc(io, rt, RULES_DIR, files, 0)
  if (rt.cfg.cursorRules?.nested) for (const d of await nestedRuleDirs(io, rt)) await listMdc(io, rt, d, files, 0)
  const key = files.map((f) => `${f.rel}:${f.mtimeMs}`).sort().join('|')
  if (rt.rules && rt.rules.key === key) {
    rt.rules.checkedAt = t
    rt.rulesDirty = false
    return rt.rules.list
  }
  const list: MdcRule[] = []
  const diagnostics: ReturnType<typeof parseMdc>['diagnostics'] = []
  for (const f of files.sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    const text = await io.fs.read(join(rt.root, f.rel)).catch(() => undefined)
    if (typeof text !== 'string') continue
    const { id, dirPrefix } = ruleIdFromPath(f.rel)
    const r = parseMdc(text, { path: f.rel, id, dirPrefix })
    list.push(r.rule)
    diagnostics.push(...r.diagnostics)
  }
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
  const opts = { nocase: rt.windows, matchBase: true }
  return rules.filter((r) => r.type === 'auto' && !seen.has(`${agent}:${r.id}`) && ruleOn(gate, r.id) && rels.some((p) => matchAny(p, r.globs, r.negGlobs, opts)))
}

async function markSeen(io: Io, keys: string[]): Promise<void> {
  if (!keys.length) return
  await io.update('seen', (s) => [...new Set([...s, ...keys])])
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
  for (const r of mentioned) if (packed.included.includes(r.id)) await journal(io, rt, { kind: 'rule-delivered', trigger: '@mention', data: { rule: r.id, via: 'prompt' } })
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
  await journal(io, rt, { kind: 'rule-delivered', trigger: '/rule', data: { rule: rule.id, via: 'command' } })
  return { text: `Застосовано правило ${rule.id}`, context: [frameRule(rule)] }
}

/** `/gate rules`: delivered rules per agent, plus the rule inventory. */
export async function rulesReport(io: Io, rt: Runtime): Promise<string> {
  const rules = await ensureRules(io, rt)
  if (!rulesActive(rt)) return `Шар cursor-rules вимкнено: ${rt.disabled.rules}`
  const seen = await io.read('seen')
  const byAgent = new Map<string, string[]>()
  for (const k of seen) {
    const i = k.lastIndexOf(':')
    const agent = k.slice(0, i)
    const id = k.slice(i + 1)
    byAgent.set(agent, [...(byAgent.get(agent) ?? []), id])
  }
  const lines = ['**Доставлені правила в цій розмові**']
  if (!byAgent.size) lines.push('- (ще жодного)')
  for (const [agent, ids] of byAgent) lines.push(`- ${agent}: ${ids.join(', ')}`)
  const byType = (t: string) => rules.filter((r) => r.type === t).map((r) => r.id)
  lines.push('', '**Правила .cursor/rules**')
  lines.push(`- Always: ${byType('always').join(', ') || '—'}`)
  lines.push(`- Auto Attached: ${byType('auto').join(', ') || '—'}`)
  lines.push(`- Agent Requested: ${byType('agent').join(', ') || '—'} (не інжектуються: \`context-gate sync\` робить із них skills)`)
  lines.push(`- Manual: ${byType('manual').join(', ') || '—'} (@id або /rule <id>)`)
  if (rt.rules?.diagnostics.length) lines.push('', `Діагностика .mdc: ${rt.rules.diagnostics.map((d) => `${d.code} ${d.path ?? ''}${d.line ? `:${d.line}` : ''}`).join(', ')}`)
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
  const pointers = packed.deferred.length ? packInjections(always.filter((x) => packed.deferred.includes(x.id)), 0).text : ''
  const files = r.instructionFiles ?? input.instructionFiles
  if (files !== undefined) {
    const added: InstructionFile[] = always.filter((x) => packed.included.includes(x.id)).map((x) => ({ path: join(rt.root, x.path), kind: 'project', content: x.body }))
    const blocks = pointers ? insertAfterClaudeMd(r.blocks, { name: 'cursorRules', text: pointers }) : r.blocks
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
  return { deny: `${packed.text}\n\nДо цього файлу діє правило Cursor, яке ще не було застосоване. Повтори запис з урахуванням правила.` }
}

/** After a successful file tool: Auto Attached rules as `context` after the result (per-agent dedup). */
export async function rulesAfterFile<R extends ToolResultLike>(io: Io, rt: Runtime, c: FileCall, r: R): Promise<R> {
  if (!rulesActive(rt) || r.deny !== undefined || r.isError) return r
  // A full Read of the .mdc itself counts as delivering that rule; a partial or token-capped one does not.
  if (c.tool === 'Read' && c.rel.endsWith('.mdc') && !isPartial(c.input as ReadLike, r)) {
    const own = (await ensureRules(io, rt)).find((x) => x.path === c.rel)
    if (own) await markSeen(io, [`${c.agent}:${own.id}`])
  }
  const hits = await autoHits(io, rt, [c.rel], c.agent)
  if (!hits.length) return r
  const packed = packInjections(hits, maxChars(rt))
  await markSeen(io, packed.included.map((id) => `${c.agent}:${id}`))
  return { ...r, context: [...(r.context ?? []), packed.text] }
}

export function rulesFileChanged(rt: Runtime, path: string): void {
  if (/[\\/]\.cursor[\\/]rules[\\/]/.test(path)) {
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

