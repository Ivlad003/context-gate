// Layer 3 of the mod (hooks/layers/dsl.ts + host.ts) over a real-filesystem port with real processes: the shims
// from core shims.ts (node .ts modules, python dataclasses, bash, callTemplate, __exports__/G158), scripts.*,
// fs.glob/fs.exists, module providers, persist, staleness of imports, the CLI cache fallback, FileChanged routing,
// debug/assert/log journaling, .trace/last.json, function tools, lazy-call journal, skill tiers and path args.
// Excluded from the root tsconfig (the mod is typed by hooks/tsconfig.json), like mod-parity.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sandbox } from './cli-helpers.ts'
import { classifyChange, composeSections, dslContextBefore, dslFileChanged, loadPrompts, registerScriptTools, renderSkill, serveOwnTool } from '../hooks/layers/dsl.ts'
import { makeRenderHost } from '../hooks/layers/host.ts'
import { newRuntime, readOptions, type Io, type Runtime } from '../hooks/ctx.ts'
import { INITIAL, type State } from '../hooks/state.ts'
import { repoCacheName } from '../packages/core/src/sha256.ts'
import type { CompiledPrompt } from '../packages/core/src/types.ts'

interface Port { io: Io; state: State; runs: string[][]; stdins: string[]; logs: string[]; registered: string[]; store: Map<string, unknown> }

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), t)
  }
}

/** The engine port over the real filesystem and real processes (what register.ts binds from `$`). */
function port(root: string, o: { home?: string; cacheHome?: string; remote?: string | null; noStat?: boolean; run?: (argv: string[]) => { exitCode: number; stdout: string; stderr: string } | undefined } = {}): Port {
  const state: State = { ...INITIAL }
  const store = new Map<string, unknown>()
  const runs: string[][] = []
  const stdins: string[] = []
  const logs: string[] = []
  const registered: string[] = []
  const fail = async (): Promise<never> => { throw new Error('not in test') }
  const io = {
    read: async (k: keyof State) => state[k],
    update: async (k: keyof State, fn: (v: unknown) => unknown) => ((state as Record<string, unknown>)[k] = fn(state[k])),
    fs: {
      read: async (p: string) => readFileSync(p, 'utf8'),
      list: async (p: string) => readdirSync(p, { withFileTypes: true }).map((d) => {
        const st = statSync(join(p, d.name))
        return { name: d.name, kind: d.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs, isLink: d.isSymbolicLink() }
      }),
      exists: async (p: string) => existsSync(p),
      write: async (p: string, text: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) },
      ...(o.noStat ? {} : { stat: async (p: string) => { const st = statSync(p); return { kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs } } }),
    },
    session: {
      id: async () => 'sess-dsl',
      root: async () => root,
      model: async () => 'claude-sonnet-4-5',
      repo: async () => ({ root, remote: o.remote ?? null, internal: false, name: 'repo' }),
      usage: async () => ({ startedAt: 0, context: { window: 200_000 }, rateLimits: [] }),
      append: fail,
      compact: fail,
    },
    env: { os: async () => undefined, home: async () => o.home ?? join(root, '..', 'home'), ...(o.cacheHome ? { cacheHome: async () => o.cacheHome } : {}) },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v) }, delete: async (k: string) => { store.delete(k) } },
    process: {
      run: async (argv: string[], init: { cwd?: string; stdin?: string; timeoutMs?: number; env?: Record<string, string> }) => {
        runs.push(argv)
        stdins.push(init.stdin ?? '')
        const fake = o.run?.(argv)
        if (fake) return { ...fake, isStdoutTruncated: false, isStderrTruncated: false }
        const r = spawnSync(argv[0]!, argv.slice(1), { cwd: init.cwd, input: init.stdin ?? '', env: { ...process.env, ...(init.env ?? {}) }, timeout: init.timeoutMs, encoding: 'utf8' })
        return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? ''), isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
    mcp: { call: fail },
    model: { complete: fail, classify: fail },
    tool: { register: async (spec: { name: string }) => { registered.push(spec.name); return {} }, list: async () => [] },
    command: { register: async () => ({}) },
    ui: { ask: fail, toast: () => undefined, status: () => undefined, log: (t: string) => { logs.push(t) }, invalidate: () => undefined, open: async () => ({ isPlaced: false }), close: async () => undefined },
    clock: { after: () => undefined },
    plugin: { root: join(root, '..', 'plugin'), name: 'context-gate' },
  }
  return { io: io as unknown as Io, state, runs, stdins, logs, registered, store }
}

