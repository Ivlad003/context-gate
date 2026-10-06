// SPEC «Продуктивність»: «Ціль: без `@run` жоден хук не перевищує 5 мс». The hooks spend their own time in
// these core paths (the rest is `$` I/O, which the hook budget does not count):
// - tool.call (Read/Edit/Write): Auto Attached glob match over the cached rules + packInjections;
// - prompt.attachment {skill_listing}: parse + rewrite of the listing;
// - prompt.compose: renderPrompt of compiled sections without @run (untrusted host → stubs, no processes).
// Median over warm iterations, so a slow CI machine does not flake on a GC pause.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CompiledPrompt, ItemDecision, MdcRule } from '../packages/core/src/types.ts'
import { autoRulesFor, packInjections, parseMdc } from '../packages/core/src/mdc.ts'
import { parseSkillListing, renderSkillListing } from '../packages/core/src/items.ts'
import { renderPrompt } from '../packages/core/src/render.ts'
import { REPO } from './cli-helpers.ts'

const BUDGET_MS = 5
const WARMUP = 20
const RUNS = 101

async function median(fn: () => unknown | Promise<unknown>): Promise<number> {
  for (let i = 0; i < WARMUP; i++) await fn()
  const ts: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now()
    await fn()
    ts.push(performance.now() - t0)
  }
  ts.sort((a, b) => a - b)
  return ts[Math.floor(ts.length / 2)]!
}

const rules: MdcRule[] = Array.from({ length: 40 }, (_, i) => parseMdc(
  `---\ndescription: rule ${i}\nglobs: ${i % 2 ? `apps/web/**/*.tsx, apps/web/**/*.ts` : `apps/api/src/**/*.ts, !**/*.test.ts`}\nalwaysApply: false\n---\n${'Текст правила. '.repeat(40)}`,
  { path: `.cursor/rules/r${i}.mdc`, id: `r${i}` },
).rule)

test(`tool.call path: glob rules for a file over 40 rules < ${BUDGET_MS} ms`, async () => {
  const ms = await median(() => {
    const hits = autoRulesFor(rules, 'apps/api/src/users/users.controller.ts')
    return packInjections(hits, 30_000)
  })
  assert.ok(ms < BUDGET_MS, `${ms.toFixed(3)} ms`)
})

test(`prompt.attachment path: parse + rewrite a 60-skill listing < ${BUDGET_MS} ms`, async () => {
  const text = 'The following skills are available for use with the Skill tool:\n\n' + Array.from({ length: 60 }, (_, i) => `- skill-${i}: ${'Опис skill-а, що робить щось корисне. '.repeat(3)}`).join('\n')
  const decisions: Record<string, ItemDecision> = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`skill:skill-${i}`, (i % 3 === 0 ? 'off' : i % 3 === 1 ? 'nameOnly' : 'on') as ItemDecision]))
  const ms = await median(() => renderSkillListing(parseSkillListing(text), decisions))
  assert.ok(ms < BUDGET_MS, `${ms.toFixed(3)} ms`)
})

const compiledFile = join(REPO, 'examples', 'basic', '.claude', 'prompt', '.compiled', 'main.json')

test(`prompt.compose path: render examples/basic without @run < ${BUDGET_MS} ms`, { skip: !existsSync(compiledFile) }, async () => {
  const compiled = JSON.parse(readFileSync(compiledFile, 'utf8')) as CompiledPrompt
  const scope = {
    gate: { profile: 'frontend', tier: 'quick', groups: ['frontend'] },
    git: { branch: 'main', dirty: false },
    cursor: { always: [{ id: 'project', body: 'Правило '.repeat(50) }], auto: [{ id: 'typescript' }] },
    ctx: { percent: 30 },
    data: {},
  }
  const host = { readFile: async () => 'x'.repeat(2000), now: () => Date.now(), trusted: false }
  const ms = await median(() => renderPrompt([compiled], scope as never, host, { tier: 'quick' }))
  assert.ok(ms < BUDGET_MS, `${ms.toFixed(3)} ms`)
})
