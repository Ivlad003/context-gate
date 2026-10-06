// Budgets (SPEC "Шар 2 — Бюджети"): context percent from session.measure / turn.complete, thresholds by tier,
// `onExceed` once per crossing: section (DSL section turns on), notice (toast + transcript notice; not
// io.ui.notice, which is tool-dialog only), compact (deferred io.session.compact keeping profile + rules).


import type { OnExceedAction } from '../../packages/core/src/types.ts'
import { budgetFor } from '../../packages/core/src/config.ts'

import { type Io, type Runtime, debug } from '../ctx.ts'
import { journal } from './journal.ts'
import { refreshStatus } from './ui.ts'

export type BudgetKey = 'softContextPct' | 'hardContextPct'
const KEYS: BudgetKey[] = ['softContextPct', 'hardContextPct']
const DEFAULT_HARD_NOTICE = 'Контекст {pct}%: запусти /compact або /handoff'

/** Section ids that onExceed `section` actions own: shown only while their threshold is crossed. */
export function budgetSections(rt: Runtime): Map<string, BudgetKey> {
  const out = new Map<string, BudgetKey>()
  for (const k of KEYS) {
    const a = rt.cfg?.onExceed?.[k]
    if (a?.do === 'section') out.set(a.section, k)
  }
  return out
}

/** What compaction must keep: the active profile, tier and delivered rules. */
export async function keepText(io: Io): Promise<string> {
  const gate = await io.read('gate')
  const seen = await io.read('seen')
  const rules = [...new Set(seen.map((k) => k.slice(k.lastIndexOf(':') + 1)))]
  const profile = gate?.profile ?? (gate?.proposed ? `${gate.proposed.profile} (запропоновано)` : '—')
  return `context-gate: збережи в підсумку активний профіль ${profile}, tier ${gate?.tier ?? '—'} і застосовані правила Cursor: ${rules.join(', ') || '—'}.`
}

async function act(io: Io, rt: Runtime, key: BudgetKey, pct: number): Promise<void> {
  const configured = rt.cfg?.onExceed?.[key]
  const action: OnExceedAction | undefined = configured ?? (key === 'hardContextPct' ? { do: 'notice', text: DEFAULT_HARD_NOTICE } : undefined)
  await journal(io, rt, { kind: 'debug', trigger: `budget:${key}`, data: { pct: Math.round(pct), action: action?.do ?? 'none' } })
  if (!action) return
  if (action.do === 'notice') {
    const text = action.text.replace(/\{pct\}/g, String(Math.round(pct)))
    try { io.ui.toast(text, { timeoutMs: 10000 }) } catch { /* no surface */ }
    await io.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch((err: unknown) => debug(io, `notice append failed: ${String(err)}`))
  } else if (action.do === 'compact') {
    const instructions = [action.instructions, await keepText(io)].filter(Boolean).join('\n\n')
    // io.session.compact rejects while a turn runs: defer it.
    io.clock.after(0, () => { void io.session.compact({ instructions }).catch((err: unknown) => debug(io, `compact failed: ${String(err)}`)) })
  }
  // `section`: budgetsFired drives the DSL section at the next prompt.compose.
}

export async function checkBudgets(io: Io, rt: Runtime, pct: number | undefined): Promise<void> {
  if (pct === undefined || !Number.isFinite(pct)) return
  await io.update('ctxPercent', () => pct)
  const gate = await io.read('gate')
  const tier = gate?.tier ?? (await io.read('tier')) ?? 'standard'
  const th = budgetFor(rt.cfg, tier)
  const fired = await io.read('budgetsFired')
  const crossed: BudgetKey[] = []
  const next: string[] = []
  for (const k of KEYS) {
    const over = pct >= th[k]
    if (over) next.push(k)
    if (over && !fired.includes(k)) crossed.push(k)
  }
  // Dropping below re-arms the threshold (after compaction): once per crossing.
  if (next.join() !== fired.join()) await io.update('budgetsFired', () => next)
  for (const k of crossed) await act(io, rt, k, pct)
  await refreshStatus(io, rt)
}

/** turn.complete part (registered by gates.ts, which owns that hook). */
export async function budgetsOnTurn(io: Io, rt: Runtime): Promise<void> {
  const u = await io.session.usage().catch(() => undefined)
  await checkBudgets(io, rt, u?.context.percent)
}
