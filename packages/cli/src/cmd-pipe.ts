// Composable pipe stages over JSONL (SPEC «Composable pipe-команда»): each stage reads Item JSONL on stdin
// and writes JSONL (or a summary) on stdout, so `collect | decide | tokens` composes with jq. The same stages
// run in-process for `context-gate pipe "collect | decide --profile x | tokens"` (grammar: core gatecmd).

import { join } from 'node:path'
import type { DecisionLogEntry, Item, ItemDecision, Value } from '../../core/src/types.ts'
import { normalize, tokens, whereFilter } from '../../core/src/pipeline.ts'
import { parseGateCommand, PIPE_STAGES, type PipeStage } from '../../core/src/gatecmd.ts'
import { fromJsonl, formatWhy } from '../../core/src/journal.ts'
import { parseDuration } from '../../core/src/duration.ts'
import { renderPrompt } from '../../core/src/render.ts'
import { buildContext, collectItems, decide, loadRepo } from './context.ts'
import { readText } from './util.ts'

export type StageOut = { records: unknown[] } | { text: string } | { error: string; code?: number }

export interface StageEnv { root: string; trustRepo?: boolean; now?: number }

type AnyItem = Item & { decision?: ItemDecision } & Record<string, unknown>
const asItems = (records: unknown[]): AnyItem[] => records.filter((r): r is AnyItem => !!r && typeof r === 'object' && typeof (r as Item).kind === 'string')

function readLog(root: string): DecisionLogEntry[] {
  const t = readText(join(root, '.claude', 'gate.log.jsonl'))
  return t ? fromJsonl<DecisionLogEntry>(t).items : []
}

export function sinceMs(since: string | undefined, now: number): number | undefined {
  if (!since) return undefined
  const d = parseDuration(since)
  if (d !== undefined) return now - d
  const t = Date.parse(since)
  return Number.isFinite(t) ? t : undefined
}

/** Per-item counters from the journal: delivered (rule-delivered / skill-render / decision enabled), denied. */
export function observeCounts(entries: readonly DecisionLogEntry[], from?: number): Map<string, { delivered: number; enabled: number; denied: number; lastAt?: number }> {
  const out = new Map<string, { delivered: number; enabled: number; denied: number; lastAt?: number }>()
  const bump = (id: string, k: 'delivered' | 'enabled' | 'denied', ts: number): void => {
    const c = out.get(id) ?? { delivered: 0, enabled: 0, denied: 0 }
    c[k]++
    c.lastAt = Math.max(c.lastAt ?? 0, ts)
    out.set(id, c)
  }
  for (const e of entries) {
    if (from !== undefined && (e.ts ?? 0) < from) continue
    const d = (e.data ?? {}) as Record<string, unknown>
    const kind = e.kind ?? 'decision'
    if (kind === 'rule-delivered') {
      const ids = [d.id, d.rule, ...(Array.isArray(d.rules) ? d.rules : [])].filter((x): x is string => typeof x === 'string')
      for (const id of ids) bump(id.includes(':') ? id : `rule:${id}`, 'delivered', e.ts)
    } else if (kind === 'skill-render' && typeof d.skill === 'string') bump(`skill:${d.skill}`, 'delivered', e.ts)
    else if (kind === 'deny') {
      const t = (d.tool ?? d.id ?? d.name) as string | undefined
      if (t) bump(t.includes(':') ? t : `tool:${t}`, 'denied', e.ts)
    } else if (kind === 'decision') for (const id of e.enabled ?? []) bump(id, 'enabled', e.ts)
  }
  return out
}

function num(v: string | undefined, dflt: number): number {
  const n = Number(v)
  return v !== undefined && Number.isFinite(n) ? n : dflt
}

