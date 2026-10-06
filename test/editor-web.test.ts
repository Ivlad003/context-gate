import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { replEval, resolvePromptFile, safePromptPath, startEditorServer } from '../packages/editor-web/src/server.ts'
import { parseMainArgs } from '../packages/editor-web/src/main.ts'
import type { RunView } from '../packages/lsp/src/runcli.ts'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'cg-edit-'))
  mkdirSync(join(root, '.claude/prompt/.trace'), { recursive: true })
  writeFileSync(join(root, '.claude/gate.json'), JSON.stringify({ tiers: { quick: {}, standard: {} }, profiles: { frontend: {} }, models: {} }))
  writeFileSync(join(root, '.claude/prompt/main.prompt.tsx'), `export default (<Prompt>\n  <Section id="workflow" scope="profile" when='gate.tier == "quick"'>x</Section>\n</Prompt>)\n`)
  writeFileSync(join(root, '.claude/prompt/notes.md'), `---\nid: notes\nscope: profile\n---\nГілка {{ git.branch }}.\n@if gate.tier == "quick"\nКоротко.\n@end\n`)
  writeFileSync(join(root, '.claude/prompt/.trace/last.json'), JSON.stringify({ scope: { git: { branch: 'feat/x' }, gate: { tier: 'quick', profile: 'frontend' }, cursor: { auto: [{ id: 'a' }, { id: 'b' }] } } }))
  writeFileSync(join(root, 'secret.txt'), 'top secret')
  return root
}

interface Res { status: number; body: string; json: () => any }

