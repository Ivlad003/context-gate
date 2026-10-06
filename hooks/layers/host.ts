// RenderHost over $ (MOD-ADAPTER "RenderHost"): files via io.fs (inside the repo only), executors via
// io.process.run (trusted repo + binary whitelist + interactive or userConfig.allowScripts), MCP via
// io.mcp.call (trusted only), cache/data via io.store, lazy includes as registered tools.
// Repo text is data: code reaches executors only as the AST's own `run` code; inputs go through stdin.
// Executors, language shims (`@call`, module providers, G158 `__exports__`) and `scripts.*` are core `shims.ts`,
// the same argv `context-gate run` starts.

import type { ExecutorConfig, MdcRule, ProviderConfig, Value } from '../../packages/core/src/types.ts'
import type { ProviderCallRequest, RenderHostExt } from '../../packages/core/src/render.ts'
import { compileGlob, hasGlobChars } from '../../packages/core/src/glob.ts'
import { exampleValue, selectExamples } from '../../packages/core/src/examples.ts'
import { cursorMatch } from '../../packages/core/src/assemble.ts'
import { parseDuration } from '../../packages/core/src/duration.ts'
import { fileProviderValue, pickFields, providerResultOk } from '../../packages/core/src/providers.ts'
import { binaryWhitelist } from '../../packages/core/src/config.ts'
import { DEFAULT_EXECUTORS as CORE_EXECUTORS, executorFor, executorInvocation, executorsOf, parseShimOutput, scriptArgv, scriptFnName, scriptLang, scriptStdin, shimCommand, type ShimCall, type ShimResponse } from '../../packages/core/src/shims.ts'
import { type Io, OWN_TOOL_PREFIX, type Runtime, debug, hash, insideRoot, join, now } from '../ctx.ts'

/** The executors `@run` knows without gate.json (core, same as the CLI). */
export const DEFAULT_EXECUTORS: Record<string, ExecutorConfig> = CORE_EXECUTORS

/** Provider names the scope owns; config entries under these names are not providers (CLI `BUILTIN_PROVIDERS`). */
export const BUILTIN_PROVIDERS = new Set(['git', 'fs', 'cursor', 'session', 'gate', 'ctx', 'scripts', 'data', 'args', 'budgets'])

/** User `~/.claude/context-gate.json` `allowBinaries` (or core DEFAULT_BINARIES), narrowed by gate.json `allowBinaries`: core `binaryWhitelist`, as the CLI. */
export async function loadWhitelist(io: Io, rt: Runtime): Promise<string[]> {
  if (rt.whitelist) return rt.whitelist
  let user: string[] | undefined
  try {
    const home = await io.env.home()
    if (home) {
      const t = await io.fs.read(`${home}/.claude/context-gate.json`).catch(() => undefined)
      if (typeof t === 'string') {
        const v = JSON.parse(t) as { allowBinaries?: unknown }
        if (Array.isArray(v.allowBinaries)) user = v.allowBinaries.filter((x): x is string => typeof x === 'string')
      }
    }
  } catch (err) {
    debug(io, `whitelist read failed: ${String(err)}`)
  }
  rt.whitelist = binaryWhitelist(user, rt.cfg?.allowBinaries)
  return rt.whitelist
}

const binOf = (argv: readonly string[]): string => (argv[0] ?? '').split(/[\\/]/).pop() ?? ''

/** May repo config start this argv? (trust is checked by the caller). */
export async function allowedBinary(io: Io, rt: Runtime, argv: readonly string[]): Promise<boolean> {
  if (!rt.interactive && !rt.options.allowScripts) return false
  return (await loadWhitelist(io, rt)).includes(binOf(argv))
}

export async function runArgv(io: Io, rt: Runtime, argv: string[], init: { stdin?: string; timeoutMs: number; env?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string; ms: number }> {
  const t0 = now()
  try {
    const r = await io.process.run(argv, { cwd: rt.root, timeoutMs: Math.max(100, Math.min(init.timeoutMs, 600_000)), ...(init.stdin !== undefined ? { stdin: init.stdin } : {}), ...(init.env ? { env: init.env } : {}) })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, ms: now() - t0 }
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: String((err as Error)?.message ?? err), ms: now() - t0 }
  }
}

