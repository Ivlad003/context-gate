// Language shims and executors shared by the CLI (`host-node.ts`) and the mod (`hooks/layers/host.ts`), so
// `@run`, `@call` and `scripts.*` start the same argv on both hosts (SPEC «Виконавці скриптів», «Виклик функцій
// зі скриптових мов»). Pure strings and functions: no Node.
//
// Shim protocol: one process per module and batch, JSON in on stdin (`{ file, calls: [{ fn, args, kwargs }] }`),
// JSON out on stdout (`{ results, errors }`). `fn: "__exports__"` lists exported functions (G158 validation);
// `fn: "__default__"` gives the default export. bash takes its calls on argv instead (`bashArgv`).

import type { ExecutorConfig, Node, Value } from './types.ts'

export interface ShimCall { fn: string; args: Value[]; kwargs?: Record<string, Value> }
export interface ShimRequest { file: string; calls: ShimCall[] }
export interface ShimResponse { results: Value[]; errors: (string | null)[] }

export const DEFAULT_EXECUTORS: Record<string, ExecutorConfig> = {
  bash: { command: ['bash', '-euo', 'pipefail', '-c', '{code}'], timeout: '10s' },
  node: { command: ['node', '--input-type=module', '-e', '{code}'], timeout: '10s' },
  python: { command: ['python3', '-c', '{code}'], timeout: '20s', env: { PYTHONDONTWRITEBYTECODE: '1' } },
  deno: { command: ['deno', 'run', '--no-prompt', '--allow-read=.', '-'], stdin: '{code}', timeout: '10s' },
}

export const LANG_ALIASES: Record<string, string> = { sh: 'bash', js: 'node', javascript: 'node', ts: 'node', typescript: 'node', py: 'python', python3: 'python' }

export function executorsOf(config: { executors?: Record<string, ExecutorConfig> } | undefined): Record<string, ExecutorConfig> {
  return { ...DEFAULT_EXECUTORS, ...(config?.executors ?? {}) }
}

/** Executor for a `@run` language (aliases resolved), or undefined (G202). */
export function executorFor(executors: Record<string, ExecutorConfig>, lang: string): ExecutorConfig | undefined {
  return executors[LANG_ALIASES[lang] ?? lang] ?? executors[lang]
}

/** argv and stdin of a `@run` block: `{code}` is substituted in the command, or in `stdin` when the executor takes code there. */
export function executorInvocation(ex: ExecutorConfig, code: string, stdin: string): { argv: string[]; stdin: string } {
  const viaStdin = ex.stdin !== undefined && ex.stdin.includes('{code}')
  return { argv: ex.command.map((a) => a.split('{code}').join(code)), stdin: viaStdin ? ex.stdin!.split('{code}').join(code) : stdin }
}

export const NODE_SHIM = `
import { pathToFileURL } from 'node:url';
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const req = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
const results = [], errors = [];
const toJson = (v) => { if (v === undefined) return null; try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); } };
let mod;
try { mod = await import(pathToFileURL(req.file).href); }
catch (e) { process.stdout.write(JSON.stringify({ results: req.calls.map(() => null), errors: req.calls.map(() => 'import: ' + (e && e.message || e)) })); process.exit(0); }
const pick = (name) => (name in mod ? mod[name] : (mod.default && typeof mod.default === 'object' ? mod.default[name] : undefined));
for (const c of req.calls) {
  try {
    if (c.fn === '__exports__') {
      const names = new Set(Object.keys(mod).filter((k) => typeof mod[k] === 'function'));
      if (mod.default && typeof mod.default === 'object') for (const k of Object.keys(mod.default)) if (typeof mod.default[k] === 'function') names.add(k);
      results.push([...names].filter((k) => k !== 'default').sort()); errors.push(null); continue;
    }
    if (c.fn === '__default__') {
      const d = mod.default;
      results.push(toJson(typeof d === 'function' ? await d(...(c.args || [])) : d)); errors.push(null); continue;
    }
    const f = pick(c.fn);
    if (typeof f !== 'function') throw new Error('функції ' + c.fn + ' немає в модулі');
    const args = [...(c.args || [])];
    if (c.kwargs && Object.keys(c.kwargs).length) args.push(c.kwargs);
    results.push(toJson(await f(...args))); errors.push(null);
  } catch (e) { results.push(null); errors.push(String(e && e.message || e)); }
}
process.stdout.write(JSON.stringify({ results, errors }));
`

