// UI: the AbovePrompt band, the pinned health status, and the panes (SPEC "Інтерфейс користувача"):
// `gate-why` (/gate why), `gate-health` (/gate health) and `gate-section` (/gate render prompt://<id>).
// Render hooks only read state (reading subscribes); every write happens in handlers or other events.


import type { Gate } from '../../packages/core/src/types.ts'
import { statusLine as gateStatusLine } from '../../packages/core/src/decide.ts'
import { budgetFor } from '../../packages/core/src/config.ts'
import { formatWhy } from '../../packages/core/src/journal.ts'
import { formatHealth } from '../../packages/core/src/health.ts'
import type { DecisionLogEntry, HealthReport } from '../../packages/core/src/types.ts'
import type { ContextGateDecision, ContextGateLogEntry, ContextGateRenderHealth, ContextGateSectionView } from '../../types'
import { json } from '../state.ts'
import type { Io, Runtime } from '../ctx.ts'

export const WHY_PANE = 'gate-why'
export const HEALTH_PANE = 'gate-health'
export const SECTION_PANE = 'gate-section'
const DASH = '—'

/** The status marker of a failed prompt build (SPEC "Помилки збірки"). */
export const BUILD_MARK = 'prompt ⚠ build'

/** `rt.buildError` (set by layer 3 on H013/G*, cleared by a good build). */
export function buildErrorOf(rt: Runtime): { code: string; message: string } | undefined {
  const e = (rt as { buildError?: { code: string; message: string } }).buildError
  return e && typeof e === 'object' ? e : undefined
}

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

/** `prompt 8.1k (static 76%) · ◌ N` from the stored render health; `prompt ⚠ build` after a failed build. */
export function healthLine(h: ContextGateRenderHealth | null, buildError?: { code: string } | null): string | undefined {
  if (!h) return buildError ? BUILD_MARK : undefined
  if (buildError) return `${BUILD_MARK} · ◌ ${h.unverified}`
  const secs = Object.values(h.sections)
  const tokens = secs.reduce((a, s) => a + s.tokens, 0)
  const stat = secs.filter((s) => s.scope === 'static').reduce((a, s) => a + s.tokens, 0)
  const pct = tokens ? Math.round((stat / tokens) * 100) : 0
  return `prompt ${fmtK(tokens)} (static ${pct}%) · ◌ ${h.unverified}`
}

const drawnMark = new WeakMap<Runtime, string>()

/** Pinned status line: health in interactive sessions; the whole line headless (no AbovePrompt).
 * A change of the build or config marker also redraws the band (it reads `rt`, which no atom subscribes to). */
export async function refreshStatus(io: Io, rt: Runtime): Promise<void> {
  try {
    const err = buildErrorOf(rt)
    const mark = `${err ? 'build' : ''}|${configMark(rt) ?? ''}`
    if ((drawnMark.get(rt) ?? '|') !== mark) {
      drawnMark.set(rt, mark)
      try { io.ui.invalidate('ui.render') } catch { /* no surface */ }
    }
    const health = healthLine(await io.read('health'), err)
    if (rt.surface === null) {
      const line = [gateLine(await io.read('gate'), await io.read('tier'), await io.read('ctxPercent')), health ?? '', configMark(rt) ?? ''].filter(Boolean).join(' · ')
      io.ui.status(line)
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

/** The marker of a layer switched off by an invalid gate.json: otherwise the band reads like «no profile matched» (O7). */
export const CONFIG_MARK = '⚠ gate.json'

function configMark(rt: Runtime): string | undefined {
  return rt.disabled?.gate ? CONFIG_MARK : undefined
}

/** The band's one line: highlighted once the soft context threshold is crossed, a prompt build failed or gate.json
 * is invalid (`/gate why` says why). */
export function bandProps(rt: Runtime, gate: ContextGateDecision | null, tier: string | null, ctx: number | null): { text: string; hot: boolean } {
  const soft = rt.cfg ? budgetFor(rt.cfg, gate?.tier ?? tier ?? 'standard').softContextPct : 70
  const err = buildErrorOf(rt)
  const cfgErr = configMark(rt)
  const line = [gateLine(gate, tier, ctx), err ? BUILD_MARK : '', cfgErr ?? ''].filter(Boolean).join(' · ')
  return { text: line, hot: (ctx !== null && ctx >= soft) || !!err || !!cfgErr }
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

/** `/gate health` pane: the full health table with the «що зробити» column, plus a failed build. */
export function healthPane(els: Els, v: { report: HealthReport | undefined; buildError: { code: string; message: string } | undefined; onRerender: () => void }): unknown {
  const parts: unknown[] = []
  if (v.buildError) parts.push(els.Text({ color: 'warning', children: `${BUILD_MARK}: ${v.buildError.code} ${v.buildError.message}` }))
  parts.push(els.Markdown({ text: v.report ? formatHealth(v.report) : 'Рендера промпту ще не було в цій сесії (секцій DSL немає або prompt.compose ще не спрацював).' }))
  parts.push(els.Box({ flexDirection: 'row', gap: 2, children: [els.Button({ key: 'rerender', label: 'Перерендерити', onPress: v.onRerender })] }))
  return els.Box({ flexDirection: 'column', gap: 1, children: parts })
}

/** The section pane's header line: `prompt://id · scope · tier · N ток. · стан`. */
export function sectionHeader(s: ContextGateSectionView): string {
  return `prompt://${s.id} · ${s.scope} · tier ${s.tier} · ${s.tokens} ток. (${s.chars} симв.) · ${s.included ? s.status : `пропущена${s.reason ? `: ${s.reason}` : ''}`}`
}

/** `/gate render prompt://<id>` pane: the section's render, tokens, and «відкрити в редакторі» / «перерендерити». */
export function sectionPane(els: Els, v: { view: ContextGateSectionView | null; onEdit: () => void; onRerender: () => void }): unknown {
  if (!v.view) return els.Text({ dimColor: true, children: 'Секцію не вибрано: /gate render prompt://<id>' })
  const s = v.view
  const parts: unknown[] = [els.Text({ bold: true, children: sectionHeader(s) })]
  if (s.diagnostics.length) parts.push(els.Text({ color: 'warning', children: s.diagnostics.join('\n') }))
  parts.push(els.Markdown({ text: s.text || '_(порожньо)_' }))
  if (s.editorUrl) parts.push(els.Text({ children: `Редактор: ${s.editorUrl}` }))
  if (s.editorError) parts.push(els.Text({ color: 'warning', children: s.editorError }))
  parts.push(els.Box({ flexDirection: 'row', gap: 2, children: [
    els.Button({ key: 'edit', label: 'Відкрити в редакторі', variant: 'primary', onPress: v.onEdit }),
    els.Button({ key: 'rerender', label: 'Перерендерити', onPress: v.onRerender }),
  ] }))
  return els.Box({ flexDirection: 'column', gap: 1, children: parts })
}