function runtime(trusted = true): Runtime {
  return newRuntime(readOptions(trusted ? { trustBuild: 'always' } : {}))
}

const compiled = (id: string, extra: Partial<CompiledPrompt>): string => JSON.stringify({ version: 1, compiler: 'test', id, sourceHash: `h-${id}`, sources: [], diagnostics: [], sections: [], ...extra })

const text = (value: string) => ({ t: 'text', value })
const expr = (e: string) => ({ t: 'expr', expr: e })

test('G-30/31/32: scripts.*, fs.glob, fs.exists, node .ts module provider, python dataclass, bash shim, callTemplate', async () => {
  const root = join(sandbox(), 'repo')
  writeFiles(root, {
    '.claude/gate.json': JSON.stringify({ executors: { rb: { command: ['ruby', '-e', '{code}'], callTemplate: ['node', '-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({results:r.calls.map(c=>"tpl:"+c.fn),errors:r.calls.map(()=>null)}))})', '{file}'] } } }),
    '.claude/prompt/lib/pkg.ts': 'export default { name: "demo" }\nexport function twice(n: number): number { return n * 2 }\n',
    '.claude/prompt/util.py': 'from dataclasses import dataclass\n@dataclass\nclass R:\n    a: int\n    b: str\ndef make(n, tag="x"):\n    return R(n, tag)\n',
    '.claude/prompt/sh.sh': 'build_dir() { echo "dist/$1"; }\n',
    '.claude/prompt/other.rb': '# ruby module\n',
    '.claude/prompt/scripts/changed_files.sh': '#!/usr/bin/env bash\ncat >/dev/null\necho \'["src/a.ts"]\'\n',
    'src/a.ts': 'export const a = 1\n',
    'src/deep/b.ts': 'export const b = 2\n',
    'docs/x.md': '# x\n',
    '.claude/prompt/.compiled/main.json': compiled('main', {
      uses: { util: '.claude/prompt/util.py', sh: '.claude/prompt/sh.sh', rb: '.claude/prompt/other.rb' },
      sections: [{ id: 'all', scope: 'volatile', children: [
        text('pkg='), expr('pkg.name'), text(' twice='), expr('pkg.twice(21)'),
        text(' scripts='), expr('scripts.changed_files() | join(",")'),
        text(' glob='), expr('fs.glob("*.ts") | join(",")'),
        text(' exists='), expr('fs.exists("docs/x.md")'), text('/'), expr('fs.exists("nope.md")'),
        { t: 'call', fn: 'util.make', args: ['2'], kwargs: { tag: '"q"' }, as: 'r' }, text(' py='), expr('r.a'), expr('r.b'),
        { t: 'call', fn: 'sh.build_dir', args: ['"web"'], as: 'bd' }, text(' sh='), expr('bd'),
        { t: 'call', fn: 'rb.anything', args: [], as: 't' }, text(' tpl='), expr('t'),
      ] }],
    }),
  })
  const p = port(root)
  const rt = runtime()
  const { sections } = await composeSections(p.io, rt, 'claude-sonnet-4-5')
  const all = sections.find((s) => s.id === 'context-gate:all')?.text ?? ''
  assert.match(all, /pkg=demo twice=42/, 'module provider: default export value + function via the node shim (.ts imported directly)')
  assert.match(all, /scripts=src\/a\.ts/, 'scripts.* runs the script with JSON stdin')
  assert.match(all, /glob=\.claude\/prompt\/lib\/pkg\.ts,src\/a\.ts,src\/deep\/b\.ts /, 'fs.glob: slash-less pattern matches at depth (as the CLI walkFiles)')
  assert.match(all, /exists=true\/false/)
  assert.match(all, /py=2q/, 'python shim: dataclass → dict')
  assert.match(all, /sh=dist\/web/, 'bash shim: source file; fn args')
  assert.match(all, /tpl=tpl:anything/, 'callTemplate of the executor named by the extension')
  assert.ok(p.runs.some((a) => a[0] === 'bash' && a[1] === '-c' && a.includes('build_dir')), 'bash shim argv')
})