function parseOut(stdout: string): Value {
  const t = stdout.trim()
  if (!t) return ''
  try { return JSON.parse(t) as Value } catch { return t }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.compiled', '.cache', '.next', 'coverage', '__pycache__', '.venv'])

/** Repo files under `base` (repo-relative POSIX, sorted), skipping the CLI's `walkFiles` dirs; bounded. */
export async function walkRepo(io: Io, rt: Runtime, base = '', limits: { dirs?: number; files?: number } = {}): Promise<string[]> {
  if (!insideRoot(base || '.')) return []
  const out: string[] = []
  const maxDirs = limits.dirs ?? 2000
  const maxFiles = limits.files ?? 20_000
  const queue: string[] = [base]
  let visited = 0
  while (queue.length && visited < maxDirs && out.length < maxFiles) {
    const rel = queue.shift()!
    visited++
    const entries = [...(await io.fs.list(rel ? join(rt.root, rel) : rt.root).catch(() => []))].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.kind === 'dir' && !e.isLink) { if (!SKIP_DIRS.has(e.name)) queue.push(p) }
      else if (e.kind === 'file') out.push(p)
    }
  }
  return out.sort()
}

/** Walk the static prefix of a glob, then core `selectExamples` / `exampleValue` (the CLI's `fs.examples` too). */
async function examples(io: Io, rt: Runtime, glob: string, n: number): Promise<Value> {
  const segs = glob.split('/')
  const prefix: string[] = []
  for (const s of segs) { if (hasGlobChars(s)) break; prefix.push(s) }
  if (prefix.length === segs.length) prefix.pop()
  const base = prefix.join('/')
  if (!insideRoot(base || '.')) return []
  const found: { path: string; size: number }[] = []
  const queue: { rel: string; depth: number }[] = [{ rel: base, depth: 0 }]
  let visited = 0
  while (queue.length && visited < 300) {
    const { rel, depth } = queue.shift()!
    visited++
    const entries = await io.fs.list(rel ? join(rt.root, rel) : rt.root).catch(() => [])
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.kind === 'dir' && !e.isLink && depth < 8 && !e.name.startsWith('.') && e.name !== 'node_modules') queue.push({ rel: p, depth: depth + 1 })
      else if (e.kind === 'file') found.push({ path: p, size: e.size })
    }
  }
  const out: Value[] = []
  for (const f of selectExamples(found, glob, Math.min(n, 20))) {
    const body = await io.fs.read(join(rt.root, f.path)).catch(() => '')
    out.push(exampleValue(f, typeof body === 'string' ? body : ''))
  }
  return out
}

/** `fs.glob(pattern)`: repo files matching a glob (a slash-less pattern matches the basename), as the CLI. */
async function globFiles(io: Io, rt: Runtime, pattern: string): Promise<Value> {
  if (!pattern) return []
  const segs = pattern.split('/')
  const prefix: string[] = []
  for (const s of segs) { if (hasGlobChars(s)) break; prefix.push(s) }
  if (prefix.length === segs.length) prefix.pop()
  const m = compileGlob(pattern, { matchBase: true })
  const base = pattern.includes('/') && !pattern.startsWith('!') ? prefix.join('/') : ''
  return (await walkRepo(io, rt, base)).filter((f) => m(f))
}

/** CLI `fill`: `{0}` positional, `{name}` kwargs, `{x}` the next positional. */
function fillPlaceholders(argv: readonly string[], args: Value[], kwargs: Record<string, Value>): string[] {
  let i = 0
  const str = (v: Value | undefined): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))
  return argv.map((a) => a.replace(/\{(\w+)\}/g, (_m, k: string) => {
    if (/^\d+$/.test(k)) return str(args[Number(k)])
    if (k in kwargs) return str(kwargs[k])
    return str(args[i++])
  }))
}

/** gate.json providers plus `<prompt dir>/lib/*.{ts,mts,js,mjs}` as `module` providers named by file (as the CLI). */
export async function providerConfigs(io: Io, rt: Runtime, promptDir: string): Promise<Record<string, ProviderConfig>> {
  const out: Record<string, ProviderConfig> = { ...(rt.cfg.providers ?? {}) }
  const lib = `${promptDir}/lib`
  const entries = await io.fs.list(join(rt.root, lib)).catch(() => [])
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const m = e.kind === 'file' ? /^([\w-]+)\.(ts|mts|js|mjs)$/.exec(e.name) : null
    if (m && !out[m[1]]) out[m[1]] = { kind: 'module', path: `${lib}/${e.name}` }
  }
  return out
}