/** One stage over records. `args` are `--key value` / `key=value` pairs as in the /gate grammar. */
export async function runStage(stage: PipeStage, input: unknown[], env: StageEnv): Promise<StageOut> {
  const a = stage.args
  const repo = loadRepo(env.root)
  const now = env.now ?? Date.now()
  switch (stage.stage) {
    case 'collect': {
      let items = collectItems(repo)
      const kinds = (a.kind ?? stage.positional[0])?.split(',')
      if (kinds) items = items.filter((i) => kinds.includes(i.kind))
      if (a.id) { const ids = a.id.split(','); items = items.filter((i) => ids.includes(i.name) || ids.includes(i.id)) }
      return { records: [...asItems(input), ...items] }
    }
    case 'normalize': return { records: normalize(asItems(input)) }
    case 'signals': {
      const ctx = await buildContext({ root: env.root, trustRepo: env.trustRepo, dryScripts: true, providerNames: new Set() })
      return { records: [{ paths: ctx.scope.git && typeof ctx.scope.git === 'object' ? (ctx.scope.git as Record<string, Value>).changed ?? [] : [], branch: (ctx.scope.git as Record<string, Value>)?.branch ?? '', model: a.model ?? '', tier: ctx.tier, profile: ctx.gate.profile ?? null }] }
    }
    case 'decide': {
      const items = asItems(input)
      const paths = a.paths?.split(',').filter(Boolean) ?? []
      const gate = decide(repo.config, items, { ...(a.profile ? { profile: a.profile } : {}), ...(a.model ? { model: a.model } : {}), ...(a.tier ? { tier: a.tier } : {}), ...(a.branch ? { branch: a.branch } : {}), paths })
      return { records: items.map((it) => ({ ...it, decision: gate.items[it.id] ?? 'on' })) }
    }
    case 'budget': {
      const maxItem = num(a['max-chars'] ?? a.max, repo.config.cursorRules?.maxCharsPerInjection ?? 30_000)
      let total = a.total !== undefined ? num(a.total, Infinity) * 4 : Infinity
      return {
        records: asItems(input).map((it) => {
          const d = it.decision ?? 'on'
          if (d === 'off' || d === 'nameOnly') return it
          const chars = it.cost?.chars ?? 0
          if (chars > maxItem) return { ...it, decision: 'nameOnly' as ItemDecision, budget: `${chars} > ${maxItem} символів → on-demand`, attach: { ...it.attach, when: 'on-demand' } }
          if (chars > total) return { ...it, decision: 'nameOnly' as ItemDecision, budget: 'загальний бюджет вичерпано → on-demand', attach: { ...it.attach, when: 'on-demand' } }
          total -= chars
          return it
        }),
      }
    }
    case 'render': {
      const ctx = await buildContext({ root: env.root, trustRepo: env.trustRepo, ...(a.tier ? { tier: a.tier } : {}), ...(a.profile ? { profile: a.profile } : {}), ...(a.model ? { model: a.model } : {}), ...(a['dry-scripts'] ? { dryScripts: true } : {}) })
      const items = asItems(input)
      const ids = new Set(items.filter((i) => i.kind === 'section').map((i) => i.name))
      const result = ids.size ? await renderPrompt(ctx.prompts.system, ctx.scope, ctx.host, { tier: ctx.tier, ...(ctx.repo.config.prompt?.runCacheDefault ? { runCacheDefault: ctx.repo.config.prompt.runCacheDefault } : {}) }) : undefined
      const byId = new Map(result?.sections.map((s) => [s.id, s]) ?? [])
      return {
        records: items.map((it) => {
          if (it.kind === 'section') {
            const s = byId.get(it.name)
            return { ...it, rendered: s ? { text: s.text, tokens: s.tokens, included: s.included, ...(s.reason ? { reason: s.reason } : {}), status: s.status } : { text: '', tokens: 0, included: false, reason: 'не знайдено' }, tier: ctx.tier }
          }
          const d = it.decision
          const text = d === 'off' ? '' : d === 'nameOnly' ? it.name : it.kind === 'rule' || d === 'preload' ? it.body ?? '' : `${it.name}${it.description ? `: ${it.description}` : ''}`
          return { ...it, rendered: { text, tokens: Math.ceil(text.length / 4), included: d !== 'off' } }
        }),
      }
    }
    case 'tokens': return { records: [tokens(asItems(input) as (Item & { decision?: ItemDecision })[])] }
    case 'preview': {
      const out: string[] = []
      for (const it of asItems(input)) {
        const r = (it as Record<string, unknown>).rendered as { text?: string; included?: boolean; reason?: string } | undefined
        const d = it.decision
        if (r) { out.push(`<!-- ${it.id}${d ? ` ${d}` : ''}${r.included === false ? ` — пропущено${r.reason ? `: ${r.reason}` : ''}` : ''} -->`); if (r.text) out.push(r.text); out.push('') }
        else out.push(`- ${it.id}${d ? ` [${d}]` : ''}${it.description ? ` — ${it.description}` : ''} (${it.cost?.chars ?? 0} симв.)`)
      }
      return { text: out.join('\n').replace(/\n+$/, '') + '\n' }
    }
    case 'deliver': {
      if (a['dry-run'] === undefined && !stage.positional.includes('dry-run')) return { error: 'deliver у CLI лише з --dry-run: доставку робить mod (claude-code-mod) або context-gate sync (static)', code: 2 }
      const adapter = a.adapter ?? 'claude-code-mod'
      return {
        records: asItems(input).map((it) => {
          const d = it.decision ?? 'on'
          let event = ''
          let action = ''
          if (adapter === 'static') {
            event = it.kind === 'rule' ? (it.ruleType === 'always' || it.ruleType === 'auto' ? '.claude/rules/cursor' : '.claude/skills/cursor-*') : it.kind === 'skill' ? 'settings.local.json skillOverrides' : it.kind === 'section' ? '.claude/prompt.generated.md' : '—'
            action = d === 'off' ? (it.kind === 'skill' ? 'skillOverrides: off' : 'не генерується') : d === 'nameOnly' ? 'skillOverrides: name-only' : 'генерується'
          } else if (it.kind === 'skill') { event = d === 'preload' ? 'skill.prompt + prompt.compose' : 'prompt.attachment skill_listing'; action = d === 'off' ? 'прибрано з листингу; skill.prompt → відмова' : d === 'nameOnly' ? 'лише назва в листингу' : d === 'preload' ? 'тіло вбудовано' : 'у листингу' }
          else if (it.kind === 'tool') { event = 'tool.describe + tool.call'; action = d === 'off' ? 'isDeferred + { deny }' : 'доступний' }
          else if (it.kind === 'agent') { event = 'agent.offer'; action = d === 'off' ? 'isOffered: false' : 'запропоновано' }
          else if (it.kind === 'rule') { event = it.ruleType === 'always' ? 'prompt.context' : it.ruleType === 'auto' ? 'tool.call (context після Read/Edit)' : it.ruleType === 'agent' ? 'skill (cursor-*)' : '/rule, @mention'; action = d === 'off' ? 'не доставляється' : 'доставляється' }
          else if (it.kind === 'section') { event = 'prompt.compose'; action = d === 'off' ? 'пропущено' : `секція context-gate:${it.name} (scope session)` }
          else { event = 'scope рендера'; action = 'дані провайдера' }
          return { id: it.id, decision: d, adapter, event, action }
        }),
      }
    }
    case 'observe': {
      const from = sinceMs(a.since, now)
      const counts = observeCounts(readLog(env.root), from)
      const status = a.status
      const out = asItems(input).map((it) => ({ ...it, observed: counts.get(it.id) ?? { delivered: 0, enabled: 0, denied: 0 } }))
      const filtered = !status ? out : out.filter((it) => {
        const c = it.observed
        if (status === 'never') return c.delivered === 0 && c.enabled === 0
        if (status === 'delivered') return c.delivered > 0
        if (status === 'denied') return c.denied > 0
        if (status === 'enabled') return c.enabled > 0
        return (it as Item).status === status
      })
      return { records: filtered }
    }
    case 'where': {
      const r = whereFilter(asItems(input), stage.expr ?? stage.positional.join(' '), repo.config)
      return 'error' in r ? { error: `G508 ${r.error}`, code: 2 } : { records: r.items }
    }
    case 'take': return { records: input.slice(0, num(stage.positional[0] ?? a.n, 10)) }
    case 'sort': {
      const key = stage.positional[0] ?? a.key ?? 'id'
      const desc = key.startsWith('-')
      const k = desc ? key.slice(1) : key
      const get = (x: unknown): unknown => k === 'chars' ? (x as Item).cost?.chars : k.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), x)
      return { records: [...input].sort((x, y) => { const p = get(x); const q = get(y); const c = typeof p === 'number' && typeof q === 'number' ? p - q : String(p ?? '').localeCompare(String(q ?? '')); return desc ? -c : c }) }
    }
    case 'on': return { records: asItems(input).filter((i) => (i.decision ?? 'on') !== 'off') }
    case 'off': return { records: asItems(input).filter((i) => i.decision === 'off') }
    case 'why': {
      const entries = readLog(env.root)
      if (a.json || a.format === 'jsonl') return { records: entries }
      return { text: formatWhy(entries, num(a.n, 50)) + '\n' }
    }
  }
  return { error: `G501 Невідома стадія «${stage.stage}»`, code: 2 }
}

