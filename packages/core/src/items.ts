// Item helpers (SPEC "Єдина модель"): ids, normalisation, skill listing, kind-prefixed groups.

import type { GateConfig, Item, ItemDecision, ItemKind } from './types.ts'
import { compileGlob, splitNegation } from './glob.ts'

export const ITEM_KINDS: readonly ItemKind[] = ['skill', 'tool', 'agent', 'rule', 'section', 'datum']

export function itemId(kind: ItemKind, name: string): string {
  return `${kind}:${name}`
}

/** Split `skill:react` → { kind: 'skill', name: 'react' }; names may contain `:` (`skill:plugin:x`). */
export function parseItemId(id: string): { kind?: ItemKind; name: string } {
  const i = id.indexOf(':')
  if (i > 0) {
    const k = id.slice(0, i) as ItemKind
    if (ITEM_KINDS.includes(k)) return { kind: k, name: id.slice(i + 1) }
  }
  return { name: id }
}

export function isMcpTool(item: Pick<Item, 'kind' | 'name'>): boolean {
  return item.kind === 'tool' && item.name.startsWith('mcp__')
}

/** `mcp__github__list_prs` → `github`. */
export function mcpServerOf(toolName: string): string | undefined {
  const m = /^mcp__(.+?)__/.exec(toolName)
  return m ? m[1] : undefined
}

export function makeItem(kind: ItemKind, name: string, extra: Partial<Item> = {}): Item {
  const it: Item = {
    kind,
    id: itemId(kind, name),
    name,
    attach: { when: kind === 'rule' ? 'manual' : 'on-demand' },
    cost: { chars: 0 },
    provenance: { source: 'unknown' },
    ...extra,
  }
  if (!extra.cost) it.cost = { chars: itemChars(it) }
  return it
}

function itemChars(it: Pick<Item, 'body' | 'description' | 'name'>): number {
  if (it.body) return it.body.length
  return (it.description?.length ?? 0) + it.name.length
}

/** Dedupe by id (first wins, missing fields filled from later duplicates), fix ids and compute cost.chars. */
export function normalizeItems(items: readonly Item[]): Item[] {
  const byId = new Map<string, Item>()
  for (const raw of items) {
    const id = raw.id && raw.id.includes(':') ? raw.id : itemId(raw.kind, raw.name)
    const it: Item = { ...raw, id, attach: raw.attach ?? { when: 'on-demand' }, provenance: raw.provenance ?? { source: 'unknown' }, cost: raw.cost ?? { chars: 0 } }
    if (it.attach.globs) it.attach = { ...it.attach, globs: [...new Set(it.attach.globs.map((g) => g.trim()).filter(Boolean))] }
    const prev = byId.get(id)
    if (!prev) { byId.set(id, it); continue }
    const merged: Item = { ...it, ...stripUndef(prev) }
    if (prev.tags || it.tags) merged.tags = [...new Set([...(prev.tags ?? []), ...(it.tags ?? [])])]
    byId.set(id, merged)
  }
  return [...byId.values()].map((it) => ({ ...it, cost: { chars: it.cost.chars > 0 ? it.cost.chars : itemChars(it) } }))
}

function stripUndef<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

// ───────────────────────── Skill listing ─────────────────────────
// Claude Code's `prompt.attachment {type:'skill_listing'}` text: a header plus lines `- name: description`
// (names may contain `:`, e.g. `plugin:skill`; the separator is the first `": "`). Descriptions may continue
// on following non-bullet lines. Unknown lines are preserved verbatim.

export type ListingLine =
  | { type: 'text'; text: string }
  | { type: 'skill'; name: string; description: string; bullet: string }

export interface SkillListing {
  lines: ListingLine[]
}

const BULLET_RE = /^(\s*(?:[-*•]|\d+[.)])\s+)(.+)$/
const NAME_RE = /^[A-Za-z0-9_@][\w.:@/-]*$/