test('G-31: untrusted repo starts no shim; G158 from __exports__ once per session', async () => {
  const root = join(sandbox(), 'repo')
  writeFiles(root, {
    '.claude/prompt/lib/m.mjs': 'export function ok() { return 1 }\n',
    '.claude/prompt/.compiled/main.json': compiled('main', { uses: { m: '.claude/prompt/lib/m.mjs' }, sections: [{ id: 's', scope: 'volatile', children: [{ t: 'call', fn: 'm.missing', args: [], as: 'x' }, text('ok')] }] }),
  })
  const untrusted = port(root)
  await composeSections(untrusted.io, runtime(false), undefined)
  assert.equal(untrusted.runs.length, 0)
  const p = port(root)
  const rt = runtime()
  const r1 = await composeSections(p.io, rt, undefined)
  assert.ok(r1.result?.diagnostics.some((d) => d.code === 'G158' && /missing/.test(d.message)))
  const asks = () => p.stdins.filter((s) => s.includes('"__exports__"')).length
  assert.equal(asks(), 1)
  await composeSections(p.io, rt, undefined)
  assert.equal(asks(), 1, '__exports__ is asked once per session')
  assert.ok(p.state.log.some((e) => e.trigger === 'G158'))
})

test('G-11: an edited import (shared/*.prompt.tsx, .md) makes its entry stale; G-15: the CLI cache is the fallback', async () => {
  const root = join(sandbox(), 'repo')
  writeFiles(root, {
    '.claude/prompt/main.prompt.tsx': 'x',
    '.claude/prompt/shared/base.prompt.tsx': 'y',
    'docs/part.md': 'z',
    '.claude/prompt/.compiled/main.json': compiled('main', { sources: [{ path: '.claude/prompt/main.prompt.tsx', hash: 'a' }, { path: '.claude/prompt/shared/base.prompt.tsx', hash: 'b' }, { path: 'docs/part.md', hash: 'c' }], sections: [{ id: 'm', scope: 'static', children: [text('M')] }] }),
  })
  const old = new Date(Date.now() - 60_000)
  for (const f of ['.claude/prompt/main.prompt.tsx', '.claude/prompt/shared/base.prompt.tsx', 'docs/part.md']) utimesSync(join(root, f), old, old)
  for (const noStat of [false, true]) {
    const p = port(root, { noStat })
    const rt = runtime(false)
    assert.deepEqual((await loadPrompts(p.io, rt)).stale, [])
    const t = new Date()
    utimesSync(join(root, 'docs/part.md'), t, t)
    utimesSync(join(root, '.claude/prompt/.compiled/main.json'), new Date(t.getTime() - 1000), new Date(t.getTime() - 1000))
    // Not dirty, but the import's mtime is in the cache key.
    assert.deepEqual((await loadPrompts(p.io, rt)).stale, ['.claude/prompt/main.prompt.tsx'], `noStat=${noStat}`)
    assert.ok(rt.prompts!.watch.includes(join(root, 'docs/part.md')))
    utimesSync(join(root, 'docs/part.md'), old, old)
  }

  // No `.compiled` in the repo: `~/.cache/context-gate/<name>-<hash12>/compiled` (XDG_CACHE_HOME first).
  const root2 = join(sandbox(), 'repo2')
  const cacheHome = join(root2, '..', 'xdg')
  writeFiles(root2, { '.claude/prompt/main.prompt.tsx': 'x' })
  writeFiles(join(cacheHome, 'context-gate', repoCacheName(root2, 'git@x:y.git'), 'compiled'), { 'main.json': compiled('main', { sections: [{ id: 'cached', scope: 'static', children: [text('з кешу')] }] }) })
  const p2 = port(root2, { cacheHome, remote: 'git@x:y.git' })
  const set = await loadPrompts(p2.io, runtime(false))
  assert.equal(set.compiledFrom, 'cache')
  assert.equal(set.compiled[0]?.id, 'main')
  // A remote spelled differently by the engine: the one cache dir for this repo name still matches.
  const p3 = port(root2, { cacheHome, remote: 'https://x/y' })
  assert.equal((await loadPrompts(p3.io, runtime(false))).compiledFrom, 'cache')
  const { sections } = await composeSections(p2.io, runtime(false), undefined)
  assert.ok(sections.some((s) => s.text === 'з кешу'))
})

