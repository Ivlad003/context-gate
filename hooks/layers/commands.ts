// `/gate` and `/rule` (SPEC "Інтерфейс користувача"). Grammar: core gatecmd.parseGateCommand.


import { parseGateCommand } from '../../packages/core/src/gatecmd.ts'
import { formatWhy } from '../../packages/core/src/journal.ts'
import type { DecisionLogEntry, Gate, Item, ItemDecision, Signals } from '../../packages/core/src/types.ts'
import { formatHealth } from '../../packages/core/src/health.ts'
import { renderPrompt } from '../../packages/core/src/render.ts'
import { skillArgs } from '../../packages/core/src/assemble.ts'
import { decideGate } from '../../packages/core/src/decide.ts'
import { evalSource, newBudget } from '../../packages/core/src/expr.ts'
import { groupsOf, makeItem, mcpServerOf } from '../../packages/core/src/items.ts'
import { formatPipeText, itemProvenance, runPipeline, type PipeHost, type RenderedRecord } from '../../packages/core/src/pipeline.ts'
import type { ContextGateManual, ContextGateSectionView } from '../../types'
import { json } from '../state.ts'
import { type Io, OWN_TOOL_PREFIX, type Runtime, now } from '../ctx.ts'
import { ensureSession } from './config.ts'
import { rulesReport } from './cursor-rules.ts'
import { effectiveMode, ensureItems, groupedConfig, readBranch, recompute } from './skill-gate.ts'
import { buildPrompts, buildScope, composeSections, hostFor, loadPrompts, preloadOf, renderOptions, sectionsFor } from './dsl.ts'
import { revokeTrust } from './trust.ts'
import { HEALTH_PANE, SECTION_PANE, WHY_PANE, buildErrorOf, gateLine } from './ui.ts'
import { openEditor } from './editor.ts'
import { unverifiedLines } from './probe.ts'
import { formatTierCosts, tierCosts } from '../../packages/core/src/report.ts'

export const GATE_HINT = '[<profile>|+group|-group|off|auto|new|why [off|<item>]|shadow|apply|rules|health|build|render prompt://<id>|edit <id>|trust revoke|<stage> | <stage>…]'

const HELP = [
  '/gate — стан; /gate <profile> — зафіксувати профіль; /gate +g / -g — групи на сесію;',
  '/gate off | auto — вимкнути фільтрацію / повернути автоматику; /gate new — перекласифікувати;',
  '/gate shadow | apply — режим класифікатора; /gate why [off] — журнал рішень; /gate why <елемент> — чому skill/MCP/агент/правило вимкнено;',
  '/gate rules — доставлені правила;',
  '/gate health — метрики промпту (pane); /gate build — зібрати промпти; /gate render prompt://<id> — секція (pane);',
  '/gate edit <id> — браузерний редактор; /gate trust revoke; pipe: /gate collect kind=skill | where group=frontend | off.',
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
    const from = await provenanceLines(io, rt, gate as unknown as Gate, manual)
    if (from.length) lines.push(`звідки${would}:`, ...from)
  }
  if (manual.profile || manual.add.length || manual.remove.length || manual.off) {
    lines.push(`вручну: ${[manual.off ? 'off' : '', manual.profile ?? '', ...manual.add.map((g) => `+${g}`), ...manual.remove.map((g) => `-${g}`)].filter(Boolean).join(' ')}`)
  }
  for (const [k, v] of Object.entries(status.disabled)) lines.push(`вимкнено ${k}: ${v}`)
  return lines.join('\n')
}