export interface HostDeps {
  trusted: boolean
  repoKey: string
  /** Section text by id for `prompt://` lazy refs. */
  itemBody: RenderHostExt['itemBody']
  /** Parsed `.mdc` rules for `cursor.match(path)`. */
  rules: () => Promise<MdcRule[]>
  /** Prompt dir (`.claude/prompt`): `scripts/` for `scripts.*`. */
  promptDir?: string
  /** Providers from `providerConfigs` (default: gate.json providers only). */
  providers?: Record<string, ProviderConfig>
}

/** The mod's RenderHost, plus the shim helpers the layers use for module tools and G158. */
export interface ModHost extends RenderHostExt {
  /** One shim batch into a repo module; per-call errors in `errors[i]`. */
  shim(path: string, calls: ShimCall[], timeoutMs?: number): Promise<ShimResponse>
  /** Exported function names of a module (G158), asked once per session; undefined when the shim can't tell. */
  listExports(path: string): Promise<string[] | undefined>
  /** Effective providers (config + lib modules). */
  providerConfigs: Record<string, ProviderConfig>
}

export function makeRenderHost(io: Io, rt: Runtime, deps: HostDeps): ModHost {
  const cfg = rt.cfg
  const executors = executorsOf(cfg)
  const providers = deps.providers ?? cfg.providers ?? {}
  const promptDir = deps.promptDir ?? (cfg.prompt?.dir ?? '.claude/prompt').replace(/\/+$/, '')
  const callables = ['git.log', 'fs.examples', 'fs.glob', 'fs.exists', 'cursor.match', 'scripts.*']
  for (const [name, p] of Object.entries(providers)) if (!p.builtin && !BUILTIN_PROVIDERS.has(name)) callables.push(`${name}.*`)

  const cached = async (key: string, ttl: string | undefined, compute: () => Promise<Value | undefined>): Promise<Value | undefined> => {
    const ttlMs = parseDuration(ttl)
    if (ttlMs !== undefined) {
      const e = await host.cacheGet!(key)
      if (e && now() - e.at <= ttlMs) return e.value
    }
    const v = await compute()
    if (v !== undefined && ttlMs !== undefined) await host.cacheSet!(key, v)
    return v
  }

  const moduleCall = async (name: string, p: ProviderConfig, fn: string, args: Value[], kwargs: Record<string, Value>): Promise<Value> => {
    if (!deps.trusted || !p.path) return null
    const key = `prov:${name}:${fn}:${hash(JSON.stringify([args, kwargs]))}`
    const v = await cached(key, p.cache, async () => {
      const r = await host.shim(p.path!, [{ fn, args, kwargs }])
      if (r.errors[0]) { debug(io, `provider ${name}.${fn}: ${r.errors[0]}`); return undefined }
      return r.results[0] ?? null
    })
    return v === undefined ? null : v
  }

  /** `scripts.<fn>(…)`: run `<prompt dir>/scripts/<fn>.*` with `{ ctx, args }` on stdin (CLI `Providers.script`). */
  const script = async (fn: string, args: Value[], kwargs: Record<string, Value>): Promise<Value> => {
    const dir = `${promptDir}/scripts`
    const file = (await walkRepo(io, rt, dir, { dirs: 50, files: 500 })).find((f) => scriptFnName(f) === fn)
    if (!file) { debug(io, `scripts.${fn}: скрипт не знайдено в ${dir}`); return null }
    if (!deps.trusted) return null
    const t = await io.fs.read(join(rt.root, file)).catch(() => undefined)
    const text = typeof t === 'string' ? t : ''
    const argv = scriptArgv(join(rt.root, file), scriptLang(file, text))
    if (!(await allowedBinary(io, rt, argv))) { debug(io, `scripts.${fn}: ${argv[0]} поза білим списком`); return null }
    const key = `scripts:${fn}:${hash(text)}:${hash(JSON.stringify([args, kwargs]))}`
    const v = await cached(key, cfg.prompt?.runCacheDefault ?? '5m', async () => {
      const r = await runArgv(io, rt, argv, { stdin: scriptStdin(args, kwargs), timeoutMs: 10_000 })
      if (r.exitCode !== 0) { debug(io, `scripts.${fn}: exit ${r.exitCode}: ${r.stderr.trim().split('\n')[0] ?? ''}`); return undefined }
      const out = r.stdout.trim()
      if (!out) return null
      try { return JSON.parse(out) as Value } catch { return out }
    })
    return v ?? null
  }

  const host: ModHost = {
    trusted: deps.trusted,
    now: () => now(),
    callables,
    providerConfigs: providers,
    async readFile(path) {
      if (!insideRoot(path)) return undefined
      const t = await io.fs.read(join(rt.root, path)).catch(() => undefined)
      return typeof t === 'string' ? t : undefined
    },
    async run(req) {
      const ex = executorFor(executors, req.lang)
      if (!ex) return { exitCode: -1, stdout: '', stderr: `виконавця «${req.lang}» не оголошено в executors`, ms: 0 }
      const inv = executorInvocation(ex, req.code, req.stdin)
      if (!deps.trusted || !(await allowedBinary(io, rt, inv.argv))) return { exitCode: -1, stdout: '', stderr: 'виконання заборонено (довіра / білий список / allowScripts)', ms: 0 }
      const timeoutMs = Math.min(req.timeoutMs, parseDuration(ex.timeout) ?? req.timeoutMs)
      return runArgv(io, rt, inv.argv, { stdin: inv.stdin, timeoutMs, env: { ...(ex.env ?? {}), CONTEXT_GATE_INPUT: req.stdin, CONTEXT_GATE_ROOT: rt.root } })
    },
    async shim(path, calls, timeoutMs = 10_000) {
      const fail = (msg: string): ShimResponse => ({ results: calls.map(() => null), errors: calls.map(() => msg) })
      if (!deps.trusted) return fail('репозиторій не довірений')
      if (!insideRoot(path)) return fail(`модуль ${path} поза репозиторієм`)
      const file = join(rt.root, path)
      if (!(await io.fs.exists(file).catch(() => false))) return fail(`модуль ${path} не знайдено`)
      const cmd = shimCommand(path, file, calls, executors)
      if (!cmd.ok) return fail(cmd.error)
      if (!(await allowedBinary(io, rt, cmd.argv))) return fail(`${cmd.argv[0]} не в білому списку або allowScripts вимкнено`)
      const r = await runArgv(io, rt, cmd.argv, { stdin: cmd.stdin, timeoutMs })
      return parseShimOutput(cmd, r, calls)
    },
    async call(req) {
      if (!deps.trusted || !insideRoot(req.path)) throw new Error('виклик заборонено')
      const r = await host.shim(req.path, req.calls)
      const err = r.errors.find((e) => e)
      if (err) throw new Error(err)
      return r.results
    },
    async listExports(path) {
      if (rt.moduleExports.has(path)) return rt.moduleExports.get(path) ?? undefined
      const r = await host.shim(path, [{ fn: '__exports__', args: [] }])
      const v = r.results[0]
      const names = !r.errors[0] && Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
      rt.moduleExports.set(path, names)
      return names ?? undefined
    },
    async mcp(req) {
      if (!deps.trusted) throw new Error('репозиторій не довірений')
      const r = await io.mcp.call(req.server, req.tool, req.args)
      if (r.isError) throw new Error(`MCP ${req.server}.${req.tool} повернув помилку`)
      if (r.structuredContent !== undefined) return r.structuredContent as Value
      const text = r.content.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('\n')
      return parseOut(text)
    },
    async cacheGet(key) {
      const v = (await io.store.get(`cache:${deps.repoKey}:${key}`).catch(() => undefined)) as { value: Value; at: number } | undefined
      return v && typeof v.at === 'number' ? v : undefined
    },
    async cacheSet(key, value) {
      const s = JSON.stringify(value)
      if (s.length > 64_000) return
      await io.store.set(`cache:${deps.repoKey}:${key}`, { value, at: now() }).catch(() => undefined)
    },
    registerLazy(name, description, ref) {
      const full = `${OWN_TOOL_PREFIX}${name}`
      const known = rt.tools.get(full)
      if (known && known.kind === 'lazy' && known.ref === ref) return
      rt.tools.set(full, { kind: 'lazy', ref, description })
      void io.tool.register({ name, description: `${description} (context-gate: повертає текст включення)`, inputSchema: { type: 'object', properties: {}, additionalProperties: false } })
        .catch((err: unknown) => debug(io, `lazy tool ${name}: ${String(err)}`))
    },
    itemBody: deps.itemBody,
    async provider(req: ProviderCallRequest) {
      const { ns, fn, args, kwargs } = req
      if (req.path === 'fs.examples') return examples(io, rt, String(args[0] ?? '**/*'), typeof args[1] === 'number' ? args[1] : 1)
      if (req.path === 'fs.glob') return globFiles(io, rt, String(args[0] ?? ''))
      if (req.path === 'fs.exists') {
        const p = String(args[0] ?? '')
        return !!p && insideRoot(p) && (await io.fs.exists(join(rt.root, p)).catch(() => false))
      }
      if (req.path === 'cursor.match') return cursorMatch(await deps.rules(), String(args[0] ?? ''), { nocase: rt.windows })
      if (req.path === 'git.log') {
        const n = Math.max(1, Math.min(50, Number(args[0] ?? 5)))
        const r = await runArgv(io, rt, ['git', 'log', '--oneline', `-${n}`], { timeoutMs: 5000 })
        return r.exitCode === 0 ? r.stdout.trim().split('\n').filter(Boolean) : []
      }
      if (ns === 'scripts') return script(fn, args, kwargs)
      const p = providers[ns]
      if (!p || p.builtin) return null
      if (p.kind === 'cli') {
        const fns = p.functions
        const tpl = fns && !Array.isArray(fns) ? fns[fn] : undefined
        const argv = tpl ? fillPlaceholders(tpl, args, kwargs) : Array.isArray(fns) && fns.includes(fn) && p.command ? [...p.command, fn, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))] : undefined
        if (!argv || !deps.trusted || !(await allowedBinary(io, rt, argv))) return null
        const r = await runArgv(io, rt, argv, { timeoutMs: 10_000 })
        const res = providerResultOk(p, r.exitCode, r.stdout) // okExitCodes / parseOnError (eslint -f json exits 1)
        if (!res.ok) throw new Error(`${req.path}: ${res.error}`)
        return res.value
      }
      if (p.kind === 'module') return moduleCall(ns, p, fn, args, kwargs)
      return null
    },
  }
  return host
}

