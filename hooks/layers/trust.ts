// Trust-on-first-use per repository (SPEC Р2). Covers every io.process.run / io.mcp.call that repo
// config initiates: prompt build, @run/@call executors, cli providers, command gates, script tools.
// Until trusted only plugin code and file reads run. Key: repo root + remote, kept in io.store.
// The decision holds for one sha256 of everything the repo can execute (S1): gate.json's commands and providers,
// and the code under the prompt dir (TSX, lib/, scripts/, Markdown with @run/@call/@mcp, compiled run nodes) and
// module provider files. A change asks again.


import type { GateConfig } from '../../packages/core/src/types.ts'
import { sha256Hex } from '../../packages/core/src/sha256.ts'
import { json } from '../state.ts'
import { type Io, type Runtime, debug, insideRoot, join, now, stableJson } from '../ctx.ts'
import { clearCacheStore, configuredPromptDir } from './host.ts'

export type TrustDecision = 'unknown' | 'trusted' | 'denied'

export const TRUST_QUESTION = 'context-gate: дозволити цьому репозиторію збирати промпти й запускати команди з .claude/gate.json (гейти, скрипти, провайдери)?'
export const TRUST_YES = 'Так, довіряю'
export const TRUST_NO = 'Ні'

interface Stored { decision: 'trusted' | 'denied'; commandsHash: string; at: number }

/** Everything repo config can execute (every provider kind, as the CLI hashes them): a change asks again. sha256,
 *  not the 32-bit cache hash: a crafted config must not collide with the trusted one (L09). */
export function commandsHash(cfg: GateConfig | undefined): string {
  if (!cfg) return sha256Hex('')
  const providers = Object.fromEntries(Object.entries(cfg.providers ?? {}).map(([k, p]) => [k, { kind: p.kind, command: p.command, functions: p.functions, path: p.path, tool: p.tool, args: p.args }]))
  // cli classify / brief providers (G-02) run repo commands too.
  const models = Object.fromEntries([['classify', cfg.classify?.provider], ['brief', cfg.brief?.provider]].filter(([, p]) => p && typeof p === 'object'))
  return sha256Hex(stableJson({ executors: cfg.executors ?? {}, providers, gates: (cfg.gates ?? []).filter((g) => g.run).map((g) => ({ name: g.name, run: g.run })), build: cfg.prompt?.build ?? 'auto', ...models }))
}

// ───────────────────────── executable surface (S1) ─────────────────────────

const CODE_EXT = /\.(tsx?|mts|cts|jsx?|mjs|cjs|py|sh|bash|rb|deno)$/
const MD_EXEC = /^\s*@(run|call|mcp)\b|<(Run|Call|Mcp)\b/m
const COMPILED_EXEC = /"t"\s*:\s*"(run|call|mcp)"/
const SKIP = new Set(['.trace', 'data', 'proposals', 'node_modules', '.cache', '.git'])
const SURFACE_TTL_MS = 1000
const SURFACE_MAX_FILES = 400

const SURFACE_MAX_DIRS = 100

/** Sessions whose surface listing hit SURFACE_MAX_FILES / SURFACE_MAX_DIRS: files past the cut are not hashed, so a
 *  stored decision cannot vouch for them; such a repo is asked once per session instead (trustState). */
const TRUNCATED = new WeakMap<Runtime, boolean>()

type SurfaceFile = { rel: string; size: number; mtimeMs: number; kind: 'code' | 'md' | 'compiled' }

/** Repo files that can run code: their (path, size, mtime) is the cheap fingerprint, their text the hash. */
async function surfaceFiles(io: Io, rt: Runtime): Promise<{ files: SurfaceFile[]; truncated: boolean }> {
  const dir = configuredPromptDir(rt.cfg ?? {})
  const out: SurfaceFile[] = []
  const queue: string[] = insideRoot(dir) ? [dir] : []
  let dirs = 0
  while (queue.length && dirs < SURFACE_MAX_DIRS && out.length < SURFACE_MAX_FILES) {
    const rel = queue.shift()!
    dirs++
    const entries = await io.fs.list(join(rt.root, rel)).catch(() => [])
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = `${rel}/${e.name}`
      if (e.kind === 'dir' && !e.isLink) { if (!SKIP.has(e.name)) queue.push(p); continue }
      if (e.kind !== 'file') continue
      const inScripts = p.startsWith(`${dir}/scripts/`)
      const inCompiled = p.startsWith(`${dir}/.compiled/`)
      if (inCompiled) { if (e.name.endsWith('.json')) out.push({ rel: p, size: e.size, mtimeMs: e.mtimeMs, kind: 'compiled' }) }
      else if (inScripts || CODE_EXT.test(e.name)) out.push({ rel: p, size: e.size, mtimeMs: e.mtimeMs, kind: 'code' })
      else if (e.name.endsWith('.md')) out.push({ rel: p, size: e.size, mtimeMs: e.mtimeMs, kind: 'md' })
    }
  }
  const truncated = queue.length > 0
  // gate.json `module` providers outside the prompt dir.
  for (const p of Object.values(rt.cfg?.providers ?? {})) {
    if (p.kind !== 'module' || !p.path || !insideRoot(p.path) || p.path.startsWith(`${dir}/`)) continue
    const st = await io.fs.stat?.(join(rt.root, p.path)).catch(() => undefined)
    out.push({ rel: p.path, size: st?.size ?? -1, mtimeMs: st?.mtimeMs ?? -1, kind: 'code' })
  }
  return { files: out, truncated }
}

