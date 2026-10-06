// RenderHost over $ (MOD-ADAPTER "RenderHost"): files via io.fs (inside the repo only), executors via
// io.process.run (trusted repo + binary whitelist + interactive or userConfig.allowScripts), MCP via
// io.mcp.call (trusted only), cache/data via io.store, lazy includes as registered tools.
// Repo text is data: code reaches executors only as the AST's own `run` code; inputs go through stdin.

import type { ExecutorConfig, MdcRule, Value } from '../../packages/core/src/types.ts'
import type { ProviderCallRequest, RenderHostExt } from '../../packages/core/src/render.ts'
import { hasGlobChars } from '../../packages/core/src/glob.ts'
import { exampleValue, selectExamples } from '../../packages/core/src/examples.ts'
import { cursorMatch } from '../../packages/core/src/assemble.ts'
import { parseDuration } from '../../packages/core/src/duration.ts'
import { binaryWhitelist } from '../../packages/core/src/config.ts'
import { type Io, OWN_TOOL_PREFIX, type Runtime, debug, insideRoot, join, now } from '../ctx.ts'

export const DEFAULT_EXECUTORS: Record<string, ExecutorConfig> = {
  bash: { command: ['bash', '-euo', 'pipefail', '-c', '{code}'], timeout: '10s' },
  sh: { command: ['sh', '-c', '{code}'], timeout: '10s' },
  node: { command: ['node', '--input-type=module', '-e', '{code}'], timeout: '10s' },
  js: { command: ['node', '--input-type=module', '-e', '{code}'], timeout: '10s' },
  python: { command: ['python3', '-c', '{code}'], timeout: '20s', env: { PYTHONDONTWRITEBYTECODE: '1' } },
}

const NODE_SHIM = [
  "import { pathToFileURL } from 'node:url';",
  'const chunks = []; for await (const c of process.stdin) chunks.push(c);',
  'const { path, calls } = JSON.parse(Buffer.concat(chunks).toString() || "{}");',
  'const m = await import(pathToFileURL(path).href);',
  'const out = [];',
  "for (const c of calls) { const f = m[c.fn] ?? m.default?.[c.fn]; if (typeof f !== 'function') throw new Error('no function ' + c.fn); out.push(await f(...c.args, ...(c.kwargs ? [c.kwargs] : []))); }",
  'process.stdout.write(JSON.stringify(out ?? null));',
].join('\n')

const PY_SHIM = [
  'import json, sys, importlib.util',
  'd = json.load(sys.stdin)',
  "spec = importlib.util.spec_from_file_location('cg_module', d['path']); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
  "print(json.dumps([getattr(m, c['fn'])(*c['args'], **(c.get('kwargs') or {})) for c in d['calls']]))",
].join('\n')

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

function fillPlaceholders(argv: readonly string[], args: Value[], kwargs: Record<string, Value>): string[] {
  let i = 0
  return argv.map((a) => a.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = k in kwargs ? kwargs[k] : args[i++]
    return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  }))
}

export interface HostDeps {
  trusted: boolean
  repoKey: string
  /** Section text by id for `prompt://` lazy refs. */
  itemBody: RenderHostExt['itemBody']
  /** Parsed `.mdc` rules for `cursor.match(path)`. */
  rules: () => Promise<MdcRule[]>
}

