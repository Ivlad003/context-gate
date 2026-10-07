// Regression tests (review 2026-10-06, package cli): path containment and repo-root discovery.
// H02 symlinks out of the repo, H03 store keys outside data/, H04 findRoot and $HOME, M49 symlinked CLAUDE.md,
// L30/M40 walkFiles over symlinks and truncation, prompt.dir / debugLog.path outside the repo.
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRoot, safeJoin, walkFilesInfo, writeText } from '../packages/cli/src/util.ts'
import { NodeHost } from '../packages/cli/src/host-node.ts'
import { loadConfig } from '../packages/core/src/config.ts'
import { findMdcFiles, loadData, loadMarkdown, loadRepo, setData } from '../packages/cli/src/context.ts'
import { persistStored, writeDebugLog } from '../packages/cli/src/cmd-run.ts'
import type { RenderResult } from '../packages/core/src/types.ts'
import { sandbox } from './cli-helpers.ts'

function tree(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); if (!p.endsWith('/')) writeFileSync(join(root, p), text); else mkdirSync(join(root, p), { recursive: true }) }
}

test('H04 findRoot: nearest .git or gate.json wins in one pass; $HOME never becomes a root through ~/.claude', () => {
  const dir = sandbox()
  const home = process.env.HOME!
  tree(home, { '.claude/settings.json': '{}', 'proj/src/': '', 'mono/.claude/gate.json': '{}', 'mono/sub/.git/': '', 'mono/sub/x/': '', 'mono/plain/y/': '', 'dot/.claude/skills/': '', 'dot/a/': '' })
  const cases: [string, string, string][] = [
    ['non-git folder under HOME → itself, not HOME', join(home, 'proj/src'), join(home, 'proj/src')],
    ['nested git repo below an ancestor gate.json → its own .git', join(home, 'mono/sub/x'), join(home, 'mono/sub')],
    ['plain dir below gate.json → the gate.json dir', join(home, 'mono/plain/y'), join(home, 'mono')],
    ['bare .claude (not HOME) is still a weak marker', join(home, 'dot/a'), join(home, 'dot')],
    ['HOME itself with only ~/.claude → HOME (the start)', home, home],
  ]
  for (const [name, start, want] of cases) assert.equal(findRoot(start), want, name)
  // An ~/.claude/gate.json (left by the old bug) does not capture every folder under HOME either.
  tree(home, { '.claude/gate.json': '{}' })
  assert.equal(findRoot(join(home, 'proj/src')), join(home, 'proj/src'))
  assert.ok(dir)
})

test('H02 safeJoin / NodeHost.abs: `..`, absolute paths and symlinks out of the repo are refused', async () => {
  const dir = sandbox()
  const root = join(dir, 'repo')
  tree(dir, { 'secret.txt': 'TOP SECRET', 'repo/ok.txt': 'fine', 'repo/sub/': '' })
  symlinkSync(join(dir, 'secret.txt'), join(root, 'leak.txt'))
  symlinkSync(dir, join(root, 'up'))
  symlinkSync(join(root, 'ok.txt'), join(root, 'inner.txt'))
  const cases: [string, boolean][] = [['ok.txt', true], ['inner.txt', true], ['sub/new.json', true], ['../secret.txt', false], [join(dir, 'secret.txt'), false], ['leak.txt', false], ['up/secret.txt', false], ['up/new/file.json', false]]
  for (const [rel, inside] of cases) assert.equal(!!safeJoin(root, rel), inside, rel)
  const host = new NodeHost({ root, config: loadConfig(undefined).config!, trusted: false, cacheDir: join(dir, 'cache'), settings: {} })
  assert.equal(await host.readFile('leak.txt'), undefined)
  assert.equal(await host.readFile('inner.txt'), 'fine')
})

