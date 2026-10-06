// Gates (`gates[]`, SPEC "Провайдери — Гейти", "Шар 3а — Контракти виходу і гейти").
// Builtin read-before-write; command gates on write (before Write/Edit), commit (Bash `git commit`),
// turn (turn.complete), prompt (prompt.submit). Commands run through io.process.run ONLY when the repo is
// trusted (Р2). `pass` is a core expression over { exitCode, stdout, stderr, result }; `message` a template.
// Failures are journaled as `gate-failed` (metadata only) and count as failed verifications (escalation).


import type { GateCheckConfig, Scope_, Value } from '../../packages/core/src/types.ts'
import { evalSource, newBudget, parseTemplate, renderTemplate, truthy } from '../../packages/core/src/expr.ts'
import type { RenderHostExt } from '../../packages/core/src/render.ts'
import type { GateStat } from '../../packages/core/src/health.ts'

import { type Io, type FileCall, type Runtime, type ToolResultLike, debug, join, now } from '../ctx.ts'
import { providerData } from './host.ts'
import { ensureSession } from './config.ts'
import { journal, flushJournal } from './journal.ts'
import { trustState } from './trust.ts'
import { budgetsOnTurn } from './budgets.ts'
import { checkEscalation } from './skill-gate.ts'

const VERIFY_RE = /\b(test|tests|jest|vitest|pytest|mocha|tsc|typecheck|lint|eslint|ruff|mypy|clippy)\b/
const COMMIT_RE = /\bgit\s+(?:-\S+\s+)*commit\b/
const GATE_TIMEOUT_MS = 120_000
const OUTPUT_TAIL = 1500

export function defaultTiers(rt: Runtime): string[] {
  return Object.keys(rt.cfg.tiers ?? {}).filter((t) => t !== 'premium')
}

async function tierOf(io: Io, agentId: string | undefined): Promise<string> {
  if (agentId !== undefined) {
    const t = (await io.read('agentTiers'))[agentId]
    if (t) return t
  }
  return (await io.read('gate'))?.tier ?? (await io.read('tier')) ?? 'standard'
}

function gatesFor(rt: Runtime, on: GateCheckConfig['on'], tier: string): GateCheckConfig[] {
  return (rt.config?.gates ?? []).filter((g) => g.on === on && (g.tiers ?? defaultTiers(rt)).includes(tier))
}

function expandArgv(argv: readonly string[], vars: { file?: string; changed: string[] }): string[] {
  const out: string[] = []
  for (const a of argv) {
    if (a === '{changedPaths}') { out.push(...vars.changed); continue }
    out.push(vars.file !== undefined ? a.replace(/\{file\}/g, vars.file) : a)
  }
  return out
}

