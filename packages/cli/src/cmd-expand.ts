// `context-gate schema infer <provider>` (Р4) and `context-gate expand` (Шар 3а): generated drafts go to
// `.claude/prompt/proposals/` with `generated-by`, `generated-at`, `source-hash`.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CompiledPrompt, Value } from '../../core/src/types.ts'
import { hasTierNodes, parseMarkdownPrompt, printMarkdownNodes, tierVariantOf } from '../../core/src/mddsl.ts'
import { findEntries } from './build.ts'
import { buildContext, loadRepo, type ContextOptions } from './context.ts'
import { posix, readText, runProcess, sha256, writeJson, writeText } from './util.ts'

// ───────────────────────── schema infer ─────────────────────────

type Schema = Record<string, unknown>

function typeOf(v: Value): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

function mergeSchemas(a: Schema, b: Schema): Schema {
  if (JSON.stringify(a) === JSON.stringify(b)) return a
  const ta = a.type as string | string[] | undefined
  const tb = b.type as string | string[] | undefined
  if (ta === 'object' && tb === 'object') {
    const pa = (a.properties ?? {}) as Record<string, Schema>
    const pb = (b.properties ?? {}) as Record<string, Schema>
    const props: Record<string, Schema> = {}
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) props[k] = pa[k] && pb[k] ? mergeSchemas(pa[k]!, pb[k]!) : (pa[k] ?? pb[k])!
    const ra = new Set((a.required ?? []) as string[])
    const req = ((b.required ?? []) as string[]).filter((k) => ra.has(k))
    return { type: 'object', properties: props, ...(req.length ? { required: req } : {}) }
  }
  if (ta === 'array' && tb === 'array') return { type: 'array', items: a.items && b.items ? mergeSchemas(a.items as Schema, b.items as Schema) : a.items ?? b.items ?? {} }
  if ((ta === 'integer' && tb === 'number') || (ta === 'number' && tb === 'integer')) return { type: 'number' }
  if (typeof ta === 'string' && typeof tb === 'string' && !a.properties && !b.properties && !a.items && !b.items) return { type: [...new Set([ta, tb])].sort() }
  const flat = (s: Schema): Schema[] => (Array.isArray(s.anyOf) ? (s.anyOf as Schema[]) : [s])
  const all = [...flat(a), ...flat(b)]
  const uniq = all.filter((s, i) => all.findIndex((x) => JSON.stringify(x) === JSON.stringify(s)) === i)
  return { anyOf: uniq }
}

/** JSON Schema (draft-07) draft from one sample value. Arrays merge item schemas; `required` = keys present in every object. */
export function inferSchema(v: Value, depth = 0): Schema {
  const t = typeOf(v)
  if (depth > 12) return {}
  if (t === 'object') {
    const o = v as Record<string, Value>
    const properties: Record<string, Schema> = {}
    for (const [k, x] of Object.entries(o)) properties[k] = inferSchema(x, depth + 1)
    const required = Object.keys(o)
    return { type: 'object', properties, ...(required.length ? { required } : {}) }
  }
  if (t === 'array') {
    const arr = v as Value[]
    if (!arr.length) return { type: 'array', items: {} }
    return { type: 'array', items: arr.slice(0, 200).map((x) => inferSchema(x, depth + 1)).reduce(mergeSchemas) }
  }
  return { type: t }
}

export async function schemaInferCommand(o: ContextOptions & { provider: string; print?: boolean }): Promise<{ code: number; out: string }> {
  const ctx = await buildContext({ ...o, providerNames: new Set([o.provider]) })
  const p = ctx.providers.cfg[o.provider]
  if (!p) return { code: 1, out: `Провайдера «${o.provider}» немає в gate.json providers (і в ${ctx.repo.promptDir}/lib)\n` }
  const value = await ctx.providers.value(o.provider)
  const fail = ctx.providers.failed.find((f) => f.name === o.provider)
  if (value === null && (fail || ctx.host.notes.some((n) => n.message.includes(o.provider)))) {
    return { code: 1, out: [...ctx.host.notes.map((n) => `${n.code} ${n.message}${n.hint ? ` (${n.hint})` : ''}`), 'Схему не виведено: провайдер не повернув даних.'].join('\n') + '\n' }
  }
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: o.provider,
    'generated-by': 'context-gate schema infer',
    'generated-at': new Date().toISOString(),
    'source-hash': sha256(JSON.stringify(value)).slice(0, 16),
    ...inferSchema(value),
  }
  if (o.print) return { code: 0, out: JSON.stringify(schema, null, 2) + '\n' }
  const rel = posix(join(ctx.repo.promptDir, 'proposals', `${o.provider}.schema.json`))
  writeJson(join(ctx.repo.root, rel), schema)
  return { code: 0, out: `записано ${rel}\nПеревір і перенеси в gate.json providers.${o.provider}.schema (або вкажи шлях до файлу).\n` }
}