test('H03 store keys: `../` never leaves data/, the render reports it; setData refuses invalid keys', () => {
  const dir = sandbox()
  const root = join(dir, 'repo')
  tree(root, { '.claude/gate.json': JSON.stringify({ prompt: { persist: true } }) })
  const repo = loadRepo(root)
  const result = { sections: [], text: '', trace: [], diagnostics: [], ms: 0, stored: { '../../../pwned': { a: 1 }, '/abs': 1, good: 2 } } as unknown as RenderResult
  const diags: { code: string }[] = []
  const written = persistStored({ repo } as never, result, diags as never)
  assert.deepEqual(written, ['.claude/prompt/data/good.json'])
  assert.deepEqual(diags.map((d) => d.code), ['G001', 'G001'])
  assert.ok(!existsSync(join(dir, 'pwned.json')) && !existsSync(join(root, 'pwned.json')))
  assert.deepEqual(setData(repo, '../x', 1), [])
  assert.ok(!existsSync(join(root, '.claude/prompt/x.json')))
})

test('prompt.dir and debugLog.path from gate.json stay inside the repo', () => {
  const dir = sandbox()
  const root = join(dir, 'repo')
  tree(root, { '.claude/gate.json': JSON.stringify({ prompt: { dir: '../outside' } }) })
  const repo = loadRepo(root)
  assert.equal(repo.promptDir, '.claude/prompt')
  // Core config (G314) or the CLI's own check (G303, also symlinks) reports it; either way the default is used.
  assert.ok(repo.configDiagnostics.some((d) => /^G3/.test(d.code) && /prompt\.dir/.test(d.message)))
  // Lexically inside, but a symlink out of the repo: the CLI refuses it too.
  const root2 = join(dir, 'repo2')
  tree(dir, { 'elsewhere/': '', 'repo2/.claude/gate.json': JSON.stringify({ prompt: { dir: 'p' } }) })
  symlinkSync(join(dir, 'elsewhere'), join(root2, 'p'))
  const repo2 = loadRepo(root2)
  assert.equal(repo2.promptDir, '.claude/prompt')
  assert.ok(repo2.configDiagnostics.some((d) => d.code === 'G303'))
  const result = { sections: [], text: '', trace: [{ kind: 'debug', section: 's', detail: 'x = 1' }], diagnostics: [], ms: 0, stored: {} } as unknown as RenderResult
  assert.equal(writeDebugLog(root, result, { file: { path: '../escape.log', maxBytes: 1000 } }), undefined)
  assert.ok(!existsSync(join(dir, 'escape.log')))
  assert.equal(writeDebugLog(root, result, { file: { path: '.claude/gate.debug.log', maxBytes: 1000 } }), join(root, '.claude/gate.debug.log'))
  assert.match(readFileSync(join(root, '.claude/gate.debug.log'), 'utf8'), / s debug: x = 1\n$/)
})

test('M49 writeText through a symlink keeps the link (CLAUDE.md → AGENTS.md)', () => {
  const root = join(sandbox(), 'repo')
  tree(root, { 'AGENTS.md': 'rules\n' })
  symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'))
  writeText(join(root, 'CLAUDE.md'), 'rules\n@.claude/prompt.generated.md\n', root)
  assert.ok(lstatSync(join(root, 'CLAUDE.md')).isSymbolicLink())
  assert.equal(readlinkSync(join(root, 'CLAUDE.md')), 'AGENTS.md')
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'rules\n@.claude/prompt.generated.md\n')
})

test('M49 a repo link out of the repo is never written through: writeText refuses, sync reports and leaves the target', async () => {
  const dir = sandbox()
  const root = join(dir, 'repo')
  tree(root, { '.git/': '', '.claude/gate.json': '{}', '.claude/prompt/main.md': '---\nid: main\n---\nПравило.\n' })
  writeFileSync(join(dir, '.bashrc'), 'export SAFE=1\n')
  writeFileSync(join(dir, '.profile'), 'export SAFE2=1\n')
  mkdirSync(join(dir, 'outside'))
  symlinkSync('../../.bashrc', join(root, '.claude/prompt.generated.md'))
  symlinkSync('../.profile', join(root, 'CLAUDE.md'))
  symlinkSync(join(dir, 'outside'), join(root, 'out'))
  assert.throws(() => writeText(join(root, 'CLAUDE.md'), 'x', root), /за межі репозиторію/)
  assert.throws(() => writeText(join(root, 'out/x.md'), 'x', root), /за межі репозиторію/)
  // Without a root a link is replaced, never followed.
  symlinkSync('../.profile', join(root, 'other.md'))
  writeText(join(root, 'other.md'), 'y')
  assert.equal(lstatSync(join(root, 'other.md')).isSymbolicLink(), false)
  const { syncCommand } = await import('../packages/cli/src/cmd-sync.ts')
  const res = await syncCommand({ root })
  assert.equal(readFileSync(join(dir, '.bashrc'), 'utf8'), 'export SAFE=1\n')
  assert.equal(readFileSync(join(dir, '.profile'), 'utf8'), 'export SAFE2=1\n')
  assert.ok(res.diagnostics?.some((d) => d.code === 'G314' && d.path === 'CLAUDE.md'), JSON.stringify(res.diagnostics))
  assert.ok(lstatSync(join(root, 'CLAUDE.md')).isSymbolicLink())
})

