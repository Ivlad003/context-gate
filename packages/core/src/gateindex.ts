// `.claude/gate.index.json`: the editor's autocomplete index (SPEC «Редактор DSL та індекс автокомпліту»).
// One builder for `context-gate index` (CLI) and the mod (which adds the session-only fields: the tools
// `$.tool.list()` reports, MCP servers, the skill listing, and the values of the last `prompt.compose`).
// Names, signatures, paths and short value samples only — never file contents.

import type { GateConfig, Item, MdcRule, Value } from './types.ts'

export interface IndexSection {
  id: string
  scope: string
  when?: string
  tier?: string | string[]
  chars: number
  tokens: number
  path?: string
}

export interface IndexScriptTool {
  name: string
  path: string
  description?: string
  inputSchema?: Record<string, unknown>
  tiers?: string[]
}

/** What only a live session knows (the mod). */
export interface IndexSession {
  /** `$.tool.list()`: built-in, MCP and our own (`@lazy`, prompt skills) tools. */
  tools: { name: string; description?: string; mcp: boolean }[]
  /** MCP server names (2nd segment of `mcp__<server>__<tool>`). */
  mcpServers: string[]
  /** The skill listing the engine attached (`prompt.attachment {skill_listing}`). */
  skills: { name: string; description?: string }[]
  model?: string
  tier?: string
  profile?: string
}

export interface IndexInput {
  generatedBy: string
  generatedAt: string
  config: GateConfig
  items: readonly Item[]
  sections: readonly IndexSection[]
  rules: readonly MdcRule[]
  providers?: Record<string, unknown>
  symbols?: Record<string, Value>[]
  tools?: readonly IndexScriptTool[]
  /** `data.*` keys. */
  data?: readonly string[]
  /** Render scope of the last `prompt.compose` / run: becomes `vars` (types and sampled values). */
  scope?: Record<string, unknown>
  session?: IndexSession
}

export const INDEX_BUILTINS = ['gate', 'git', 'fs', 'cursor', 'session', 'ctx', 'budgets', 'args', 'data', 'scripts'] as const

export function typeOfValue(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v === 'object' ? 'object' : typeof v
}

/** Keys whose values are file or rule contents: never sampled into the index. */
const CONTENT_KEYS = new Set(['body', 'text', 'content', 'source', 'stdout', 'stderr'])

/** A short sample of a value: strings cut, arrays to 3 elements, objects to 3 levels and 30 keys; contents dropped. */
export function sampleValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v
  if (v === undefined || typeof v === 'function') return null
  if (depth >= 3) return Array.isArray(v) ? `[${v.length}]` : '{…}'
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => sampleValue(x, depth + 1))
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).slice(0, 30)) {
      const x = (v as Record<string, unknown>)[k]
      out[k] = CONTENT_KEYS.has(k) && typeof x === 'string' ? `string(${x.length})` : sampleValue(x, depth + 1)
    }
    return out
  }
  return null
}

/** `env` (the gate.json whitelist) is secret: the index keeps its names and value types, never the values. */
function maskedEnv(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return typeof v === 'string' ? '***' : sampleValue(v)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as Record<string, unknown>).slice(0, 30)) out[k] = '***'
  return out
}

function withMaskedEnv(o: Record<string, unknown>): Record<string, unknown> {
  return 'env' in o ? { ...o, env: maskedEnv(o.env) } : o
}

/** `vars`: each top-level scope name with its type and a sampled value (`args` left out: per-call). */
export function varsOf(scope: Record<string, unknown> | undefined): Record<string, { type: string; value: unknown }> {
  const out: Record<string, { type: string; value: unknown }> = {}
  for (const [k, v] of Object.entries(scope ?? {})) {
    if (k === 'args' || typeof v === 'function') continue
    out[k] = { type: typeOfValue(v), value: k === 'env' ? maskedEnv(v) : k === 'providers' && v && typeof v === 'object' && !Array.isArray(v) ? sampleValue(withMaskedEnv(v as Record<string, unknown>)) : sampleValue(v) }
  }
  return out
}

/** Provider symbols (`exposes: ["symbols"]`): id, signature, file, kind. */
export function symbolsOf(v: Value | undefined, provider: string): Record<string, Value>[] {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as Record<string, Value>).symbols) ? (v as Record<string, Value[]>).symbols : []
  const out: Record<string, Value>[] = []
  for (const s of list.slice(0, 20_000)) {
    if (typeof s === 'string') { out.push({ provider, id: s }); continue }
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue
    const o = s as Record<string, Value>
    const id = o.id ?? o.name
    if (typeof id !== 'string') continue
    const file = o.file ?? o.path
    out.push({ provider, id, ...(typeof o.signature === 'string' ? { signature: o.signature } : {}), ...(typeof file === 'string' ? { file } : {}), ...(typeof o.kind === 'string' ? { kind: o.kind } : {}) })
  }
  return out
}

export function buildGateIndex(i: IndexInput): Record<string, unknown> {
  const { config } = i
  return {
    version: 1,
    generatedBy: i.generatedBy,
    generatedAt: i.generatedAt,
    profiles: Object.fromEntries(Object.entries(config.profiles ?? {}).map(([k, v]) => [k, { groups: v.groups ?? [], ...(v.when ? { when: v.when } : {}) }])),
    groups: config.groups ?? {},
    tiers: Object.fromEntries(Object.entries(config.tiers ?? {}).map(([k, v]) => [k, { groups: v.groups ?? [], ...(v.preload ? { preload: v.preload } : {}) }])),
    items: i.items.map((x) => ({ id: x.id, kind: x.kind, name: x.name, ...(x.description ? { description: x.description } : {}), chars: x.cost.chars, ...(x.provenance.path ? { path: x.provenance.path } : {}), source: x.provenance.source })),
    sections: i.sections.map((s) => ({ ...s, uri: `prompt://${s.id}` })),
    rules: i.rules.map((x) => ({ id: x.id, type: x.type, globs: x.globs, ...(x.negGlobs.length ? { negGlobs: x.negGlobs } : {}), path: x.path, ...(x.description ? { description: x.description } : {}) })),
    providers: i.providers ?? {},
    symbols: i.symbols ?? [],
    tools: i.tools ?? [],
    data: [...(i.data ?? [])],
    builtins: [...INDEX_BUILTINS],
    ...(i.scope ? { vars: varsOf(i.scope) } : {}),
    ...(i.session ? { session: i.session } : {}),
  }
}

/** Content key of an index without its timestamp (skip rewriting an unchanged file). */
export function indexKey(index: Record<string, unknown>): string {
  const { generatedAt: _at, ...rest } = index
  return JSON.stringify(rest)
}