// ───────────────────────── expand ─────────────────────────

const TIER_GUIDE: Record<string, string> = {
  quick: 'Слабка швидка модель: явні нумеровані кроки замість цілі, 1 короткий приклад, чекліст виходу наприкінці, мінімум варіантів вибору. Не більше ніж удвічі довше за оригінал.',
  standard: 'Модель середнього рівня: коротка послідовність кроків і критерії готовності; без прикладів, якщо оригінал їх не має.',
}

export function expandInstruction(id: string, tier: string, text: string): string {
  return [
    `Перепиши секцію системного промпту «${id}» як варіант для tier «${tier}».`,
    TIER_GUIDE[tier] ?? `Адаптуй під tier ${tier}.`,
    'Правила: не змінюй суті й обмежень; не вигадуй команд, шляхів чи інструментів, яких немає в оригіналі; збережи директиви `@…` і вирази `{{ … }}` дослівно; відповідай лише текстом секції (Markdown, без frontmatter і без пояснень).',
    '',
    '--- оригінал ---',
    text.trim(),
    '--- кінець ---',
  ].join('\n')
}

function fmValue(text: string, key: string): string | undefined {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n?/g, '\n'))
  return m ? new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(m[1]!)?.[1]?.trim().replace(/^["']|["']$/g, '') : undefined
}

export interface ExpandPlanItem {
  id: string
  tier: string
  source: string
  sourceHash: string
  out: string
  skip?: string
  instruction: string
  /** TSX section (from `.compiled`): the proposal is applied as `<Tier is="…">` in `source` at `line`. */
  tsx?: { line?: number }
}

/** `tierNames`: the configured tiers, so only `<id>.<tier>.md` of a known tier is a variant (L53). */
export function planExpand(root: string, promptDir: string, tiers: string[], only?: string[], tierNames?: string[]): ExpandPlanItem[] {
  const dir = join(root, promptDir)
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && !/^readme\.md$/i.test(f)).sort()
  const plan: ExpandPlanItem[] = []
  for (const f of files) {
    if (tierVariantOf(f, tierNames)) continue
    const rel = posix(join(promptDir, f))
    const text = readText(join(dir, f)) ?? ''
    const parsed = parseMarkdownPrompt(text, { path: rel, ...(tierNames ? { tiers: tierNames } : {}) })
    const id = parsed.section.id
    if (only?.length && !only.includes(id)) continue
    const hasTierDirective = /^\s*@tier\b/m.test(text)
    const sourceHash = sha256(text).slice(0, 16)
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '')
    for (const tier of tiers) {
      const out = posix(join(promptDir, 'proposals', `${id}.${tier}.md`))
      const merged = join(dir, `${id}.${tier}.md`)
      let skip: string | undefined
      if (hasTierDirective) skip = 'секція вже має @tier-варіанти'
      else if (existsSync(merged) && fmValue(readText(merged) ?? '', 'source-hash') === sourceHash) skip = `${id}.${tier}.md актуальний`
      else if (existsSync(merged) && !fmValue(readText(merged) ?? '', 'source-hash')) skip = `${id}.${tier}.md написано вручну`
      else if (fmValue(readText(join(root, out)) ?? '', 'source-hash') === sourceHash) skip = 'пропозиція актуальна (source-hash не змінився)'
      plan.push({ id, tier, source: rel, sourceHash, out, instruction: expandInstruction(id, tier, body), ...(skip ? { skip } : {}) })
    }
  }
  return plan
}

const TSX_NOTE = 'Секція з TSX: варіант застосовується як <Tier is="…"> у файлі-джерелі (Markdown-форма нижче — та сама AST).'

/**
 * TSX sections (SPEC «Шар 3а», G-67): the compiled section is printed in the Markdown form (same AST) and
 * offered to the model as canonical text; the proposal is applied as a `<Tier is="quick">` block in the
 * `.prompt.tsx` file. Sections with `<Tier>` already, or ids covered by a Markdown section, are skipped.
 */
