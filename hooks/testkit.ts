// Test kit for hooks/*.test.ts (`claude plugin test`): an in-memory repository answering the $ ops the
// plugin calls. The test's own `on` hooks sit beneath the plugin and stand for the engine.
import type { On } from 'claude-code'
import { mock, test as kitTest, type TestBody, type TestOptions } from 'claude-code/testing'

/**
 * Every mod test gets at least this long. `claude plugin test` runs each file in its own child, all at once, and
 * every test pays a fresh plugin load (the core is compiled in): on a loaded machine that alone passes the kit's
 * 5 s default. The kit has no global option, so the test files import `test` from here.
 */
export const TEST_TIMEOUT_MS = 60_000

export function test(name: string, ...rest: readonly [TestBody] | readonly [TestOptions, TestBody]): void {
  const [opts, body] = rest.length === 1 ? [{} as TestOptions, rest[0]] : rest
  kitTest(name, { ...opts, timeoutMs: Math.max(opts.timeoutMs ?? 0, TEST_TIMEOUT_MS) }, body)
}

export const ROOT = '/repo'
export const HOME = '/home/test'

export interface RunResult { exitCode: number; stdout: string; stderr: string }

export interface RepoOptions {
  files?: Record<string, string>
  model?: string
  tools?: string[]
  store?: Record<string, unknown>
  /** `stdin` is what the module passed to `process.run` (a `prompt` gate's prompt text). */
  run?: (argv: readonly string[], stdin?: string) => RunResult
  /** A promise answers late (the shadow grace path of the classifier and the brief, P5). */
  complete?: (req: { model: string; prompt: string; system?: string }) => string | undefined | Promise<string | undefined>
  /** `clock.after` waits the real time instead of firing at once, so `within()` can time out. */
  realClock?: boolean
  ask?: string
  percent?: number
  /** The settings `env` block `$.settings.read()` answers (the gate.json `env` whitelist reads it). */
  settingsEnv?: Record<string, string>
  /** The user's `~/.claude/context-gate.json` `allowBinaries` (HOME is `/home/test`); unset → core DEFAULT_BINARIES. */
  allowBinaries?: string[]
  /** Answers `fs.exists` first (paths outside the repo, e.g. the plugin folder); undefined → the repo. */
  exists?: (path: string) => boolean | undefined
  /** Symbolic links: repo-relative link path → absolute target (`fs.read`/`fs.write` follow it, `fs.stat` reports
   *  `isLink` and, with `resolve`, the target as `realPath`). A target outside ROOT is a file keyed by its path. */
  links?: Record<string, string>
}

export interface Repo {
  files: Map<string, { text: string; mtimeMs: number }>
  commands: string[]
  tools: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  appended: string[]
  invalidated: string[]
  runs: (readonly string[])[]
  asks: string[]
  completes: string[]
  /** Set the context percent session.usage answers. */
  percent: number | undefined
  /** What `session.root` / `session.cwd` answer; set it to move the session (a `cd` into another worktree). Files
   *  outside ROOT are keyed by their absolute path. */
  root: string
}

const rel = (p: string): string => (p.startsWith(ROOT + '/') ? p.slice(ROOT.length + 1) : p === ROOT ? '' : p)

