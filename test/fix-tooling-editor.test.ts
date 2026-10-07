// Regressions of the 2026-10-06 review in the browser editor (M70, L68-L74, S12).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { resolvePromptFile, sectionIds, startEditorServer } from '../packages/editor-web/src/server.ts'
import { CODEMIRROR_URLS, editorPage } from '../packages/editor-web/src/page.ts'
import { parseMainArgs } from '../packages/editor-web/src/main.ts'
import type { RunView } from '../packages/lsp/src/runcli.ts'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'cg-edit-fix-'))
  mkdirSync(join(root, '.claude/prompt/sub'), { recursive: true })
  mkdirSync(join(root, 'schemas'))
  writeFileSync(join(root, '.claude/gate.json'), JSON.stringify({ tiers: { quick: {} }, providers: { arch: { kind: 'cli', command: ['arch'], schema: 'schemas/arch.schema.json' } } }))
  writeFileSync(join(root, 'schemas/arch.schema.json'), JSON.stringify({ type: 'object', properties: { layers: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }))
  writeFileSync(join(root, '.claude/prompt/main.prompt.tsx'), `export default (<Prompt>\n  <Section scope="volatile" when="ctx.percent > 50" id="main-rules">x</Section>\n  <Section id={'health'} scope="static">y</Section>\n</Prompt>)\n`)
  return root
}

interface Res { status: number; body: string; csp: string; json: () => any }

function http(port: number, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((ok, fail) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) }
    if (opts.token) headers['x-gate-token'] = opts.token
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)) }
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => ok({ status: res.statusCode ?? 0, body, csp: String(res.headers['content-security-policy'] ?? ''), json: () => JSON.parse(body) }))
    })
    req.on('error', fail)
    if (payload) req.write(payload)
    req.end()
  })
}

test('L71, L73: section ids are matched whole, past `>` inside attribute values', () => {
  const dir = join(fixture(), '.claude/prompt')
  assert.deepEqual(sectionIds(`<Section scope="volatile" when="ctx.percent > 50" id="health">`), ['health'])
  assert.deepEqual(sectionIds(`<Section when={'a > b'} id='x'>`), ['x'])
  assert.deepEqual(sectionIds(`---\r\nid: notes\r\n---\nbody`), ['notes'])
  const cases: [string, string | undefined][] = [['main-rules', 'main.prompt.tsx'], ['health', 'main.prompt.tsx'], ['main-r', undefined], ['rules', undefined]]
  for (const [id, want] of cases) assert.equal(resolvePromptFile(dir, id), want && join(dir, want), id)
})

test('editor server: preview section, ids validated, CLI runs serialized, absent-file etag, schema files, cross-site', async () => {
  const root = fixture()
  let active = 0
  let peak = 0
  const calls: string[][] = []
  const fakeCli = async (argv: string[]): Promise<RunView> => {
    calls.push(argv)
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 20))
    active--
    return { text: 'T', sections: [], trace: [], diagnostics: [] }
  }
  const srv = await startEditorServer({ root, id: 'main', token: 'tok', cli: 'node cli.js', runCli: fakeCli, cdn: false })
  try {
    const p = srv.port
    // `main` names the file; its first section is main-rules, not a prefix match on "main".
    await http(p, 'POST', '/api/preview', { token: 'tok', body: {} })
    assert.deepEqual(calls[0]!.slice(2, 5), ['run', '--only', 'main-rules'])
    await Promise.all([1, 2, 3].map(() => http(p, 'POST', '/api/preview', { token: 'tok', body: { tier: 'quick' } })))
    assert.equal(peak, 1, 'one CLI run at a time')
    for (const body of [{ section: '--help' }, { section: 'a & calc' }, { tier: '-x' }, { ctxFrom: '--trust-repo' }]) {
      assert.equal((await http(p, 'POST', '/api/preview', { token: 'tok', body })).status, 400, JSON.stringify(body))
    }
    // etag null = the client saw no file: a file created meanwhile is not overwritten.
    assert.equal((await http(p, 'GET', '/api/file?path=new.prompt.tsx', { token: 'tok' })).status, 404)
    assert.equal((await http(p, 'PUT', '/api/file?path=new.prompt.tsx', { token: 'tok', body: { text: 'a', etag: null } })).status, 200)
    assert.equal((await http(p, 'PUT', '/api/file?path=new.prompt.tsx', { token: 'tok', body: { text: 'b', etag: null } })).status, 409)
    // Only ENOENT is "not found".
    assert.equal((await http(p, 'GET', '/api/file?path=sub', { token: 'tok' })).status, 500)
    // Provider schema files feed the model (no false G170).
    const ck = (await http(p, 'POST', '/api/check', { token: 'tok', body: { path: 'notes.md', text: '{{ arch.layers }} {{ arch.nope }}\n' } })).json()
    assert.deepEqual(ck.diagnostics.map((d: { code: string }) => d.code), ['G172'])
    // Cross-site requests without Origin.
    assert.equal((await http(p, 'GET', '/api/index', { token: 'tok', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
    // No third-party script origin with cdn: false.
    const page = await http(p, 'GET', '/?t=tok')
    assert.ok(page.body.includes('"cm":[]') && page.csp.includes("script-src 'nonce-") && !page.csp.includes('esm.sh'), page.csp)
  } finally {
    await srv.close()
  }
})

test('M70: CodeMirror URLs are pinned to exact versions; the page escapes CLI fields', () => {
  for (const u of CODEMIRROR_URLS) assert.match(u, /^https:\/\/esm\.sh\/(@codemirror\/)?[\w-]+@\d+\.\d+\.\d+\?deps=/, u)
  const page = editorPage({ token: 't', file: 'a.tsx', id: 'a', section: 's', nonce: 'n' })
  assert.ok(!/esm\.sh\/[^"'?]*@6['"?]/.test(page), 'no floating @6')
  for (const field of ['escH(t.line)', 'escH(t.ms)', 'escH(d.severity)', 'escH(d.start)']) assert.ok(page.includes(field), field)
  assert.deepEqual(editorPage({ token: 't', file: 'a', id: 'a', section: 's', nonce: 'n', cdn: false }).includes('"cm":[]'), true)
  assert.equal(parseMainArgs(['main', '--no-cdn']).noCdn, true)
})
