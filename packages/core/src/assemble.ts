// Prompt assembly shared by `context-gate run` and the mod's `prompt.compose` / `skill.prompt`, so both
// render the same prompts with the same scope: Markdown tier variants, the skill split, the render scope
// (`gate`, `git`, `cursor`, `session`, `ctx`, `budgets`, `args`, `data`, providers) and the usage text.

import type { CompiledPrompt, Diagnostic, Gate, GateConfig, MdcRule, SectionNode, Tier, Value } from './types.ts'
import { parseMarkdownPrompt, resolveTierVariant, tierVariantOf } from './mddsl.ts'
import { budgetFor } from './config.ts'
import { autoRulesFor, type RuleMatchOptions } from './mdc.ts'
import { parseArgs, usageLine } from './argparse.ts'
import { dataEnvelope } from './render.ts'

export interface MarkdownFile { path: string; text: string }

export interface PromptSet {
  /** System-prompt prompts (compiled TSX without `skill`, plus Markdown sections wrapped as CompiledPrompt). */
  system: CompiledPrompt[]
  /** Compiled skill prompts by skill name. */
  skills: Record<string, CompiledPrompt>
  diagnostics: Diagnostic[]
}

function wrapSection(section: SectionNode, uses: Record<string, string>, path: string): CompiledPrompt {
  return { version: 1, compiler: 'markdown', id: section.id, sourceHash: '', sources: [{ path, hash: '' }], sections: [section], ...(Object.keys(uses).length ? { uses } : {}), diagnostics: [] }
}

/**
 * Compiled prompts + Markdown prompt files → what to render for `tier`. Markdown `<id>.<tier>.md` variants
 * replace their canonical section for that tier. Compiled prompts come first, then Markdown in path order.
 */
export function assemblePrompts(compiled: readonly CompiledPrompt[], markdown: readonly MarkdownFile[], tier: Tier, tierNames?: Tier[]): PromptSet {
  const diagnostics: Diagnostic[] = []
  const system: CompiledPrompt[] = []
  const skills: Record<string, CompiledPrompt> = {}
  for (const cp of [...compiled].sort((a, b) => a.id.localeCompare(b.id))) {
    if (cp.skill) skills[cp.skill.name] = cp
    else system.push(cp)
  }
  const files = [...markdown].sort((a, b) => a.path.localeCompare(b.path))
  const variantsOf = new Map<string, { tier: Tier; file: MarkdownFile }[]>()
  const canonical: MarkdownFile[] = []
  for (const f of files) {
    const v = tierVariantOf(f.path, tierNames)
    if (v) {
      const l = variantsOf.get(v.id) ?? []
      l.push({ tier: v.tier, file: f })
      variantsOf.set(v.id, l)
    } else canonical.push(f)
  }
  for (const f of canonical) {
    const base = parseMarkdownPrompt(f.text, { path: f.path })
    diagnostics.push(...base.diagnostics)
    const variants: Record<Tier, SectionNode> = {}
    const uses = { ...base.uses }
    const fileId = (f.path.split('/').pop() ?? f.path).replace(/\.md$/, '')
    for (const v of variantsOf.get(base.section.id) ?? variantsOf.get(fileId) ?? []) {
      if (v.tier !== tier) continue
      const p = parseMarkdownPrompt(v.file.text, { path: v.file.path, inherit: base.section })
      diagnostics.push(...p.diagnostics)
      variants[v.tier] = p.section
      Object.assign(uses, p.uses)
    }
    system.push(wrapSection(resolveTierVariant(base.section, variants, tier), uses, f.path))
  }
  return { system, skills, diagnostics }
}

// ───────────────────────── scope ─────────────────────────

export function ruleRef(r: MdcRule): Value {
  return { id: r.id, name: r.id, ...(r.description ? { description: r.description } : {}), body: r.body, globs: r.globs, path: r.path, type: r.type, cost: { chars: r.body.length } }
}

/** `cursor.*`: rules by type. `cursor.match(path)` is a provider function (see `cursorMatch`). */
export function cursorScope(rules: readonly MdcRule[]): Value {
  const by = (t: MdcRule['type']) => rules.filter((r) => r.type === t).map(ruleRef)
  return { always: by('always'), auto: by('auto'), agent: by('agent'), manual: by('manual') }
}

/** `cursor.match(path)`: Auto Attached rules whose globs match `path` (Cursor semantics, `ruleMatches`). */
export function cursorMatch(rules: readonly MdcRule[], path: string, opts: RuleMatchOptions = {}): Value {
  return autoRulesFor(rules, path, opts).map(ruleRef)
}

/** A neutral gate (nothing decided yet): every list empty, trigger `default`. */
export function defaultGate(tier: Tier): Gate {
  return { profile: undefined, tier, trigger: 'default', off: false, skills: { on: [], nameOnly: [], off: [], preload: [] }, mcp: { on: [], off: [] }, agents: { on: [], off: [] }, rules: { on: [], off: [] }, items: {}, groups: [], reason: [] }
}

