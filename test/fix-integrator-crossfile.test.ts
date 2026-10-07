// Cross-file follow-ups of the 2026-10-06 review fixes: render totality (H05/H06 at the section level), bash shim
// numbers (M60), `--since` without a unit (L17), executor env (S5/L33), linear regex for gate.json patterns (M51).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Diagnostic, GateConfig, Item, Value } from '../packages/core/src/types.ts'
import { MAX_STRING_LENGTH } from '../packages/core/src/expr.ts'
import { renderPrompt, type RenderHostExt } from '../packages/core/src/render.ts'
import { parseMarkdownPrompt } from '../packages/core/src/mddsl.ts'
import { executorEnv, parseBashOutput } from '../packages/core/src/shims.ts'
import { sinceMs } from '../packages/core/src/pipeline.ts'
import { decideGate } from '../packages/core/src/decide.ts'

const host: RenderHostExt = { async readFile() { return undefined }, now: () => 0, trusted: true }

async function render(body: string, scope: Record<string, Value> = {}) {
  const r = parseMarkdownPrompt(`${body}\n`, { path: 'p/s.md' })
  return renderPrompt([r.section], scope, host, { tier: 'standard' })
}

test('H06: a size overrun names the limit in G155 and fails only that section', async () => {
  const res = await render('{{ len(big + big) }}', { big: 'x'.repeat(MAX_STRING_LENGTH / 2 + 1) })
  const d = res.diagnostics.find((x: Diagnostic) => x.code === 'G155')
  assert.ok(d, JSON.stringify(res.diagnostics))
  assert.match(d.message, /Рядок довший за/)
  assert.equal(res.sections[0]!.included, false)
})

test('H05: printing a shared-structure value is charged by its cells (G155, not a 2^n walk)', async () => {
  // 18 doublings stay under the size cap (2^20 cells), but each `{{ x }}` walks ~2^19 cells: three of them
  // overrun the 10 000-step budget.
  const t = Date.now()
  const res = await render('@set x = 0\n@repeat 18\n@set x = [x, x]\n@end\n{{ x }}{{ x }}{{ x }}')
  assert.ok(Date.now() - t < 5000)
  assert.ok(res.diagnostics.some((x: Diagnostic) => x.code === 'G155'), JSON.stringify(res.diagnostics))
  assert.equal(res.text, '')
})

test('M60: the bash shim keeps number-looking text that does not print back exactly', () => {
  const calls = ['a', 'b', 'c', 'd', 'e'].map((fn) => ({ fn, args: [] }))
  const out = ['O\x1f42', 'O\x1f1.10', 'O\x1f12345678901234567890', 'O\x1f1e3', 'O\x1f-7'].join('\0')
  assert.deepEqual(parseBashOutput(out, calls).results, [42, '1.10', '12345678901234567890', '1e3', -7])
})

test('L17: sinceMs rejects a unitless number; units and dates still work', () => {
  const now = 1_000_000_000_000
  assert.equal(sinceMs('30', now), undefined)
  assert.equal(sinceMs('1.5', now), undefined)
  assert.equal(sinceMs('30m', now), now - 30 * 60_000)
  assert.equal(sinceMs('2026-01-31', now), Date.parse('2026-01-31'))
})

test('S5/L33: executorEnv drops variables that change which code runs', () => {
  const r = executorEnv({ PATH: '/tmp/evil', NODE_OPTIONS: '--require x', LD_PRELOAD: 'x', DYLD_INSERT_LIBRARIES: 'x', BASH_ENV: 'x', FOO: 'bar' })
  assert.deepEqual(r.env, { FOO: 'bar' })
  assert.deepEqual(r.dropped.sort(), ['BASH_ENV', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'NODE_OPTIONS', 'PATH'])
})

test('M51: profiles[].when.branch runs on the linear regex engine', () => {
  const items: Item[] = []
  const cfg = (branch: string): GateConfig => ({ groups: {}, profiles: { p: { groups: [], when: { branch } } } } as unknown as GateConfig)
  // Catastrophic for a backtracking engine; linear here.
  const t = Date.now()
  const slow = decideGate(cfg('^(a+)+$'), { paths: [], branch: 'a'.repeat(40) + 'b' }, { turn: 0 }, items)
  assert.ok(Date.now() - t < 1000)
  assert.notEqual(slow.gate.trigger, 'when:branch')
  assert.equal(decideGate(cfg('^feat/'), { paths: [], branch: 'feat/x' }, { turn: 0 }, items).gate.trigger, 'when:branch')
  // Unsupported syntax (lookahead) is no match, with a reason, never a crash.
  const look = decideGate(cfg('^(?=feat)'), { paths: [], branch: 'feat/x' }, { turn: 0 }, items)
  assert.notEqual(look.gate.trigger, 'when:branch')
})
