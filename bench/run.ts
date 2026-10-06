// Bench harness (SPEC MVP exit criterion, "bench"): for every repo in bench/repos.json run the built CLI with the
// gate off and on, and print one Markdown table: system-prompt tokens per session, item tokens, unverified sections,
// and Verify-first-try from the repo's `.claude/gate.log.jsonl` (written by shiftwork via hooks-adapter/shiftwork.ts).
//
//   npm run build && node --experimental-strip-types bench/run.ts [--json] [--repos bench/repos.json]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DecisionLogEntry } from '../packages/core/src/types.ts'
import { fromJsonl } from '../packages/core/src/journal.ts'
import { verifyFirstTry } from '../packages/hooks-adapter/src/shiftwork.ts'

export interface BenchRepo {
  name: string
  dir: string
  profile?: string
  model?: string
  tier?: string
  /** argv overrides for `node dist/cli.js …`. */
  commands?: { health?: string[]; tokensOff?: string[]; tokensOn?: string[] }
}

export interface BenchResult {
  repo: string
  promptTokens?: number
  unverified?: number
  itemTokensOff?: number
  itemTokensOn?: number
  saved?: number
  verifyFirstTry?: string
  errors: string[]
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'dist', 'cli.js')

function decideArgs(r: BenchRepo): string {
  return ['decide', r.profile && `--profile ${r.profile}`, r.model && `--model ${r.model}`, r.tier && `--tier ${r.tier}`].filter(Boolean).join(' ')
}

export function defaultCommands(r: BenchRepo): Required<NonNullable<BenchRepo['commands']>> {
  return {
    health: ['health', '--json', ...(r.profile ? ['--profile', r.profile] : []), ...(r.model ? ['--model', r.model] : [])],
    tokensOff: ['pipe', 'collect | tokens'],
    tokensOn: ['pipe', `collect | ${decideArgs(r)} | tokens`],
  }
}

/** First JSON value in the output: a whole JSON document, or the last parseable JSONL line. */
export function parseJsonOut(text: string): unknown {
  const t = text.trim()
  if (!t) return undefined
  try { return JSON.parse(t) } catch { /* JSONL */ }
  const lines = t.split('\n').reverse()
  for (const l of lines) { try { return JSON.parse(l) } catch { /* next */ } }
  return undefined
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** System-prompt tokens and unverified count from a HealthReport (or a `{ report }` wrapper). */
export function readHealth(v: unknown): { promptTokens?: number; unverified?: number } {
  const rep = isObj(v) && isObj(v.report) ? v.report : v
  if (!isObj(rep)) return {}
  const out: { promptTokens?: number; unverified?: number } = {}
  if (Array.isArray(rep.sections)) out.promptTokens = rep.sections.reduce((a: number, s) => a + (isObj(s) && typeof s.tokens === 'number' ? s.tokens : 0), 0)
  if (Array.isArray(rep.metrics)) {
    for (const m of rep.metrics) {
      if (!isObj(m) || typeof m.name !== 'string') continue
      if (/unverified/i.test(m.name) && typeof m.value === 'number') out.unverified = m.value
      if (out.promptTokens === undefined && /token|розмір|size/i.test(m.name) && typeof m.value === 'number') out.promptTokens = m.value
    }
  }
  return out
}

/** Tokens reaching the context from a TokenSummary (`included.tokens`, else `tokens`). */
export function readTokens(v: unknown): number | undefined {
  const s = Array.isArray(v) ? v[0] : v
  if (!isObj(s)) return undefined
  if (isObj(s.included) && typeof s.included.tokens === 'number') return s.included.tokens
  return typeof s.tokens === 'number' ? s.tokens : undefined
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
}

export function benchOne(r: BenchRepo, run: (args: string[], cwd: string) => string = runCli): BenchResult {
  const dir = resolve(root, r.dir)
  const cmds = { ...defaultCommands(r), ...r.commands }
  const res: BenchResult = { repo: r.name, errors: [] }
  const attempt = (label: string, args: string[]): unknown => {
    try { return parseJsonOut(run(args, dir)) } catch (e) { res.errors.push(`${label}: ${((e as { stderr?: string }).stderr || (e as Error).message).split('\n')[0]}`); return undefined }
  }
  Object.assign(res, readHealth(attempt('health', cmds.health)))
  res.itemTokensOff = readTokens(attempt('tokens off', cmds.tokensOff))
  res.itemTokensOn = readTokens(attempt('tokens on', cmds.tokensOn))
  if (res.itemTokensOff !== undefined && res.itemTokensOn !== undefined) res.saved = res.itemTokensOff - res.itemTokensOn
  const log = join(dir, '.claude', 'gate.log.jsonl')
  if (existsSync(log)) {
    const v = verifyFirstTry(fromJsonl<DecisionLogEntry>(readFileSync(log, 'utf8')).items)
    if (v.rate !== undefined) res.verifyFirstTry = `${v.firstTry}/${v.tickets} (${Math.round(v.rate * 100)}%)`
  }
  return res
}

const cell = (v: number | string | undefined): string => (v === undefined ? '—' : String(v))

export function formatTable(rows: readonly BenchResult[]): string {
  const head = '| репозиторій | системний промпт, ток. | елементи, gate off | елементи, gate on | економія | unverified | Verify з 1-ї спроби |'
  const sep = '| --- | ---: | ---: | ---: | ---: | ---: | --- |'
  const lines = rows.map((r) => `| ${r.repo} | ${cell(r.promptTokens)} | ${cell(r.itemTokensOff)} | ${cell(r.itemTokensOn)} | ${cell(r.saved)} | ${cell(r.unverified)} | ${cell(r.verifyFirstTry)} |`)
  const errs = rows.flatMap((r) => r.errors.map((e) => `- ${r.repo}: ${e}`))
  return [head, sep, ...lines, ...(errs.length ? ['', 'Помилки:', ...errs] : [])].join('\n')
}

function main(): number {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const i = argv.indexOf('--repos')
  const reposFile = resolve(root, i >= 0 ? argv[i + 1] : 'bench/repos.json')
  if (!existsSync(cli)) { process.stderr.write(`немає ${cli}: спершу npm run build\n`); return 1 }
  const repos = (JSON.parse(readFileSync(reposFile, 'utf8')) as { repos: BenchRepo[] }).repos
  const rows = repos.map((r) => benchOne(r))
  process.stdout.write(json ? JSON.stringify(rows, null, 2) + '\n' : formatTable(rows) + '\n')
  return rows.some((r) => r.errors.length) ? 2 : 0
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = main()