/** Hash input of the listed files. A file that cannot be read (over the 4 MiB read limit, EACCES) is bound to its
 *  size and mtime, so a change to it still changes the hash. `noCompiled` leaves `.compiled/` out (`sourcesHash`). */
async function surfaceText(io: Io, rt: Runtime, files: readonly SurfaceFile[], noCompiled = false): Promise<string[]> {
  const parts: string[] = []
  for (const f of files) {
    if (noCompiled && f.kind === 'compiled') continue
    const t = await io.fs.read(join(rt.root, f.rel)).catch(() => undefined)
    if (typeof t !== 'string') { parts.push(`${f.rel}\0unreadable\0${f.size}\0${f.mtimeMs}`); continue }
    if (f.kind === 'md' && !MD_EXEC.test(t)) continue
    if (f.kind === 'compiled' && !COMPILED_EXEC.test(t)) continue
    parts.push(`${f.rel}\0${t}`)
  }
  return parts
}

/** sha256 over the executable files' text (Markdown and compiled prompts only when they hold run/call/mcp). Cached
 *  by fingerprint; re-listed at most once a second and after `invalidateSurface`. */
export async function surfaceHash(io: Io, rt: Runtime): Promise<string> {
  if (!rt.root) return ''
  const s = rt.trustSurface
  if (s && s.root === rt.root && now() - s.at < SURFACE_TTL_MS) return s.hash
  const { files, truncated } = await surfaceFiles(io, rt)
  TRUNCATED.set(rt, truncated)
  const fingerprint = files.map((f) => `${f.rel}\0${f.size}\0${f.mtimeMs}`).join('\n')
  if (s && s.root === rt.root && s.fingerprint === fingerprint) {
    rt.trustSurface = { ...s, at: now() }
    return s.hash
  }
  const parts = await surfaceText(io, rt, files)
  const hash = parts.length ? sha256Hex(parts.join('\0\0')) : ''
  rt.trustSurface = { root: rt.root, fingerprint, hash, at: now() }
  return hash
}

/** sha256 of the executable sources without `.compiled/` (uncached): what a build derives `.compiled/` from. */
export async function sourcesHash(io: Io, rt: Runtime): Promise<string> {
  if (!rt.root) return ''
  const { files } = await surfaceFiles(io, rt)
  return sha256Hex(`${commandsHash(rt.config)}\0${(await surfaceText(io, rt, files, true)).join('\0\0')}`)
}

/**
 * After a build the mod ran in a trusted repo (S1): `.compiled/` is gitignored output of trusted sources (Р3), so the
 * stored decision moves to the new surface hash instead of asking again on every clone and rebuild. Only when the
 * sources (`sourcesHash` taken before the build) are unchanged: an edit that landed meanwhile still asks.
 */
export async function rebindAfterBuild(io: Io, rt: Runtime, sourcesBefore: string): Promise<void> {
  invalidateSurface(rt)
  const key = await repoKey(io, rt)
  const cached = rt.trustCache
  if (!cached || cached.key !== key || cached.decision !== 'trusted') return
  const stored = (await io.store.get(`trust:${key}`).catch(() => undefined)) as Stored | undefined
  if (stored?.decision !== 'trusted' || stored.commandsHash !== cached.hash) return
  if ((await sourcesHash(io, rt)) !== sourcesBefore) return
  const h = await trustHash(io, rt)
  if (h === stored.commandsHash) return
  await io.store.set(`trust:${key}`, { ...stored, commandsHash: h, at: now() } satisfies Stored).catch((err: unknown) => debug(io, `trust rebind failed: ${String(err)}`))
  rt.trustCache = { key, hash: h, decision: 'trusted' }
  await io.update('trust', () => json({ decision: 'trusted', key, commandsHash: h }))
}

/** A file under the prompt dir may have changed (an edit, a Bash command, FileChanged): re-list on the next check. */
export function invalidateSurface(rt: Runtime): void {
  if (rt.trustSurface) rt.trustSurface = { ...rt.trustSurface, at: 0 }
}

