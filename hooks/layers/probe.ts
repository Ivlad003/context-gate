// Features that depend on mods-API points no live run has confirmed yet (SPEC Р6, docs/PROBE.md «LIVE results»).
// `requires: ['probe:<point>']` ties a feature to a point; while the point is `unverified`, `/gate health` and
// `/gate why` list the feature as «не перевірено наживо». Update `PROBE_POINTS` when a probe session settles a point.

import type { Runtime } from '../ctx.ts'

export type ProbeStatus = 'verified' | 'unverified'

/** The PROBE.md LIVE points, by name, with what the last live run (2026-10-06, Claude Code 2.1.291) showed. */
export const PROBE_POINTS: Record<string, { status: ProbeStatus; note: string }> = {
  'skill-listing-format': { status: 'verified', note: '`- <name>: <description>` lines (claude -p)' },
  'skill-listing-rewrite': { status: 'unverified', note: 'чи бачить модель переписаний листинг (інтерактивний крок 1)' },
  'tool-describe-deferred': { status: 'verified', note: 'tool.describe fires for deferred MCP tools; isDeferred holds' },
  'skill-prompt-bang': { status: 'unverified', note: 'чи виконано !`…` до skill.prompt; args через Skill / command.run (крок 3)' },
  'state-after-clear': { status: 'unverified', note: '$.state після /clear і classic.SessionStart {source: clear} (крок 7)' },
  'filechanged-watchdir': { status: 'verified', note: 'a watchPaths directory fires FileChanged recursively' },
  'subagent-prompt-context': { status: 'unverified', note: 'prompt.context у субагентах (крок 5)' },
  'model-complete-cost': { status: 'unverified', note: 'латентність і вартість $.model.complete (/probe classify)' },
  'prompt-compose-print': { status: 'verified', note: 'prompt.compose fires under -p (traits print, skills, lean)' },
}

export interface ProbeRequirement {
  feature: string
  requires: string[]
  /** Only listed when the feature is in use. */
  active: (rt: Runtime) => boolean
}

export const PROBE_REQUIREMENTS: ProbeRequirement[] = [
  { feature: 'фільтр листингу skills (skill-gate apply)', requires: ['probe:skill-listing-format', 'probe:skill-listing-rewrite'], active: (rt) => !!rt.config },
  { feature: 'MCP: коротший опис + isDeferred', requires: ['probe:tool-describe-deferred'], active: (rt) => !!rt.config },
  { feature: 'skills-промпти з аргументами (skill.prompt)', requires: ['probe:skill-prompt-bang'], active: (rt) => !!rt.prompts?.compiled.some((p) => p.skill) },
  { feature: 'скидання стану на /clear', requires: ['probe:state-after-clear'], active: () => true },
  { feature: 'перезбірка за classic.FileChanged', requires: ['probe:filechanged-watchdir'], active: () => true },
  { feature: 'Always-правила в субагентах', requires: ['probe:subagent-prompt-context'], active: (rt) => rt.disabled.rules === undefined },
  { feature: 'класифікатор / бриф через $.model.complete', requires: ['probe:model-complete-cost'], active: (rt) => !!rt.config?.classify || !!rt.options.brief },
  { feature: 'секції DSL у claude -p', requires: ['probe:prompt-compose-print'], active: () => true },
]

/** Requirements whose points are not all verified (an unknown point counts as unverified). */
export function unverifiedRequirements(rt: Runtime, points: Record<string, { status: ProbeStatus }> = PROBE_POINTS): { feature: string; points: string[] }[] {
  const out: { feature: string; points: string[] }[] = []
  for (const r of PROBE_REQUIREMENTS) {
    if (!r.active(rt)) continue
    const open = r.requires.map((x) => x.replace(/^probe:/, '')).filter((p) => points[p]?.status !== 'verified')
    if (open.length) out.push({ feature: r.feature, points: open })
  }
  return out
}

/** Lines for `/gate health` and `/gate why`; empty when everything in use is verified. */
export function unverifiedLines(rt: Runtime): string[] {
  const open = unverifiedRequirements(rt)
  if (!open.length) return []
  return ['Не перевірено наживо (docs/PROBE.md):', ...open.map((o) => `- ${o.feature} — ${o.points.map((p) => `probe:${p}`).join(', ')}`)]
}
