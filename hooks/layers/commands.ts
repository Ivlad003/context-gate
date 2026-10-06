// `/gate` and `/rule` (SPEC "Інтерфейс користувача"). Grammar: core gatecmd.parseGateCommand.


import { parseGateCommand } from '../../packages/core/src/gatecmd.ts'
import { formatWhy } from '../../packages/core/src/journal.ts'
import type { DecisionLogEntry } from '../../packages/core/src/types.ts'
import { formatHealth } from '../../packages/core/src/health.ts'
import { renderPrompt } from '../../packages/core/src/render.ts'
import { skillArgs } from '../../packages/core/src/assemble.ts'
import type { ContextGateManual } from '../../types'
import { json } from '../state.ts'
import { type Io, type Runtime } from '../ctx.ts'
import { ensureSession } from './config.ts'
import { rulesReport } from './cursor-rules.ts'
import { effectiveMode, recompute } from './skill-gate.ts'
import { buildPrompts, buildScope, hostFor, loadPrompts, renderOptions, sectionsFor } from './dsl.ts'
import { revokeTrust } from './trust.ts'
import { WHY_PANE, gateLine } from './ui.ts'

export const GATE_HINT = '[<profile>|+group|-group|off|auto|new|why [off]|shadow|apply|rules|health|build|render prompt://<id>|trust revoke]'

const HELP = [
  '/gate — стан; /gate <profile> — зафіксувати профіль; /gate +g / -g — групи на сесію;',
  '/gate off | auto — вимкнути фільтрацію / повернути автоматику; /gate new — перекласифікувати;',
  '/gate shadow | apply — режим класифікатора; /gate why [off] — журнал рішень; /gate rules — доставлені правила;',
  '/gate health — метрики промпту; /gate build — зібрати промпти; /gate render prompt://<id>; /gate trust revoke.',
].join('\n')

async function statusText(io: Io, rt: Runtime): Promise<string> {
  const gate = await io.read('gate')
  const manual = await io.read('manual')
  const status = await io.read('config')
  const trust = await io.read('trust')
  const lines = [gateLine(gate, await io.read('tier'), await io.read('ctxPercent'))]
  const mode = effectiveMode(rt, manual)
  lines.push(`режим: ${mode === 'auto' ? 'apply (auto)' : 'shadow'}${gate?.shadow ? ' — рішення лише в журнал, нічого не фільтрується' : ''}; довіра: ${trust.decision}`)
  if (gate) {
    lines.push(`тригер: ${gate.trigger}${gate.proposed ? `; пропозиція: ${gate.proposed.profile} (${gate.proposed.confidence.toFixed(2)})` : ''}; групи: ${gate.groups.join(', ') || '—'}`)
    const list = (label: string, xs: string[]) => { if (xs.length) lines.push(`${label}: ${xs.slice(0, 30).join(', ')}${xs.length > 30 ? ` …(+${xs.length - 30})` : ''}`) }
    // Shadow: nothing is filtered; the lists are what the proposal would do.
    const would = gate.shadow ? ' (пропозиція, не застосовано)' : ''
    list('skills on', [...gate.skills.on, ...gate.skills.preload.map((s) => `${s} (preload)`)])
    list(`skills лише назва${would}`, gate.skills.nameOnly)
    list(`skills off${would}`, gate.skills.off)
    list(`mcp off${would}`, gate.mcp.off)
    list(`агенти off${would}`, gate.agents.off)
    if (gate.reason.length) lines.push(`чому: ${gate.reason.join('; ')}`)
  }
  if (manual.profile || manual.add.length || manual.remove.length || manual.off) {
    lines.push(`вручну: ${[manual.off ? 'off' : '', manual.profile ?? '', ...manual.add.map((g) => `+${g}`), ...manual.remove.map((g) => `-${g}`)].filter(Boolean).join(' ')}`)
  }
  for (const [k, v] of Object.entries(status.disabled)) lines.push(`вимкнено ${k}: ${v}`)
  return lines.join('\n')
}

async function setManual(io: Io, fn: (m: ContextGateManual) => ContextGateManual): Promise<void> {
  await io.update('manual', (m) => json(fn(m)))
}

export async function registerCommands(io: Io): Promise<void> {
  await io.command.register({ name: 'gate', description: 'context-gate: стан, профіль, why, rules, health', argumentHint: GATE_HINT })
  await io.command.register({ name: 'rule', description: 'context-gate: застосувати Manual-правило Cursor', argumentHint: '<id>' })
}