function violationsOf(result: Value | undefined, stdout: string): string[] {
  const pickArr = (v: Value | undefined): Value[] | undefined => {
    if (Array.isArray(v)) return v
    if (v && typeof v === 'object') for (const k of ['violations', 'errors', 'problems', 'issues']) if (Array.isArray((v as Record<string, Value>)[k])) return (v as Record<string, Value[]>)[k]
    return undefined
  }
  const arr = pickArr(result)
  if (arr) return arr.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

export interface GateOutcome { pass: boolean; message?: string; skipped?: string; exitCode?: number }

// ───────────────────────── gate statistics (health H011) ─────────────────────────

/** Per-session counters by gate name. Kept beside the Runtime (not in it) so `ctx.ts` stays untouched. */
const STATS = new WeakMap<Runtime, { gates: Map<string, GateStat>; lastBlocked?: { name: string; at: number } }>()

function statsOf(rt: Runtime): { gates: Map<string, GateStat>; lastBlocked?: { name: string; at: number } } {
  let s = STATS.get(rt)
  if (!s) { s = { gates: new Map() }; STATS.set(rt, s) }
  return s
}

function recordGate(rt: Runtime, name: string, blocked: boolean, ms: number): void {
  const s = statsOf(rt)
  const g = s.gates.get(name) ?? { attempts: 0, blocks: 0, ms: 0, overrides: 0 }
  g.attempts++
  g.ms = (g.ms ?? 0) + ms
  if (blocked) { g.blocks++; s.lastBlocked = { name, at: now() } }
  s.gates.set(name, g)
}

/** Gate counters of this session for `computeHealth(…, { gates })` (H011). */
export function gateStats(rt: Runtime): Record<string, GateStat> {
  return Object.fromEntries([...statsOf(rt).gates].map(([k, v]) => [k, { ...v }]))
}

/** Reset on `/clear` and a fresh session. */
export function resetGateStats(rt: Runtime): void { STATS.delete(rt) }

/** SPEC «Гейти … false positives за ручними «все одно»»: a prompt that insists after a block. */
const OVERRIDE_RE = /(все\s*одно|всеодно|anyway|ignore (?:the )?gate|пропусти гейт|без гейт)/i
const OVERRIDE_WINDOW_MS = 10 * 60_000

/** A manual «все одно» right after a block counts as an override (a likely false positive) of that gate. */
export function noteGateOverride(rt: Runtime, text: string | undefined): string | undefined {
  const s = statsOf(rt)
  if (!text || !s.lastBlocked || now() - s.lastBlocked.at > OVERRIDE_WINDOW_MS || !OVERRIDE_RE.test(text)) return undefined
  const g = s.gates.get(s.lastBlocked.name)
  if (g) g.overrides = (g.overrides ?? 0) + 1
  const name = s.lastBlocked.name
  s.lastBlocked = undefined
  return name
}

// ───────────────────────── provider data for gates (gates[].provider) ─────────────────────────

/** Data of `gates[].provider` (SPEC «Гейти … кожна — команда або провайдер плюс умова проходження»). */
async function gateProvider(io: Io, rt: Runtime, name: string, trusted: boolean): Promise<Value | undefined> {
  if (!rt.cfg.providers?.[name]) return undefined
  const host: RenderHostExt = {
    trusted,
    now: () => now(),
    async readFile(path) {
      if (/^\//.test(path) || path.split(/[\\/]/).includes('..')) return undefined
      const t = await io.fs.read(join(rt.root, path)).catch(() => undefined)
      return typeof t === 'string' ? t : undefined
    },
    async mcp(req) {
      if (!trusted) throw new Error('репозиторій не довірений')
      const r = await io.mcp.call(req.server, req.tool, req.args)
      if (r.isError) throw new Error(`MCP ${req.server}.${req.tool} повернув помилку`)
      if (r.structuredContent !== undefined) return r.structuredContent as Value
      const text = r.content.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('\n')
      try { return JSON.parse(text) as Value } catch { return text }
    },
  }
  try {
    const data = await providerData(io, rt, host, name)
    return data[name]
  } catch (err) {
    debug(io, `gate provider ${name}: ${String((err as Error)?.message ?? err)}`)
    return undefined
  }
}

const isUnverified = (v: Value | undefined): boolean => v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v) && (v as Record<string, Value>).unverified === true)

