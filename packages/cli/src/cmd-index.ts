// `context-gate index`: `.claude/gate.index.json` for the editor (SPEC «Редактор DSL та індекс автокомпліту»).
// Names, signatures and paths only — never file contents.

import { join } from 'node:path'
import type { Value } from '../../core/src/types.ts'
import { buildGateIndex, symbolsOf } from '../../core/src/gateindex.ts'
import { buildContext, collectItems, scriptFiles, type ContextOptions } from './context.ts'
import { renderWith } from './cmd-run.ts'
import { parseToolHeader } from '../../core/src/toolheader.ts'
import { readText, writeJson } from './util.ts'

/** The CLI's index: core `buildGateIndex` over the repo on disk (the mod adds the session fields). */
export async function buildIndex(o: ContextOptions): Promise<Record<string, unknown>> {
  const ctx = await buildContext({ ...o, dryScripts: o.dryScripts ?? true })
  const { config } = ctx.repo
  const r = await renderWith(ctx, {})
  const rendered = new Map(r.result.sections.map((s) => [s.id, s]))
  const sections = ctx.prompts.system.flatMap((cp) => cp.sections.map((s) => {
    const x = rendered.get(s.id)
    return { id: s.id, scope: s.scope, ...(s.when ? { when: s.when } : {}), ...(s.tier ? { tier: s.tier } : {}), chars: x?.chars ?? 0, tokens: x?.tokens ?? 0, ...(s.source?.path ? { path: s.source.path } : {}) }
  }))
  const providers: Record<string, unknown> = {}
  const symbols: Record<string, Value>[] = []
  for (const [name, p] of Object.entries(ctx.providers.cfg)) {
    const fns = Array.isArray(p.functions) ? p.functions : p.functions ? Object.keys(p.functions) : []
    providers[name] = { kind: p.kind, ...(p.builtin ? { builtin: true } : {}), ...(p.schema ? { schema: p.schema } : {}), ...(fns.length ? { functions: fns } : {}), ...(p.exposes ? { exposes: p.exposes } : {}) }
    if (p.exposes?.includes('symbols')) symbols.push(...symbolsOf(await ctx.providers.value(name), name))
  }
  const tools = scriptFiles(ctx.repo).flatMap((f) => {
    const { header } = parseToolHeader(readText(join(ctx.repo.root, f)) ?? '')
    return header ? [{ name: header.name, path: f, ...(header.description ? { description: header.description } : {}), inputSchema: header.inputSchema, ...(header.tiers ? { tiers: header.tiers } : {}) }] : []
  })
  return buildGateIndex({
    generatedBy: 'context-gate index',
    generatedAt: new Date().toISOString(),
    config,
    items: collectItems(ctx.repo, ctx.rules),
    sections,
    rules: ctx.rules,
    providers,
    symbols,
    tools,
    data: Object.keys((ctx.scope.data ?? {}) as Record<string, Value>),
    scope: ctx.scope as Record<string, unknown>,
  })
}

export async function indexCommand(o: ContextOptions & { print?: boolean }): Promise<{ code: number; out: string }> {
  const index = await buildIndex(o)
  if (o.print) return { code: 0, out: JSON.stringify(index, null, 2) + '\n' }
  writeJson(join(o.root, '.claude', 'gate.index.json'), index)
  return { code: 0, out: `записано .claude/gate.index.json: ${(index.items as unknown[]).length} елементів, ${(index.sections as unknown[]).length} секцій, ${(index.symbols as unknown[]).length} символів\n` }
}
