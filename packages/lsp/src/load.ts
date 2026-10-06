// File-system side of the editor tooling: find the repo root of a prompt file and load the Ctx model
// inputs (gate.json, gate.index.json, .types/ctx.d.ts, .trace/last.json, .compiled/*.json) with an
// mtime cache, so tsserver can call it on every keystroke.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { CompiledPrompt, Diagnostic, GateConfig } from '../../core/src/types.ts'
import { buildModel, type CtxModel, type GateIndex, type LastTrace } from './model.ts'

export const PROMPT_FILE = /\.prompt\.tsx$/

export function isPromptFile(fileName: string): boolean {
  return PROMPT_FILE.test(fileName)
}

/** Nearest ancestor directory with `.claude/` (gate.json or prompt dir). */
export function findRoot(fileName: string): string | undefined {
  let dir = dirname(resolve(fileName))
  for (;;) {
    if (existsSync(join(dir, '.claude', 'gate.json')) || existsSync(join(dir, '.claude', 'prompt'))) return dir
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

function mtime(p: string): number {
  try { return statSync(p).mtimeMs } catch { return -1 }
}

function readJson<T>(p: string): T | undefined {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T } catch { return undefined }
}

function readText(p: string): string | undefined {
  try { return readFileSync(p, 'utf8') } catch { return undefined }
}

export function promptDir(root: string, config?: Partial<GateConfig>): string {
  return join(root, config?.prompt?.dir ?? '.claude/prompt')
}

export function modelPaths(root: string, config?: Partial<GateConfig>): { config: string; index: string; ctxDts: string; trace: string; compiled: string } {
  const dir = promptDir(root, config)
  return {
    config: join(root, '.claude', 'gate.json'),
    index: join(root, '.claude', 'gate.index.json'),
    ctxDts: join(dir, '.types', 'ctx.d.ts'),
    trace: join(dir, '.trace', 'last.json'),
    compiled: join(dir, '.compiled'),
  }
}

const modelCache = new Map<string, { key: string; model: CtxModel; config?: Partial<GateConfig> }>()

/** Ctx model of a repo, reloaded when any input file changes. */
export function loadModel(root: string): { model: CtxModel; config?: Partial<GateConfig> } {
  const cfgPath = join(root, '.claude', 'gate.json')
  const config = readJsonCached<Partial<GateConfig>>(cfgPath)
  const p = modelPaths(root, config)
  const key = [p.config, p.index, p.ctxDts, p.trace].map(mtime).join(':')
  const hit = modelCache.get(root)
  if (hit && hit.key === key) return hit
  const index = readJson<GateIndex>(p.index)
  const ctxDts = readText(p.ctxDts)
  const trace = readJson<LastTrace>(p.trace)
  const model = buildModel({
    ...(config ? { config } : {}),
    ...(index ? { index } : {}),
    ...(ctxDts ? { ctxDts } : {}),
    ...(trace ? { trace } : {}),
    readFile: (rel: string) => readText(join(root, rel)),
  })
  const entry = { key, model, ...(config ? { config } : {}) }
  modelCache.set(root, entry)
  return entry
}

const jsonCache = new Map<string, { m: number; v: unknown }>()
function readJsonCached<T>(p: string): T | undefined {
  const m = mtime(p)
  const hit = jsonCache.get(p)
  if (hit && hit.m === m) return hit.v as T | undefined
  const v = m < 0 ? undefined : readJson<T>(p)
  jsonCache.set(p, { m, v })
  return v
}

export function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/** Diagnostics from every `.compiled/*.json` whose sources include this file (repo-relative path). */
export function compiledDiagnosticsFor(root: string, fileName: string): { diagnostics: Diagnostic[]; relPath: string } {
  const { config } = loadModel(root)
  const dir = modelPaths(root, config).compiled
  const relPath = toPosix(relative(root, resolve(fileName)))
  const out: Diagnostic[] = []
  let files: string[] = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return { diagnostics: out, relPath } }
  for (const f of files) {
    const cp = readJsonCached<CompiledPrompt>(join(dir, f))
    if (!cp || !Array.isArray(cp.diagnostics)) continue
    const own = cp.sources?.some((s) => s.path === relPath)
    for (const d of cp.diagnostics) {
      if (d.path ? d.path === relPath || relPath.endsWith('/' + d.path) : own && cp.sources?.[0]?.path === relPath) out.push(d)
    }
  }
  return { diagnostics: out, relPath }
}

/** Prompt id of a file: `.claude/prompt/<id>.prompt.tsx` / `<id>.md`. */
export function promptIdOfFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName
  return base.replace(/\.prompt\.tsx$/, '').replace(/\.md$/, '')
}
