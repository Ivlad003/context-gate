// .claude/gate.json: defaults, JSON Schema, hand-written validator, legacy normalisation and migration.
// SPEC "Конфігурація `.claude/gate.json`", "Єдина модель" (groups with kind prefixes, G310).
// Never throws: a schema error returns diagnostics and no config (the skill-gate layer is disabled).

import type { BudgetPct, Diagnostic, GateConfig, ItemSourceConfig, ModelSpec, ProfileConfig, Tier, TierConfig, TierThresholds } from './types.ts'
import { diag } from './codes.ts'
import { parseDuration } from './duration.ts'
import { compileGlob } from './glob.ts'

// ───────────────────────── Defaults ─────────────────────────

export const DEFAULT_TIER: Tier = 'standard'
export const DEFAULT_BUDGET: Required<BudgetPct> = { softContextPct: 70, hardContextPct: 85 }

export function defaultConfig(): GateConfig {
  return {
    groups: {},
    tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [] } },
    models: { '*opus*': 'premium', '*sonnet*': 'standard', '*haiku*': 'quick' },
    profiles: {},
    classify: { mode: 'shadow', minConfidence: 0.7, recheckOn: ['/gate new', 'compact'] },
    budgets: { default: { ...DEFAULT_BUDGET } },
    cursorRules: { enabled: true, nested: false, maxCharsPerInjection: 30000, strictWrite: false },
    prompt: { dir: '.claude/prompt', runCacheDefault: '5m', build: 'auto', commitCompiled: false },
  }
}

// ───────────────────────── JSON Schema ─────────────────────────
// A subset of JSON Schema (type, properties, additionalProperties, items, enum, minimum, maximum,
// required, anyOf, description) — interpreted by `checkSchema` below and published as
// schema/context-gate.schema.json.

type S = Record<string, unknown>
const str: S = { type: 'string' }
const bool: S = { type: 'boolean' }
const strArr: S = { type: 'array', items: { type: 'string' } }
const pct: S = { type: 'number', minimum: 0, maximum: 100 }
const tierRef: S = { type: 'string', description: 'Tier name (key of `tiers`).' }
const budgetPct: S = { type: 'object', additionalProperties: false, properties: { softContextPct: pct, hardContextPct: pct } }
const onExceedAction: S = {
  anyOf: [
    { type: 'object', additionalProperties: false, required: ['do', 'section'], properties: { do: { enum: ['section'] }, section: str } },
    { type: 'object', additionalProperties: false, required: ['do', 'text'], properties: { do: { enum: ['notice'] }, text: str } },
    { type: 'object', additionalProperties: false, required: ['do'], properties: { do: { enum: ['compact'] }, instructions: str } },
  ],
}
const num0: S = { type: 'number', minimum: 0 }
const modelSpec: S = {
  type: 'object', additionalProperties: false,
  description: 'Model attributes: with `tier` a direct mapping; without it the tier is inferred from `tiers[*].thresholds`.',
  properties: { tier: tierRef, match: { type: 'string', description: 'Glob on the model id (the key is then a label).' }, contextWindow: { type: 'integer', minimum: 1 }, costPer1k: num0 },
}
const thresholds: S = {
  type: 'object', additionalProperties: false,
  properties: { minContextWindow: { type: 'integer', minimum: 0 }, maxContextWindow: { type: 'integer', minimum: 0 }, minCostPer1k: num0, maxCostPer1k: num0 },
}
const providerRef: S = {
  anyOf: [
    { enum: ['builtin', 'jev'] },
    { type: 'object', additionalProperties: false, required: ['kind', 'command'], properties: { kind: { enum: ['cli'] }, command: strArr, timeout: { type: 'string', format: 'duration' } } },
  ],
}
const groupMap: S = { type: 'object', additionalProperties: strArr, description: 'Group name → globs.' }
const itemSource: S = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { enum: ['claude-skills', 'claude-tools', 'claude-agents', 'cursor-mdc', 'markdown-dir', 'prompt-dir', 'provider'] },
    dir: str, match: str, as: { enum: ['skill', 'tool', 'agent', 'rule', 'section', 'datum', 'always'] },
    name: str, pick: str, field: str, template: str, nested: bool,
    frontmatter: { type: 'object', additionalProperties: str },
  },
}