export function makeRenderHost(io: Io, rt: Runtime, deps: HostDeps): RenderHostExt {
  const cfg = rt.cfg
  const executors = { ...DEFAULT_EXECUTORS, ...(cfg.executors ?? {}) }
  const providers = cfg.providers ?? {}
  const callables = ['fs.examples', 'git.log', 'cursor.match']
  for (const [name, p] of Object.entries(providers)) {
    if (p.kind === 'cli' && p.functions && !Array.isArray(p.functions)) for (const fn of Object.keys(p.functions)) callables.push(`${name}.${fn}`)
  }
  const host: RenderHostExt = {
    trusted: deps.trusted,
    now: () => now(),
    callables,
    async readFile(path) {
      if (!insideRoot(path)) return undefined
      const t = await io.fs.read(join(rt.root, path)).catch(() => undefined)
      return typeof t === 'string' ? t : undefined
    },
    async run(req) {
      const ex = executors[req.lang]
      if (!ex) return { exitCode: -1, stdout: '', stderr: `виконавця «${req.lang}» не оголошено в executors`, ms: 0 }
      const viaStdin = ex.stdin === '{code}'
      const argv = ex.command.map((a) => (a === '{code}' ? req.code : a))
      if (!deps.trusted || !(await allowedBinary(io, rt, argv))) return { exitCode: -1, stdout: '', stderr: 'виконання заборонено (довіра / білий список / allowScripts)', ms: 0 }
      const timeoutMs = Math.min(req.timeoutMs, parseDuration(ex.timeout) ?? req.timeoutMs)
      return runArgv(io, rt, argv, { stdin: viaStdin ? req.code : req.stdin, timeoutMs, env: ex.env })
    },
    async call(req) {
      if (!deps.trusted || !insideRoot(req.path)) throw new Error('виклик заборонено')
      const abs = join(rt.root, req.path)
      const py = /\.py$/.test(req.path)
      const argv = py ? ['python3', '-c', PY_SHIM] : ['node', '--input-type=module', '-e', NODE_SHIM]
      if (!(await allowedBinary(io, rt, argv))) throw new Error(`${argv[0]} не в білому списку або allowScripts вимкнено`)
      const r = await runArgv(io, rt, argv, { stdin: JSON.stringify({ path: abs, calls: req.calls }), timeoutMs: 10_000 })
      if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`)
      const v = parseOut(r.stdout)
      return Array.isArray(v) ? v : [v]
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
      if (req.path === 'fs.examples') return examples(io, rt, String(req.args[0] ?? '**/*'), typeof req.args[1] === 'number' ? req.args[1] : 1)
      if (req.path === 'cursor.match') return cursorMatch(await deps.rules(), String(req.args[0] ?? ''), { nocase: rt.windows })
      if (req.path === 'git.log') {
        const n = Math.max(1, Math.min(50, Number(req.args[0] ?? 5)))
        const r = await runArgv(io, rt, ['git', 'log', '--oneline', `-${n}`], { timeoutMs: 5000 })
        return r.exitCode === 0 ? r.stdout.trim().split('\n').filter(Boolean) : []
      }
      const p = providers[req.ns]
      if (p?.kind === 'cli' && p.functions && !Array.isArray(p.functions)) {
        const argv = p.functions[req.fn]
        if (!argv || !deps.trusted || !(await allowedBinary(io, rt, argv))) return null
        const r = await runArgv(io, rt, fillPlaceholders(argv, req.args, req.kwargs), { timeoutMs: 10_000 })
        if (r.exitCode !== 0) throw new Error(`${req.path}: exit ${r.exitCode}`)
        return parseOut(r.stdout)
      }
      return null
    },
  }
  return host
}

/** Data of config providers (file / cli / mcp) for the render scope, cached per their `cache`. */
export async function providerData(io: Io, rt: Runtime, host: RenderHostExt): Promise<Record<string, Value>> {
  const out: Record<string, Value> = {}
  for (const [name, p] of Object.entries(rt.cfg.providers ?? {})) {
    if (p.builtin || ['git', 'fs', 'cursor', 'gate', 'ctx', 'session'].includes(name)) continue
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
        let parsed: Value = t
        if (/\.json$/i.test(p.path)) parsed = JSON.parse(t) as Value
        if (p.pick && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const src = parsed as Record<string, Value>
          parsed = Object.fromEntries(p.pick.filter((k) => k in src).map((k) => [k, src[k]]))
        }
        v = parsed
      } else if (p.kind === 'cli' && p.command?.length) {
        if (!host.trusted || !(await allowedBinary(io, rt, p.command))) throw new Error('не довірено')
        const r = await runArgv(io, rt, p.command, { timeoutMs: 10_000 })
        if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`)
        v = parseOut(r.stdout)
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