export function planExpandTsx(root: string, promptDir: string, tiers: string[], only?: string[], skipIds: ReadonlySet<string> = new Set()): { plan: ExpandPlanItem[]; unbuilt: string[] } {
  const compiledDir = join(root, promptDir, '.compiled')
  const prompts: CompiledPrompt[] = []
  if (existsSync(compiledDir)) {
    for (const f of readdirSync(compiledDir).filter((x) => x.endsWith('.json')).sort()) {
      try { prompts.push(JSON.parse(readText(join(compiledDir, f)) ?? '') as CompiledPrompt) } catch { /* unreadable: skipped */ }
    }
  }
  const builtEntries = new Set(prompts.map((cp) => cp.sources?.[0]?.path))
  const unbuilt = findEntries(root, promptDir).map((e) => posix(e.slice(root.length + 1))).filter((e) => !builtEntries.has(e))
  const plan: ExpandPlanItem[] = []
  for (const cp of prompts) {
    if (cp.skill) continue
    for (const sec of cp.sections ?? []) {
      if (skipIds.has(sec.id) || (only?.length && !only.includes(sec.id))) continue
      const text = printMarkdownNodes(sec.children)
      const sourceHash = sha256(text).slice(0, 16)
      const source = sec.source?.path ?? cp.sources?.[0]?.path ?? `${promptDir}/${cp.id}.prompt.tsx`
      for (const tier of tiers) {
        const out = posix(join(promptDir, 'proposals', `${sec.id}.${tier}.md`))
        let skip: string | undefined
        if (sec.tier?.length || hasTierNodes(sec.children)) skip = 'секція вже має <Tier>-варіанти'
        else if (fmValue(readText(join(root, out)) ?? '', 'source-hash') === sourceHash) skip = 'пропозиція актуальна (source-hash не змінився)'
        plan.push({ id: sec.id, tier, source, sourceHash, out, tsx: sec.source?.line ? { line: sec.source.line } : {}, instruction: `${expandInstruction(sec.id, tier, text)}\n${TSX_NOTE}`, ...(skip ? { skip } : {}) })
      }
    }
  }
  return { plan, unbuilt }
}

export async function expandCommand(root: string, o: { model?: string; dryRun?: boolean; only?: string[]; tiers?: string[]; force?: boolean }): Promise<{ code: number; out: string }> {
  const repo = loadRepo(root)
  const tiers = o.tiers?.length ? o.tiers : ['quick', 'standard'].filter((t) => !repo.config.tiers || t in repo.config.tiers)
  const tierNames = Object.keys(repo.config.tiers ?? {})
  const mdPlan = planExpand(root, repo.promptDir, tiers, o.only, tierNames.length ? tierNames : undefined)
  const tsx = planExpandTsx(root, repo.promptDir, tiers, o.only, new Set(mdPlan.map((p) => p.id)))
  const plan = [...mdPlan, ...tsx.plan]
  const unbuiltNote = tsx.unbuilt.length ? `Не зібрано: ${tsx.unbuilt.join(', ')} — запусти context-gate build, щоб expand побачив TSX-секції.\n` : ''
  if (!plan.length) return { code: 0, out: `Канонічних секцій (Markdown або зібраних TSX) у ${repo.promptDir} немає.\n${unbuiltNote}` }
  const model = o.model ?? 'opus'
  const lines: string[] = []
  if (o.dryRun) {
    for (const p of plan) {
      if (p.skip && !o.force) { lines.push(`# ${p.id}.${p.tier}: пропущено — ${p.skip}`, ''); continue }
      lines.push(`# ${p.id}.${p.tier} → ${p.out} (claude -p --model ${model})${p.tsx ? ` [TSX ${p.source}${p.tsx.line ? `:${p.tsx.line}` : ''}]` : ''}`, '', p.instruction, '')
    }
    return { code: 0, out: lines.join('\n') + unbuiltNote }
  }
  const bin = process.env.CONTEXT_GATE_CLAUDE || 'claude'
  let code = 0
  for (const p of plan) {
    if (p.skip && !o.force) { lines.push(`пропущено ${p.id}.${p.tier}: ${p.skip}`); continue }
    const r = await runProcess([bin, '-p', '--model', model], { cwd: root, stdin: p.instruction, timeoutMs: 300_000 })
    if (r.exitCode !== 0 || !r.stdout.trim()) {
      code = 1
      lines.push(r.exitCode === -1 && /ENOENT/.test(r.stderr) ? `немає «${bin}» у PATH: запусти з --dry-run і передай інструкцію моделі вручну` : `${p.id}.${p.tier}: claude -p завершився з кодом ${r.exitCode}: ${r.stderr.trim().split('\n')[0] ?? ''}`)
      if (r.exitCode === -1 && /ENOENT/.test(r.stderr)) break
      continue
    }
    const fm = ['---', `id: ${p.id}`, `generated-by: context-gate expand (${model})`, `generated-at: ${new Date().toISOString()}`, `source-hash: ${p.sourceHash}`, `source: ${p.source}${p.tsx?.line ? `:${p.tsx.line}` : ''}`, ...(p.tsx ? [`apply: "<Tier is=\\"${p.tier}\\"> у ${p.source}"`] : []), '---', '']
    writeText(join(root, p.out), fm.join('\n') + r.stdout.trim() + '\n', root)
    lines.push(`записано ${p.out}${p.tsx ? ` (TSX: встав як <Tier is="${p.tier}">…</Tier> у ${p.source}${p.tsx.line ? `:${p.tsx.line}` : ''}, а канонічний текст — у <Tier is={[…інші tiers]}>)` : ''}`)
  }
  if (lines.some((l) => l.startsWith('записано'))) lines.push('', `Переглянь diff і перенеси потрібні варіанти з proposals/ у ${repo.promptDir}/.`)
  return { code, out: lines.join('\n') + '\n' + unbuiltNote }
}