/** One line per source: `- manual +backend: skill:prisma, tool:mcp__postgres__query` (SPEC scenario 4). */
async function provenanceLines(io: Io, rt: Runtime, gate: Gate, manual: ContextGateManual): Promise<string[]> {
  if (!rt.config) return []
  const items = await ensureItems(io, rt)
  const state = await io.read('gateState')
  const src = state.profileSource
  const profileSource = src === 'classify' && gate.proposed ? `classify ${gate.proposed.confidence.toFixed(2)}` : src
  const prov = itemProvenance(items, { config: rt.config, gate, ...(profileSource ? { profileSource } : {}), manual })
  const by = new Map<string, string[]>()
  for (const [id, label] of prov) by.set(label, [...(by.get(label) ?? []), id])
  return [...by].map(([label, ids]) => `- ${label}: ${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ` …(+${ids.length - 20})` : ''}`)
}

const DECISION_LABEL: Record<string, string> = { on: 'увімкнено', nameOnly: 'лише назва (без опису)', off: 'вимкнено', preload: 'preload (тіло в промпті)' }

/** Items a `/gate why <q>` names: an id (`skill:x`, `tool:mcp__a__b`), a name, or an MCP server (`postgres`). */
function itemsNamed(items: readonly Item[], q: string): Item[] {
  const bare = q.replace(/^@/, '')
  const byId = items.filter((it) => it.id === bare)
  if (byId.length) return byId
  return items.filter((it) => it.name === bare || it.name.replace(/^[^:]+:/, '') === bare || (it.kind === 'tool' && (mcpServerOf(it.name) === bare || it.name === OWN_TOOL_PREFIX + bare)))
}

/**
 * `/gate why <item>` (O7): for each item the query names, the decision in force and the reason: the groups that
 * mention it, which of them are active (profile, tier, `/gate +g`), the mode, denies so far, and how to turn it
 * on; an item the session does not hold says why it may be missing.
 */
