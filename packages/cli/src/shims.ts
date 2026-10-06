// Language shims for `@call` / `Call` (SPEC «Виклик функцій зі скриптових мов»): one process per module and
// batch, JSON in on stdin (`{ file, calls: [{ fn, args, kwargs }] }`), JSON out on stdout (`{ results, errors }`).
// `fn: "__exports__"` lists exported functions (G158 validation); `fn: "__default__"` gives the default export.

import type { Value } from '../../core/src/types.ts'

export interface ShimCall { fn: string; args: Value[]; kwargs?: Record<string, Value> }
export interface ShimRequest { file: string; calls: ShimCall[] }
export interface ShimResponse { results: Value[]; errors: (string | null)[] }

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
        results.append(json.loads(json.dumps(f(*c.get('args', []), **(c.get('kwargs') or {})), default=conv))); errors.append(None)
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
__cg_before="$(compgen -A function | sort)"
# shellcheck disable=SC1090
source "$file" >/dev/null || { printf 'E\\x1fsource failed\\0'; exit 0; }
while [ "$#" -gt 0 ]; do
  fn="$1"; n="$2"; shift 2
  args=("\${@:1:$n}"); shift "$n"
  if [ "$fn" = "__exports__" ]; then
    printf 'O\\x1f%s\\0' "$(comm -13 <(printf '%s\\n' "$__cg_before") <(compgen -A function | sort) | grep -v '^__cg' | tr '\\n' ' ')"
    continue
  fi
  if ! declare -F "$fn" >/dev/null; then printf 'E\\x1fфункції %s немає в модулі\\0' "$fn"; continue; fi
  out="$("$fn" "\${args[@]}")"; code=$?
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
  if (x && /^[{["\-\d]|^(true|false|null)$/.test(x)) { try { return JSON.parse(x) as Value } catch { /* text */ } }
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