export async function gateCommand(io: Io, rt: Runtime, args: string): Promise<{ text: string }> {
    await ensureSession(io, rt)
    const profiles = rt.config ? Object.keys(rt.config.profiles) : undefined
    const cmd = parseGateCommand(args, profiles ? { profiles } : {})
    if ('error' in cmd) return { text: `${cmd.error}\n${HELP}` }
    const needGate = (): string | undefined => (rt.config ? undefined : `skill-gate вимкнено: ${rt.disabled.gate ?? 'немає конфігурації'}`)
    switch (cmd.cmd) {
      case 'status':
        return { text: await statusText(io, rt) }
      case 'help':
        return { text: HELP }
      case 'profile':
      case 'groups':
      case 'off':
      case 'auto': {
        const off = needGate()
        if (off) return { text: off }
        if (cmd.cmd === 'profile') await setManual(io, (m) => ({ ...m, profile: cmd.profile, off: undefined }))
        else if (cmd.cmd === 'groups') await setManual(io, (m) => ({ ...m, add: [...new Set([...m.add.filter((g) => !cmd.remove.includes(g)), ...cmd.add])], remove: [...new Set([...m.remove.filter((g) => !cmd.add.includes(g)), ...cmd.remove])] }))
        else if (cmd.cmd === 'off') await setManual(io, (m) => ({ ...m, off: true }))
        else await setManual(io, (m) => ({ add: [], remove: [], ...(m.mode ? { mode: m.mode } : {}) }))
        await recompute(io, rt, 'manual', cmd.cmd === 'auto' ? { recheck: true, recheckReason: 'auto' } : {})
        return { text: await statusText(io, rt) }
      }
      case 'new': {
        const off = needGate()
        if (off) return { text: off }
        await setManual(io, (m) => ({ ...m, recheck: true }))
        rt.recheckReason = 'new'
        return { text: 'Перекласифікую задачу з наступного промпту.' }
      }
      case 'shadow':
      case 'apply': {
        const off = needGate()
        if (off) return { text: off }
        await setManual(io, (m) => ({ ...m, mode: cmd.cmd === 'apply' ? 'auto' : 'shadow' }))
        await recompute(io, rt, 'manual')
        return { text: await statusText(io, rt) }
      }
      case 'why': {
        if (cmd.close) {
          await io.ui.close({ id: WHY_PANE })
          return { text: 'Pane /gate why закрито.' }
        }
        const opened = await io.ui.open({ id: WHY_PANE, title: 'gate why', closeOnEscape: true }).catch(() => ({ isPlaced: false as const, reason: 'no surface' }))
        const status = await io.read('config')
        const disabled = Object.entries(status.disabled).map(([k, v]) => `- вимкнено ${k}: ${v}`)
        const text = [...disabled, formatWhy((await io.read('log')) as DecisionLogEntry[], 50)].join('\n')
        return { text: opened.isPlaced ? `Відкрито pane «gate why».\n\n${text}` : text }
      }
      case 'rules':
        return { text: await rulesReport(io, rt) }
      case 'health':
        return { text: rt.lastHealth ? formatHealth(rt.lastHealth) : 'Рендера промпту ще не було в цій сесії (секцій DSL немає або prompt.compose ще не спрацював).' }
      case 'build': {
        const r = await buildPrompts(io, rt, { timeoutMs: 120_000, ask: true })
        await loadPrompts(io, rt, { force: true })
        return { text: r.message }
      }
      case 'render': {
        const set = await loadPrompts(io, rt)
        const host = await hostFor(io, rt)
        const { scope, tier } = await buildScope(io, rt, host, undefined)
        const assembled = sectionsFor(rt, set, tier)
        const skill = set.compiled.find((p) => p.skill?.name === cmd.id)
        if (skill?.skill) {
          const parsed = skillArgs(skill, '')
          if (!parsed.ok) return { text: parsed.text }
        }
        const res = await renderPrompt(skill ? [...assembled.system, skill] : assembled.system, scope, host, { ...renderOptions(rt, tier), only: cmd.id })
        const s = res.sections.find((x) => x.id === cmd.id)
        const diags = res.diagnostics.map((d) => `- ${d.code} ${d.severity}: ${d.message}`)
        return { text: [s ? `prompt://${cmd.id} (${s.scope}, ${s.tokens} ток., ${s.included ? 'увійшла' : `пропущена: ${s.reason ?? ''}`})\n\n${s.text}` : `Секцію ${cmd.id} не знайдено`, ...diags].join('\n') }
      }
      case 'trust': {
        const key = await revokeTrust(io, rt)
        return { text: `Довіру до ${key} скасовано: скрипти, збірка й командні гейти не запускатимуться до нового підтвердження.` }
      }
      case 'pipe':
        return { text: 'Pipe-команди (`collect | where … | decide`) виконує CLI: npx context-gate pipe …' }
    }
}