/** Binaries repo code may start when `~/.claude/context-gate.json` has no `allowBinaries` (mod and CLI). */
export const DEFAULT_BINARIES: readonly string[] = ['bash', 'sh', 'node', 'python3', 'python', 'deno', 'git']

/** Effective whitelist: the user's list (or DEFAULT_BINARIES) narrowed by gate.json `allowBinaries` (Р2: never widened). */
export function binaryWhitelist(user: readonly string[] | undefined, repo: readonly string[] | undefined): string[] {
  const base = user ?? DEFAULT_BINARIES
  return repo ? base.filter((b) => repo.includes(b)) : [...base]
}

export const gateJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://context-gate.dev/context-gate.schema.json',
  title: 'context-gate .claude/gate.json',
  type: 'object',
  additionalProperties: false,
  properties: {
    $schema: str,
    groups: { ...groupMap, description: 'Unified groups: name → kind-prefixed globs (`skill:react-*`, `tool:mcp__figma__*`, `agent:ui-reviewer`, `rule:api-*`).' },
    skillGroups: { ...groupMap, description: 'Legacy (G310): group → skill name globs.' },
    mcpGroups: { ...groupMap, description: 'Legacy (G310): group → MCP server name globs.' },
    tiers: {
      type: 'object',
      additionalProperties: {
        type: 'object', additionalProperties: false,
        properties: { groups: strArr, skills: { ...strArr, description: 'Legacy (G310).' }, preload: strArr, thresholds },
      },
    },
    models: { type: 'object', additionalProperties: { anyOf: [tierRef, modelSpec] }, description: 'Model id glob → tier, or model attributes (`contextWindow`, `costPer1k`).' },
    profiles: {
      type: 'object',
      additionalProperties: {
        type: 'object', additionalProperties: false,
        properties: {
          groups: strArr, skills: strArr, mcp: strArr, agents: strArr,
          when: {
            type: 'object', additionalProperties: false,
            properties: { paths: strArr, branch: str, expr: str, ticketType: strArr },
          },
        },
      },
    },
    classify: {
      type: 'object', additionalProperties: false, required: ['mode'],
      properties: {
        mode: { enum: ['shadow', 'auto'] }, model: str,
        minConfidence: { type: 'number', minimum: 0, maximum: 1 }, recheckOn: strArr, provider: providerRef,
      },
    },
    budgets: { type: 'object', additionalProperties: false, properties: { default: budgetPct, tiers: { type: 'object', additionalProperties: budgetPct } } },
    onExceed: { type: 'object', additionalProperties: false, properties: { softContextPct: onExceedAction, hardContextPct: onExceedAction } },
    escalation: {
      type: 'object', additionalProperties: false, required: ['order', 'after'],
      properties: {
        order: { type: 'array', items: tierRef },
        after: { type: 'object', additionalProperties: false, properties: { verifyFailed: { type: 'integer', minimum: 1 }, stallTurns: { type: 'integer', minimum: 1 } } },
      },
    },
    brief: {
      type: 'object', additionalProperties: false, required: ['enabled'],
      properties: { enabled: bool, model: str, maxChars: { type: 'integer', minimum: 0 }, tiers: { type: 'array', items: tierRef }, provider: providerRef },
    },
    providers: {
      type: 'object',
      additionalProperties: {
        type: 'object', additionalProperties: false, required: ['kind'],
        properties: {
          kind: { enum: ['cli', 'file', 'mcp', 'module'] }, builtin: bool, command: strArr,
          functions: { anyOf: [strArr, { type: 'object', additionalProperties: strArr }] },
          path: str, pick: strArr, tool: str, args: { type: 'object' },
          cache: { type: 'string', format: 'duration' }, onError: { enum: ['unverified', 'skip', 'fail'] },
          schema: {}, exposes: strArr,
        },
      },
    },
    executors: {
      type: 'object',
      additionalProperties: {
        type: 'object', additionalProperties: false, required: ['command'],
        properties: { command: strArr, stdin: str, timeout: { type: 'string', format: 'duration' }, env: { type: 'object', additionalProperties: str }, callTemplate: strArr },
      },
    },
    ruleSources: { type: 'array', items: itemSource, description: 'Legacy (G310): use itemSources.' },
    itemSources: { type: 'array', items: itemSource },
    gates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'on'],
        properties: {
          name: str, on: { enum: ['write', 'commit', 'turn', 'prompt'] }, builtin: bool, tiers: { type: 'array', items: tierRef },
          run: strArr, pass: str, message: str, provider: str, onlyNew: bool, baseline: str,
        },
      },
    },
    cursorRules: {
      type: 'object', additionalProperties: false,
      properties: { enabled: bool, nested: bool, maxCharsPerInjection: { type: 'integer', minimum: 0 }, strictWrite: bool },
    },
    prompt: {
      type: 'object', additionalProperties: false,
      properties: { dir: str, runCacheDefault: { type: 'string', format: 'duration' }, build: { enum: ['auto', 'never'] }, commitCompiled: bool, persist: bool, packages: { ...strArr, description: 'Prompt library packages whose exported skills `build` builds.' }, transform: { enum: ['level1', 'level2'], description: 'TSX level 2: native TS expressions in runtime props (Р1).' }, skillBody: { enum: ['live', 'static', 'both'], description: 'SKILL.md body: live render line, pre-rendered static body, or both (Р6).' } },
    },
    health: { type: 'object', additionalProperties: { type: 'number' }, description: 'Code (H001…) → threshold.' },
    debug: bool,
    debugLog: { type: 'object', additionalProperties: false, properties: { path: str, maxBytes: { type: 'integer', minimum: 1 } }, description: 'Debug log file (written only with `debug: true` or CLI `--debug`).' },
    assertFail: { enum: ['skip', 'fail'], description: 'A false `@assert`: skip the section (default) or fail the render.' },
    log: { type: 'object', additionalProperties: false, properties: { file: bool } },
    env: { ...strArr, description: 'Env vars visible to the DSL as `env.*` (masked in debug output).' },
    allowBinaries: { ...strArr, description: 'Binaries repo executors/providers may start. Narrows the user whitelist (~/.claude/context-gate.json), never widens it (Р2).' },
  },
} as const

