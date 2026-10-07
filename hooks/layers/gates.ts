// Gates (`gates[]`, SPEC "Провайдери — Гейти", "Шар 3а — Контракти виходу і гейти").
// Builtin read-before-write (before Write/Edit); command gates on write (after the Write/Edit landed: they check the
// new content and a failure reaches the model as context), commit (Bash `git commit`, global git options included),
// turn (turn.complete), prompt (prompt.submit). Commands run through io.process.run ONLY when the repo is
// trusted (Р2). `pass` is a core expression over { exitCode, stdout, stderr, result }; `message` a template.
// A gate that cannot run is reported once per session; `failClosed: true` makes it block instead (S6).
// Failures are journaled as `gate-failed` (metadata only) and count as failed verifications (escalation).


import type { GateCheckConfig, Scope_, Value } from '../../packages/core/src/types.ts'
import { evalSource, newBudget, parseTemplate, renderTemplate, truthy } from '../../packages/core/src/expr.ts'
import type { GateStat } from '../../packages/core/src/health.ts'

import { type Io, type FileCall, type Runtime, type ToolResultLike, debug, insideRoot, join, now, stableJson } from '../ctx.ts'
import { bareBinary, configuredPromptDir, insideRealRoot, loadWhitelist, makeRenderHost, providerConfigs, providerData, writableInsideRoot } from './host.ts'
import { commandGateDecision } from '../../packages/core/src/config.ts'
import { ensureSession } from './config.ts'
import { journal, flushJournal, pushFileEntry } from './journal.ts'
import { gateAttemptEntry, type GateOutcome as AttemptOutcome } from '../../packages/core/src/journal.ts'
import { invalidateSurface, repoKey, trustState } from './trust.ts'
import { budgetsOnTurn } from './budgets.ts'
import { checkEscalation } from './skill-gate.ts'

const VERIFY_RE = /\b(test|tests|jest|vitest|pytest|mocha|tsc|typecheck|lint|eslint|ruff|mypy|clippy)\b/
const GATE_TIMEOUT_MS = 120_000
/** A baseline capture runs inside the pre-edit hook, so it is cut short: a slow gate just keeps no baseline. */
const CAPTURE_TIMEOUT_MS = 15_000
const OUTPUT_TAIL = 1500
const DEFAULT_BASELINE = '.claude/gate.baseline.json'

/** A gate as gate.json may write it: `failClosed` makes a gate that cannot run block instead of pass (S6). */
export type Gate = GateCheckConfig & { failClosed?: boolean }

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

function gatesFor(rt: Runtime, on: GateCheckConfig['on'] | undefined, tier: string): Gate[] {
  return (rt.config?.gates ?? []).filter((g) => (on === undefined || g.on === on) && (g.tiers ?? defaultTiers(rt)).includes(tier))
}

// ───────────────────────── `git commit` detection (M08) ─────────────────────────

/** git global options that take a separate value (`git -C <dir> commit`). */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--list-cmds', '--attr-source'])