/** Run one command gate (trusted repos only), or a provider gate (`provider` without `run`). */
export async function runCommandGate(io: Io, rt: Runtime, g: GateCheckConfig, vars: { file?: string }): Promise<GateOutcome> {
  if (!g.run?.length && !g.provider) return { pass: true, skipped: 'немає run' }
  const trust = await trustState(io, rt)
  const trusted = trust === 'trusted'
  if (g.run?.length && !trusted) {
    debug(io, `gate ${g.name} skipped: repository not trusted`)
    return { pass: true, skipped: 'репозиторій не довірений' }
  }
  const prov = g.provider ? await gateProvider(io, rt, g.provider, trusted) : undefined
  let r: { exitCode: number; stdout: string; stderr: string }
  let result: Value = null
  if (g.run?.length) {
    const argv = expandArgv(g.run, { file: vars.file, changed: [...rt.changedPaths] })
    try {
      r = await io.process.run(argv, { cwd: rt.root, timeoutMs: GATE_TIMEOUT_MS })
    } catch (err) {
      r = { exitCode: -1, stdout: '', stderr: String((err as Error)?.message ?? err) }
    }
    try { result = JSON.parse(r.stdout) as Value } catch { /* not JSON */ }
  } else {
    // Provider-only gate: `result` is the provider's data; unavailable data never blocks (unverified).
    if (isUnverified(prov)) {
      debug(io, `gate ${g.name} skipped: provider ${g.provider} unavailable`)
      return { pass: true, skipped: `провайдер ${g.provider} недоступний` }
    }
    result = prov ?? null
    r = { exitCode: 0, stdout: typeof prov === 'string' ? prov : JSON.stringify(prov), stderr: '' }
  }
  const scope: Scope_ = { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, result }
  if (g.provider) {
    scope.provider = prov ?? null
    if (!(g.provider in scope)) scope[g.provider] = prov ?? null
  }
  let pass: boolean
  try {
    pass = truthy(evalSource(g.pass ?? 'exitCode == 0', scope, newBudget()))
  } catch (err) {
    debug(io, `gate ${g.name}: pass expression failed: ${String(err)}`)
    pass = r.exitCode === 0
  }
  let fresh: string[] | undefined
  if (!pass && g.onlyNew) {
    const path = join(rt.root, g.baseline ?? `.claude/gate.baseline.json`)
    const current = violationsOf(result, r.stdout)
    const raw = await io.fs.read(path).catch(() => undefined)
    let base: Record<string, string[]> = {}
    try { base = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, string[]>) : {} } catch { base = {} }
    if (!Array.isArray(base[g.name])) {
      await io.fs.write(path, JSON.stringify({ ...base, [g.name]: current }, null, 2) + '\n').catch(() => undefined)
      pass = true
    } else {
      const known = new Set(base[g.name])
      fresh = current.filter((v) => !known.has(v))
      pass = fresh.length === 0
    }
  }
  if (pass) return { pass, exitCode: r.exitCode }
  let message: string
  if (g.message) {
    const t = parseTemplate(g.message)
    try { message = renderTemplate(t.parts, scope, newBudget()) } catch { message = g.message }
  } else {
    const tail = (fresh ? fresh.join('\n') : `${r.stdout}\n${r.stderr}`).trim()
    message = `Гейт ${g.name} не пройдено (exit ${r.exitCode}).${tail ? `\n${tail.slice(-OUTPUT_TAIL)}` : ''}`
  }
  if (fresh?.length && g.message) message += `\nНові порушення:\n${fresh.slice(0, 20).join('\n')}`
  return { pass, message, exitCode: r.exitCode }
}

async function failed(io: Io, rt: Runtime, g: GateCheckConfig, out: GateOutcome, tier: string): Promise<void> {
  rt.verifyFailed++
  await journal(io, rt, { kind: 'gate-failed', trigger: `gate:${g.on}`, tier, data: { gate: g.name, exitCode: out.exitCode ?? null } })
  await checkEscalation(io, rt)
}

/** Gates of one kind; returns the first failure's message. */
async function runGates(io: Io, rt: Runtime, on: GateCheckConfig['on'], tier: string, vars: { file?: string }): Promise<string | undefined> {
  for (const g of gatesFor(rt, on, tier)) {
    if (g.builtin) continue
    const t0 = now()
    const out = await runCommandGate(io, rt, g, vars)
    if (!out.skipped) recordGate(rt, g.name, !out.pass, now() - t0)
    if (!out.pass) {
      await failed(io, rt, g, out, tier)
      return out.message
    }
  }
  return undefined
}

