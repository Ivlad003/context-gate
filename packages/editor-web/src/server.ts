// Browser editor of context-gate (`/gate edit <id>`, SPEC "Редактор DSL": CodeMirror 6, keylang-web model).
// A tiny node:http server on 127.0.0.1 with a random port and a per-run token. It edits files only inside
// `.claude/prompt/`, renders previews with the CLI (`run --only <id> --json --dry-scripts`) or, for
// Markdown sections, with the core renderer directly, and evaluates REPL expressions in the last trace scope.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Diagnostic, GateConfig, RenderHost, Scope_, Value } from '../../core/src/types.ts'
import { evalExpr, newBudget, parseExpr, StepLimitError, toText, FILTERS, BUILTINS } from '../../core/src/expr.ts'
import { parseMarkdownPrompt } from '../../core/src/mddsl.ts'
import { renderPrompt } from '../../core/src/render.ts'
import { buildModel, membersOf, shapeText, traceScope, type GateIndex, type LastTrace } from '../../lsp/src/model.ts'
import { analyzeMarkdown, completeMarkdown, hoverMarkdownAt } from '../../lsp/src/markdown.ts'
import { buildRunArgs, cliArgv, DEFAULT_CLI, invalidRunState, runCli, type RunView } from '../../lsp/src/runcli.ts'
import { repoFileReader } from '../../lsp/src/load.ts'
import { editorPage } from './page.ts'

export interface EditorServerOptions {
  /** Repo root (contains `.claude/`). */
  root: string
  /** Prompt file id (`main` → `.claude/prompt/main.prompt.tsx`) or a section id declared in one of the files. */
  id: string
  /** 0 / undefined → random free port. */
  port?: number
  /** Fixed token (tests); random by default. */
  token?: string
  /** CLI argv prefix (default: the plugin's own `dist/cli.js`, else `npx --no context-gate`). */
  cli?: string | string[]
  /** Load CodeMirror from esm.sh (pinned versions; default true). false: the plain textarea, no third-party code. */
  cdn?: boolean
  /** Injected CLI runner (tests). */
  runCli?: (argv: string[], cwd: string) => Promise<RunView>
}

export interface EditorServer {
  url: string
  port: number
  token: string
  /** Repo-relative path of the edited file. */
  file: string
  close(): Promise<void>
}

const MAX_BODY = 2 * 1024 * 1024
const EDITABLE = new Set(['.tsx', '.ts', '.md', '.mdc', '.json', '.txt'])

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

function readConfig(root: string): Partial<GateConfig> | undefined {
  try { return JSON.parse(readFileSync(join(root, '.claude', 'gate.json'), 'utf8')) as Partial<GateConfig> } catch { return undefined }
}

function readJson<T>(p: string): T | undefined {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T } catch { return undefined }
}

const etag = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16)

/**
 * Resolve a path given by the client to an absolute path strictly inside `promptDir`.
 * Rejects absolute paths, `..` escapes, NUL bytes and symlinks pointing outside.
 */
export function safePromptPath(promptDir: string, rel: string): string {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new HttpError(400, 'Невірний шлях')
  const norm = rel.replace(/\\/g, '/')
  if (isAbsolute(norm) || /^[A-Za-z]:/.test(norm)) throw new HttpError(403, 'Шлях має бути відносним до .claude/prompt/')
  const base = resolve(promptDir)
  const abs = resolve(base, norm)
  if (abs !== base && !abs.startsWith(base + sep)) throw new HttpError(403, 'Шлях поза .claude/prompt/')
  // Symlink escape: compare real paths of the deepest existing ancestor.
  let probe = abs
  while (!existsSync(probe) && probe !== base) probe = dirname(probe)
  if (existsSync(probe) && existsSync(base)) {
    const realBase = realpathSync(base)
    const real = realpathSync(probe)
    if (real !== realBase && !real.startsWith(realBase + sep)) throw new HttpError(403, 'Шлях поза .claude/prompt/ (symlink)')
  }
  return abs
}

/** Attributes of a JSX opening tag up to its `>`: quoted strings and `{…}` may contain `>` (`when="a > 1"`). */
const TAG_ATTRS = String.raw`(?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?`

/** Ids of the sections declared in a prompt file (TSX `<Section id>` or Markdown front-matter `id:`). */
export function sectionIds(text: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<Section\\b${TAG_ATTRS}\\bid\\s*=\\s*(?:"([^"]+)"|'([^']+)'|\\{\\s*["'\`]([^"'\`]+)["'\`]\\s*\\})`, 'g')
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]!)
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const md = fm && /^id:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm[1]!)
  if (md) out.push(md[1]!)
  return out
}