// ───────────────────────── Mini validator ─────────────────────────

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

function typeMatches(want: string, v: unknown): boolean {
  const t = typeOf(v)
  if (want === 'number') return t === 'number' || t === 'integer'
  return want === t
}

function checkSchema(schema: S, v: unknown, path: string, out: Diagnostic[]): void {
  if (schema.anyOf) {
    const alts = schema.anyOf as S[]
    let best: Diagnostic[] | undefined
    for (const alt of alts) {
      const d: Diagnostic[] = []
      checkSchema(alt, v, path, d)
      if (!d.some((x) => x.severity === 'error')) { out.push(...d); return }
      if (!best || d.length < best.length) best = d
    }
    out.push(...(best ?? []))
    return
  }
  if (schema.enum) {
    const vals = schema.enum as unknown[]
    if (!vals.includes(v)) out.push(diag('G308', `${path}: ${JSON.stringify(v)} — очікується одне з: ${vals.join(' | ')}`))
    return
  }
  const type = schema.type as string | undefined
  if (type && !typeMatches(type, v)) {
    out.push(diag('G303', `${path}: очікується ${type}, отримано ${typeOf(v)}`))
    return
  }
  if (typeof v === 'number') {
    if (typeof schema.minimum === 'number' && v < schema.minimum) out.push(diag('G309', `${path}: ${v} < ${schema.minimum}`))
    if (typeof schema.maximum === 'number' && v > schema.maximum) out.push(diag('G309', `${path}: ${v} > ${schema.maximum}`))
  }
  if (typeof v === 'string' && schema.format === 'duration' && parseDuration(v) === undefined) {
    out.push(diag('G307', `${path}: невірна тривалість ${JSON.stringify(v)}`))
  }
  if (Array.isArray(v) && schema.items) {
    v.forEach((x, i) => checkSchema(schema.items as S, x, `${path}[${i}]`, out))
  }
  if (type === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, S>
    for (const r of (schema.required ?? []) as string[]) {
      if (!(r in obj)) out.push(diag('G311', `${path}.${r}: обов'язкове поле відсутнє`))
    }
    for (const [k, val] of Object.entries(obj)) {
      const sub = props[k]
      if (sub) { checkSchema(sub, val, `${path}.${k}`, out); continue }
      const ap = schema.additionalProperties
      if (ap === false) out.push(diag('G302', `${path}.${k}: невідомий ключ, ігнорується`))
      else if (ap && typeof ap === 'object') checkSchema(ap as S, val, `${path}.${k}`, out)
    }
  }
}