export const PYTHON_SHIM = `
import importlib.util, json, sys, inspect, dataclasses
req = json.loads(sys.stdin.read() or '{}')
results, errors = [], []
def conv(o):
    if dataclasses.is_dataclass(o) and not isinstance(o, type): return dataclasses.asdict(o)
    if hasattr(o, 'model_dump'): return o.model_dump()
    if hasattr(o, 'dict') and callable(o.dict): return o.dict()
    if isinstance(o, (set, tuple)): return list(o)
    if hasattr(o, '__dict__'): return o.__dict__
    return str(o)
try:
    sys.path.insert(0, __import__('os').path.dirname(req['file']))
    spec = importlib.util.spec_from_file_location('cg_module', req['file'])
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
except Exception as e:
    print(json.dumps({'results': [None for _ in req['calls']], 'errors': ['import: ' + str(e) for _ in req['calls']]}))
    sys.exit(0)
for c in req['calls']:
    try:
        if c['fn'] == '__exports__':
            results.append(sorted(n for n, v in vars(mod).items() if callable(v) and not n.startswith('_') and getattr(v, '__module__', None) == mod.__name__)); errors.append(None); continue
        f = getattr(mod, c['fn'], None)
        if not callable(f): raise Exception('функції ' + c['fn'] + ' немає в модулі')
        results.append(json.loads(json.dumps(f(*c.get('args', []), **(c.get('kwargs') or {})), default=conv, allow_nan=False))); errors.append(None)
    except Exception as e:
        results.append(None); errors.append(str(e))
print(json.dumps({'results': results, 'errors': errors}, default=conv))
`

/**
 * bash: `source file`, then for each call `fn arg…` with string args from argv
 * (`<file> <fn> <nargs> <args…> <fn> …`); outputs NUL-separated, prefixed with the exit code.
 */
export const BASH_SHIM = `
file="$1"; shift
__cg_argv=("$@"); set --
__cg_before="$(compgen -A function | sort)"
# shellcheck disable=SC1090
source "$file" >/dev/null || { printf 'E\\x1fsource failed\\0'; exit 0; }
# The module's \`set -euo pipefail\` must not end the batch: the loop runs without it, and each call gets the
# module's options back inside its own subshell, so a failing call reports its exit code and the next one still runs.
# (\`set +o\` runs in a command substitution, which drops errexit, so errexit is read from \$- here.)
__cg_opts="$(set +o)"; case $- in *e*) __cg_opts="$__cg_opts; set -e" ;; esac
set +e +u +o pipefail
set -- \${__cg_argv[@]+"\${__cg_argv[@]}"}
while [ "$#" -gt 0 ]; do
  fn="$1"; n="$2"; shift 2
  args=("\${@:1:$n}"); shift "$n"
  if [ "$fn" = "__exports__" ]; then
    printf 'O\\x1f%s\\0' "$(comm -13 <(printf '%s\\n' "$__cg_before") <(compgen -A function | sort) | grep -v '^__cg' | tr '\\n' ' ')"
    continue
  fi
  if ! declare -F "$fn" >/dev/null; then printf 'E\\x1fфункції %s немає в модулі\\0' "$fn"; continue; fi
  out="$(eval "$__cg_opts"; "$fn" \${args[@]+"\${args[@]}"})"; code=$?
  if [ "$code" -eq 0 ]; then printf 'O\\x1f%s\\0' "$out"; else printf 'E\\x1fexit %s\\0' "$code"; fi
done
`