/** Runs a whole `a | b | c` pipe in-process. */
export async function runPipe(text: string, input: unknown[], env: StageEnv): Promise<StageOut> {
  const parsed = parseGateCommand(text.trim().startsWith('gate') ? text : text, {})
  if ('error' in parsed) return { error: parsed.error, code: 2 }
  const stages = parsed.cmd === 'pipe' ? parsed.stages : undefined
  if (!stages) return { error: `G501 «${text}» не є pipe-командою (стадії: ${PIPE_STAGES.join(', ')})`, code: 2 }
  let records = input
  for (let i = 0; i < stages.length; i++) {
    const out = await runStage(stages[i]!, records, env)
    if ('error' in out) return out
    if ('text' in out) {
      if (i < stages.length - 1) return { error: `G504 Стадія ${stages[i]!.stage} виводить текст, далі в pipe її не передати`, code: 2 }
      return out
    }
    records = out.records
  }
  return { records }
}

export function formatStageOut(out: StageOut, opts: { pretty?: boolean } = {}): string {
  if ('error' in out) return ''
  if ('text' in out) return out.text
  if (opts.pretty && out.records.length === 1) return JSON.stringify(out.records[0], null, 2) + '\n'
  return out.records.map((r) => JSON.stringify(r)).join('\n') + (out.records.length ? '\n' : '')
}