test('G-12: FileChanged routing — entry, import, gate.json, scripts, lib; outside paths ignored', async () => {
  const root = join(sandbox(), 'repo')
  writeFiles(root, {
    '.claude/prompt/main.prompt.tsx': 'x',
    '.claude/prompt/shared/base.tsx': 'y',
    '.claude/prompt/.compiled/main.json': compiled('main', { sources: [{ path: '.claude/prompt/main.prompt.tsx', hash: 'a' }, { path: '.claude/prompt/shared/base.tsx', hash: 'b' }, { path: 'docs/d.md', hash: 'c' }], sections: [{ id: 'm', scope: 'static', children: [text('M')] }] }),
    '.claude/prompt/scripts/t.sh': '# gate-tool: t1\necho 1\n',
    'plugin/dist/cli.js': '',
  })
  const rt = runtime()
  const p = port(root, { run: () => ({ exitCode: 0, stdout: '{}', stderr: '' }) })
  p.io.plugin.root = join(root, 'plugin')
  await loadPrompts(p.io, rt)
  const at = (rel: string) => classifyChange(rt, join(root, rel)).kind
  assert.equal(at('.claude/prompt/main.prompt.tsx'), 'entry')
  assert.equal(at('.claude/prompt/shared/base.tsx'), 'import')
  assert.equal(at('docs/d.md'), 'import')
  assert.equal(at('docs/other.md'), 'none')
  assert.equal(at('.claude/prompt-old/x.prompt.tsx'), 'none', 'a sibling dir with the same prefix is outside')
  assert.equal(at('.claude/gate.json'), 'config')
  assert.equal(at('.claude/prompt/.compiled/main.json'), 'compiled')
  assert.equal(at('.claude/prompt/.trace/last.json'), 'none')
  assert.equal(at('.claude/prompt/scripts/t.sh'), 'scripts')
  assert.equal(at('.claude/prompt/lib/m.ts'), 'module')
  assert.equal(classifyChange(rt, '/elsewhere/.claude/gate.json').kind, 'none')

  const builds = () => p.runs.filter((a) => a[2] === 'build').map((a) => a.slice(3).join(' '))
  await dslFileChanged(p.io, rt, join(root, 'docs/d.md'))
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(builds(), ['--only .claude/prompt/main.prompt.tsx'], 'an import rebuilds its importer')
  await dslFileChanged(p.io, rt, join(root, '.claude/gate.json'))
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(builds().at(-1), '', 'gate.json rebuilds everything')
  await dslFileChanged(p.io, rt, join(root, 'docs/other.md'))
  assert.equal(builds().length, 2)
  await registerScriptTools(p.io, rt)
  assert.ok(p.registered.includes('t1'))
  writeFiles(root, { '.claude/prompt/scripts/t.sh': '# gate-tool: t2\necho 2\n' })
  await dslFileChanged(p.io, rt, join(root, '.claude/prompt/scripts/t.sh'))
  assert.ok(p.registered.includes('t2'), 'a changed script re-registers its tool')
  assert.ok(!rt.tools.has('mcp__context-gate__t1'))
})

