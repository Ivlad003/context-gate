// `context-gate report` (journal summary, SPEC сценарії 6, 8, 11) and `bench` (сценарій 12).

import { basename, join, resolve } from 'node:path'
import type { DecisionLogEntry, GateConfig } from '../../core/src/types.ts'
import { fromJsonl } from '../../core/src/journal.ts'
import { compareRunnerMod, denySuggestions, formatTierCosts, skillRenderStats, tierCosts, type DenySuggestion, type SkillRenderStat, type TaskCost, type TicketComparison } from '../../core/src/report.ts'
import { tokens } from '../../core/src/pipeline.ts'
import { buildContext, collectItems, decide, loadRepo, loadRules } from './context.ts'
import { renderWith } from './cmd-run.ts'
import { observeCounts, sinceMs } from './cmd-pipe.ts'
import { readJson, readText } from './util.ts'

export interface Report {
  since?: string
  entries: number
  decisions: number
  triggers: { when: number; classify: number; manual: number; tier: number; other: number; byTrigger: Record<string, number> }
  shadow: { proposed: number; matched: number; differed: number }
  denies: Record<string, number>
  rulesNeverDelivered: string[]
  rulesDelivered: Record<string, number>
  escalations: { count: number; byTier: Record<string, number> }
  gateFailures: Record<string, number>
  skillRenders: Record<string, number>
  /** Attempts and tokens per tier per task (SPEC "Ескалація"). */
  tierCosts: TaskCost[]
  /** Repeated denies under one profile → add the enabling group (сценарій 8). */
  suggestions: DenySuggestion[]
  /** Runner vs mod decisions per ticket (сценарій 11). */
  runnerVsMod: TicketComparison[]
  /** Skill-prompt renders: args samples and render cost. */
  skills: SkillRenderStat[]
}

export function buildReport(entries: readonly DecisionLogEntry[], ruleIds: readonly string[], from?: number, config?: GateConfig): Report {
  const es = entries.filter((e) => from === undefined || (e.ts ?? 0) >= from)
  const r: Report = { entries: es.length, decisions: 0, triggers: { when: 0, classify: 0, manual: 0, tier: 0, other: 0, byTrigger: {} }, shadow: { proposed: 0, matched: 0, differed: 0 }, denies: {}, rulesNeverDelivered: [], rulesDelivered: {}, escalations: { count: 0, byTier: {} }, gateFailures: {}, skillRenders: {}, tierCosts: tierCosts(es), suggestions: denySuggestions(es, config, (config?.health as Record<string, number> | undefined)?.H010 ?? 3), runnerVsMod: compareRunnerMod(es), skills: skillRenderStats(es) }
  for (const e of es) {
    const kind = e.kind ?? 'decision'
    const d = (e.data ?? {}) as Record<string, unknown>
    if (kind === 'decision') {
      r.decisions++
      const t = String(e.trigger)
      r.triggers.byTrigger[t] = (r.triggers.byTrigger[t] ?? 0) + 1
      if (t.startsWith('when:')) r.triggers.when++
      else if (t === 'classify') r.triggers.classify++
      else if (t === 'manual') r.triggers.manual++
      else if (t === 'tier' || t === 'default' || t === 'model-change') r.triggers.tier++
      else r.triggers.other++
      const proposed = d.proposed as { profile?: string } | undefined
      if (proposed?.profile) {
        r.shadow.proposed++
        if (e.profile && e.profile.split('+').includes(proposed.profile)) r.shadow.matched++
        else r.shadow.differed++
      }
    } else if (kind === 'deny') {
      const t = String(d.tool ?? d.id ?? d.name ?? '?')
      r.denies[t] = (r.denies[t] ?? 0) + 1
    } else if (kind === 'escalation-suggested') {
      r.escalations.count++
      const t = String(d.from ?? e.tier ?? '?')
      r.escalations.byTier[t] = (r.escalations.byTier[t] ?? 0) + 1
    } else if (kind === 'gate-failed') {
      const g = String(d.gate ?? d.name ?? '?')
      r.gateFailures[g] = (r.gateFailures[g] ?? 0) + 1
    } else if (kind === 'skill-render' && typeof d.skill === 'string') r.skillRenders[d.skill] = (r.skillRenders[d.skill] ?? 0) + 1
  }
  const counts = observeCounts(es)
  for (const id of ruleIds) {
    const c = counts.get(`rule:${id}`)
    if (c?.delivered) r.rulesDelivered[id] = c.delivered
    else r.rulesNeverDelivered.push(id)
  }
  return r
}