/** Before Write/Edit/NotebookEdit: builtin read-before-write, then `write` command gates. */
export async function gatesBeforeFile(io: Io, rt: Runtime, c: FileCall): Promise<{ deny: string } | undefined> {
  if (c.tool === 'Read' || !rt.config) return undefined
  const tier = await tierOf(io, c.agentId)
  const reads = rt.readFiles.get(c.agent)
  const rbw = gatesFor(rt, 'write', tier).find((g) => g.builtin && g.name === 'read-before-write')
  if (rbw) {
    const blocked = !reads?.has(c.rel) && (c.tool === 'Write' ? await io.fs.exists(c.file).catch(() => false) : true)
    recordGate(rt, rbw.name, blocked, 0)
    if (blocked) {
      await failed(io, rt, rbw, { pass: false }, tier)
      return { deny: `Гейт read-before-write: спочатку прочитай ${c.rel} інструментом Read, потім змінюй файл.` }
    }
  }
  const msg = await runGates(io, rt, 'write', tier, { file: c.rel })
  return msg ? { deny: msg } : undefined
}

/** After a file tool: what this agent has read, what changed this session and turn. */
export function gatesAfterFile(rt: Runtime, c: FileCall, r: ToolResultLike): void {
  if (r.deny !== undefined || r.isError) return
  const reads = rt.readFiles.get(c.agent) ?? new Set<string>()
  rt.readFiles.set(c.agent, reads)
  reads.add(c.rel)
  if (c.tool !== 'Read') {
    rt.changedPaths.add(c.rel)
    rt.editedThisTurn = true
  }
}

/** `@file` mentions arrive with their content: they count as read for read-before-write. */
export function gatesMentioned(rt: Runtime, rels: string[]): void {
  const reads = rt.readFiles.get('main') ?? new Set<string>()
  rt.readFiles.set('main', reads)
  for (const r of rels) reads.add(r)
}

/** `prompt` gates: a failure becomes context of the prompt. `text` (the prompt) feeds the «все одно» override counter. */
export async function promptGates(io: Io, rt: Runtime, text?: string): Promise<string | undefined> {
  const overridden = noteGateOverride(rt, text)
  if (overridden) await journal(io, rt, { kind: 'debug', trigger: 'gate-override', data: { gate: overridden } })
  if (!rt.config) return undefined
  return runGates(io, rt, 'prompt', await tierOf(io, undefined), {})
}

/** Bash before: commit gates on `git commit`. */
export async function bashBefore(io: Io, rt: Runtime, cmd: string, agentId: string | undefined): Promise<string | undefined> {
  await ensureSession(io, rt)
  if (!rt.config || !COMMIT_RE.test(cmd)) return undefined
  return runGates(io, rt, 'commit', await tierOf(io, agentId), {})
}

/** Bash after: a failed test / typecheck / lint command counts as a failed verification. */
export async function bashAfter(io: Io, rt: Runtime, cmd: string, r: ToolResultLike): Promise<void> {
  if (r.deny !== undefined || r.isError !== true || !VERIFY_RE.test(cmd)) return
  rt.verifyFailed++
  await journal(io, rt, { kind: 'debug', trigger: 'verify-failed', data: { tool: 'Bash' } })
  await checkEscalation(io, rt)
}

/** turn.complete (main loop), after `next`: stall counter, `turn` gates, budgets, escalation, journal flush. */
export async function turnAfter(io: Io, rt: Runtime, e: { agentId?: string; isAborted: boolean }): Promise<void> {
  if (e.agentId !== undefined) return
  try {
    await ensureSession(io, rt)
    if (rt.editedThisTurn) rt.stallTurns = 0
    else rt.stallTurns++
    rt.editedThisTurn = false
    if (rt.config && !e.isAborted) {
      const msg = await runGates(io, rt, 'turn', await tierOf(io, undefined), {})
      if (msg) {
        try { io.ui.toast(`context-gate: ${msg.split('\n')[0]}`, { timeoutMs: 8000 }) } catch { /* no surface */ }
        await io.session.append({ message: { type: 'user', content: [{ type: 'text', text: msg }] } }).catch((err: unknown) => debug(io, `gate append failed: ${String(err)}`))
      }
    }
    await budgetsOnTurn(io, rt)
    await checkEscalation(io, rt)
    await flushJournal(io, rt)
  } catch (err) {
    debug(io, `turn.complete: ${String((err as Error)?.message ?? err)}`)
  }
}