function splitEntry(s: string): { name: string; description: string } | undefined {
  const t = s.replace(/^`([^`]+)`/, '$1').trim()
  const i = t.indexOf(': ')
  let name: string
  let description: string
  if (i < 0) {
    name = t.endsWith(':') ? t.slice(0, -1) : t
    description = ''
  } else {
    name = t.slice(0, i)
    description = t.slice(i + 2).trim()
  }
  name = name.replace(/^\*\*(.+)\*\*$/, '$1').replace(/^`(.+)`$/, '$1').trim()
  if (!NAME_RE.test(name)) return undefined
  return { name, description }
}

export function parseSkillListing(text: string): SkillListing {
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  const hasBullets = raw.some((l) => { const m = BULLET_RE.exec(l); return !!m && !!splitEntry(m[2]) })
  const lines: ListingLine[] = []
  let last: Extract<ListingLine, { type: 'skill' }> | undefined
  for (const line of raw) {
    if (hasBullets) {
      const m = BULLET_RE.exec(line)
      const e = m ? splitEntry(m[2]) : undefined
      if (m && e) {
        last = { type: 'skill', ...e, bullet: m[1] }
        lines.push(last)
        continue
      }
    } else {
      const e = /^\S/.test(line) && line.includes(': ') ? splitEntry(line) : undefined
      if (e) {
        last = { type: 'skill', ...e, bullet: '' }
        lines.push(last)
        continue
      }
    }
    // Continuation of the previous description: in bullet lists any non-empty line until a blank one;
    // in `name: description` lists only indented lines.
    if (last && line.trim() !== '' && (hasBullets || /^\s/.test(line))) {
      last.description += (last.description ? '\n' : '') + line
      continue
    }
    last = undefined
    lines.push({ type: 'text', text: line })
  }
  return { lines }
}

export function skillListingItems(listing: SkillListing): Item[] {
  return listing.lines
    .filter((l): l is Extract<ListingLine, { type: 'skill' }> => l.type === 'skill')
    .map((l) => makeItem('skill', l.name, { description: l.description || undefined, provenance: { source: 'claude-skills' } }))
}

function decisionFor(decisions: Record<string, ItemDecision>, name: string): ItemDecision {
  return decisions[itemId('skill', name)] ?? decisions[name] ?? 'on'
}

/** Rewrite the listing for the decision: on/preload → full line, nameOnly → `- name`, off → dropped.
 * Skills absent from `decisions` stay as they are. */
export function renderSkillListing(listing: SkillListing | readonly Item[], decisions: Record<string, ItemDecision>): string {
  const lines: ListingLine[] = Array.isArray(listing)
    ? (listing as readonly Item[]).filter((i) => i.kind === 'skill').map((i) => ({ type: 'skill', name: i.name, description: i.description ?? '', bullet: '- ' }))
    : (listing as SkillListing).lines
  const out: string[] = []
  for (const l of lines) {
    if (l.type === 'text') { out.push(l.text); continue }
    const d = decisionFor(decisions, l.name)
    if (d === 'off') continue
    const bullet = l.bullet || '- '
    if (d === 'nameOnly' || !l.description) out.push(`${bullet}${l.name}`)
    else out.push(`${bullet}${l.name}: ${l.description}`)
  }
  return out.join('\n')
}

// ───────────────────────── Groups ─────────────────────────

/** Own-property lookup in a config map: `toString`, `constructor`, … are never group or profile names. */
export function ownEntry<T>(map: Readonly<Record<string, T>> | undefined, name: string): T | undefined {
  return map && Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined
}

/** One form of negation: `skill:!react` is read as `!skill:react` (an exclusion), never as «all skills but react». */
function groupEntry(raw: string): { negated: boolean; pattern: string } {
  const { negated, pattern } = splitNegation(raw.trim())
  const { kind, name } = parseItemId(pattern)
  if (kind && name.startsWith('!')) {
    const inner = splitNegation(name)
    return { negated: negated !== inner.negated, pattern: `${kind}:${inner.pattern}` }
  }
  return { negated, pattern }
}

/** `skill:react-*` matches skill items named `react-*`; a pattern without kind prefix matches any kind by name.
 * A leading `!` is ignored here (see `expandGroups` for negation). */
export function groupMatches(groupPattern: string, item: Pick<Item, 'kind' | 'name'>): boolean {
  const { pattern } = groupEntry(groupPattern)
  const { kind, name } = parseItemId(pattern)
  if (kind && kind !== item.kind) return false
  return compileGlob(name)(item.name)
}

function splitGroup(pats: readonly string[]): { pos: string[]; neg: string[] } {
  const pos: string[] = []
  const neg: string[] = []
  for (const p of Array.isArray(pats) ? pats : []) {
    if (typeof p !== 'string') continue
    const e = groupEntry(p)
    ;(e.negated ? neg : pos).push(e.pattern)
  }
  return { pos, neg }
}

/** Item ids enabled by the given group names. Unknown group names are ignored.
 * Negated patterns (`!skill:x`) inside a group remove matches of that group. */
export function expandGroups(cfg: Pick<GateConfig, 'groups'>, groupNames: Iterable<string>, items: readonly Item[]): Set<string> {
  const out = new Set<string>()
  for (const g of groupNames) {
    const pats = ownEntry(cfg.groups, g)
    if (!pats) continue
    const { pos, neg } = splitGroup(pats)
    for (const it of items) {
      if (pos.some((p) => groupMatches(p, it)) && !neg.some((p) => groupMatches(p, it))) out.add(it.id)
    }
  }
  return out
}

/** Names of groups that (positively) contain the item. */
export function groupsOf(cfg: Pick<GateConfig, 'groups'>, item: Pick<Item, 'kind' | 'name'>): string[] {
  const out: string[] = []
  for (const [g, pats] of Object.entries(cfg.groups ?? {})) {
    const { pos, neg } = splitGroup(pats)
    if (pos.some((p) => groupMatches(p, item)) && !neg.some((p) => groupMatches(p, item))) out.push(g)
  }
  return out
}

/** Whether some group mentions the item at all: a positive pattern matches it, even when a `!` entry of that
 * group then excludes it. An excluded item is still "grouped" for the decision, so the exclusion turns it off
 * instead of handing it the more permissive default of ungrouped items. */
export function mentionedInGroups(cfg: Pick<GateConfig, 'groups'>, item: Pick<Item, 'kind' | 'name'>): boolean {
  for (const pats of Object.values(cfg.groups ?? {})) {
    if (splitGroup(pats).pos.some((p) => groupMatches(p, item))) return true
  }
  return false
}