function http(port: number, method: string, path: string, opts: { token?: string; body?: unknown; host?: string; origin?: string } = {}): Promise<Res> {
  return new Promise((ok, fail) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` }
    if (opts.token) headers['x-gate-token'] = opts.token
    if (opts.origin) headers.origin = opts.origin
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)) }
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => ok({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) }))
    })
    req.on('error', fail)
    if (payload) req.write(payload)
    req.end()
  })
}

test('safePromptPath rejects traversal, absolute paths and symlink escapes', () => {
  const root = fixture()
  const dir = join(root, '.claude/prompt')
  assert.equal(safePromptPath(dir, 'main.prompt.tsx'), join(dir, 'main.prompt.tsx'))
  assert.equal(safePromptPath(dir, 'shared/new.prompt.tsx'), join(dir, 'shared/new.prompt.tsx'))
  symlinkSync(root, join(dir, 'link'))
  for (const bad of ['../gate.json', '../../secret.txt', '/etc/passwd', 'a/../../x', '..\\..\\secret.txt', 'C:/x', 'link/secret.txt', 'x\0y', '']) {
    assert.throws(() => safePromptPath(dir, bad), /Шлях|шлях/, bad)
  }
})

test('resolvePromptFile: by file id or by section id', () => {
  const root = fixture()
  const dir = join(root, '.claude/prompt')
  assert.equal(resolvePromptFile(dir, 'main'), join(dir, 'main.prompt.tsx'))
  assert.equal(resolvePromptFile(dir, 'workflow'), join(dir, 'main.prompt.tsx'))
  assert.equal(resolvePromptFile(dir, 'notes'), join(dir, 'notes.md'))
  assert.equal(resolvePromptFile(dir, 'nope'), undefined)
})

test('replEval: interpreter over a scope, errors as codes', () => {
  const scope = { gate: { tier: 'quick' }, xs: [1, 2, 3] }
  assert.deepEqual(replEval('gate.tier == "quick"', scope), { ok: true, value: true, text: 'true', diagnostics: [] })
  assert.equal(replEval('len(xs) * 2', scope).value, 6)
  assert.equal(replEval('xs |', scope).ok, false)
  assert.equal(replEval('fs.read("x")', scope).diagnostics[0]?.code, 'G157')
})

test('parseMainArgs', () => {
  assert.deepEqual(parseMainArgs(['main', '--port', '9000', '--json']), { id: 'main', root: process.cwd(), port: 9000, json: true, help: false })
  assert.throws(() => parseMainArgs(['--bogus']))
})

test('editor server: token, host, file API, preview, eval, index, check', async () => {
  const root = fixture()
  const calls: string[][] = []
  const fakeCli = async (argv: string[]): Promise<RunView> => { calls.push(argv); return { text: 'TEXT', sections: [{ id: 'workflow', text: 'TEXT', tokens: 1 }], trace: [], diagnostics: [] } }
  const srv = await startEditorServer({ root, id: 'workflow', token: 'tok', cli: 'node cli.js', runCli: fakeCli })
  try {
    assert.equal(srv.file, '.claude/prompt/main.prompt.tsx')
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=tok$/)
    const p = srv.port
    // Token required everywhere.
    assert.equal((await http(p, 'GET', '/')).status, 401)
    assert.equal((await http(p, 'GET', '/?t=wrong')).status, 401)
    assert.equal((await http(p, 'GET', '/api/file')).status, 401)
    assert.equal((await http(p, 'GET', '/api/file', { token: 'nope' })).status, 401)
    const page = await http(p, 'GET', '/?t=tok')
    assert.equal(page.status, 200)
    assert.match(page.body, /codemirror/)
    // DNS rebinding / cross-origin.
    assert.equal((await http(p, 'GET', '/api/file', { token: 'tok', host: `evil.test:${p}` })).status, 421)
    assert.equal((await http(p, 'PUT', '/api/file', { token: 'tok', origin: 'http://evil.test', body: { text: 'x' } })).status, 403)
    // File API.
    const f = (await http(p, 'GET', '/api/file', { token: 'tok' })).json()
    assert.match(f.text, /Section id="workflow"/)
    for (const bad of ['../gate.json', '../../secret.txt', '%2e%2e/gate.json', '/etc/passwd']) {
      const r = await http(p, 'GET', `/api/file?path=${bad}`, { token: 'tok' })
      assert.ok(r.status === 403 || r.status === 400, `${bad} → ${r.status}`)
      assert.ok(!r.body.includes('top secret'))
    }
    assert.equal((await http(p, 'PUT', '/api/file?path=../../secret.txt', { token: 'tok', body: { text: 'pwned' } })).status, 403)
    assert.equal(readFileSync(join(root, 'secret.txt'), 'utf8'), 'top secret')
    assert.equal((await http(p, 'PUT', '/api/file?path=.compiled/main.json', { token: 'tok', body: { text: '{}' } })).status, 403)
    assert.equal((await http(p, 'PUT', '/api/file?path=x.sh', { token: 'tok', body: { text: 'rm' } })).status, 403)
    const put = await http(p, 'PUT', '/api/file', { token: 'tok', body: { text: f.text + '\n', etag: f.etag } })
    assert.equal(put.status, 200)
    assert.equal((await http(p, 'PUT', '/api/file', { token: 'tok', body: { text: 'stale', etag: f.etag } })).status, 409, 'etag mismatch')
    // Preview through the CLI (dry by default; scripts need confirm).
    const pv = (await http(p, 'POST', '/api/preview', { token: 'tok', body: { tier: 'quick' } })).json()
    assert.equal(pv.via, 'cli')
    assert.deepEqual(calls[0], ['node', 'cli.js', 'run', '--only', 'workflow', '--json', '--dry-scripts', '--tier', 'quick'])
    assert.equal((await http(p, 'POST', '/api/preview', { token: 'tok', body: { runScripts: true } })).status, 428)
    await http(p, 'POST', '/api/preview', { token: 'tok', body: { runScripts: true, confirm: true } })
    assert.ok(!calls[1]!.includes('--dry-scripts'))
    // Markdown preview via the core renderer.
    const md = (await http(p, 'POST', '/api/preview', { token: 'tok', body: { path: 'notes.md', tier: 'quick' } })).json()
    assert.equal(md.via, 'core')
    assert.match(md.text, /Гілка feat\/x\./)
    assert.match(md.text, /Коротко\./)
    // REPL against the last trace.
    const ev = (await http(p, 'POST', '/api/eval', { token: 'tok', body: { expr: 'cursor.auto | map("id") | join(",")' } })).json()
    assert.equal(ev.ok, true)
    assert.equal(ev.value, 'a,b')
    assert.equal((await http(p, 'POST', '/api/eval', { token: 'tok', body: { expr: 'x |' } })).json().ok, false)
    assert.equal((await http(p, 'POST', '/api/eval', { token: 'tok', body: {} })).status, 400)
    // Index for autocomplete.
    const ix = (await http(p, 'GET', '/api/index', { token: 'tok' })).json()
    assert.deepEqual(ix.tiers, ['quick', 'standard'])
    assert.ok(ix.roots.gate.members.includes('tier'))
    // Diagnostics and completion for Markdown and TSX.
    const ck = (await http(p, 'POST', '/api/check', { token: 'tok', body: { path: 'notes.md', text: 'Гілка {{ git.nope }}\n' } })).json()
    assert.deepEqual(ck.diagnostics.map((d: { code: string }) => d.code), ['G172'])
    const cp = (await http(p, 'POST', '/api/complete', { token: 'tok', body: { path: 'notes.md', text: '{{ gate. }}', offset: 8 } })).json()
    assert.ok(cp.options.some((o: { name: string }) => o.name === 'tier'))
    const tsx = (await http(p, 'POST', '/api/check', { token: 'tok', body: { text: '<Section id="a" scope="profile" when="git.nope">x</Section>' } })).json()
    assert.deepEqual(tsx.diagnostics.map((d: { code: string }) => d.code), ['G172'])
    const hv = (await http(p, 'POST', '/api/hover', { token: 'tok', body: { path: 'notes.md', text: '{{ git.branch }}', offset: 8 } })).json()
    assert.equal(hv.hover.value, '"feat/x"')
    assert.equal((await http(p, 'GET', '/nope', { token: 'tok' })).status, 404)
  } finally {
    await srv.close()
  }
})