test('G-13: dslContextBefore re-checks staleness and starts a background build; G-14: a failed build sets rt.buildError', async () => {
  const root = join(sandbox(), 'repo')
  writeFiles(root, { '.claude/prompt/main.prompt.tsx': 'x', 'plugin/dist/cli.js': '' })
  const rt = runtime()
  const p = port(root, { run: () => ({ exitCode: 1, stdout: '', stderr: 'G164 Збірка: boom\nmore' }) })
  p.io.plugin.root = join(root, 'plugin')
  await dslContextBefore(p.io, rt)
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(p.runs.some((a) => a[2] === 'build'))
  assert.equal(rt.buildError?.code, 'G164')
  assert.match(rt.buildError?.message ?? '', /boom/)
  const ok = port(root, { run: () => ({ exitCode: 0, stdout: '', stderr: '' }) })
  ok.io.plugin.root = join(root, 'plugin')
  rt.building = false
  await dslContextBefore(ok.io, rt)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(rt.buildError, undefined, 'a good build clears the marker')
})

test('G-33: store= with prompt.persist writes <prompt dir>/data/<key>.json; G-50: .trace/last.json is RunJson, throttled', async () => {
  const root = join(sandbox(), 'repo')
  writeFiles(root, {
    '.claude/gate.json': JSON.stringify({ prompt: { persist: true } }),
    '.claude/prompt/.compiled/main.json': compiled('main', { sections: [{ id: 's', scope: 'volatile', children: [{ t: 'let', name: 'counter', value: '3' }, { t: 'store', name: 'counter' }, text('n='), expr('counter')] }] }),
  })
  const p = port(root)
  const rt = runtime(false)
  await composeSections(p.io, rt, undefined)
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude/prompt/data/counter.json'), 'utf8')), 3)
  const trace = JSON.parse(readFileSync(join(root, '.claude/prompt/.trace/last.json'), 'utf8'))
  for (const k of ['sections', 'text', 'trace', 'diagnostics', 'ms', 'scope', 'meta']) assert.ok(k in trace, k)
  assert.equal(trace.meta.mode, 'prompt')
  assert.match(trace.text, /n=3$/)
  const first = trace.meta.at
  await composeSections(p.io, rt, undefined)
  assert.equal(JSON.parse(readFileSync(join(root, '.claude/prompt/.trace/last.json'), 'utf8')).meta.at, first, 'unchanged render is not rewritten')

  const root2 = join(sandbox(), 'repo')
  writeFiles(root2, { '.claude/prompt/.compiled/main.json': compiled('main', { sections: [{ id: 's', scope: 'volatile', children: [{ t: 'let', name: 'c', value: '1' }, { t: 'store', name: 'c' }, text('x')] }] }) })
  const p2 = port(root2)
  await composeSections(p2.io, runtime(false), undefined)
  assert.ok(!existsSync(join(root2, '.claude/prompt/data')), 'without persist only $.store holds data')
  assert.ok([...p2.store.keys()].some((k) => k.startsWith('data:')))
})

test('G-40/41/38: @debug/@log/@assert go to ui.log debug, the journal (kind debug, D001) and gate.debug.log, never the prompt', async () => {
  const root = join(sandbox(), 'repo')
  writeFiles(root, {
    '.claude/gate.json': JSON.stringify({ debug: true, assertFail: 'skip' }),
    '.claude/prompt/.compiled/main.json': compiled('main', { sections: [
      { id: 'dbg', scope: 'volatile', children: [{ t: 'debug', exprs: ['gate.tier'], message: 'tier' }, { t: 'log', level: 'warn', message: 'обережно' }, text('видимий текст')] },
      { id: 'bad', scope: 'volatile', children: [{ t: 'assert', test: '1 == 2', message: 'не так' }, text('пропущено')] },
    ] }),
  })
  const p = port(root)
  const rt = runtime(false)
  const { sections } = await composeSections(p.io, rt, undefined)
  assert.deepEqual(sections.filter((s) => s.id !== 'context-gate:plan-then-act').map((s) => s.text), ['видимий текст'])
  assert.ok(p.logs.some((l) => /debug dbg: \[debug dbg\] tier gate\.tier=standard/.test(l)), p.logs.join('\n'))
  assert.ok(p.logs.some((l) => /log dbg: warn: обережно/.test(l)))
  const dbg = p.state.log.filter((e) => e.kind === 'debug')
  assert.ok(dbg.some((e) => e.trigger === 'render' && JSON.stringify(e.data).includes('обережно')))
  assert.ok(dbg.some((e) => e.trigger === 'assert' && (e.data as { code: string }).code === 'D001'))
  const file = readFileSync(join(root, '.claude/gate.debug.log'), 'utf8')
  assert.match(file, /dbg debug: \[debug dbg\] tier/)
  assert.match(file, /D001 warning/)
  const n = p.state.log.length
  await composeSections(p.io, rt, undefined)
  assert.equal(p.state.log.filter((e) => e.kind === 'debug').length, dbg.length, 'the same batch is not journaled twice')
  assert.ok(p.state.log.length >= n)
})

