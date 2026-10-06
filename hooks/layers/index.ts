// The mod's writer of `.claude/gate.index.json` (SPEC «Редактор DSL та індекс автокомпліту»): rewritten on
// session.start, after `/gate`, on classic.FileChanged for gate.json and the prompt dir, and when the skill
// listing changes. Core `buildGateIndex` (shared with `context-gate index`) plus the session-only fields:
// `$.tool.list()`, MCP servers, the skill listing and the values of the last `prompt.compose`
// (`.trace/last.json`). Unchanged content is not rewritten.

import { buildGateIndex, indexKey, type IndexScriptTool, type IndexSection } from '../../packages/core/src/gateindex.ts'
import { mcpServerOf, parseSkillListing, skillListingItems } from '../../packages/core/src/items.ts'
import { parseRunJson } from '../../packages/core/src/runjson.ts'
import { type Io, OWN_TOOL_PREFIX, type Runtime, debug, join, now } from '../ctx.ts'
import { GATE_JSON, ensureSession } from './config.ts'
import { ensureRules } from './cursor-rules.ts'
import { ensureItems } from './skill-gate.ts'
import { loadPrompts, promptDir, sectionsFor } from './dsl.ts'
import { repoKey } from './trust.ts'

export const INDEX_FILE = '.claude/gate.index.json'

const written = new WeakMap<Runtime, string>()

/** The repo uses context-gate (a gate.json or a prompt dir): only then is the index written. */
async function configured(io: Io, rt: Runtime): Promise<boolean> {
  if (await io.fs.exists(join(rt.root, GATE_JSON)).catch(() => false)) return true
  return io.fs.exists(join(rt.root, promptDir(rt))).catch(() => false)
}

/** The last render scope: `.trace/last.json` (layer 3), else what the session state holds. */
async function lastScope(io: Io, rt: Runtime): Promise<Record<string, unknown>> {
  const t = await io.fs.read(join(rt.root, `${promptDir(rt)}/.trace/last.json`)).catch(() => undefined)
  if (typeof t === 'string') {
    const p = parseRunJson(t)
    if ('json' in p) return p.json.scope
  }
  const gate = await io.read('gate')
  const pct = await io.read('ctxPercent')
  return {
    gate: { profile: gate?.profile ?? null, tier: gate?.tier ?? (await io.read('tier')) ?? 'standard', groups: gate?.groups ?? [] },
    session: { model: (await io.read('model')) ?? '' },
    ctx: { percent: pct ?? 0 },
  }
}

export async function buildModIndex(io: Io, rt: Runtime): Promise<Record<string, unknown>> {
  await ensureSession(io, rt)
  const rules = await ensureRules(io, rt)
  const items = rt.config ? await ensureItems(io, rt) : []
  const set = await loadPrompts(io, rt)
  const tier = (await io.read('tier')) ?? 'standard'
  const health = await io.read('health')
  const sections: IndexSection[] = sectionsFor(rt, set, tier).system.flatMap((cp) => cp.sections.map((s) => {
    const h = health?.sections[s.id]
    return { id: s.id, scope: s.scope, ...(s.when ? { when: s.when } : {}), ...(s.tier ? { tier: s.tier } : {}), chars: h?.chars ?? 0, tokens: h?.tokens ?? 0, ...(s.source?.path ? { path: s.source.path } : {}) }
  }))
  const tools: IndexScriptTool[] = []
  for (const t of rt.tools.values()) if (t.kind === 'script') tools.push({ name: t.tool.name, path: t.tool.path, description: t.tool.description, inputSchema: t.tool.inputSchema, ...(t.tool.tiers ? { tiers: t.tool.tiers } : {}) })
  const providers: Record<string, unknown> = {}
  for (const [name, p] of Object.entries(rt.cfg.providers ?? {})) {
    const fns = Array.isArray(p.functions) ? p.functions : p.functions ? Object.keys(p.functions) : []
    providers[name] = { kind: p.kind, ...(p.schema ? { schema: p.schema } : {}), ...(fns.length ? { functions: fns } : {}), ...(p.exposes ? { exposes: p.exposes } : {}) }
  }
  const stored = await io.store.get(`data:${await repoKey(io, rt)}`).catch(() => undefined)
  const listed = await io.tool.list().catch(() => [])
  const gate = await io.read('gate')
  const model = await io.read('model')
  const skills = rt.listingText ? skillListingItems(parseSkillListing(rt.listingText)).map((e) => ({ name: e.name, ...(e.description ? { description: e.description } : {}) })) : []
  return buildGateIndex({
    generatedBy: 'context-gate mod',
    generatedAt: new Date(now()).toISOString(),
    config: rt.cfg,
    items,
    sections,
    rules,
    providers,
    tools,
    data: stored && typeof stored === 'object' ? Object.keys(stored) : [],
    scope: await lastScope(io, rt),
    session: {
      tools: listed.map((t) => ({ name: t.name, ...(t.description ? { description: t.description.split('\n')[0].slice(0, 200) } : {}), mcp: t.mcp })),
      mcpServers: [...new Set(listed.filter((t) => t.mcp && !t.name.startsWith(OWN_TOOL_PREFIX)).map((t) => mcpServerOf(t.name)).filter((s): s is string => !!s))].sort(),
      skills,
      ...(model ? { model } : {}),
      tier,
      ...(gate?.profile ? { profile: gate.profile } : {}),
    },
  })
}

/** Writes the index when the repo is configured and the content changed. Never throws. */
export async function writeIndex(io: Io, rt: Runtime, reason: string): Promise<boolean> {
  try {
    await ensureSession(io, rt)
    if (!(await configured(io, rt))) return false
    const index = await buildModIndex(io, rt)
    const key = indexKey(index)
    if (written.get(rt) === key) return false
    await io.fs.write(join(rt.root, INDEX_FILE), JSON.stringify(index, null, 2) + '\n')
    written.set(rt, key)
    return true
  } catch (err) {
    debug(io, `index (${reason}): ${String((err as Error)?.message ?? err)}`)
    return false
  }
}

/** classic.FileChanged: gate.json or a file under the prompt dir (not `.trace`/`.compiled` output). */
export function indexWatched(rt: Runtime, path: string): boolean {
  if (!rt.root) return false
  if (path === join(rt.root, GATE_JSON)) return true
  const dir = join(rt.root, promptDir(rt)) + '/'
  return path.startsWith(dir) && !/\/\.(trace|compiled)\//.test(path.slice(dir.length - 1))
}