/** Validate raw JSON (already parsed) against the schema plus semantic checks; merges defaults.
 * Returns `config` only when there are no errors. Unknown keys are warnings (and dropped). */
export function validateConfig(json: unknown): { config?: GateConfig; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { diagnostics: [diag('G301', `gate.json: очікується об'єкт, отримано ${typeOf(json)}`)] }
  }
  checkSchema(gateJsonSchema as unknown as S, json, '$', diagnostics)
  const raw = json as Record<string, unknown>
  semanticChecks(raw, diagnostics)
  if (diagnostics.some((d) => d.severity === 'error')) return { diagnostics }
  const known = gateJsonSchema.properties as Record<string, unknown>
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (k in known) clean[k] = v
  return { config: mergeDefaults(clean as Partial<GateConfig>), diagnostics }
}

/** Parse text + validate + normalise. Convenience for the hook / CLI. */
export function loadConfig(text: string | undefined): { config?: GateConfig; diagnostics: Diagnostic[] } {
  if (text === undefined) return { config: defaultConfig(), diagnostics: [] }
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^﻿/, ''))
  } catch (e) {
    return { diagnostics: [diag('G301', `gate.json не парситься: ${(e as Error).message}`)] }
  }
  const v = validateConfig(json)
  if (!v.config) return v
  const n = normalizeConfig(v.config)
  return { config: n.config, diagnostics: [...v.diagnostics, ...n.diagnostics] }
}