async function explainItem(io: Io, rt: Runtime, q: string): Promise<string> {
  if (!rt.config) return `skill-gate вимкнено: ${rt.disabled.gate ?? 'немає конфігурації'} — жоден елемент не фільтрується.`
  const items = await ensureItems(io, rt)
  const gate = await io.read('gate')
  const log = (await io.read('log')) as DecisionLogEntry[]
  const found = itemsNamed(items, q)
  if (!found.length) {
    const lines = [`«${q}» немає серед елементів сесії (${items.length}), тож gate його не вимикав.`]
    if (!rt.listingText) lines.push('- листинг skills ще не надходив (з’явиться з першим запитом до моделі): skill може бути там.')
    if (!rt.mcpTools?.length) lines.push('- MCP-інструментів сесія ще не показала.')
    if (rt.disabled.rules) lines.push(`- шар cursor-rules вимкнено: ${rt.disabled.rules}`)
    if ((rt.config.itemSources ?? []).some((s) => s.kind === 'claude-tools' && s.match)) lines.push('- itemSources `claude-tools` з `match` звужує, які MCP-інструменти стають елементами.')
    const denied = log.filter((e) => e.kind === 'deny' && JSON.stringify(e.data ?? {}).includes(q)).length
    if (denied) lines.push(`- у журналі ${denied} deny зі згадкою «${q}»: /gate why`)
    lines.push('Повний перелік: /gate collect | where name~' + JSON.stringify(q))
    return lines.join('\n')
  }
  const cfg = groupedConfig(rt.config)
  const active = new Set(gate?.groups ?? [])
  const mode = !gate ? 'рішення ще не було' : gate.off ? '/gate off: нічого не фільтрується' : gate.shadow ? 'shadow: рішення лише в журнал, нічого не фільтрується' : `застосовано (${gate.profile ? `профіль ${gate.profile}` : `tier ${gate.tier}`})`
  const lines = [`режим: ${mode}`]
  for (const it of found.slice(0, 10)) {
    const d = gate?.items[it.id]
    const groups = groupsOf(cfg, it)
    const on = groups.filter((g) => active.has(g))
    const parts = [`\`${it.id}\`: ${d ? DECISION_LABEL[d] ?? d : 'ще не вирішено'}`]
    if (groups.length) parts.push(`групи: ${groups.map((g) => `${g}${active.has(g) ? ' (активна)' : ''}`).join(', ')}`)
    else parts.push(it.kind === 'tool' && it.name.startsWith('mcp__') ? 'жодна група не згадує → не фільтрується' : it.kind === 'skill' ? 'жодна група не згадує → лише назва в apply' : 'жодна група не згадує → доступний')
    if (d === 'off' && groups.length && !on.length) parts.push(`увімкнути: /gate +${groups[0]}`)
    const denies = rt.denies[it.name] ?? rt.denies[it.name.replace(/^tool:/, '')]
    if (denies) parts.push(`deny у сесії: ${denies}`)
    if (it.kind === 'rule' && d === 'off' && rt.rules?.list.find((r) => r.id === it.name)?.type === 'auto') parts.push('Auto Attached: доставляється за globs, профіль його не вимикає')
    if (it.kind === 'rule') parts.push(`доставлено main: ${(await io.read('seen')).includes(`main:${it.name}`) ? 'так' : 'ні'}`)
    lines.push(`- ${parts.join(' · ')}`)
  }
  if (found.length > 10) lines.push(`…(+${found.length - 10})`)
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
    // `/gate why <item>` (O7): core's grammar knows only `why [off]`, the item form is the mod's.
    const whyItem = args.includes('|') ? null : /^\s*why\s+(\S.*?)\s*$/.exec(args)
    if (whyItem && whyItem[1] !== 'off') return { text: await explainItem(io, rt, whyItem[1]) }
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
        const g = await recompute(io, rt, 'manual', cmd.cmd === 'auto' ? { recheck: true, recheckReason: 'auto' } : {})
        // In shadow `+g` / `-g` only edit the proposal (M20): say so, the user may expect filtering to start.
        const note = cmd.cmd === 'groups' && g?.shadow ? 'shadow: групи записано в пропозицію, нічого не фільтрується; застосувати: /gate apply або /gate <профіль>.\n' : ''
        return { text: note + (await statusText(io, rt)) }
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
        const log = (await io.read('log')) as DecisionLogEntry[]
        const costs = tierCosts(log) // SPEC «Ескалація»: attempts and tokens per tier (core report.ts)
        const probe = unverifiedLines(rt) // G-62: features resting on probe points no live run confirmed
        const text = [...disabled, formatWhy(log, 50), ...(costs.length ? ['', formatTierCosts(costs)] : []), ...(probe.length ? ['', ...probe] : [])].join('\n')
        return { text: opened.isPlaced ? `Відкрито pane «gate why».\n\n${text}` : text }
      }
      case 'rules':
        return { text: await rulesReport(io, rt) }
      case 'health': {
        const opened = await openPane(io, HEALTH_PANE, 'gate health')
        const err = buildErrorOf(rt)
        const body = rt.lastHealth ? formatHealth(rt.lastHealth) : 'Рендера промпту ще не було в цій сесії (секцій DSL немає або prompt.compose ще не спрацював).'
        const u = rt.stepUsage
        const cache = u && u.input + u.cacheRead + u.cacheCreation > 0 ? `turn.step: кроків ${u.steps}, кеш промпту ${Math.round((u.cacheRead / (u.input + u.cacheRead + u.cacheCreation)) * 100)}% вхідних токенів (read ${u.cacheRead}, write ${u.cacheCreation}, без кешу ${u.input})\n` : ''
        const probe = unverifiedLines(rt)
        return { text: [opened ? 'Відкрито pane «gate health».\n' : '', err ? `prompt ⚠ build: ${err.code} ${err.message}\n` : '', cache, body, probe.length ? `\n\n${probe.join('\n')}` : ''].join('') }
      }
      case 'build': {
        const r = await buildPrompts(io, rt, { timeoutMs: 120_000, ask: true })
        await loadPrompts(io, rt, { force: true })
        return { text: r.message }
      }
      case 'render': {
        const v = await renderSectionView(io, rt, cmd.id)
        if ('error' in v) return { text: v.error }
        await io.update('sectionView', (prev) => json({ ...v.view, ...(prev?.id === v.id && prev.editorUrl ? { editorUrl: prev.editorUrl } : {}) }))
        const opened = await openPane(io, SECTION_PANE, `prompt://${cmd.id}`)
        const s = v.view
        return { text: [`${opened ? 'Відкрито pane секції.\n' : ''}prompt://${s.id} (${s.scope}, ${s.tokens} ток., ${s.included ? 'увійшла' : `пропущена: ${s.reason ?? ''}`})\n\n${s.text}`, ...s.diagnostics].join('\n') }
      }
      case 'edit': {
        const r = await editSection(io, rt, cmd.id)
        return { text: 'url' in r ? `Редактор ${cmd.id}: ${r.url}` : r.error }
      }
      case 'trust': {
        const key = await revokeTrust(io, rt)
        return { text: `Довіру до ${key} скасовано: скрипти, збірка й командні гейти не запускатимуться до нового підтвердження.` }
      }
      case 'pipe':
        return { text: formatPipeText(await runPipeline(cmd.stages, [], modPipeHost(io, rt))) }
    }
}