test('G-36: `# gate-tool: <fn>` over a module export is a model tool served through the shim; G-35: an off tool is denied', async () => {
  const root = join(sandbox(), 'repo')
  writeFiles(root, {
    '.claude/prompt/lib/ver.mjs': '// gate-tool: next_version\n// description: Наступна версія\n// input: { "bump": "major|minor|patch" }\nexport function next_version({ bump }) { return bump === "major" ? "2.0.0" : "1.1.0" }\n\nexport function helper() { return 1 }\n',
    '.claude/prompt/tools.py': 'x = 1\n# gate-tool: py_sum\n# input: { "a": "number", "b": "number" }\ndef py_sum(a, b):\n    return {"sum": a + b}\n',
    '.claude/prompt/.compiled/main.json': compiled('main', { uses: { tools: '.claude/prompt/tools.py' }, sections: [{ id: 's', scope: 'static', children: [text('x')] }] }),
  })
  const p = port(root)
  const rt = runtime()
  await loadPrompts(p.io, rt)
  await registerScriptTools(p.io, rt)
  assert.ok(p.registered.includes('next_version') && p.registered.includes('py_sum'), p.registered.join())
  assert.ok(!p.registered.includes('helper'))
  const r = await serveOwnTool(p.io, rt, { tool: 'mcp__context-gate__next_version', tool_use_id: 't', bump: 'major' })
  assert.deepEqual(r, { result: '2.0.0' })
  const py = await serveOwnTool(p.io, rt, { tool: 'mcp__context-gate__py_sum', tool_use_id: 't', a: 2, b: 3 })
  assert.deepEqual(py, { result: '{"sum":5}' })
  // An applied gate with the tool item off → deny (counts toward H010).
  rt.config = rt.cfg
  p.state.gate = { tier: 'standard', trigger: 'manual', off: false, profile: 'p', skills: { on: [], nameOnly: [], off: [], preload: [] }, mcp: { on: [], off: [] }, agents: { on: [], off: [] }, rules: { on: [], off: [] }, items: { 'tool:next_version': 'off' }, groups: [], reason: [] }
  const denied = await serveOwnTool(p.io, rt, { tool: 'mcp__context-gate__next_version', tool_use_id: 't', bump: 'major' })
  assert.ok(denied && 'deny' in denied, JSON.stringify(denied))
})

test('G-69: a lazy include call is journaled with its ref and count', async () => {
  const root = join(sandbox(), 'repo')
  writeFiles(root, {
    'docs/api.md': 'REST: множина в URL.',
    '.claude/prompt/.compiled/main.json': compiled('main', { sections: [{ id: 's', scope: 'static', children: [{ t: 'include', source: 'file', ref: 'docs/api.md', mode: 'lazy', description: 'API' }] }] }),
  })
  const p = port(root)
  const rt = runtime(false)
  await composeSections(p.io, rt, undefined)
  const name = [...rt.tools.keys()].find((k) => rt.tools.get(k)?.kind === 'lazy')!
  assert.ok(name)
  for (let i = 0; i < 2; i++) assert.deepEqual(await serveOwnTool(p.io, rt, { tool: name, tool_use_id: `t${i}` }), { result: 'REST: множина в URL.' })
  const lazy = p.state.log.filter((e) => e.kind === 'debug' && e.trigger === 'lazy')
  assert.deepEqual(lazy.map((e) => (e.data as { count: number; ref: string }).count), [1, 2])
  assert.equal((lazy[0]!.data as { ref: string }).ref, 'docs/api.md')
})