test('H02 Markdown section dirs, data/ and a symlinked .claude/prompt out of the repo are never read', () => {
  const dir = sandbox()
  const root = join(dir, 'repo')
  tree(dir, { 'secret/notes.md': 'SECRET-MD\n', 'secret/k.json': '"SECRET-DATA"', 'secretdata/x.json': '"SECRET-DIR"', 'p2/main.md': '---\nid: m\n---\nSECRET-PROMPT\n' })
  tree(root, { '.git/': '', '.claude/gate.json': JSON.stringify({ itemSources: [{ kind: 'prompt-dir', dir: 'notes' }] }), '.claude/prompt/data/ok.json': '1' })
  symlinkSync(join(dir, 'secret'), join(root, 'notes'))
  symlinkSync(join(dir, 'secret/k.json'), join(root, '.claude/prompt/data/k.json'))
  const repo = loadRepo(root)
  assert.ok(!loadMarkdown(repo).some((m) => m.text.includes('SECRET')))
  assert.deepEqual(loadData(repo).map((e) => e.key), ['ok'])
  const root2 = join(dir, 'repo2')
  tree(root2, { '.git/': '', '.claude/': '' })
  symlinkSync(join(dir, 'p2'), join(root2, '.claude/prompt'))
  const repo2 = loadRepo(root2)
  assert.ok(repo2.configDiagnostics.some((d) => d.code === 'G303'))
  assert.ok(!loadMarkdown(repo2).some((m) => m.text.includes('SECRET')))
})

test('L30/M40 walkFilesInfo: follows symlinks inside the root (no loops), skips ones leaving it, reports truncation', () => {
  const dir = sandbox()
  const root = join(dir, 'repo')
  tree(dir, { 'outside/secret.mdc': 'x', 'repo/shared/rules/a.mdc': 'a', 'repo/b.txt': 'b', 'repo/.cursor/': '' })
  symlinkSync(join(root, 'shared/rules'), join(root, '.cursor/rules'))
  symlinkSync(join(dir, 'outside'), join(root, 'ext'))
  symlinkSync(root, join(root, 'loop'))
  const w = walkFilesInfo(root)
  assert.ok(w.files.includes('.cursor/rules/a.mdc'), 'symlinked rules dir is walked')
  assert.ok(!w.files.some((f) => f.startsWith('ext/')), 'symlink out of the repo is skipped')
  assert.ok(!w.files.some((f) => f.startsWith('loop/')), 'symlink loop is cut')
  assert.equal(w.truncated, false)
  assert.equal(walkFilesInfo(root, { limit: 1 }).truncated, true)
})

test('M40 nested .cursor/rules: in git the search honours .gitignore (build output never hides or adds rules)', () => {
  const root = join(sandbox(), 'repo')
  tree(root, { '.gitignore': 'build/\n', 'build/gen/.cursor/rules/junk.mdc': 'x', 'pkg/web/.cursor/rules/react.mdc': 'r', '.cursor/rules/top.mdc': 't' })
  execFileSync('git', ['init', '-q'], { cwd: root })
  const diags: { code: string }[] = []
  const files = findMdcFiles(root, { cursorRules: { nested: true } } as never, diags as never)
  assert.deepEqual(files, ['.cursor/rules/top.mdc', 'pkg/web/.cursor/rules/react.mdc'])
  assert.deepEqual(diags, [])
})
