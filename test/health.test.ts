import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RenderResult, RenderedSection, Scope } from '../packages/core/src/types.ts'
import { computeHealth, formatHealth, statusLine } from '../packages/core/src/health.ts'

const sec = (id: string, scope: Scope, tokens: number, extra: Partial<RenderedSection> = {}): RenderedSection => ({
  id, scope, text: 'x'.repeat(tokens * 4), chars: tokens * 4, tokens, included: true, hash: `${id}:${tokens}`, status: 'ok', ...extra,
})
const result = (sections: RenderedSection[], extra: Partial<RenderResult> = {}): RenderResult => ({
  sections, text: '', trace: [], diagnostics: [], ms: 50, stored: {}, ...extra,
})
const metric = (r: ReturnType<typeof computeHealth>, code: string) => r.metrics.find(m => m.code === code)

test('status line: ctx · prompt size (static share) · unverified', () => {
  const r = computeHealth(result([sec('identity', 'static', 6156), sec('rules', 'profile', 1500), sec('repo', 'volatile', 444, { status: 'unverified' })]))
  assert.equal(statusLine(r, 38), 'ctx 38% · prompt 8.1k (static 76%) · ◌ 1')
  assert.equal(statusLine(computeHealth(result([sec('a', 'static', 10)]))), 'prompt 10 (static 100%) · ◌ 0')
})

const cases: { name: string; code: string; ok: boolean; cur: RenderResult; prev?: RenderResult; extras?: Parameters<typeof computeHealth>[2]; th?: Parameters<typeof computeHealth>[3] }[] = [
  { name: 'H001 small prompt', code: 'H001', ok: true, cur: result([sec('a', 'static', 1000)]) },
  { name: 'H001 too big', code: 'H001', ok: false, cur: result([sec('cursor-always', 'profile', 9800), sec('b', 'static', 3000)]) },
  { name: 'H001 custom threshold', code: 'H001', ok: false, cur: result([sec('a', 'static', 1000)]), th: { H001: 500 } },
  { name: 'H002 stable', code: 'H002', ok: true, cur: result([sec('a', 'static', 900), sec('v', 'volatile', 100)]), prev: result([sec('a', 'static', 900), sec('v', 'volatile', 50)]) },
  { name: 'H002 unstable', code: 'H002', ok: false, cur: result([sec('a', 'static', 500), sec('b', 'profile', 500)]), prev: result([sec('a', 'static', 400), sec('b', 'profile', 500)]) },
  { name: 'H003 drift outside volatile', code: 'H003', ok: false, cur: result([sec('p', 'profile', 1200)]), prev: result([sec('p', 'profile', 100)]) },
  { name: 'H003 volatile drift ignored', code: 'H003', ok: true, cur: result([sec('v', 'volatile', 1200)]), prev: result([sec('v', 'volatile', 100)]) },
  { name: 'H004 slow without scripts', code: 'H004', ok: false, cur: result([], { ms: 1500 }) },
  { name: 'H004 scripts excluded', code: 'H004', ok: true, cur: result([], { ms: 1500, trace: [{ section: 's', kind: 'run', detail: '', ms: 1200, source: 'run' }] }) },
  { name: 'H005 total', code: 'H005', ok: false, cur: result([], { ms: 2500 }) },
  { name: 'H006 stale data', code: 'H006', ok: false, cur: result([sec('api', 'profile', 10, { stale: ['data.api-endpoints'] } as any)]) },
  { name: 'H006 fresh data', code: 'H006', ok: true, cur: result([sec('api', 'profile', 10)]) },
  { name: 'H007 unverified from extras', code: 'H007', ok: false, cur: result([]), extras: { unverified: 2 } },
  { name: 'H008 static truncated', code: 'H008', ok: false, cur: result([sec('s', 'static', 10, { truncated: true })]) },
  { name: 'H008 profile truncation is ok', code: 'H008', ok: true, cur: result([sec('p', 'profile', 10, { truncated: true })]) },
  { name: 'H009 listing overflow', code: 'H009', ok: false, cur: result([]), extras: { skillListingChars: 12_000, contextWindow: 200_000 } },
  { name: 'H009 listing ok', code: 'H009', ok: true, cur: result([]), extras: { skillListingChars: 4_000, contextWindow: 200_000 } },
  { name: 'H010 denies', code: 'H010', ok: false, cur: result([]), extras: { denies: { mcp__figma__x: 4, Bash: 1 } } },
  { name: 'H013 stale compiled', code: 'H013', ok: false, cur: result([]), extras: { compiledStale: ['main'] } },
]
for (const c of cases) {
  test(`health: ${c.name}`, () => {
    const r = computeHealth(c.cur, c.prev, c.extras, c.th)
    const m = metric(r, c.code)
    assert.ok(m, `metric ${c.code} missing`)
    assert.equal(m.ok, c.ok, JSON.stringify(m))
    assert.equal(r.diagnostics.some(d => d.code === c.code), !c.ok)
  })
}

test('formatHealth: Markdown table with advice for failing metrics', () => {
  const r = computeHealth(result([sec('cursor-always', 'profile', 9800), sec('b', 'static', 3000)]))
  const t = formatHealth(r)
  assert.match(t, /^\| Код \| Метрика \| Значення \| Поріг \| Стан \| Що зробити \|/)
  assert.match(t, /\| H001 \| .* \| 12800 \| 12000 \| ⚠ \| `cursor-always` 9\.8k → додати `budget`/)
  assert.match(t, /\| cursor-always \| profile \| 39200 \| 9800 \|/)
})