/** Find the file for `id`: `<id>.prompt.tsx`, `<id>.md`, else a file declaring `<Section id="<id>">` / `id: <id>`. */
export function resolvePromptFile(promptDir: string, id: string): string | undefined {
  for (const c of [`${id}.prompt.tsx`, `${id}.md`, id]) {
    const p = join(promptDir, c)
    try { if (statSync(p).isFile()) return p } catch { /* next */ }
  }
  const walk = (dir: string, depth: number): string | undefined => {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return undefined }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue
      const p = join(dir, e)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory() && depth < 3) { const r = walk(p, depth + 1); if (r) return r; continue }
      if (!/\.(prompt\.tsx|md)$/.test(e)) continue
      const text = readFileSync(p, 'utf8')
      if (sectionIds(text).includes(id)) return p
    }
    return undefined
  }
  return walk(promptDir, 0)
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > MAX_BODY) throw new HttpError(413, 'Завеликий запит')
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function jsonBody<T>(req: IncomingMessage): Promise<T> {
  const s = await body(req)
  if (!s) return {} as T
  try { return JSON.parse(s) as T } catch { throw new HttpError(400, 'Невірний JSON') }
}

function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  const isText = typeof data === 'string'
  const payload = isText ? data : JSON.stringify(data)
  res.writeHead(status, {
    'content-type': isText ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(payload)
}

function tokenOk(given: string | undefined | null, token: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Evaluate a REPL expression in a scope (no host calls: provider functions give G157 and null). */
export function replEval(expr: string, scope: Scope_): { ok: boolean; value?: Value; text?: string; diagnostics: { code: string; message: string }[] } {
  const p = parseExpr(expr)
  if (!p.ast) return { ok: false, diagnostics: p.diagnostics.map((d) => ({ code: d.code, message: d.message })) }
  const diagnostics: { code: string; message: string }[] = []
  const diags: import('../../core/src/types.ts').Diagnostic[] = []
  try {
    const value = evalExpr(p.ast, scope, newBudget(10_000), { diagnostics: diags, now: Date.now() })
    diagnostics.push(...diags.map((d) => ({ code: d.code, message: d.message })))
    return { ok: true, value, text: toText(value), diagnostics }
  } catch (e) {
    if (e instanceof StepLimitError) return { ok: false, diagnostics: [{ code: 'G155', message: e.message }] }
    return { ok: false, diagnostics: [{ code: 'G101', message: (e as Error).message }] }
  }
}

/** The CLI next to this package in the plugin (`<plugin>/dist/cli.js`), run with this Node; else `npx --no`. */
function bundledCli(): string[] | string {
  try {
    // `packages/editor-web/src/server.ts` and the bundled `packages/editor-web/dist/editor-web.js` are both three levels deep.
    const p = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist/cli.js')
    if (existsSync(p)) return [process.execPath, p]
  } catch { /* not a file URL (bundled elsewhere) */ }
  return DEFAULT_CLI
}

export async function startEditorServer(opts: EditorServerOptions): Promise<EditorServer> {
  const root = resolve(opts.root)
  const config0 = readConfig(root)
  const promptDir = resolve(root, config0?.prompt?.dir ?? '.claude/prompt')
  const token = opts.token ?? randomBytes(18).toString('base64url')
  const file = resolvePromptFile(promptDir, opts.id) ?? join(promptDir, `${opts.id}.prompt.tsx`)
  const fileRel = relative(promptDir, file).split(sep).join('/')
  const cli = cliArgv(opts.cli ?? process.env.CONTEXT_GATE_CLI ?? bundledCli())
  const cdn = opts.cdn ?? process.env.CONTEXT_GATE_EDITOR_CDN !== '0'
  const runner = opts.runCli ?? ((argv: string[], cwd: string) => runCli(argv, cwd))
  const tracePath = join(promptDir, '.trace', 'last.json')
  let port = 0

  const model = () => buildModel({
    // Provider `schema` files (`.schema.json`, `.d.ts`), only inside the repo.
    readFile: repoFileReader(root),
    ...(readConfig(root) ? { config: readConfig(root)! } : {}),
    ...(readJson<GateIndex>(join(root, '.claude', 'gate.index.json')) ? { index: readJson<GateIndex>(join(root, '.claude', 'gate.index.json'))! } : {}),
    ...(readJson<LastTrace>(tracePath) ? { trace: readJson<LastTrace>(tracePath)! } : {}),
    ...(existsSync(join(promptDir, '.types', 'ctx.d.ts')) ? { ctxDts: readFileSync(join(promptDir, '.types', 'ctx.d.ts'), 'utf8') } : {}),
  })

  const sectionId = (): string => {
    // `/gate edit <id>` may name a file or a section; a file id that is not a section falls back to the first section.
    try {
      const ids = sectionIds(readFileSync(file, 'utf8'))
      return ids.includes(opts.id) ? opts.id : ids[0] ?? opts.id
    } catch { return opts.id }
  }

  // One CLI run at a time: concurrent previews would rebuild the same `.compiled` files.
  let cliQueue: Promise<unknown> = Promise.resolve()
  const runQueued = (argv: string[]): Promise<RunView> => {
    const next = cliQueue.then(() => runner(argv, root))
    cliQueue = next.catch(() => undefined)
    return next
  }
  const readRepoFile = repoFileReader(root)

  const previewMarkdown = async (abs: string, b: { tier?: string; profile?: string }): Promise<RunView> => {
    const text = readFileSync(abs, 'utf8')
    const rel = relative(root, abs).split(sep).join('/')
    const tierNames = Object.keys(readConfig(root)?.tiers ?? {})
    const parsed = parseMarkdownPrompt(text, { path: rel, ...(tierNames.length ? { tiers: tierNames } : {}) })
    const scope: Scope_ = { ...(traceScope(readJson<LastTrace>(tracePath)) ?? {}) }
    const gate = (scope.gate && typeof scope.gate === 'object' && !Array.isArray(scope.gate) ? { ...scope.gate } : {}) as Record<string, Value>
    if (b.tier) gate.tier = b.tier
    if (b.profile) gate.profile = b.profile
    scope.gate = gate
    const host: RenderHost = {
      // Inside the repo only, symlinks resolved (`@include ../../.ssh/id_rsa` or a symlink out of the repo is refused).
      readFile: async (p) => readRepoFile(p),
      now: () => Date.now(),
      trusted: false,
      dryScripts: true,
    }
    const r = await renderPrompt([parsed.section], scope, host, { tier: b.tier ?? (typeof gate.tier === 'string' ? gate.tier : 'standard'), only: parsed.section.id })
    return { text: r.text, sections: r.sections, trace: r.trace, diagnostics: [...parsed.diagnostics, ...r.diagnostics], ms: r.ms }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(421, 'Невірний Host')
    const url = new URL(req.url ?? '/', `http://${host}`)
    const origin = req.headers.origin
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new HttpError(403, 'Чужий Origin')
    // Browsers without Origin on a request still send Sec-Fetch-Site: another site never reaches the API.
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Чужий Origin')
    const given = url.pathname === '/' ? url.searchParams.get('t') : (req.headers['x-gate-token'] as string | undefined)
    if (!tokenOk(given, token)) throw new HttpError(401, 'Потрібен токен (?t=… з URL, який надрукував /gate edit)')
    const m = req.method ?? 'GET'

    if (m === 'GET' && url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64')
      const esm = cdn ? ' https://esm.sh' : ''
      send(res, 200, editorPage({ token, file: fileRel, id: opts.id, section: sectionId(), nonce, cdn }), {
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'${esm}; style-src 'unsafe-inline'; connect-src 'self'${esm}; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      })
      return
    }
    if (url.pathname === '/api/file') {
      const abs = safePromptPath(promptDir, url.searchParams.get('path') ?? fileRel)
      if (m === 'GET') {
        let text: string
        try { text = readFileSync(abs, 'utf8') } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'Файл не знайдено')
          throw new HttpError(500, `Не вдалося прочитати файл: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`)
        }
        send(res, 200, { path: relative(promptDir, abs).split(sep).join('/'), text, etag: etag(text) })
        return
      }
      if (m === 'PUT') {
        if (!EDITABLE.has(extname(abs))) throw new HttpError(403, `Редагування ${extname(abs) || 'файлів без розширення'} не дозволено`)
        const relParts = relative(promptDir, abs).split(sep)
        if (relParts.some((p) => p.startsWith('.'))) throw new HttpError(403, 'Службові каталоги (.compiled, .trace, .types) не редагуються')
        const b = await jsonBody<{ text?: string; etag?: string | null }>(req)
        if (typeof b.text !== 'string') throw new HttpError(400, 'Очікувалось { text }')
        // `etag: null` = the client saw no file: one created since then (by the agent, another editor) is not overwritten.
        if (b.etag === null && existsSync(abs)) throw new HttpError(409, 'Файл створено поза редактором — перезавантаж')
        if (b.etag && existsSync(abs) && etag(readFileSync(abs, 'utf8')) !== b.etag) throw new HttpError(409, 'Файл змінено поза редактором — перезавантаж')
        mkdirSync(dirname(abs), { recursive: true })
        const tmp = `${abs}.${process.pid}.tmp`
        writeFileSync(tmp, b.text)
        renameSync(tmp, abs)
        send(res, 200, { ok: true, etag: etag(b.text) })
        return
      }
    }
    if (m === 'POST' && url.pathname === '/api/preview') {
      const b = await jsonBody<{ path?: string; section?: string; tier?: string; profile?: string; ctxFrom?: string; runScripts?: boolean; confirm?: boolean }>(req)
      const abs = safePromptPath(promptDir, b.path ?? fileRel)
      if (b.runScripts && b.confirm !== true) throw new HttpError(428, 'Виконання скриптів потребує підтвердження (confirm: true)')
      const section = b.section || sectionId()
      const state = { section, ...(b.tier ? { tier: b.tier } : {}), ...(b.profile ? { profile: b.profile } : {}), ...(b.ctxFrom ? { ctxFrom: b.ctxFrom } : {}) }
      // The Markdown preview renders in core (no CLI); only ids that become CLI arguments are checked.
      if (abs.endsWith('.md') && !b.runScripts && !b.ctxFrom) { send(res, 200, { via: 'core', ...(await previewMarkdown(abs, b)) }); return }
      const invalid = invalidRunState(state)
      if (invalid) throw new HttpError(400, invalid)
      const argv = [...cli, ...buildRunArgs(state, { dryScripts: !b.runScripts })]
      send(res, 200, { via: 'cli', argv, ...(await runQueued(argv)) })
      return
    }
    if (m === 'POST' && url.pathname === '/api/eval') {
      const b = await jsonBody<{ expr?: string; scope?: Scope_ }>(req)
      if (typeof b.expr !== 'string') throw new HttpError(400, 'Очікувалось { expr }')
      const scope: Scope_ = { ...(traceScope(readJson<LastTrace>(tracePath)) ?? {}), ...(b.scope && typeof b.scope === 'object' ? b.scope : {}) }
      send(res, 200, { ...replEval(b.expr, scope), hasTrace: existsSync(tracePath) })
      return
    }
    if (m === 'GET' && url.pathname === '/api/index') {
      const mdl = model()
      const roots: Record<string, { type: string; doc?: string; members: string[] }> = {}
      for (const [k, s] of Object.entries(mdl.roots)) roots[k] = { type: shapeText(s), ...(s.doc ? { doc: s.doc } : {}), members: membersOf(s).map(([n]) => n) }
      send(res, 200, { index: readJson<GateIndex>(join(root, '.claude', 'gate.index.json')) ?? null, roots, filters: FILTERS, builtins: BUILTINS, profiles: mdl.profiles, tiers: mdl.tiers, sections: mdl.sections })
      return
    }
    if (m === 'POST' && (url.pathname === '/api/check' || url.pathname === '/api/complete' || url.pathname === '/api/hover')) {
      const b = await jsonBody<{ text?: string; path?: string; offset?: number }>(req)
      if (typeof b.text !== 'string') throw new HttpError(400, 'Очікувалось { text }')
      const p = b.path ?? fileRel
      safePromptPath(promptDir, p)
      const mdl = model()
      const isMd = /\.md$/.test(p)
      let ts: typeof import('typescript') | undefined
      if (!isMd) { try { ts = (await import('typescript')).default } catch { ts = undefined } }
      const an = isMd ? undefined : await import('../../lsp/src/analyze.ts')
      if (url.pathname === '/api/check') {
        const diags = isMd ? analyzeMarkdown(b.text, p, mdl) : ts && an ? an.analyzeFile(ts, p, b.text, mdl) : []
        send(res, 200, { diagnostics: diags, ...(isMd || ts ? {} : { note: 'typescript не встановлено: перевірка TSX недоступна' }) })
        return
      }
      const off = Math.max(0, Math.min(b.text.length, Number(b.offset ?? 0)))
      if (url.pathname === '/api/complete') {
        const r = isMd ? completeMarkdown(b.text, off, mdl) : ts && an ? an.completeAt(ts, p, b.text, off, mdl) : undefined
        send(res, 200, r ? { from: r.start, to: r.end, options: r.entries } : { options: [] })
        return
      }
      const h = isMd ? hoverMarkdownAt(b.text, off, mdl) : ts && an ? an.hoverAt(ts, p, b.text, off, mdl) : undefined
      send(res, 200, h ? { hover: h, markdown: an ? an.hoverMarkdown(h) : `${h.text}: ${h.type}${h.value !== undefined ? ` = ${h.value}` : ''}` } : { hover: null })
      return
    }
    throw new HttpError(404, 'Не знайдено')
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500
      if (!res.headersSent) send(res, status, { error: (e as Error).message })
      else res.end()
    })
  })
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(opts.port ?? 0, '127.0.0.1', () => ok()) })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    url: `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`,
    port,
    token,
    file: relative(root, file).split(sep).join('/'),
    close: () => new Promise<void>((ok) => { server.closeAllConnections?.(); server.close(() => ok()) }),
  }
}