/** Words of one simple command, quotes removed (no expansion: enough to find the program and its subcommand). */
function words(segment: string): string[] {
  const out: string[] = []
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(segment))) out.push(m[1] ?? (m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3].replace(/['"]/g, '')))
  return out
}

/** Shells whose `-c` takes a script (`/bin/bash`, `sh`, `zsh`…). */
const SHELLS = /^(?:.*[\\/])?(?:ba|z|da|k|fi)?sh(\.exe)?$/i

/** What a Bash command does that a gate can be bound to. */
export type BashTrigger = 'commit' | 'push' | 'publish'

/** Options of package managers that take a separate value (`npm --workspace pkg publish`, `pnpm -C dir publish`). */
const PUBLISH_VALUE_OPTS = new Set(['-w', '--workspace', '--prefix', '--registry', '--cwd', '-C', '--dir', '--filter', '-F', '--manifest-path', '--package', '-p', '--repository', '--userconfig'])

/** Package managers whose `publish` (or `npm publish` under yarn berry) uploads a package, plus twine's `upload`. */
const PUBLISHERS: Record<string, readonly string[]> = { npm: ['publish'], pnpm: ['publish'], yarn: ['publish', 'npm'], bun: ['publish'], cargo: ['publish'], poetry: ['publish'], twine: ['upload'] }

/**
 * What a Bash command runs: `git commit`, `git push`, a package publish. Every command of a list or pipeline (`;`,
 * `&&`, `||`, `|`, `&`, newlines, `$(…)`, backticks, subshells) counts, and any program word in it (after `sudo`,
 * `env X=1`, `time`…); git's global options are skipped with their values (`-C <dir>`, `-c k=v`, `--git-dir=…`), and
 * the subcommand must match exactly (`git commit-tree` is not a commit). A quoted script given to `sh -c` or `eval` is
 * scanned as a command line. A false positive (`echo git commit`) only runs the gates.
 */
export function bashTriggers(cmd: string, depth = 0, out: Set<BashTrigger> = new Set()): Set<BashTrigger> {
  for (const segment of cmd.split(/\|\||&&|[;|&\n`(){}]|\$\(/)) {
    const w = words(segment)
    for (let j = 0; j < w.length; j++) {
      // A quoted script is one word: the argument of a shell's `-c` (`bash -lc "git commit"`, `xargs sh -c '…'`)
      // or of `eval` is a command line of its own. (`grep "git commit"` is not: its argument is only text.)
      const script = j > 0 && (/^-[A-Za-z]*c$/.test(w[j - 1]) && w.slice(0, j - 1).some((x) => SHELLS.test(x)) || w.slice(0, j).some((x) => x === 'eval'))
      if (script && depth < 4) bashTriggers(w[j], depth + 1, out)
      const prog = (w[j].split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd)$/i, '').toLowerCase()
      if (prog === 'git') {
        let i = j + 1
        while (i < w.length && w[i].startsWith('-')) i += GIT_VALUE_OPTS.has(w[i]) ? 2 : 1
        if (w[i] === 'commit') out.add('commit')
        if (w[i] === 'push') out.add('push')
        continue
      }
      const subs = PUBLISHERS[prog]
      if (!subs) continue
      // The subcommand is the first word that is not an option or an option's value (`npm --workspace x publish`).
      let i = j + 1
      while (i < w.length && w[i].startsWith('-')) i += PUBLISH_VALUE_OPTS.has(w[i]) ? 2 : 1
      const sub = w[i]
      if (sub && subs.includes(sub) && (prog !== 'yarn' || sub === 'publish' || w.slice(j + 1).includes('publish'))) out.add('publish')
    }
  }
  return out
}

/** Does a Bash command run `git commit`? (M08; see `bashTriggers`.) */
export function isGitCommit(cmd: string): boolean {
  return bashTriggers(cmd).has('commit')
}

// ───────────────────────── argv placeholders (M09/S13) ─────────────────────────

/** A path argument that cannot be read as an option (`-rf.ts` → `./-rf.ts`). */
const asArg = (p: string): string => (p.startsWith('-') ? `./${p}` : p)
/** What a path may hold inside a larger argv element (`--file={file}`, `sh -c "lint {file}"`): no shell syntax. */
const SAFE_IN_ARG = /^[\w./@+,=:%~-]+$/

/**
 * `{file}` and `{changedPaths}` in a gate's argv. A whole element becomes one argv word, never shell text. Inside a
 * larger element (a `sh -c` script) a path is substituted only when it holds no shell syntax; otherwise the gate
 * refuses. Paths outside the repo are refused or dropped, a leading `-` is defused, and the replacer is a function,
 * so `$&` in a name stays literal.
 */
export function expandArgv(argv: readonly string[], vars: { file?: string; changed: readonly string[] }): { argv: string[] } | { error: string } {
  const out: string[] = []
  const file = vars.file
  const bad = (p: string): boolean => !insideRoot(p) || /[\0\r\n]/.test(p)
  for (const a of argv) {
    if (a === '{changedPaths}') { out.push(...vars.changed.filter((p) => !bad(p)).map(asArg)); continue }
    if (file === undefined || !a.includes('{file}')) { out.push(a); continue }
    if (bad(file)) return { error: `шлях ${JSON.stringify(file)} поза репозиторієм` }
    if (a === '{file}') { out.push(asArg(file)); continue }
    if (!SAFE_IN_ARG.test(file)) return { error: `шлях ${JSON.stringify(file)} містить символи, які не можна безпечно підставити в «${a}»` }
    out.push(a.replace(/\{file\}/g, () => asArg(file)))
  }
  return { argv: out }
}

// ───────────────────────── violations and baselines (onlyNew, M10/M12, H01) ─────────────────────────

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

const POSITION_KEYS = new Set(['line', 'column', 'col', 'endLine', 'endColumn', 'endCol', 'offset', 'range', 'start', 'end', 'position', 'pos', 'loc', 'location', 'lineNumber', 'columnNumber', 'startLine', 'startColumn'])

function stripPositions(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripPositions)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !POSITION_KEYS.has(k)).map(([k, x]) => [k, stripPositions(x)]))
  return v
}

/** A violation's identity without its position: an edit above it shifts its line, not the violation. */
export function violationKey(v: string): string {
  const t = v.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return stableJson(stripPositions(JSON.parse(t))) } catch { /* plain text */ }
  }
  return t
    .replace(/\(\d+\s*,\s*\d+\)/g, '')
    .replace(/^\d+:\d+(?=\s)/, '')
    .replace(/:\d+(?::\d+)?(?=[:\s)\]]|$)/g, '')
    .replace(/\b(line|col|column)\s*\d+/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Violations beyond the baseline, by position-free key and count (two equal errors where one was known: one new). */
export function freshViolations(current: readonly string[], known: readonly string[]): string[] {
  const left = new Map<string, number>()
  for (const k of known) { const key = violationKey(k); left.set(key, (left.get(key) ?? 0) + 1) }
  const out: string[] = []
  for (const v of current) {
    const key = violationKey(v)
    const n = left.get(key) ?? 0
    if (n > 0) left.set(key, n - 1)
    else out.push(v)
  }
  return out
}

/** Baselines kept in memory: an untrusted repo (nothing written to it), a `baseline` path outside the repo, and the
 *  per-file state a `{file}` write gate saw just before the edit. */
const MEM_BASELINES = new WeakMap<Runtime, Map<string, string[]>>()
function memBaselines(rt: Runtime): Map<string, string[]> {
  let m = MEM_BASELINES.get(rt)
  if (!m) { m = new Map(); MEM_BASELINES.set(rt, m) }
  return m
}

/** A `{file}` gate keeps one baseline per file (memory only); every other gate one per gate name. */
function baselineKey(g: Gate, file: string | undefined): string {
  return file !== undefined && (g.run ?? []).some((a) => a.includes('{file}')) ? `${g.name}\0${file}` : g.name
}

/** The baseline file, when `gates[].baseline` is repo-relative and stays inside the repo (H01). */
function baselinePath(io: Io, rt: Runtime, g: Gate): string | undefined {
  const rel = g.baseline ?? DEFAULT_BASELINE
  if (insideRoot(rel)) return join(rt.root, rel)
  debug(io, `gate ${g.name}: baseline ${JSON.stringify(rel)} поза репозиторієм — знімок лише в пам'яті`)
  return undefined
}

async function readBaseline(io: Io, rt: Runtime, g: Gate, key: string): Promise<string[] | undefined> {
  const mem = memBaselines(rt).get(key)
  if (mem || key !== g.name) return mem
  const path = baselinePath(io, rt, g)
  if (!path || !(await insideRealRoot(io, rt, path))) return undefined
  const raw = await io.fs.read(path).catch(() => undefined)
  try {
    const list = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>)[g.name] : undefined
    return Array.isArray(list) ? list.map(String) : undefined
  } catch {
    return undefined
  }
}

/** Record a baseline: into the repo file only for a trusted repo and a path whose real target stays inside the repo
 *  (no symlink out, H01); otherwise in memory for this session. A clean state (`[]`) stays in memory too: written to
 *  the file it would pin every later session to this one's starting point and add a file to `git status`. */
async function writeBaseline(io: Io, rt: Runtime, g: Gate, key: string, current: string[], trusted: boolean): Promise<void> {
  const path = key === g.name && current.length ? baselinePath(io, rt, g) : undefined
  if (!trusted || !path || !(await writableInsideRoot(io, rt, path))) {
    if (trusted && path) debug(io, `gate ${g.name}: baseline веде за межі репозиторію — знімок лише в пам'яті`)
    memBaselines(rt).set(key, current)
    return
  }
  const raw = await io.fs.read(path).catch(() => undefined)
  let base: Record<string, unknown> = {}
  try { base = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {} } catch { base = {} }
  if (!base || typeof base !== 'object' || Array.isArray(base)) base = {}
  await io.fs.write(path, JSON.stringify({ ...base, [g.name]: current }, null, 2) + '\n').catch((err: unknown) => {
    debug(io, `gate ${g.name}: baseline write failed: ${String(err)}`)
    memBaselines(rt).set(key, current)
  })
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

/**
 * One evaluation of a gate: the in-memory counters (this conversation's H011) plus a `gate-attempt` entry in
 * `.claude/gate.log.jsonl` (core journal contract; file only, buffered, so the 200-entry ring keeps the decisions),
 * which CLI `health` / `report` read with `gateStatsFromJournal`. `skip` is journaled but counts nothing.
 */
async function noteAttempt(io: Io, rt: Runtime, g: { name: string; on: string }, outcome: AttemptOutcome, ms: number, tier: string, skipped?: string): Promise<void> {
  if (outcome === 'pass' || outcome === 'block') recordGate(rt, g.name, outcome === 'block', ms)
  if (!rt.cfg?.log?.file) return
  try {
    const sessionId = await io.session.id().catch(() => undefined)
    const turn = await io.read('gateState').then((s) => s.turn, () => 0)
    const profile = (await io.read('gate'))?.profile ?? undefined
    await pushFileEntry(io, rt, gateAttemptEntry({ gate: g.name, on: g.on, outcome, ms, ...(sessionId ? { sessionId } : {}), ...(skipped ? { skipped } : {}) }, { ts: now(), turn, tier, ...(profile ? { profile } : {}) }), { buffered: true })
  } catch (err) {
    debug(io, `gate-attempt journal: ${String((err as Error)?.message ?? err)}`)
  }
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

/** Data of `gates[].provider` (SPEC «Гейти … кожна — команда або провайдер плюс умова проходження»), through the same
 *  RenderHost as a render: gate.json providers and `<prompt dir>/lib` modules alike (M11). */
async function gateProvider(io: Io, rt: Runtime, name: string, trusted: boolean): Promise<Value | undefined> {
  const dir = configuredPromptDir(rt.cfg)
  const providers = await providerConfigs(io, rt, dir)
  if (!providers[name]) return undefined
  const host = makeRenderHost(io, rt, { trusted, repoKey: await repoKey(io, rt), itemBody: async () => undefined, rules: async () => rt.rules?.list ?? [], promptDir: dir, providers })
  try {
    const data = await providerData(io, rt, host, name)
    return data[name]
  } catch (err) {
    debug(io, `gate provider ${name}: ${String((err as Error)?.message ?? err)}`)
    return undefined
  }
}

const isUnverified = (v: Value | undefined): boolean => v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v) && (v as Record<string, Value>).unverified === true)

/** What the gate's expressions see of its trigger: the prompt text (prompt gates), the Bash command (Bash gates). */
function inputsOf(vars: GateVars): Scope_ {
  return { ...(vars.prompt !== undefined ? { prompt: vars.prompt } : {}), ...(vars.command !== undefined ? { command: vars.command } : {}) }
}

/**
 * A gate with `pass` and neither `run` nor `provider`: only the expression decides, over `prompt` / `command`. Runs no
 * process, so it needs no trust: `{ "on": "publish", "pass": "false", "message": "…" }` keeps publishing for people.
 */
function expressionGate(io: Io, g: Gate, vars: GateVars): GateOutcome {
  const scope: Scope_ = { exitCode: 0, stdout: '', stderr: '', result: null, ...inputsOf(vars) }
  let pass: boolean
  try {
    pass = truthy(evalSource(g.pass!, scope, newBudget()))
  } catch (err) {
    debug(io, `gate ${g.name}: pass expression failed: ${String(err)}`)
    return { pass: true, skipped: 'вираз pass не обчислено' }
  }
  if (pass) return { pass }
  let message = `Гейт ${g.name} не пройдено.`
  if (g.message) {
    const t = parseTemplate(g.message)
    try { message = renderTemplate(t.parts, scope, newBudget()) } catch { message = g.message }
  }
  return { pass, message }
}

/**
 * Run one command gate (trusted repos only), or a provider gate (`provider` without `run`). `capture` records the
 * baseline of an `onlyNew` gate (before the first edit, or a `{file}` gate just before its edit) and always passes.
 */
export interface GateVars { file?: string; prompt?: string; command?: string }

export async function runCommandGate(io: Io, rt: Runtime, g: Gate, vars: GateVars, opts: { capture?: boolean } = {}): Promise<GateOutcome> {
  if (!g.run?.length && !g.provider) return g.pass && !opts.capture ? expressionGate(io, g, vars) : { pass: true, skipped: 'немає run' }
  const trust = await trustState(io, rt)
  const trusted = trust === 'trusted'
  if (g.run?.length) {
    // Р2 (core): trusted repo, scripts allowed (interactive, or userConfig allowScripts under -p), binary on the whitelist.
    const d = commandGateDecision({ trusted, whitelist: await loadWhitelist(io, rt), scriptsAllowed: rt.interactive || rt.options.allowScripts }, g.run)
    if (!d.run) {
      debug(io, `gate ${g.name} skipped: ${d.skipped}`)
      return { pass: true, skipped: d.skipped }
    }
    if (!bareBinary(g.run)) return { pass: true, skipped: `${g.run[0]}: шлях замість імені бінарника (білий список приймає лише імена з PATH)` }
  }
  const prov = g.provider ? await gateProvider(io, rt, g.provider, trusted) : undefined
  let r: { exitCode: number; stdout: string; stderr: string }
  let result: Value = null
  if (g.run?.length) {
    const ex = expandArgv(g.run, { file: vars.file, changed: [...rt.changedPaths] })
    if ('error' in ex) {
      debug(io, `gate ${g.name}: ${ex.error}`)
      return opts.capture ? { pass: true, skipped: ex.error } : { pass: false, message: `Гейт ${g.name}: ${ex.error} — перевірку не запущено.` }
    }
    try {
      // A prompt gate reads the prompt on stdin (never in argv: the text is the user's, not a command).
      r = await io.process.run(ex.argv, { cwd: rt.root, timeoutMs: opts.capture ? CAPTURE_TIMEOUT_MS : GATE_TIMEOUT_MS, ...(vars.prompt !== undefined ? { stdin: vars.prompt } : {}) })
    } catch (err) {
      r = { exitCode: -1, stdout: '', stderr: String((err as Error)?.message ?? err) }
    }
    // A capture that could not run (timeout, spawn error) records no baseline rather than an empty one.
    if (opts.capture && r.exitCode < 0) return { pass: true, skipped: 'знімок не знято' }
    try { result = JSON.parse(r.stdout) as Value } catch { /* not JSON */ }
  } else {
    // Provider-only gate: `result` is the provider's data; unavailable data is a skip (reported, or a block with failClosed).
    if (isUnverified(prov)) {
      debug(io, `gate ${g.name} skipped: provider ${g.provider} unavailable`)
      return { pass: true, skipped: `провайдер ${g.provider} недоступний` }
    }
    result = prov ?? null
    r = { exitCode: 0, stdout: typeof prov === 'string' ? prov : JSON.stringify(prov), stderr: '' }
  }
  const scope: Scope_ = { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, result, ...inputsOf(vars) }
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
  let noBaseline = false
  if (g.onlyNew) {
    // The baseline is the state before this session's edits: captured on a pass too (empty), never from a failure
    // the session itself may have caused (M12). Compared by position-free keys (M10).
    const key = baselineKey(g, vars.file)
    const current = pass ? [] : violationsOf(result, r.stdout)
    const known = opts.capture ? undefined : await readBaseline(io, rt, g, key)
    if (known === undefined && (opts.capture || rt.changedPaths.size === 0)) {
      await writeBaseline(io, rt, g, key, current, trusted)
      pass = true
    } else if (known === undefined) {
      if (pass) await writeBaseline(io, rt, g, key, [], trusted)
      else { fresh = current; noBaseline = true }
    } else if (!pass) {
      fresh = freshViolations(current, known)
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
  if (noBaseline) message += '\n(Базового знімка для onlyNew немає: усі порушення вважаються новими.)'
  return { pass, message, exitCode: r.exitCode }
}

async function failed(io: Io, rt: Runtime, g: GateCheckConfig, out: GateOutcome, tier: string): Promise<void> {
  rt.verifyFailed++
  await journal(io, rt, { kind: 'gate-failed', trigger: `gate:${g.on}`, tier, data: { gate: g.name, exitCode: out.exitCode ?? null } })
  await checkEscalation(io, rt)
}

/** Skips already reported this session (gate + reason). */
const SKIP_NOTED = new WeakMap<Runtime, Set<string>>()

/** A gate that could not run (S6, R7): a block when gate.json marks it `failClosed`, otherwise a pass that is shown
 *  once per session (toast + debug), never a silent one. */
function skipOutcome(io: Io, rt: Runtime, g: Gate, out: GateOutcome): GateOutcome {
  if (g.failClosed) return { pass: false, message: `Гейт ${g.name} не виконано (${out.skipped}), а він обов'язковий (failClosed) — дію заблоковано.` }
  let noted = SKIP_NOTED.get(rt)
  if (!noted) { noted = new Set(); SKIP_NOTED.set(rt, noted) }
  const k = `${g.name}\0${out.skipped}`
  if (!noted.has(k)) {
    noted.add(k)
    debug(io, `gate ${g.name} пропущено: ${out.skipped}`)
    try { io.ui.toast(`context-gate: гейт ${g.name} пропущено — ${out.skipped}`, { timeoutMs: 6000 }) } catch { /* no surface */ }
  }
  return out
}

/** Gates of one kind; returns the first failure's message. */
async function runGates(io: Io, rt: Runtime, on: GateCheckConfig['on'], tier: string, vars: GateVars, failedGate?: (g: Gate) => void): Promise<string | undefined> {
  for (const g of gatesFor(rt, on, tier)) {
    if (g.builtin) continue
    const t0 = now()
    let out = await runCommandGate(io, rt, g, vars)
    if (out.skipped) out = skipOutcome(io, rt, g, out)
    await noteAttempt(io, rt, g, out.skipped ? 'skip' : out.pass ? 'pass' : 'block', now() - t0, tier, out.skipped)
    if (!out.pass) {
      await failed(io, rt, g, out, tier)
      failedGate?.(g)
      return out.message
    }
  }
  return undefined
}

/** Sessions whose pre-edit baselines were taken. */
const CAPTURED = new WeakSet<Runtime>()

/**
 * Before an edit (M12): the first edit of the session records the baseline of every `onlyNew` gate that has none,
 * so the session's own regressions never become «known»; a `{file}` write gate records the file as it is before its
 * first edit in the session, so later only what the session introduced counts. The first edit waits for these
 * captures, so they run in parallel and each is cut at CAPTURE_TIMEOUT_MS (a gate slower than that keeps no
 * baseline: after edits every violation of it counts as new, as the message says). A gate that already has a
 * baseline (`gates[].baseline` file with violations) is not run. Best effort: never blocks the edit.
 */
async function captureBaselines(io: Io, rt: Runtime, tier: string, rel: string): Promise<void> {
  const fileGate = (g: Gate): boolean => (g.run ?? []).some((a) => a.includes('{file}'))
  try {
    if (rt.changedPaths.size === 0 && !CAPTURED.has(rt)) {
      CAPTURED.add(rt)
      await Promise.all(gatesFor(rt, undefined, tier).map(async (g) => {
        if (!g.onlyNew || g.builtin || fileGate(g)) return
        if ((await readBaseline(io, rt, g, g.name)) === undefined) await runCommandGate(io, rt, g, {}, { capture: true })
      }))
    }
    if (!insideRoot(rel)) return
    for (const g of gatesFor(rt, 'write', tier)) {
      if (!g.onlyNew || g.builtin || !fileGate(g)) continue
      // Re-recording before every edit would turn edit 1's new violation into «known» at edit 2.
      if (memBaselines(rt).has(baselineKey(g, rel))) continue
      if (await io.fs.exists(join(rt.root, rel)).catch(() => false)) await runCommandGate(io, rt, g, { file: rel }, { capture: true })
      else memBaselines(rt).set(baselineKey(g, rel), [])
    }
  } catch (err) {
    debug(io, `baseline capture: ${String((err as Error)?.message ?? err)}`)
  }
}

/** Before Write/Edit/NotebookEdit: builtin read-before-write; the pre-edit baselines of `onlyNew` gates. */
export async function gatesBeforeFile(io: Io, rt: Runtime, c: FileCall): Promise<{ deny: string } | undefined> {
  if (c.tool === 'Read' || !rt.config) return undefined
  const tier = await tierOf(io, c.agentId)
  const reads = rt.readFiles.get(c.agent)
  const rbw = gatesFor(rt, 'write', tier).find((g) => g.builtin && g.name === 'read-before-write')
  if (rbw) {
    const blocked = !reads?.has(c.rel) && (c.tool === 'Write' ? await io.fs.exists(c.file).catch(() => false) : true)
    await noteAttempt(io, rt, rbw, blocked ? 'block' : 'pass', 0, tier)
    if (blocked) {
      await failed(io, rt, rbw, { pass: false }, tier)
      return { deny: `Гейт read-before-write: спочатку прочитай ${c.rel} інструментом Read, потім змінюй файл.` }
    }
  }
  await captureBaselines(io, rt, tier, c.rel)
  return undefined
}

/**
 * After a Write/Edit/NotebookEdit landed: `write` command gates check the new content (M13: before the edit they saw
 * the old file and inverted the verdict). The edit stays; a failure reaches the model as context of the result.
 */
export async function gatesAfterWrite<R extends ToolResultLike>(io: Io, rt: Runtime, c: FileCall, r: R): Promise<R> {
  if (c.tool === 'Read' || !rt.config || r.deny !== undefined || r.isError || !insideRoot(c.rel)) return r
  const msg = await runGates(io, rt, 'write', await tierOf(io, c.agentId), { file: c.rel })
  return msg ? { ...r, context: [...(r.context ?? []), `${msg}\n(Правку ${c.rel} уже застосовано: виправ порушення наступною правкою.)`] } : r
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
    invalidateSurface(rt) // an edit may touch code the trust decision covers (S1)
  }
}

/** `@file` mentions arrive with their content: they count as read for read-before-write. */
export function gatesMentioned(rt: Runtime, rels: string[]): void {
  const reads = rt.readFiles.get('main') ?? new Set<string>()
  rt.readFiles.set('main', reads)
  for (const r of rels) reads.add(r)
}

/**
 * `prompt` gates over the prompt text (stdin of `run`, `prompt` in `pass`/`message`). A failure becomes context of the
 * prompt, or, for a gate with `drop: true`, stops the prompt before the model sees it. `text` also feeds the «все одно»
 * override counter.
 */
export async function promptGates(io: Io, rt: Runtime, text?: string): Promise<{ message: string; drop: boolean } | undefined> {
  const overridden = noteGateOverride(rt, text)
  if (overridden) {
    const g = rt.config?.gates?.find((x) => x.name === overridden)
    await noteAttempt(io, rt, { name: overridden, on: g?.on ?? 'gate' }, 'override', 0, await tierOf(io, undefined))
  }
  if (!rt.config) return undefined
  let drop = false
  const message = await runGates(io, rt, 'prompt', await tierOf(io, undefined), { prompt: text ?? '' }, (g) => { drop = g.drop === true })
  return message === undefined ? undefined : { message, drop }
}

/** Bash before: `commit`, `push` and `publish` gates on the commands that trigger them (any spelling git accepts, M08). */
export async function bashBefore(io: Io, rt: Runtime, cmd: string, agentId: string | undefined): Promise<string | undefined> {
  await ensureSession(io, rt)
  if (!rt.config) return undefined
  const triggers = bashTriggers(cmd)
  if (!triggers.size) return undefined
  const tier = await tierOf(io, agentId)
  for (const on of ['commit', 'push', 'publish'] as const) {
    if (!triggers.has(on)) continue
    const msg = await runGates(io, rt, on, tier, { command: cmd })
    if (msg) return msg
  }
  return undefined
}

/** Whether a failing guard must refuse instead of letting the call through (R7): the repo enforces something on it. */
export function guardsFileCall(rt: Runtime, tool: string): boolean {
  if (tool === 'Read' || !rt.config) return false
  return (rt.config.gates ?? []).some((g) => g.on === 'write' && g.builtin) || rt.cfg?.cursorRules?.strictWrite === true
}

export function guardsBash(rt: Runtime, cmd: string): boolean {
  if (!rt.config) return false
  const triggers = bashTriggers(cmd)
  return (rt.config.gates ?? []).some((g) => (triggers as Set<string>).has(g.on))
}

/** Bash after: a failed test / typecheck / lint command counts as a failed verification. */
export async function bashAfter(io: Io, rt: Runtime, cmd: string, r: ToolResultLike): Promise<void> {
  invalidateSurface(rt) // a command may have changed code the trust decision covers (S1)
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