function semanticChecks(raw: Record<string, unknown>, out: Diagnostic[]): void {
  const profiles = isObj(raw.profiles) ? raw.profiles : {}
  for (const [name, p] of Object.entries(profiles)) {
    if (!isObj(p) || !isObj(p.when)) continue
    const br = p.when.branch
    if (typeof br === 'string') {
      try { new RegExp(br) } catch (e) { out.push(diag('G306', `$.profiles.${name}.when.branch: ${(e as Error).message}`)) }
    }
  }
  const tiers = isObj(raw.tiers) ? raw.tiers : undefined
  const tierNames = new Set(Object.keys(tiers ?? defaultConfig().tiers))
  if (isObj(raw.models)) {
    for (const [glob, t] of Object.entries(raw.models)) {
      const tt = typeof t === 'string' ? t : isObj(t) && typeof t.tier === 'string' ? t.tier : undefined
      if (tt !== undefined && !tierNames.has(tt)) out.push(diag('G305', `$.models.${glob}: tier "${tt}" не оголошено в tiers`))
    }
  }
  const sources = [...(Array.isArray(raw.itemSources) ? raw.itemSources : []), ...(Array.isArray(raw.ruleSources) ? raw.ruleSources : [])]
  const providerNames = new Set(Object.keys(isObj(raw.providers) ? raw.providers : {}))
  sources.forEach((src, i) => {
    if (!isObj(src)) return
    const where = `$.itemSources[${i}] (${String(src.kind)})`
    if (src.kind === 'markdown-dir' && typeof src.dir !== 'string') out.push(diag('G313', `${where}: потрібне поле dir`))
    if (src.kind === 'provider') {
      if (typeof src.name !== 'string') out.push(diag('G313', `${where}: потрібне поле name`))
      else if (!providerNames.has(src.name)) out.push(diag('G313', `${where}: провайдер "${src.name}" не оголошено в providers`))
    }
  })
  const esc = raw.escalation
  if (isObj(esc) && Array.isArray(esc.order)) {
    for (const t of esc.order) if (typeof t === 'string' && !tierNames.has(t)) out.push(diag('G305', `$.escalation.order: tier "${t}" не оголошено в tiers`))
  }
  const budgets = raw.budgets
  if (isObj(budgets)) {
    const check = (b: unknown, p: string) => {
      if (isObj(b) && typeof b.softContextPct === 'number' && typeof b.hardContextPct === 'number' && b.softContextPct >= b.hardContextPct) {
        out.push(diag('G312', `${p}: softContextPct ${b.softContextPct} ≥ hardContextPct ${b.hardContextPct}`))
      }
    }
    check(budgets.default, '$.budgets.default')
    if (isObj(budgets.tiers)) for (const [t, b] of Object.entries(budgets.tiers)) check(b, `$.budgets.tiers.${t}`)
  }
  // Group references (new format only; legacy refs are checked in normalizeConfig).
  const groupNames = new Set([...Object.keys(isObj(raw.groups) ? raw.groups : {}), ...Object.keys(isObj(raw.skillGroups) ? raw.skillGroups : {}), ...Object.keys(isObj(raw.mcpGroups) ? raw.mcpGroups : {})])
  for (const [name, p] of Object.entries(profiles)) {
    if (isObj(p) && Array.isArray(p.groups)) {
      for (const g of p.groups) if (typeof g === 'string' && !groupNames.has(g)) out.push(diag('G304', `$.profiles.${name}.groups: група "${g}" не оголошена`))
    }
  }
  if (tiers) {
    for (const [name, t] of Object.entries(tiers)) {
      if (isObj(t) && Array.isArray(t.groups)) {
        for (const g of t.groups) if (typeof g === 'string' && !groupNames.has(g)) out.push(diag('G304', `$.tiers.${name}.groups: група "${g}" не оголошена`))
      }
    }
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Fill in defaults for missing top-level and nested fields. User values win. */
export function mergeDefaults(cfg: Partial<GateConfig>): GateConfig {
  const d = defaultConfig()
  return {
    ...d,
    ...cfg,
    tiers: cfg.tiers ?? d.tiers,
    models: cfg.models ?? d.models,
    profiles: cfg.profiles ?? d.profiles,
    groups: cfg.groups ?? (cfg.skillGroups || cfg.mcpGroups ? undefined : d.groups),
    classify: cfg.classify ? { ...d.classify!, ...cfg.classify } : d.classify,
    budgets: cfg.budgets ? { ...cfg.budgets, default: { ...DEFAULT_BUDGET, ...cfg.budgets.default } } : d.budgets,
    cursorRules: { ...d.cursorRules, ...cfg.cursorRules },
    prompt: { ...d.prompt, ...cfg.prompt },
  }
}

// ───────────────────────── Legacy → unified groups (G310) ─────────────────────────

function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)]
}

function hasLegacy(cfg: Partial<GateConfig>): string[] {
  const fields: string[] = []
  if (cfg.skillGroups) fields.push('skillGroups')
  if (cfg.mcpGroups) fields.push('mcpGroups')
  if (cfg.ruleSources) fields.push('ruleSources')
  for (const [n, p] of Object.entries(cfg.profiles ?? {})) {
    for (const k of ['skills', 'mcp', 'agents'] as const) if (p[k]) fields.push(`profiles.${n}.${k}`)
  }
  for (const [n, t] of Object.entries(cfg.tiers ?? {})) if (t.skills) fields.push(`tiers.${n}.skills`)
  return fields
}

/** Convert legacy `skillGroups` / `mcpGroups` / `ruleSources` / profile `skills|mcp|agents` / tier `skills`
 * into unified kind-prefixed `groups` and `itemSources`. Emits one G310 warning when anything was converted.
 * Works on partial (raw) configs as well as merged ones. */