const table = (head: string[], rows: (string | number)[][]): string => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')

export function formatReport(r: Report): string {
  const out: string[] = [`# context-gate report${r.since ? ` (за ${r.since})` : ''}`, '', `Подій у журналі: ${r.entries}; рішень: ${r.decisions}.`, '']
  out.push('## Хто вирішив профіль', '', table(['джерело', 'разів'], [['when (детерміновані сигнали)', r.triggers.when], ['класифікатор', r.triggers.classify], ['вручну (/gate)', r.triggers.manual], ['tier / default', r.triggers.tier], ['інше', r.triggers.other]]), '')
  if (r.shadow.proposed) out.push(`Shadow-класифікатор: ${r.shadow.proposed} пропозицій, збіг із фактичним профілем ${r.shadow.matched} (${Math.round((r.shadow.matched / r.shadow.proposed) * 100)} %), розбіжність ${r.shadow.differed}.`, '')
  const denies = Object.entries(r.denies).sort((a, b) => b[1] - a[1])
  out.push('## Deny по інструментах', '', denies.length ? table(['інструмент', 'deny'], denies) : 'Немає.', '')
  if (r.suggestions.length) out.push('### Пропозиції', '', ...r.suggestions.map((s) => `- ${s.text}`), '')
  else if (denies.some(([, n]) => n > 3)) out.push('Повторні deny одного інструмента: додай його групу в профіль (`/gate +група`, потім у gate.json).', '')
  out.push('## Правила, які жодного разу не доставлено', '', r.rulesNeverDelivered.length ? r.rulesNeverDelivered.map((id) => `- ${id}`).join('\n') : 'Немає.', '')
  out.push('## Ескалації', '', r.escalations.count ? table(['з tier', 'разів'], Object.entries(r.escalations.byTier)) : 'Немає.', '')
  if (r.tierCosts.length) out.push('## Спроби і токени за tier', '', formatTierCosts(r.tierCosts), '')
  if (r.runnerVsMod.length) {
    const differ = r.runnerVsMod.filter((c) => !c.agree).length
    out.push('## Runner і mod за ticketId', '', table(['тікет', 'тип', 'runner', 'mod', 'збіг'], r.runnerVsMod.map((c) => [c.ticket, c.ticketType ?? '—', c.runner ?? '—', c.mod ?? '—', c.agree ? 'так' : '**ні**'])), '')
    if (differ) out.push(`Розбіжностей: ${differ}. Додай \`profiles.<p>.when.ticketType\` у gate.json, щоб runner і mod вирішували однаково.`, '')
  }
  if (Object.keys(r.gateFailures).length) out.push('## Непройдені гейти', '', table(['гейт', 'разів'], Object.entries(r.gateFailures)), '')
  if (r.skills.length) out.push('## Виклики skills-промптів', '', table(['skill', 'рендерів', 'мс (сер.)', 'символів (сер.)', 'не ok', 'аргументи (приклади)'], r.skills.map((s) => [s.skill, s.renders, s.avgMs, s.avgChars, s.failed, s.args.map((a) => `\`${a.replace(/\|/g, '\\|')}\``).join(', ') || '—'])), '')
  else if (Object.keys(r.skillRenders).length) out.push('## Виклики skills-промптів', '', table(['skill', 'рендерів'], Object.entries(r.skillRenders)), '')
  return out.join('\n').replace(/\n+$/, '') + '\n'
}

export function reportCommand(root: string, o: { since?: string; json?: boolean }): { code: number; out: string } {
  const text = readText(join(root, '.claude', 'gate.log.jsonl'))
  const entries = text ? fromJsonl<DecisionLogEntry>(text).items : []
  const repo = loadRepo(root)
  const ruleIds = loadRules(root, repo.config).rules.map((r) => r.id)
  const rep = buildReport(entries, ruleIds, sinceMs(o.since, Date.now()), repo.config)
  if (o.since) rep.since = o.since
  return { code: 0, out: o.json ? JSON.stringify(rep) + '\n' : formatReport(rep) }
}

// ───────────────────────── bench ─────────────────────────

export interface BenchRow { repo: string; promptTokens: number; itemsBefore: number; itemsAfter: number; unverified: number; sections: number; ms: number }

