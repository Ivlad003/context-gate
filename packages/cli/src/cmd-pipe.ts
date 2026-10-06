// Composable pipe stages over JSONL (SPEC «Composable pipe-команда»): each stage reads Item JSONL on stdin
// and writes JSONL (or a summary) on stdout, so `collect | decide | tokens` composes with jq. The same stages
// run in-process for `context-gate pipe "collect | decide --profile x | tokens"` (grammar: core gatecmd).

import { join } from 'node:path'
import type { DecisionLogEntry, Value } from '../../core/src/types.ts'
import { observeCounts, runPipeStage, runPipeline, sinceMs, type PipeHost, type RenderedRecord, type StageOut } from '../../core/src/pipeline.ts'
import { parseGateCommand, PIPE_STAGES, type PipeStage } from '../../core/src/gatecmd.ts'
import { fromJsonl } from '../../core/src/journal.ts'
import { renderPrompt } from '../../core/src/render.ts'
import { buildContext, collectRepoItems, decide, loadRepo } from './context.ts'
import { readText } from './util.ts'

export { observeCounts, sinceMs }
export type { StageOut }

export interface StageEnv { root: string; trustRepo?: boolean; now?: number }

function readLog(root: string): DecisionLogEntry[] {
  const t = readText(join(root, '.claude', 'gate.log.jsonl'))
  return t ? fromJsonl<DecisionLogEntry>(t).items : []
}

/** The CLI's side of the pipe: files on disk and `buildContext` (core `runPipeStage` does the stages). */
export function cliPipeHost(env: StageEnv): PipeHost {
  const repo = loadRepo(env.root)
  return {
    config: repo.config,
    now: env.now ?? Date.now(),
    deliverNeedsDryRun: true,
    // Async: `provider` rule sources resolve when the repo is trusted, else they stay `unverified` items.
    collect: async () => (await collectRepoItems(repo, { ...(env.trustRepo ? { trustRepo: true } : {}) })).items,
    decide: (items, f) => decide(repo.config, items, { ...(f.profile ? { profile: f.profile } : {}), ...(f.model ? { model: f.model } : {}), ...(f.tier ? { tier: f.tier } : {}), ...(f.branch ? { branch: f.branch } : {}), paths: f.paths }).items,
    signals: async (a) => {
      const ctx = await buildContext({ root: env.root, trustRepo: env.trustRepo, dryScripts: true, providerNames: new Set() })
      const git = ctx.scope.git && typeof ctx.scope.git === 'object' ? (ctx.scope.git as Record<string, Value>) : {}
      return { paths: git.changed ?? [], branch: git.branch ?? '', model: a.model ?? '', tier: ctx.tier, profile: ctx.gate.profile ?? null }
    },
    render: async (_ids, a) => {
      const ctx = await buildContext({ root: env.root, trustRepo: env.trustRepo, ...(a.tier ? { tier: a.tier } : {}), ...(a.profile ? { profile: a.profile } : {}), ...(a.model ? { model: a.model } : {}), ...(a['dry-scripts'] ? { dryScripts: true } : {}) })
      const result = await renderPrompt(ctx.prompts.system, ctx.scope, ctx.host, { tier: ctx.tier, ...(ctx.repo.config.prompt?.runCacheDefault ? { runCacheDefault: ctx.repo.config.prompt.runCacheDefault } : {}) })
      const sections = new Map<string, RenderedRecord>(result.sections.map((s) => [s.id, { text: s.text, tokens: s.tokens, included: s.included, ...(s.reason ? { reason: s.reason } : {}), status: s.status }]))
      return { tier: ctx.tier, sections }
    },
    log: () => readLog(env.root),
  }
}

/** One stage over records (a standalone `context-gate <stage>` reading JSONL on stdin). */
export async function runStage(stage: PipeStage, input: unknown[], env: StageEnv): Promise<StageOut> {
  return runPipeStage(stage, input, cliPipeHost(env))
}

/** Runs a whole `a | b | c` pipe in-process. */
export async function runPipe(text: string, input: unknown[], env: StageEnv): Promise<StageOut> {
  const parsed = parseGateCommand(text, {})
  if ('error' in parsed) return { error: parsed.error, code: 2 }
  const stages = parsed.cmd === 'pipe' ? parsed.stages : undefined
  if (!stages) return { error: `G501 «${text}» не є pipe-командою (стадії: ${PIPE_STAGES.join(', ')})`, code: 2 }
  return runPipeline(stages, input, cliPipeHost(env))
}

export function formatStageOut(out: StageOut, opts: { pretty?: boolean } = {}): string {
  if ('error' in out) return ''
  if ('text' in out) return out.text
  if (opts.pretty && out.records.length === 1) return JSON.stringify(out.records[0], null, 2) + '\n'
  return out.records.map((r) => JSON.stringify(r)).join('\n') + (out.records.length ? '\n' : '')
}