export function mountRepo(on: On, opts: RepoOptions = {}): Repo {
  const repo: Repo = {
    files: new Map(Object.entries({ ...(opts.files ?? {}), ...(opts.allowBinaries ? { [`${HOME}/.claude/context-gate.json`]: JSON.stringify({ allowBinaries: opts.allowBinaries }) } : {}) }).map(([k, v], i) => [k, { text: v, mtimeMs: 1000 + i }])),
    commands: [], tools: [], toasts: [], statuses: [], appended: [], invalidated: [], runs: [], asks: [], completes: [],
    percent: opts.percent,
    root: ROOT,
  }
  mock.store(on, opts.store ?? {})
  const isDir = (r: string): boolean => r === '' || [...repo.files.keys()].some((f) => f.startsWith(r + '/'))
  on('session.root', () => ({ value: repo.root }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: repo.root }))
  on('session.model', () => ({ value: opts.model ?? 'claude-sonnet-4-5' }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: 'repo' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, ...(repo.percent !== undefined ? { percent: repo.percent } : {}) }, rateLimits: [] } }))
  on('session.append', ($, e) => {
    repo.appended.push(e.message.content.map((b) => ('text' in b ? String(b.text) : '')).join(''))
    return { message: e.message, uuid: `u${repo.appended.length}` } as never
  })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  const links = opts.links ?? {}
  /** Where a path lands: a link's target, else the path itself, as a files-map key. */
  const follow = (p: string): string => { const r = rel(p); return links[r] !== undefined ? rel(links[r]) : r }
  const real = (r: string): string => (r.startsWith('/') ? r : r ? `${ROOT}/${r}` : ROOT)
  on('fs.read', ($, e) => {
    const f = repo.files.get(follow(e.path))
    return f ? { value: f.text } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.exists', ($, e) => ({ value: opts.exists?.(e.path) ?? (repo.files.has(follow(e.path)) || isDir(rel(e.path))) }))
  on('fs.stat', ($, e) => {
    const isLink = links[rel(e.path)] !== undefined
    const r = follow(e.path)
    const f = repo.files.get(r)
    const at = e.resolve ? { realPath: real(r) } : {}
    if (f) return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink, ...at } }
    if (isLink) return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink, ...at } }
    return isDir(r) ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, ...at } } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', ($, e) => {
    const r = rel(e.path)
    if (!isDir(r)) return { deny: `ENOENT: ${e.path}` }
    const prefix = r ? r + '/' : ''
    const seen = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [p, f] of repo.files) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const i = rest.indexOf('/')
      if (i < 0) seen.set(rest, { name: rest, kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })
      else if (!seen.has(rest.slice(0, i))) seen.set(rest.slice(0, i), { name: rest.slice(0, i), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    }
    return { value: [...seen.values()] }
  })
  on('fs.write', ($, e) => {
    repo.files.set(follow(e.path), { text: e.text, mtimeMs: 9999 })
    return { value: undefined }
  })
  on('command.register', ($, e) => {
    repo.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    repo.tools.push(e.name)
    return { value: { tool: `mcp__context-gate__${e.name}` } }
  })
  on('tool.list', () => ({ value: (opts.tools ?? []).map((name) => ({ name, description: name, mcp: name.startsWith('mcp__') })) }) as never)
  on('ui.toast', ($, e) => {
    repo.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    repo.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', ($, e) => {
    repo.invalidated.push(e.event)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    repo.runs.push(e.argv)
    const r = opts.run?.(e.argv, e.init?.stdin) ?? { exitCode: 0, stdout: '', stderr: '' }
    return { value: { ...r, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', async ($, e) => {
    repo.completes.push(e.model)
    const text = await opts.complete?.(e)
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return { value: (text === undefined ? { isAnswered: false, reason: 'empty-reply', usage } : { isAnswered: true, text, usage }) as never }
  })
  on('model.classify', () => ({ value: undefined }))
  if (opts.settingsEnv) on('settings.read', () => ({ value: { env: opts.settingsEnv } }) as never)
  if (opts.realClock) on('clock.after', async ($, e) => { await sleep(e.ms); return { value: undefined } })
  else on('clock.after', () => ({ value: undefined }))
  return repo
}

/** Real-time wait for tests (the mod's types have no timers; the test runtime does). */
export function sleep(ms: number): Promise<void> {
  const timers = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }
  return new Promise((resolve) => { timers.setTimeout(resolve, ms) })
}

export const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

export const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
} as const

export function gateJson(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

export const RULES = {
  '.cursor/rules/base.mdc': '---\nalwaysApply: true\n---\nЗавжди пиши тести.',
  '.cursor/rules/ts.mdc': '---\nglobs: src/**/*.ts\nalwaysApply: false\n---\nTypeScript: strict, без any.',
  '.cursor/rules/style.mdc': 'Стиль коміту: conventional commits.',
  '.cursor/rules/api.mdc': '---\ndescription: Правила REST API\n---\nREST: множина в URL.',
}