export async function benchRepo(dir: string, o: { profile?: string; tier?: string; model?: string }): Promise<BenchRow> {
  const ctx = await buildContext({ root: dir, dryScripts: true, ...(o.profile ? { profile: o.profile } : {}), ...(o.tier ? { tier: o.tier } : {}), ...(o.model ? { model: o.model } : {}) })
  const r = await renderWith(ctx, {})
  const repo = loadRepo(dir)
  const items = collectItems(repo, ctx.rules)
  const before = tokens(items).tokens
  const gate = decide(repo.config, items, { ...(o.profile ? { profile: o.profile } : {}), ...(o.tier ? { tier: o.tier } : {}), ...(o.model ? { model: o.model } : {}) })
  const after = tokens(items.map((i) => ({ ...i, decision: gate.items[i.id] ?? 'on' }))).included.tokens
  return {
    repo: basename(dir),
    promptTokens: r.result.sections.filter((s) => s.included).reduce((a, s) => a + s.tokens, 0),
    itemsBefore: before,
    itemsAfter: after,
    unverified: r.result.sections.filter((s) => s.status === 'unverified').length,
    sections: r.result.sections.filter((s) => s.included).length,
    ms: r.result.ms,
  }
}

/** One entry of `bench/repos.json`, the single list of bench repos (CLI `bench` and `bench/run.ts`). */
export interface BenchRepo {
  name: string
  /** Relative to the repo root that holds `bench/repos.json`. */
  dir: string
  profile?: string
  model?: string
  tier?: string
  /** argv overrides for `node dist/cli.js …` (bench/run.ts only). */
  commands?: { health?: string[]; tokensOff?: string[]; tokensOn?: string[] }
}

export const BENCH_REPOS = join('bench', 'repos.json')

/** `bench/repos.json` → repos; missing or invalid → []. */
export function readBenchRepos(file: string): BenchRepo[] {
  const v = readJson<{ repos?: unknown }>(file)
  if (!v || !Array.isArray(v.repos)) return []
  return v.repos.filter((r): r is BenchRepo => !!r && typeof r === 'object' && typeof (r as BenchRepo).dir === 'string').map((r) => ({ ...r, name: typeof r.name === 'string' ? r.name : basename(r.dir) }))
}

/** Repos to bench: the given dirs; else `bench/repos.json` under root; else root itself. */
export function benchTargets(root: string, given: string[]): BenchRepo[] {
  if (given.length) return given.map((g) => ({ name: basename(resolve(root, g)), dir: resolve(root, g) }))
  const listed = readBenchRepos(join(root, BENCH_REPOS))
  if (listed.length) return listed.map((r) => ({ ...r, dir: resolve(root, r.dir) }))
  return [{ name: basename(root), dir: root }]
}

export async function benchCommand(root: string, dirs: string[], o: { before?: boolean; after?: boolean; json?: boolean; profile?: string; tier?: string; model?: string }): Promise<{ code: number; out: string }> {
  const rows: BenchRow[] = []
  for (const t of benchTargets(root, dirs)) {
    const pick = (k: 'profile' | 'tier' | 'model') => o[k] ?? t[k]
    const row = await benchRepo(t.dir, { ...(pick('profile') ? { profile: pick('profile') } : {}), ...(pick('tier') ? { tier: pick('tier') } : {}), ...(pick('model') ? { model: pick('model') } : {}) })
    rows.push({ ...row, repo: t.name })
  }
  if (o.json) return { code: 0, out: JSON.stringify(rows) + '\n' }
  const both = !o.before && !o.after
  const head = ['репозиторій', 'промпт, ток.', ...(o.before || both ? ['елементи до gate, ток.'] : []), ...(o.after || both ? ['елементи після gate, ток.'] : []), 'секцій', 'unverified', 'мс']
  const lines = rows.map((r) => [r.repo, r.promptTokens, ...(o.before || both ? [r.itemsBefore] : []), ...(o.after || both ? [r.itemsAfter] : []), r.sections, r.unverified, r.ms])
  const sum = (k: keyof BenchRow) => rows.reduce((a, r) => a + (r[k] as number), 0)
  if (rows.length > 1) lines.push(['**разом**', sum('promptTokens'), ...(o.before || both ? [sum('itemsBefore')] : []), ...(o.after || both ? [sum('itemsAfter')] : []), sum('sections'), sum('unverified'), sum('ms')])
  return { code: 0, out: table(head, lines) + '\n\nVerify з першої спроби по tier рахує runner (shiftwork) за журналом; тут — лише токени й unverified.\n' }
}
