// UI: the AbovePrompt band, the pinned health status, and the `/gate why` pane (SPEC "Інтерфейс користувача").
// Render hooks only read state (reading subscribes); every write happens in handlers or other events.


import type { Gate } from '../../packages/core/src/types.ts'
import { statusLine as gateStatusLine } from '../../packages/core/src/decide.ts'
import { budgetFor } from '../../packages/core/src/config.ts'
import { formatWhy } from '../../packages/core/src/journal.ts'
import type { DecisionLogEntry } from '../../packages/core/src/types.ts'
import type { ContextGateDecision, ContextGateLogEntry, ContextGateRenderHealth } from '../../types'
import { json } from '../state.ts'
import type { Io, Runtime } from '../ctx.ts'

export const WHY_PANE = 'gate-why'
const DASH = '—'

/** `gate — · tier — · ctx —%` with whatever the state holds (no decision yet). */
export function bandLine(v: { profile: string | null | undefined; proposed?: string | null; tier: string | null | undefined; ctx: number | null | undefined }): string {
  const profile = v.profile ?? (v.proposed ? `(${v.proposed}?)` : DASH)
  return `gate ${profile} · tier ${v.tier ?? DASH} · ctx ${v.ctx === null || v.ctx === undefined ? DASH : Math.round(v.ctx)}%`
}

/** `gate frontend · tier standard · skills 5/23 · mcp 2/6 · rules 3 · ctx 38%`; shadow → `gate (frontend?) …`. */
export function gateLine(gate: ContextGateDecision | null, tier: string | null, ctx: number | null): string {
  if (!gate) return bandLine({ profile: null, tier, ctx })
  const line = gateStatusLine(gate as unknown as Gate, ctx === null ? {} : { ctxPct: ctx })
  return ctx === null ? `${line} · ctx ${DASH}%` : line
}

const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** `prompt 8.1k (static 76%) · ◌ N` from the stored render health. */
export function healthLine(h: ContextGateRenderHealth | null): string | undefined {
  if (!h) return undefined
  const secs = Object.values(h.sections)
  const tokens = secs.reduce((a, s) => a + s.tokens, 0)
  const stat = secs.filter((s) => s.scope === 'static').reduce((a, s) => a + s.tokens, 0)
  const pct = tokens ? Math.round((stat / tokens) * 100) : 0
  return `prompt ${fmtK(tokens)} (static ${pct}%) · ◌ ${h.unverified}`
}

/** Pinned status line: health in interactive sessions; the whole line headless (no AbovePrompt). */
export async function refreshStatus(io: Io, rt: Runtime): Promise<void> {
  try {
    const health = healthLine(await io.read('health'))
    if (rt.surface === null) {
      const line = gateLine(await io.read('gate'), await io.read('tier'), await io.read('ctxPercent'))
      io.ui.status(health ? `${line} · ${health}` : line)
    } else {
      io.ui.status(health)
    }
  } catch { /* no surface */ }
}

export async function applyProposed(io: Io, rt: Runtime, recompute: (trigger: string) => Promise<unknown>): Promise<void> {
  const gate = await io.read('gate')
  const p = gate?.proposed?.profile
  if (!p) return
  await io.update('manual', (m) => json({ ...m, profile: p, off: undefined }))
  await recompute('manual')
  void rt
}

export async function resetAuto(io: Io, recompute: (trigger: string) => Promise<unknown>): Promise<void> {
  await io.update('manual', (m) => json({ add: [], remove: [], ...(m.mode ? { mode: m.mode } : {}) }))
  await recompute('auto')
}

type Els = { Box: (p: Record<string, unknown>) => unknown; Text: (p: Record<string, unknown>) => unknown; Markdown: (p: { text: string }) => unknown; Button: (p: { key: string; label: string; variant?: 'primary'; onPress: () => void }) => unknown }

/** The band's one line: highlighted once the soft context threshold is crossed. */
export function bandProps(rt: Runtime, gate: ContextGateDecision | null, tier: string | null, ctx: number | null): { text: string; hot: boolean } {
  const soft = rt.cfg ? budgetFor(rt.cfg, gate?.tier ?? tier ?? 'standard').softContextPct : 70
  return { text: gateLine(gate, tier, ctx), hot: ctx !== null && ctx >= soft }
}

/** `/gate why` pane: disabled layers, the last decisions, prompt sections, and the two buttons. */
export function whyPane(els: Els, v: {
  log: readonly ContextGateLogEntry[]; gate: ContextGateDecision | null; health: ContextGateRenderHealth | null; disabled: Record<string, string>; rows: number
  onApply: () => void; onAuto: () => void
}): unknown {
  const parts: unknown[] = []
  const off = Object.entries(v.disabled)
  if (off.length) parts.push(els.Text({ color: 'warning', children: off.map(([k, d]) => `${k}: ${d}`).join('\n') }))
  parts.push(els.Markdown({ text: formatWhy(v.log as DecisionLogEntry[], Math.min(50, v.rows)) }))
  if (v.health) {
    const secs = Object.entries(v.health.sections).map(([id, s]) => `| ${id} | ${s.scope} | ${s.chars} | ${s.tokens} | ${s.status}${s.truncated ? ', обрізано' : ''} |`)
    if (secs.length) parts.push(els.Markdown({ text: ['| секція | scope | символи | токени | стан |', '| --- | --- | --- | --- | --- |', ...secs].join('\n') }))
  }
  const buttons: unknown[] = []
  if (v.gate?.shadow && v.gate.proposed) buttons.push(els.Button({ key: 'apply', label: 'Застосувати запропонований профіль', variant: 'primary', onPress: v.onApply }))
  buttons.push(els.Button({ key: 'auto', label: 'Скинути до auto', onPress: v.onAuto }))
  parts.push(els.Box({ flexDirection: 'row', gap: 2, children: buttons }))
  return els.Box({ flexDirection: 'column', gap: 1, children: parts })
}