/** Data of providers (file / cli / module / mcp) for the render scope, cached per their `cache`.
 * `host.providerConfigs` (a `ModHost`) adds the `lib/` modules; `only` reads one provider (gates.ts). */
export async function providerData(io: Io, rt: Runtime, host: RenderHostExt & { providerConfigs?: Record<string, ProviderConfig> }, only?: string): Promise<Record<string, Value>> {
  const out: Record<string, Value> = {}
  for (const [name, p] of Object.entries(host.providerConfigs ?? rt.cfg.providers ?? {})) {
    if (only !== undefined && name !== only) continue // gates[].provider reads one provider (gates.ts)
    if (p.builtin || BUILTIN_PROVIDERS.has(name)) continue
    try {
      const cacheMs = parseDuration(p.cache)
      const key = `provider:${name}`
      if (cacheMs !== undefined) {
        const c = await host.cacheGet?.(key)
        if (c && now() - c.at <= cacheMs) { out[name] = c.value; continue }
      }
      let v: Value = null
      if (p.kind === 'file' && p.path) {
        const t = await host.readFile(p.path)
        if (t === undefined) throw new Error(`немає файлу ${p.path}`)
        const f = fileProviderValue(p.path, t, p.pick) // core: .json parsed + dotted `pick`, else the text
        if ('error' in f) throw new Error(f.error)
        v = 'value' in f ? f.value : t
      } else if (p.kind === 'cli' && p.command?.length) {
        if (!host.trusted || !(await allowedBinary(io, rt, p.command))) throw new Error('не довірено')
        const r = await runArgv(io, rt, p.command, { timeoutMs: 10_000 })
        const res = providerResultOk(p, r.exitCode, r.stdout)
        if (!res.ok) throw new Error(res.error)
        v = pickFields(res.value, p.pick)
      } else if (p.kind === 'module' && p.path) {
        // Repo module (`<prompt dir>/lib/*.ts`, gate.json `module`): its default export through the node shim.
        const shim = (host as Partial<ModHost>).shim
        if (!host.trusted || !shim) throw new Error('не довірено')
        const r = await shim(p.path, [{ fn: '__default__', args: [] }])
        if (r.errors[0]) throw new Error(r.errors[0])
        v = pickFields(r.results[0] ?? null, p.pick)
      } else if (p.kind === 'mcp' && p.tool && host.mcp) {
        const m = /^mcp__(.+?)__(.+)$/.exec(p.tool)
        if (!m) throw new Error(`tool ${p.tool}`)
        v = await host.mcp({ server: m[1], tool: m[2], args: (p.args ?? {}) as Record<string, Value> })
      } else continue
      out[name] = v
      if (cacheMs !== undefined) await host.cacheSet?.(key, v)
    } catch (err) {
      debug(io, `provider ${name}: ${String((err as Error)?.message ?? err)}`)
      if (p.onError === 'fail' || p.onError === 'skip') continue
      out[name] = { unverified: true }
    }
  }
  return out
}