export function normalizeConfig<C extends Partial<GateConfig>>(cfg: C): { config: C; diagnostics: Diagnostic[] } {
  const legacy = hasLegacy(cfg)
  if (!legacy.length) return { config: cfg, diagnostics: [] }
  const diagnostics: Diagnostic[] = [diag('G310', `Застарілий формат gate.json: ${legacy.join(', ')}. Конвертовано в groups; запусти \`context-gate migrate\`.`)]
  const sg = cfg.skillGroups ?? {}
  const mg = cfg.mcpGroups ?? {}
  const groups: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(cfg.groups ?? {})) groups[k] = [...v]
  const add = (name: string, globs: string[]) => { groups[name] = uniq([...(groups[name] ?? []), ...globs]) }
  const skillGlobs = (name: string) => (sg[name] ?? []).map((g) => prefixKind('skill', g))
  const mcpGlobs = (name: string) => (mg[name] ?? []).map(mcpServerGlob)
  for (const name of Object.keys(sg)) add(name, skillGlobs(name))
  for (const name of Object.keys(mg)) add(name, mcpGlobs(name))
  const collides = (name: string) => name in sg && name in mg

  // A reference from a skills-only list to a name that exists in both legacy maps must not
  // pull in the other kind: use a dedicated split group.
  const refFor = (name: string, kind: 'skills' | 'mcp', where: string): string | undefined => {
    if (kind === 'skills' && !(name in sg) && !(name in mg) && !(name in (cfg.groups ?? {}))) {
      diagnostics.push(diag('G304', `${where}: група "${name}" не оголошена в skillGroups`))
      return undefined
    }
    if (kind === 'mcp' && !(name in mg) && !(name in sg) && !(name in (cfg.groups ?? {}))) {
      diagnostics.push(diag('G304', `${where}: група "${name}" не оголошена в mcpGroups`))
      return undefined
    }
    if (!collides(name)) return name
    const split = `${name}-${kind}`
    add(split, kind === 'skills' ? skillGlobs(name) : mcpGlobs(name))
    return split
  }
  const convertRefs = (skills: string[] | undefined, mcp: string[] | undefined, where: string): string[] => {
    const s = new Set(skills ?? [])
    const m = new Set(mcp ?? [])
    const out: string[] = []
    for (const name of uniq([...s, ...m])) {
      if (s.has(name) && m.has(name)) { out.push(name); continue }
      const r = refFor(name, s.has(name) ? 'skills' : 'mcp', where)
      if (r) out.push(r)
    }
    return out
  }

  const profiles: Record<string, ProfileConfig> = {}
  for (const [name, p] of Object.entries(cfg.profiles ?? {})) {
    const { skills, mcp, agents, ...rest } = p
    const refs = [...(p.groups ?? []), ...convertRefs(skills, mcp, `profiles.${name}`)]
    if (agents && agents.length) {
      const g = `${name}-agents`
      add(g, agents.map((a) => prefixKind('agent', a)))
      refs.push(g)
    }
    profiles[name] = { ...rest, groups: uniq(refs) }
  }
  const tiers: Record<Tier, TierConfig> = {}
  for (const [name, t] of Object.entries(cfg.tiers ?? {})) {
    const { skills, ...rest } = t
    tiers[name] = { ...rest, groups: uniq([...(t.groups ?? []), ...convertRefs(skills, undefined, `tiers.${name}`)]) }
  }
  const out: Partial<GateConfig> = { ...cfg, groups, profiles, tiers }
  delete out.skillGroups
  delete out.mcpGroups
  if (cfg.ruleSources) {
    out.itemSources = [...(cfg.itemSources ?? []), ...cfg.ruleSources.filter((r) => !(cfg.itemSources ?? []).some((i) => sameSource(i, r)))]
    delete out.ruleSources
  }
  if (cfg.profiles === undefined) delete out.profiles
  if (cfg.tiers === undefined) delete out.tiers
  return { config: out as C, diagnostics }
}

function sameSource(a: ItemSourceConfig, b: ItemSourceConfig): boolean {
  return a.kind === b.kind && a.dir === b.dir && a.name === b.name
}

function prefixKind(kind: string, glob: string): string {
  const neg = glob.startsWith('!')
  const g = neg ? glob.slice(1) : glob
  return (neg ? '!' : '') + (/^(skill|tool|agent|rule|section|datum):/.test(g) ? g : `${kind}:${g}`)
}