export function gateScope(gate: Gate): Value {
  return {
    profile: gate.profile ?? null,
    tier: gate.tier,
    groups: gate.groups,
    off: gate.off,
    trigger: gate.trigger,
    shadow: !!gate.shadow,
    skills: { on: gate.skills.on, nameOnly: gate.skills.nameOnly, off: gate.skills.off, preload: gate.skills.preload },
    mcp: { on: gate.mcp.on, off: gate.mcp.off },
    agents: { on: gate.agents.on, off: gate.agents.off },
    ...(gate.proposed ? { proposed: { profile: gate.proposed.profile, confidence: gate.proposed.confidence } } : {}),
  }
}

export interface DataEntry { key: string; value: Value; fetchedAt?: number; cache?: string }

/**
 * `data.*` in the scope: entries with a known `fetchedAt` become core data envelopes (`dataEnvelope`), which
 * renderPrompt materializes into `fetchedAt` / `stale` fields (H006); others pass through as plain values.
 */
export function dataScope(entries: readonly DataEntry[]): Value {
  const out: Record<string, Value> = {}
  for (const e of [...entries].sort((a, b) => a.key.localeCompare(b.key))) out[e.key] = e.fetchedAt !== undefined ? dataEnvelope(e.value, e.fetchedAt, e.cache) : e.value
  return out
}

export interface ScopeParts {
  config: GateConfig
  gate: Gate
  git?: Value
  rules?: readonly MdcRule[]
  session?: { id?: string; model?: string; cwd?: string; root?: string; turn?: number; agentId?: string; interactive?: boolean }
  ctxPercent?: number
  ctxTokens?: number
  ctxLimit?: number
  data?: Value
  args?: Record<string, Value>
  /** Budget keys whose threshold fired this conversation, and the budget-owned sections they turn on (mod). */
  budgetsFired?: string[]
  budgetsActive?: string[]
  /** Non-builtin provider values by name (`pkg`, `arch`, …). */
  providers?: Record<string, Value>
}

const DEFAULT_GIT: Record<string, Value> = { branch: '', head: '', dirty: false, ahead: 0, behind: 0, changed: [] }

/** The render scope: gate, git, cursor, session, ctx, budgets, args, data, then providers (never overriding builtins). */
export function buildScope(p: ScopeParts): Record<string, Value> {
  const b = budgetFor(p.config, p.gate.tier)
  const scope: Record<string, Value> = {
    gate: gateScope(p.gate),
    git: p.git && typeof p.git === 'object' && !Array.isArray(p.git) ? { ...DEFAULT_GIT, ...p.git } : { ...DEFAULT_GIT },
    fs: {},
    cursor: cursorScope(p.rules ?? []),
    session: {
      id: p.session?.id ?? '', model: p.session?.model ?? '', cwd: p.session?.cwd ?? '', root: p.session?.root ?? '', turn: p.session?.turn ?? 0,
      ...(p.session?.agentId ? { agentId: p.session.agentId } : {}),
      ...(p.session?.interactive !== undefined ? { interactive: p.session.interactive, print: !p.session.interactive } : {}),
    },
    ctx: { percent: p.ctxPercent ?? 0, tokens: p.ctxTokens ?? 0, limit: p.ctxLimit ?? 200_000 },
    budgets: { soft: b.softContextPct, hard: b.hardContextPct, fired: p.budgetsFired ?? [], active: p.budgetsActive ?? [] },
    args: p.args ?? {},
    data: p.data ?? {},
  }
  for (const [k, v] of Object.entries(p.providers ?? {})) if (!(k in scope)) scope[k] = v
  return scope
}

// ───────────────────────── skills ─────────────────────────

export type SkillArgs = { ok: true; args: Record<string, Value> } | { ok: false; text: string }

/** Parses skill args with the core parser; an error becomes the `usage` section text (what the skill returns). */
export function skillArgs(cp: CompiledPrompt, raw: string | Record<string, unknown>, pathExists?: (p: string) => boolean): SkillArgs {
  const spec = cp.skill!.args
  const r = parseArgs(raw, spec, { name: cp.skill!.name, ...(pathExists ? { pathExists } : {}) })
  if (r.ok) return { ok: true, args: JSON.parse(JSON.stringify(r.args)) as Record<string, Value> }
  return { ok: false, text: usageText(cp, r.error) }
}

export function usageText(cp: CompiledPrompt, error: string): string {
  const s = cp.skill!
  const lines = [error, '']
  const opts = Object.entries(s.args)
  if (opts.length) {
    lines.push(`Аргументи ${usageLine(s.name, s.args)}:`)
    for (const [k, a] of opts) {
      const kind = a.type === 'enum' ? (a.values ?? []).join('|') : a.type
      const def = a.default !== undefined && a.default !== null ? `, за замовчуванням ${JSON.stringify(a.default)}` : ''
      lines.push(`- ${a.positional !== undefined ? `<${k}>` : `--${k}`} (${kind}${a.required ? ', обовʼязковий' : ''}${def})${a.description ? ` — ${a.description}` : ''}`)
    }
  }
  lines.push('', 'Перепитай користувача або виправ виклик.')
  return lines.join('\n')
}

/** Text the mod / CLI prints for a rendered set: sections joined as the core does. */
export function sectionText(sections: readonly { id: string; scope: string; text: string; included: boolean }[], markers: boolean): string {
  return sections.filter((s) => s.included && s.text).map((s) => (markers ? `<!-- section:${s.id} ${s.scope} -->\n${s.text}` : s.text)).join('\n\n')
}
