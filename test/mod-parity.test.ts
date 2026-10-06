// The mod's prompt.compose path (hooks/layers/dsl.ts over a fake port) and `context-gate run --no-markers`
// render the same fixture to the same bytes; the mod's journal snapshot feeds `run --ctx-from session:latest`
// and `run --diff session:latest`. Imports only pure-by-port mod code (no `$`, no claude-code runtime); it is
// excluded from the root tsconfig because the mod is typed by hooks/tsconfig.json (claude-code d.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sandbox, cli } from './cli-helpers.ts'
import { runCommand } from '../packages/cli/src/cmd-run.ts'
import { composeSections } from '../hooks/layers/dsl.ts'
import { newRuntime, readOptions, type Io } from '../hooks/ctx.ts'
import { INITIAL, type State } from '../hooks/state.ts'
import { findSnapshot, fromJsonl } from '../packages/core/src/journal.ts'
import type { Gate } from '../packages/core/src/types.ts'

const FILES: Record<string, string> = {
  '.claude/gate.json': JSON.stringify({ log: { file: true }, classify: { mode: 'shadow' } }),
  '.claude/prompt/intro.md': '---\nid: intro\nscope: static\n---\nTier {{ gate.tier }}. Always: {{ cursor.always | len }}.\n',
  '.claude/prompt/intro.quick.md': '---\nid: intro\n---\nКоротко: tier {{ gate.tier }}.\n',
  '.claude/prompt/rules.md': [
    '---', 'id: rules', 'scope: profile', '---',
    '@each r in cursor.match("src/deep/b.ts")',
    '- {{ r.id }}: {{ r.body }}',
    '@end',
    '@each ex in fs.examples("*.ts", 1)',
    'Зразок {{ ex.path }} ({{ ex.chars }})',
    '@end',
    'Auto: {{ cursor.auto | map("id") | join(", ") }}; budgets {{ budgets.soft }}/{{ budgets.hard }}.',
    '',
  ].join('\n'),
  '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\nЗавжди тести.',
  '.cursor/rules/ts.mdc': '---\nglobs: "*.ts, !src/gen/**"\nalwaysApply: false\n---\nTypeScript strict.',
  '.cursor/rules/api.mdc': '---\nglobs: src/api/**\n---\nREST.',
  'src/a.ts': 'export const a = 1\n',
  'src/deep/b.ts': 'export const b = 22222\n',
}

function writeRepo(root: string): void {
  for (const [p, t] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), t)
  }
}

/** The engine port over the real filesystem: what register.ts binds from `$`. */
function fakeIo(root: string, model: string, gate: Gate): Io {
  const state: State = { ...INITIAL, gate: JSON.parse(JSON.stringify(gate)) }
  const store = new Map<string, unknown>()
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
    },
    session: {
      id: async () => 'sess-parity',
      root: async () => root,
      model: async () => model,
      repo: async () => ({ root, remote: null, internal: false, name: 'repo' }),
      usage: async () => ({ startedAt: 0, context: { window: 200_000 }, rateLimits: [] }),
      append: fail,
      compact: fail,
    },
    env: { os: async () => undefined, home: async () => join(root, '..', 'home') },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v) }, delete: async (k: string) => { store.delete(k) } },
    process: { run: fail },
    mcp: { call: fail },
    model: { complete: fail, classify: fail },
    tool: { register: async () => ({}), list: async () => [] },
    command: { register: async () => ({}) },
    ui: { ask: fail, toast: () => undefined, status: () => undefined, log: () => undefined, invalidate: () => undefined, open: async () => ({ isPlaced: false }), close: async () => undefined },
    clock: { after: () => undefined },
    plugin: { root: join(root, '..', 'plugin'), name: 'context-gate' },
  }
  return io as unknown as Io
}

for (const [model, tier] of [['claude-sonnet-4-5', 'standard'], ['claude-haiku-4-5', 'quick']] as const) {
  test(`mod prompt.compose and CLI run --no-markers render identical bytes (${tier})`, async () => {
    const root = join(sandbox(), 'repo')
    writeRepo(root)
    const cliOut = await runCommand({ root, model, markers: false })
    assert.equal(cliOut.code, 0, cliOut.stderr)
    const ctx = cliOut.ctx!
    assert.equal(ctx.tier, tier)

    const rt = newRuntime(readOptions({}))
    rt.interactive = false
    const io = fakeIo(root, model, ctx.gate)
    const mod = await composeSections(io, rt, model)
    const modText = mod.sections.map((s) => s.text).join('\n\n')
    assert.ok(modText.length > 0)
    assert.equal(modText + '\n', cliOut.stdout)
    assert.match(modText, /- ts: TypeScript strict\./, 'cursor.match: slash-less glob matches at depth')
    assert.match(modText, /Зразок src\/a\.ts \(19\)/, 'fs.examples: smallest *.ts')
    if (tier === 'quick') assert.match(modText, /^Коротко: tier quick\./)

    // Journal snapshot (log.file: true) → run --ctx-from session:latest and --diff session:latest.
    const log = readFileSync(join(root, '.claude/gate.log.jsonl'), 'utf8')
    const snap = findSnapshot(fromJsonl(log).items, 'latest')
    assert.equal(snap?.sessionId, 'sess-parity')
    assert.equal(snap?.tier, tier)
    assert.equal(snap?.text, modText)
    assert.deepEqual(Object.keys(ctx.scope.cursor as object).sort(), ['agent', 'always', 'auto', 'manual'])
    assert.ok(ctx.host.callables?.includes('cursor.match') && ctx.host.callables.includes('fs.examples'))
    assert.deepEqual((snap?.scope as Record<string, unknown>).cursor, ctx.scope.cursor)
    assert.deepEqual((snap?.scope as Record<string, unknown>).gate, ctx.scope.gate)
    const replay = await cli(root, ['run', '--no-markers', '--ctx-from', 'session:latest'])
    assert.equal(replay.code, 0, replay.err)
    assert.equal(replay.out, modText + '\n')
    const diff = await cli(root, ['run', '--model', model, '--diff', 'session:sess-parity'])
    assert.match(diff.out, /без змін відносно session:sess-parity/)
  })
}