async function openPane(io: Io, id: string, title: string): Promise<boolean> {
  const r = await io.ui.open({ id, title, closeOnEscape: true }).catch(() => ({ isPlaced: false as const, reason: 'no surface' }))
  return r.isPlaced
}

// ───────────────────────── section pane (/gate render, /gate edit) ─────────────────────────

/** Renders one section (or a prompt skill with empty args) for the pane, as `prompt.compose` would. */
export async function renderSectionView(io: Io, rt: Runtime, id: string): Promise<{ view: ContextGateSectionView; id: string } | { error: string }> {
  const set = await loadPrompts(io, rt)
  const host = await hostFor(io, rt)
  const { scope, tier } = await buildScope(io, rt, host, undefined)
  const assembled = sectionsFor(rt, set, tier, await preloadOf(io, rt))
  const skill = set.compiled.find((p) => p.skill?.name === id)
  if (skill?.skill) {
    const parsed = skillArgs(skill, '')
    if (!parsed.ok) return { error: parsed.text }
  }
  const res = await renderPrompt(skill ? [...assembled.system, skill] : assembled.system, scope, host, { ...renderOptions(rt, tier), only: id })
  const s = res.sections.find((x) => x.id === id)
  if (!s) return { error: [`Секцію ${id} не знайдено`, ...res.diagnostics.map((d) => `- ${d.code} ${d.severity}: ${d.message}`)].join('\n') }
  const view: ContextGateSectionView = {
    id, tier, scope: s.scope, text: s.text, chars: s.chars, tokens: s.tokens, included: s.included, status: s.status,
    ...(s.reason ? { reason: s.reason } : {}),
    diagnostics: res.diagnostics.map((d) => `- ${d.code} ${d.severity}: ${d.message}`), at: now(),
  }
  return { view, id }
}

/** Health pane button «перерендерити»: a compose render, which stores fresh health (the pane subscribes). */
export async function rerenderHealth(io: Io, rt: Runtime): Promise<void> {
  await composeSections(io, rt, undefined)
}

/** Pane button «перерендерити»: render the shown section again. */
export async function rerenderSection(io: Io, rt: Runtime): Promise<void> {
  const cur = await io.read('sectionView')
  if (!cur) return
  const v = await renderSectionView(io, rt, cur.id)
  await io.update('sectionView', (prev) => json('error' in v ? { ...(prev ?? cur), diagnostics: [v.error], at: now() } : { ...v.view, ...(prev?.editorUrl ? { editorUrl: prev.editorUrl } : {}) }))
}