test('G-27: skill tiers limit the render; a `path` arg must exist in the repo', async () => {
  const root = join(sandbox(), 'repo')
  writeFiles(root, { 'src/a.ts': '1' })
  const p = port(root)
  const rt = runtime(false)
  const skill = (tiers?: string[]): CompiledPrompt => JSON.parse(compiled('s', { skill: { name: 'review', description: 'd', invoke: { user: true, model: 'skill' }, args: { file: { type: 'path', positional: 0, required: true } }, body: [text('Рев\'ю '), expr('args.file')], ...(tiers ? { tiers } : {}) } })) as CompiledPrompt
  assert.equal(await renderSkill(p.io, rt, skill(), 'src/a.ts'), 'Рев\'ю src/a.ts')
  assert.match(await renderSkill(p.io, rt, skill(), 'src/missing.ts'), /шлях «src\/missing\.ts» не існує/)
  assert.match(await renderSkill(p.io, rt, skill(), '../../etc/passwd'), /не існує/)
  assert.match(await renderSkill(p.io, rt, skill(['premium']), 'src/a.ts'), /^Skill review:/, 'tier standard is outside tiers=[premium]')
})

test('G-29: the mod whitelist is the user `allowBinaries` narrowed by gate.json; default executors equal the CLI', async () => {
  const root = join(sandbox(), 'repo')
  const home = join(root, '..', 'home')
  writeFiles(home, { '.claude/context-gate.json': JSON.stringify({ allowBinaries: ['node', 'bash'] }) })
  writeFiles(root, { '.claude/gate.json': JSON.stringify({ allowBinaries: ['node'] }) })
  const p = port(root, { home })
  const rt = runtime()
  await loadPrompts(p.io, rt)
  const host = makeRenderHost(p.io, rt, { trusted: true, repoKey: 'k', itemBody: async () => undefined, rules: async () => [] })
  const bash = await host.run!({ lang: 'sh', code: 'echo hi', stdin: '', timeoutMs: 1000 })
  assert.equal(bash.exitCode, -1, 'bash is narrowed away by the repo')
  const node = await host.run!({ lang: 'js', code: 'process.stdout.write("ok")', stdin: '', timeoutMs: 5000 })
  assert.equal(node.stdout, 'ok', 'aliases js → node as the CLI')
  const { DEFAULT_EXECUTORS: cli } = await import('../packages/cli/src/host-node.ts')
  const { DEFAULT_EXECUTORS: mod } = await import('../hooks/layers/host.ts')
  assert.deepEqual(mod, cli)
})

test('G-54: plan-then-act joins the mod system prompt below premium; a repo section with that id replaces it', async () => {
  const root = join(sandbox(), 'repo')
  writeFiles(root, { '.claude/prompt/a.md': '---\nid: a\nscope: static\n---\nA\n' })
  const p = port(root)
  const std = await composeSections(p.io, runtime(false), 'claude-sonnet-4-5')
  assert.ok(std.sections.some((s) => s.id === 'context-gate:plan-then-act' && /план → правка → перевірка/.test(s.text)))
  const premium = await composeSections(port(root).io, runtime(false), 'claude-opus-4-5')
  assert.ok(!premium.sections.some((s) => s.id === 'context-gate:plan-then-act'))
  writeFiles(root, { '.claude/prompt/plan.md': '---\nid: plan-then-act\nscope: static\n---\nСвій план.\n' })
  const own = await composeSections(port(root).io, runtime(false), 'claude-sonnet-4-5')
  assert.deepEqual(own.sections.filter((s) => s.id === 'context-gate:plan-then-act').map((s) => s.text), ['Свій план.'])
})
