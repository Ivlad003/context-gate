// Pure pipeline stages over JSONL-friendly Item arrays (SPEC "Pipeline"): collect → normalize → decide → tokens / where.
// The CLI and `/gate … | …` wire them; each stage takes JSON and returns JSON.

import type { GateConfig, GateState, Item, ItemDecision, ItemKind, MdcRule, Signals } from './types.ts'
import { ruleToItem } from './mdc.ts'
import { groupsOf, normalizeItems, parseSkillListing, skillListingItems } from './items.ts'
import { decideGate } from './decide.ts'
import type { DecideOptions } from './decide.ts'
import { filterWhere, getPath } from './journal.ts'

export type DecidedItem = Item & { decision: ItemDecision }

export function collectFromRules(rules: readonly MdcRule[]): Item[] {
  return rules.map(ruleToItem)
}

export function collectFromSkillListing(text: string): Item[] {
  return skillListingItems(parseSkillListing(text))
}

export function normalize(items: readonly Item[]): Item[] {
  return normalizeItems(items)
}

/** Attach a decision to each item (fresh state, no hysteresis — a pipe run is one decision). */
export function decideStage(items: readonly Item[], cfg: GateConfig, signals: Signals, opts: DecideOptions & { state?: GateState } = {}): DecidedItem[] {
  const { gate } = decideGate(cfg, signals, opts.state ?? { turn: 0 }, items, opts)
  return items.map((it) => ({ ...it, decision: gate.items[it.id] ?? 'on' }))
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

export interface TokenSummary {
  count: number
  chars: number
  tokens: number
  /** Only items that reach the context (decision ≠ off; nameOnly counts the name). */
  included: { count: number; chars: number; tokens: number }
  byKind: Partial<Record<ItemKind, { count: number; chars: number; tokens: number }>>
  byDecision: Partial<Record<ItemDecision, { count: number; chars: number; tokens: number }>>
}

export function tokens(items: readonly (Item & { decision?: ItemDecision })[]): TokenSummary {
  const sum: TokenSummary = { count: 0, chars: 0, tokens: 0, included: { count: 0, chars: 0, tokens: 0 }, byKind: {}, byDecision: {} }
  const bump = (b: { count: number; chars: number; tokens: number }, chars: number) => { b.count++; b.chars += chars; b.tokens = estimateTokens(b.chars) }
  for (const it of items) {
    const chars = it.cost?.chars ?? 0
    bump(sum, chars)
    bump((sum.byKind[it.kind] ??= { count: 0, chars: 0, tokens: 0 }), chars)
    const d = it.decision ?? 'on'
    bump((sum.byDecision[d] ??= { count: 0, chars: 0, tokens: 0 }), chars)
    if (d !== 'off') bump(sum.included, d === 'nameOnly' ? it.name.length : chars)
  }
  sum.tokens = estimateTokens(sum.chars)
  return sum
}

/** `where` over items. Extra keys: `group` (needs cfg), `globs` (attach.globs), `when` (attach.when), `source` (provenance.source). */
export function whereFilter<T extends Item>(items: readonly T[], expr: string, cfg?: Pick<GateConfig, 'groups'>): { items: T[] } | { error: string } {
  return filterWhere(items, expr, (obj, key) => {
    const it = obj as T
    if (key === 'group') return cfg ? groupsOf(cfg, it) : []
    if (key === 'when') return it.attach?.when
    if (key === 'globs') return it.attach?.globs
    if (key === 'source') return it.provenance?.source
    if (key === 'chars') return it.cost?.chars
    return getPath(it, key)
  })
}

export function itemsToJsonl(items: readonly unknown[]): string {
  return items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '')
}