/** Legacy mcpGroups entry is a server name (glob) → `tool:mcp__<server>__*`. */
function mcpServerGlob(server: string): string {
  const neg = server.startsWith('!')
  const s = neg ? server.slice(1) : server
  if (s.startsWith('tool:')) return server
  return (neg ? '!' : '') + (s.startsWith('mcp__') ? `tool:${s}` : `tool:mcp__${s}__*`)
}

/** New-format JSON for `context-gate migrate` (raw input, no defaults added). */
export function migrateConfig(raw: unknown): { json?: Record<string, unknown>; diagnostics: Diagnostic[] } {
  if (!isObj(raw)) return { diagnostics: [diag('G301', `gate.json: очікується об'єкт`)] }
  const { config, diagnostics } = normalizeConfig(raw as Partial<GateConfig>)
  // Put `groups` near the top for readability.
  const { $schema, groups, ...rest } = config as Record<string, unknown>
  const json: Record<string, unknown> = {}
  if ($schema !== undefined) json.$schema = $schema
  if (groups !== undefined) json.groups = groups
  Object.assign(json, rest)
  return { json, diagnostics }
}

// ───────────────────────── Lookups ─────────────────────────

/** Strip harness suffixes like `[1m]` and provider prefixes like `us.anthropic.`. */
export function normalizeModelId(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/, '').replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
}

export interface ModelAttrs { contextWindow?: number; costPer1k?: number }

/** Default thresholds when no tier declares any: premium ≥ $0.01/1k input, standard ≥ $0.002/1k, quick below. */
const DEFAULT_THRESHOLDS: Record<string, TierThresholds> = { premium: { minCostPer1k: 0.01 }, standard: { minCostPer1k: 0.002 }, quick: {} }

function meets(t: TierThresholds, a: ModelAttrs): boolean {
  const cw = a.contextWindow
  const cost = a.costPer1k
  if (t.minContextWindow !== undefined && (cw === undefined || cw < t.minContextWindow)) return false
  if (t.maxContextWindow !== undefined && (cw === undefined || cw > t.maxContextWindow)) return false
  if (t.minCostPer1k !== undefined && (cost === undefined || cost < t.minCostPer1k)) return false
  if (t.maxCostPer1k !== undefined && (cost === undefined || cost > t.maxCostPer1k)) return false
  return true
}

/** Tier from model attributes: the first tier (declaration order) whose `thresholds` all hold. Tiers without
 * `thresholds` are skipped unless no tier declares any, in which case DEFAULT_THRESHOLDS apply to the
 * premium/standard/quick tiers that exist. undefined when nothing matches or no attributes are known. */
export function inferTier(cfg: Pick<GateConfig, 'tiers'>, attrs: ModelAttrs): Tier | undefined {
  if (attrs.contextWindow === undefined && attrs.costPer1k === undefined) return undefined
  const tiers = Object.entries(cfg.tiers ?? {})
  const declared = tiers.filter(([, t]) => t.thresholds)
  const table: [Tier, TierThresholds][] = declared.length
    ? declared.map(([n, t]) => [n, t.thresholds!])
    : Object.keys(DEFAULT_THRESHOLDS).filter((n) => tiers.some(([k]) => k === n)).map((n) => [n, DEFAULT_THRESHOLDS[n]!])
  for (const [name, t] of table) if (meets(t, attrs)) return name
  return undefined
}

function attrText(a: ModelAttrs): string {
  return [a.contextWindow !== undefined ? `contextWindow ${a.contextWindow}` : '', a.costPer1k !== undefined ? `costPer1k ${a.costPer1k}` : ''].filter(Boolean).join(', ')
}

/** Tier for a model id: exact key first, then globs (`match` or the key) in declaration order; an entry
 * with attributes and no `tier` infers it from thresholds; no entry → `attrs` from the harness (when given)
 * through thresholds; then `standard`. */