/** What a trust decision is bound to: gate.json's commands plus the executable files. */
export async function trustHash(io: Io, rt: Runtime): Promise<string> {
  const surface = await surfaceHash(io, rt).catch((err: unknown) => { debug(io, `trust surface: ${String(err)}`); return 'unreadable' })
  const cmds = commandsHash(rt.config)
  return surface ? sha256Hex(`${cmds}\0${surface}`) : cmds
}

export async function repoKey(io: Io, rt: Runtime): Promise<string> {
  const repo = await io.session.repo().catch(() => null)
  return `${repo?.root ?? rt.root}|${repo?.remote ?? ''}`
}

/** Current decision without asking. */
export async function trustState(io: Io, rt: Runtime): Promise<TrustDecision> {
  if (rt.options.trustBuild === 'always') return 'trusted'
  if (rt.options.trustBuild === 'never') return 'denied'
  const key = await repoKey(io, rt)
  const h = await trustHash(io, rt)
  const cached = rt.trustCache
  if (cached && cached.key === key && cached.hash === h) return cached.decision
  const stored = (await io.store.get(`trust:${key}`).catch(() => undefined)) as Stored | undefined
  // A truncated surface listing hides files from the hash: a stored «trusted» cannot vouch for them (a «denied» can).
  const usable = stored && stored.commandsHash === h && !(stored.decision === 'trusted' && TRUNCATED.get(rt))
  if (stored && stored.commandsHash === h && !usable) debug(io, `trust: тека промптів більша за ${SURFACE_MAX_FILES} файлів / ${SURFACE_MAX_DIRS} тек — довіру запитано на цю сесію`)
  const decision: TrustDecision = usable ? stored.decision : 'unknown'
  // The executable code changed under a decision taken this session: ask again on the next prompt (S1).
  if (decision === 'unknown' && cached && cached.key === key && cached.decision !== 'unknown') {
    rt.trustAsked = false
    debug(io, 'trust: виконуваний код репозиторію змінився — довіру буде запитано знову')
  }
  rt.trustCache = { key, hash: h, decision }
  await io.update('trust', () => json({ decision, key, commandsHash: h }))
  return decision
}

/** Decision, asking once per session when interactive. A dismissed question stays unknown (not stored). */
export async function ensureTrust(io: Io, rt: Runtime, opts: { ask: boolean }): Promise<TrustDecision> {
  const current = await trustState(io, rt)
  if (current !== 'unknown' || !opts.ask || !rt.interactive || rt.trustAsked) return current
  rt.trustAsked = true
  let answer: string | undefined
  try {
    answer = await io.ui.ask(TRUST_QUESTION, { header: 'context-gate', options: [TRUST_YES, TRUST_NO] })
  } catch {
    return 'unknown'
  }
  if (answer !== TRUST_YES && answer !== TRUST_NO) return 'unknown'
  const decision: 'trusted' | 'denied' = answer === TRUST_YES ? 'trusted' : 'denied'
  const key = await repoKey(io, rt)
  const h = await trustHash(io, rt)
  const record: Stored = { decision, commandsHash: h, at: now() }
  try {
    await io.store.set(`trust:${key}`, record)
  } catch (err) {
    // A full store (R2): caches go, the decision stays.
    debug(io, `trust store failed: ${String(err)}; кеш очищено, повтор`)
    await clearCacheStore(io)
    await io.store.set(`trust:${key}`, record).catch((err2: unknown) => {
      debug(io, `trust store failed: ${String(err2)}`)
      try { io.ui.toast('context-gate: рішення про довіру не збережено ($.store переповнений) — питання повториться', { timeoutMs: 8000 }) } catch { /* no surface */ }
    })
  }
  rt.trustCache = { key, hash: h, decision }
  await io.update('trust', () => json({ decision, key, commandsHash: h }))
  return decision
}

export async function revokeTrust(io: Io, rt: Runtime): Promise<string> {
  const key = await repoKey(io, rt)
  await io.store.delete(`trust:${key}`).catch(() => undefined)
  rt.trustCache = undefined
  rt.trustAsked = false
  await io.update('trust', () => json({ decision: 'unknown', key, commandsHash: null }))
  return key
}

/** Repo config holds something only trust unlocks (every kind `commandsHash` covers, M25). */
export function needsTrust(cfg: GateConfig | undefined, hasPrompts: boolean, hasScripts: boolean): boolean {
  if (!cfg) return hasPrompts
  const cliModel = [cfg.classify?.provider, cfg.brief?.provider].some((p) => !!p && typeof p === 'object')
  return hasPrompts || hasScripts || cliModel || (cfg.gates ?? []).some((g) => g.run) || Object.keys(cfg.executors ?? {}).length > 0 ||
    Object.values(cfg.providers ?? {}).some((p) => p.kind === 'cli' || p.kind === 'mcp' || p.kind === 'module')
}