/** `/gate edit <id>` and the pane button: start the browser editor, keep its URL on the pane's view. */
export async function editSection(io: Io, rt: Runtime, id: string): Promise<{ url: string } | { error: string }> {
  await ensureSession(io, rt)
  const r = await openEditor(io, rt, id)
  await io.update('sectionView', (prev) => (prev && prev.id === id ? json({ ...prev, ...('url' in r ? { editorUrl: r.url, editorError: undefined } : { editorError: r.error }) }) : prev))
  return r
}

// ───────────────────────── /gate a | b: core stages over the session ─────────────────────────

function evalWhen(expr: string, data: Record<string, unknown>): boolean {
  const v = evalSource(expr, data as never, newBudget())
  return !!v && v !== 0 && v !== ''
}

/** The mod's side of the pipe: the session's items (with the decision in force), live gate and journal. */
export function modPipeHost(io: Io, rt: Runtime): PipeHost {
  const sectionItems = async (): Promise<Item[]> => {
    const set = await loadPrompts(io, rt)
    const tier = (await io.read('tier')) ?? 'standard'
    const health = await io.read('health')
    return sectionsFor(rt, set, tier).system.flatMap((cp) => cp.sections.map((s) => makeItem('section', s.id, {
      attach: { when: s.when ? 'on-demand' : 'always' },
      cost: { chars: health?.sections[s.id]?.chars ?? 0 },
      provenance: { source: 'prompt-dir', ...(s.source?.path ? { path: s.source.path } : {}) },
    })))
  }
  return {
    config: rt.cfg,
    now: now(),
    collect: async () => {
      const items = [...(rt.config ? await ensureItems(io, rt) : []), ...(await sectionItems())]
      const gate = await io.read('gate')
      return gate ? items.map((it) => (gate.items[it.id] ? { ...it, decision: gate.items[it.id] as ItemDecision } : it)) : items
    },
    decide: async (items, f) => {
      const gate = await io.read('gate')
      const fresh = f.profile || f.model || f.tier || f.branch || f.paths.length
      if (gate && !fresh) return gate.items as Record<string, ItemDecision>
      const manual = await io.read('manual')
      const signals: Signals = { paths: f.paths.length ? f.paths : await io.read('recentPaths') }
      const model = f.model ?? (await io.read('model')) ?? undefined
      if (model) signals.model = model
      const branch = f.branch ?? (await readBranch(io, rt))
      if (branch) signals.branch = branch
      if (f.profile) signals.manual = { profile: f.profile, add: [], remove: [] }
      else if (manual.profile || manual.add.length || manual.remove.length || manual.off) signals.manual = { add: manual.add, remove: manual.remove, ...(manual.profile ? { profile: manual.profile } : {}), ...(manual.off ? { off: true } : {}) }
      return decideGate(rt.cfg, signals, { turn: 0 }, items, { evalExpr: evalWhen, ...(f.tier ? { tier: f.tier } : {}), now: now() }).gate.items
    },
    signals: async () => {
      const gate = await io.read('gate')
      return { paths: await io.read('recentPaths'), branch: (await readBranch(io, rt)) ?? '', model: (await io.read('model')) ?? '', tier: (await io.read('tier')) ?? gate?.tier ?? 'standard', profile: gate?.profile ?? null, manual: await io.read('manual') }
    },
    render: async (ids, a) => {
      const set = await loadPrompts(io, rt)
      const host = await hostFor(io, rt)
      const built = await buildScope(io, rt, host, a.model)
      const tier = a.tier ?? built.tier
      const res = await renderPrompt(sectionsFor(rt, set, tier, await preloadOf(io, rt)).system, built.scope, host, renderOptions(rt, tier))
      const sections = new Map<string, RenderedRecord>()
      for (const s of res.sections) if (ids.has(s.id)) sections.set(s.id, { text: s.text, tokens: s.tokens, included: s.included, ...(s.reason ? { reason: s.reason } : {}), status: s.status })
      return { tier, sections }
    },
    log: async () => (await io.read('log')) as DecisionLogEntry[],
  }
}