export function tierForModel(cfg: Pick<GateConfig, 'models' | 'tiers'>, modelId: string | undefined, attrs?: ModelAttrs): { tier: Tier; reason: string; matched?: string; fallback: boolean } {
  if (!modelId) return { tier: DEFAULT_TIER, reason: `модель невідома → ${DEFAULT_TIER}`, fallback: true }
  const id = normalizeModelId(modelId)
  const models = cfg.models ?? {}
  const resolve = (key: string, how: string, v: Tier | ModelSpec) => {
    if (typeof v === 'string') return { tier: v, reason: `модель ${id} ${how} → ${v}`, matched: key, fallback: false }
    if (v.tier) return { tier: v.tier, reason: `модель ${id} ${how} → ${v.tier}`, matched: key, fallback: false }
    const a: ModelAttrs = { ...attrs, ...(v.contextWindow !== undefined ? { contextWindow: v.contextWindow } : {}), ...(v.costPer1k !== undefined ? { costPer1k: v.costPer1k } : {}) }
    const t = inferTier(cfg, a)
    if (t) return { tier: t, reason: `модель ${id} ${how}: ${attrText(a)} → поріг tier ${t}`, matched: key, fallback: false }
    return { tier: DEFAULT_TIER, reason: `модель ${id} ${how}: атрибути (${attrText(a) || '—'}) не відповідають порогам жодного tier → ${DEFAULT_TIER}`, matched: key, fallback: true }
  }
  const exact = models[id]
  if (exact !== undefined && (typeof exact === 'string' || !exact.match)) return resolve(id, '→', exact)
  for (const [key, v] of Object.entries(models)) {
    const glob = typeof v === 'string' ? key : (v.match ?? key)
    if (compileGlob(glob, { nocase: true })(id)) return resolve(key, `~ ${glob}`, v)
  }
  if (attrs) {
    const t = inferTier(cfg, attrs)
    if (t) return { tier: t, reason: `модель ${id} немає в models; ${attrText(attrs)} → поріг tier ${t}`, fallback: false }
  }
  return { tier: DEFAULT_TIER, reason: `модель ${id} не збігається з жодним glob у models → ${DEFAULT_TIER}`, fallback: true }
}

/** A model glob/label that maps to `tier` (for `/model` hints). */
export function modelForTier(cfg: Pick<GateConfig, 'models'>, tier: Tier): string | undefined {
  for (const [key, v] of Object.entries(cfg.models ?? {})) {
    if (typeof v === 'string' ? v === tier : v.tier === tier) return typeof v === 'string' ? key : (v.match ?? key)
  }
  return undefined
}

// ───────────────────────── debug log, env ─────────────────────────

export const DEBUG_LOG_PATH = '.claude/gate.debug.log'
export const DEBUG_LOG_MAX_BYTES = 1024 * 1024

/** Where the debug log goes, or undefined when it is off (`debug: true` in gate.json, or `force` = CLI `--debug`). */
export function debugLogPath(cfg: Pick<GateConfig, 'debug' | 'debugLog'>, force = false): { path: string; maxBytes: number } | undefined {
  if (!cfg.debug && !force) return undefined
  return { path: cfg.debugLog?.path ?? DEBUG_LOG_PATH, maxBytes: cfg.debugLog?.maxBytes ?? DEBUG_LOG_MAX_BYTES }
}

/** `env.*` for the render scope: only whitelisted names (gate.json `env`) that are set. */
export function filterEnv(source: Readonly<Record<string, unknown>> | undefined, whitelist: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!source || !whitelist?.length) return out
  for (const name of whitelist) {
    const v = source[name]
    if (typeof v === 'string') out[name] = v
  }
  return out
}

/** Values to mask in debug output: every whitelisted env value (the spec masks all `env` values in debug). Short values (< 4 chars) are skipped. */
export function envMaskValues(env: Readonly<Record<string, string>>): string[] {
  return Object.values(env).filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)
}

/** Replace every mask value in `text` with `***`. */
export function maskSecrets(text: string, values: readonly string[]): string {
  let out = text
  for (const v of values) if (v) out = out.split(v).join('***')
  return out
}

export function budgetFor(cfg: Pick<GateConfig, 'budgets'>, tier: Tier): Required<BudgetPct> {
  return { ...DEFAULT_BUDGET, ...cfg.budgets?.default, ...cfg.budgets?.tiers?.[tier] }
}