/** bash argv for a batch: string args only (objects as JSON, null as empty). */
export function bashArgv(req: ShimRequest): string[] {
  const out = [req.file]
  for (const c of req.calls) {
    const args = [...c.args, ...Object.entries(c.kwargs ?? {}).map(([k, v]) => `--${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)]
    out.push(c.fn, String(args.length), ...args.map((a) => (a === null ? '' : typeof a === 'string' ? a : typeof a === 'object' ? JSON.stringify(a) : String(a))))
  }
  return out
}

function parseLoose(s: string): Value {
  const t = s.replace(/\n+$/, '')
  const x = t.trim()
  if (x && /^[{["]|^(true|false|null)$/.test(x)) { try { return JSON.parse(x) as Value } catch { /* text */ } }
  // A number only when it prints back exactly (render.ts parseStdout, M60): `1.10`, `1e3` and long ids stay text.
  if (/^-?\d/.test(x)) {
    try {
      const v: unknown = JSON.parse(x)
      if (typeof v === 'number' && Number.isFinite(v) && String(v) === x) return v
    } catch { /* text */ }
  }
  return t
}

export function parseBashOutput(stdout: string, calls: ShimCall[]): ShimResponse {
  const parts = stdout.split('\0')
  const results: Value[] = []
  const errors: (string | null)[] = []
  for (let i = 0; i < calls.length; i++) {
    const p = parts[i]
    if (p === undefined) { results.push(null); errors.push('немає результату'); continue }
    const [tag, ...rest] = p.split('\x1f')
    const body = rest.join('\x1f')
    if (tag === 'O') {
      if (calls[i]!.fn === '__exports__') results.push(body.split(/\s+/).filter(Boolean).sort())
      else results.push(parseLoose(body))
      errors.push(null)
    } else { results.push(null); errors.push(body || 'помилка') }
  }
  return { results, errors }
}

/** Shim language for a module path, by extension. */
export function shimLang(path: string): 'node' | 'python' | 'bash' | undefined {
  const ext = /\.([\w]+)$/.exec(path)?.[1]?.toLowerCase()
  if (!ext) return undefined
  if (['js', 'mjs', 'cjs', 'ts', 'mts'].includes(ext)) return 'node'
  if (ext === 'py') return 'python'
  if (ext === 'sh' || ext === 'bash') return 'bash'
  return undefined
}

export type ShimCommand =
  | { ok: true; lang: 'node' | 'python' | 'bash' | 'template'; argv: string[]; stdin: string }
  | { ok: false; error: string }

/**
 * The process that serves a batch of calls into the module at absolute `file` (`path` is the name used for the
 * language): node / python / bash shims, else the `callTemplate` of the executor named by the extension.
 */
export function shimCommand(path: string, file: string, calls: ShimCall[], executors: Record<string, ExecutorConfig>): ShimCommand {
  const lang = shimLang(path)
  const stdin = JSON.stringify({ file, calls })
  if (lang === 'node') return { ok: true, lang, argv: ['node', '--input-type=module', '-e', NODE_SHIM], stdin }
  if (lang === 'python') return { ok: true, lang, argv: ['python3', '-c', PYTHON_SHIM], stdin }
  if (lang === 'bash') return { ok: true, lang, argv: ['bash', '-c', BASH_SHIM, 'cg-shim', ...bashArgv({ file, calls })], stdin: '' }
  const ext = /\.([\w]+)$/.exec(path)?.[1] ?? ''
  const ex = Object.entries(executors).find(([k, e]) => e.callTemplate && (k === ext || LANG_ALIASES[ext] === k))?.[1]
  if (!ex?.callTemplate) return { ok: false, error: `немає shim для ${path} (додай executors.<мова>.callTemplate)` }
  return { ok: true, lang: 'template', argv: ex.callTemplate.map((a) => a.split('{file}').join(file)), stdin }
}

/** Shim stdout → per-call results; a non-zero exit or non-JSON output fails every call. */
export function parseShimOutput(cmd: { lang: string }, r: { exitCode: number; stdout: string; stderr: string }, calls: ShimCall[]): ShimResponse {
  const fail = (msg: string): ShimResponse => ({ results: calls.map(() => null), errors: calls.map(() => msg) })
  if (cmd.lang === 'bash') return parseBashOutput(r.stdout, calls)
  if (r.exitCode !== 0) return fail(`exit ${r.exitCode}: ${r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`)
  try {
    const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as ShimResponse | Value[]
    if (Array.isArray(out)) return { results: out, errors: out.map(() => null) }
    if (!out || !Array.isArray(out.results)) return fail(`shim повернув не JSON: ${r.stdout.slice(0, 200)}`)
    return { results: out.results, errors: Array.isArray(out.errors) ? out.errors : out.results.map(() => null) }
  } catch {
    return fail(`shim повернув не JSON: ${r.stdout.slice(0, 200)}`)
  }
}

// ───────────────────────── scripts provider ─────────────────────────

const EXT_LANG: Record<string, string> = {
  sh: 'bash', bash: 'bash', js: 'node', mjs: 'node', cjs: 'node', ts: 'node', mts: 'node', py: 'python', rb: 'ruby', php: 'php', deno: 'deno',
}

/** Language of a script: shebang first (`#!/usr/bin/env python3` → python), then the extension. */
export function scriptLang(path: string, text?: string): string | undefined {
  const first = text?.split('\n', 1)[0] ?? ''
  if (first.startsWith('#!')) {
    const parts = first.slice(2).trim().split(/\s+/)
    let bin = (parts[0] ?? '').split('/').pop() ?? ''
    if (bin === 'env') bin = (parts.find((p, i) => i > 0 && !p.startsWith('-')) ?? '').split('/').pop() ?? ''
    if (/^python/.test(bin)) return 'python'
    if (/^(ba|z|)sh$/.test(bin)) return 'bash'
    if (bin === 'node' || bin === 'tsx') return 'node'
    if (bin === 'deno') return 'deno'
    if (bin) return bin
  }
  const ext = /\.([\w]+)$/.exec(path)?.[1]?.toLowerCase()
  return ext ? EXT_LANG[ext] : undefined
}

/** Function name of a script file: base name without extension, `-` → `_`. */
export function scriptFnName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_')
}

/** Interpreter argv of a script file (`scripts.<name>()`, script tools): by `scriptLang`, `sh` when unknown. */
export function scriptArgv(absPath: string, lang: string | undefined): string[] {
  const interp: Record<string, string[]> = { bash: ['bash'], node: ['node'], python: ['python3'], deno: ['deno', 'run', '--no-prompt', '--allow-read=.'] }
  return [...(interp[lang ?? ''] ?? [lang ?? 'sh']), absPath]
}

/** `scripts.<fn>` stdin: the context and the call arguments (kwargs as a trailing object). */
export function scriptStdin(args: Value[], kwargs: Record<string, Value>, ctx: Value = {}): string {
  return JSON.stringify({ ctx, args: Object.keys(kwargs).length ? [...args, kwargs] : args })
}

// ───────────────────────── G158: used functions ─────────────────────────

function walkNodes(nodes: readonly Node[], fn: (n: Node) => void): void {
  for (const n of nodes) {
    fn(n)
    if (n.t === 'if') { walkNodes(n.then, fn); if (n.else) walkNodes(n.else, fn) }
    else if ('children' in n && Array.isArray(n.children)) walkNodes(n.children, fn)
  }
}

/** Module path → functions the prompts call through `use` bindings (`Call`, `ns.fn(` in expressions). */
export function usedFunctions(prompts: readonly { uses?: Record<string, string>; sections: { children: Node[] }[]; skill?: { body: Node[] } }[]): Map<string, Set<string>> {
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
  return want
}

/** G158 diagnostics: called functions a module does not export. */
export function missingExports(path: string, called: Iterable<string>, exports: readonly string[]): { code: 'G158'; severity: 'error'; message: string; path: string }[] {
  const out: { code: 'G158'; severity: 'error'; message: string; path: string }[] = []
  for (const fn of called) if (!exports.includes(fn)) out.push({ code: 'G158', severity: 'error', message: `Функції ${fn} немає в модулі ${path} (експорти: ${exports.join(', ') || '—'})`, path })
  return out
}

/** S5/L33: variables that change which code an allowed binary runs; a repo's `executors[].env` may not set them. */
export const UNSAFE_EXECUTOR_ENV = /^(PATH|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|BASH_ENV|ENV|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|LD_.*|DYLD_.*)$/i

/** `executors[].env` without the unsafe keys; `dropped` names them for a debug line. */
export function executorEnv(env: Record<string, string> | undefined): { env: Record<string, string>; dropped: string[] } {
  const out: Record<string, string> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(env ?? {})) {
    if (UNSAFE_EXECUTOR_ENV.test(k)) dropped.push(k)
    else out[k] = v
  }
  return { env: out, dropped }
}
