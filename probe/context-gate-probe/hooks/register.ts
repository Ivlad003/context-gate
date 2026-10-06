// context-gate-probe: SPEC Р6 stage 0, docs/PROBE.md "Still LIVE". One observer per unverified mods API
// point. Every hook passes through unchanged, never throws, appends one observation to an in-memory report
// and rewrites `<session root>/.claude/<out>` (default probe.json; CONTEXT_GATE_PROBE_OUT overrides the
// file name, as probe/run-print.sh does for the `-p` run) through $.fs.write.
// Recorded: metadata and lengths only, except the skill_listing text (the parseSkillListing fixture).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { ProbeMarker } from '../types'

export type PointName =
  | 'skill_listing'
  | 'tool_describe_mcp'
  | 'skill_prompt_bang'
  | 'state_after_clear'
  | 'filechanged_watchdir'
  | 'prompt_context_subagent'
  | 'model_complete_cost'
  | 'prompt_compose_print'

export const POINTS: readonly PointName[] = [
  'skill_listing',
  'tool_describe_mcp',
  'skill_prompt_bang',
  'state_after_clear',
  'filechanged_watchdir',
  'prompt_context_subagent',
  'model_complete_cost',
  'prompt_compose_print',
]

export type Verdict = 'works' | 'broken' | 'partial'
export type Sample = Record<string, unknown> & { seq: number; at: string; kind: string }
export interface Point { status: 'observed' | 'not-fired'; samples: Sample[]; verdict?: Verdict }
export interface Report {
  claudeCode: string | null
  startedAt: string
  out: string
  points: Record<PointName, Point>
}

const MAX_SAMPLES = 60
const LISTING_CHARS = 20_000
const WATCH_DIR = '.cursor/rules'
const WATCH_FILE = '.claude/probe-watch.txt'

const markerAtom = atom({ plugin: 'context-gate-probe', key: 'marker' } as const, '')

export function newReport(now: string): Report {
  const points = {} as Record<PointName, Point>
  for (const p of POINTS) points[p] = { status: 'not-fired', samples: [] }
  return { claudeCode: null, startedAt: now, out: 'probe.json', points }
}

/** Automatic verdicts where a sample answers the question by itself; the rest stay for the person. */
export function judge(r: Report): void {
  const s = (p: PointName) => r.points[p].samples
  const set = (p: PointName, v: Verdict | undefined) => {
    if (v) r.points[p].verdict = v
  }
  set('tool_describe_mcp', s('tool_describe_mcp').some((x) => x.isDeferred === true) ? 'works' : undefined)
  const clears = s('state_after_clear').filter((x) => x.kind === 'classic.SessionStart' && x.source === 'clear')
  if (clears.length) set('state_after_clear', clears.some((x) => typeof x.markerBefore === 'string' && x.markerBefore !== '') ? 'works' : 'broken')
  const fc = s('filechanged_watchdir').filter((x) => x.kind === 'classic.FileChanged')
  if (fc.length) set('filechanged_watchdir', fc.some((x) => x.underWatchDir === true) ? 'works' : 'partial')
  const mc = s('model_complete_cost').filter((x) => x.kind === 'model.complete')
  if (mc.length) set('model_complete_cost', mc.some((x) => x.isAnswered === true) ? 'works' : 'broken')
  if (s('prompt_compose_print').some((x) => Array.isArray(x.traits) && (x.traits as unknown[]).includes('print'))) set('prompt_compose_print', 'works')
}

const lengthOf = (v: unknown): number => (typeof v === 'string' ? v.length : 0)
const agentKeys = (e: object): string[] => Object.keys(e).filter((k) => /agent/i.test(k))

/** Repo-relative when inside `root`, else the basename: paths only, never content. */
export function relPath(root: string, path: string): string {
  if (root && path.startsWith(root.endsWith('/') ? root : root + '/')) return path.slice(root.replace(/\/+$/, '').length + 1)
  return path.split(/[\\/]/).pop() ?? path
}

/** `.catch` for every hook: a failed observer degrades to the engine's own behaviour. */
function pass<E, R>(_$: unknown, e: E, next: (e: E) => R): R {
  return next(e)
}

/** The module's own runtime: the report and the write queue (reset on every load). */
export interface Probe {
  report: Report
  seq: number
  seen: Set<string>
  writing: Promise<void> | null
  dirty: boolean
}

export function newProbe(): Probe {
  return { report: newReport(new Date().toISOString()), seq: 0, seen: new Set(), writing: null, dirty: false }
}

async function writeNow($: EngineInterface, rt: Probe): Promise<void> {
  judge(rt.report)
  const root = await $.session.root()
  const name = (await $.env.get('CONTEXT_GATE_PROBE_OUT')) || 'probe.json'
  rt.report.out = name
  await $.fs.write(`${root}/.claude/${name}`, JSON.stringify(rt.report, null, 2) + '\n')
}

/** Overwrite the whole file; writes requested while one is in flight coalesce into one more. */
async function flush($: EngineInterface, rt: Probe): Promise<void> {
  rt.dirty = true
  if (rt.writing) return rt.writing
  let done: () => void = () => {}
  rt.writing = new Promise<void>((resolve) => { done = resolve })
  while (rt.dirty) {
    rt.dirty = false
    try {
      await writeNow($, rt)
    } catch (err) {
      try { $.ui.log(`context-gate-probe: write failed: ${String(err)}`, { to: 'debug' }) } catch { /* ignore */ }
    }
  }
  rt.writing = null
  done()
}

/** Append one sample (deduplicated by `keyOf` when given) and rewrite probe.json. Never throws. */
async function observe($: EngineInterface, rt: Probe, point: PointName, kind: string, data: () => Record<string, unknown>, keyOf?: () => string): Promise<void> {
  try {
    const key = keyOf?.()
    if (key !== undefined) {
      const k = `${point}|${kind}|${key}`
      if (rt.seen.has(k)) return
      rt.seen.add(k)
    }
    const p = rt.report.points[point]
    p.status = 'observed'
    const sample: Sample = { seq: ++rt.seq, at: new Date().toISOString(), kind, ...data() }
    if (p.samples.length < MAX_SAMPLES) p.samples.push(sample)
    const { text: _omit, ...logged } = sample
    try { $.ui.log(`context-gate-probe: ${point} ${JSON.stringify(logged)}`, { to: 'debug' }) } catch { /* ignore */ }
    await flush($, rt)
  } catch {
    /* the probe never breaks the session */
  }
}

async function marker($: EngineInterface): Promise<ProbeMarker | null> {
  try { return await read($, markerAtom) } catch { return null }
}

async function setMarker($: EngineInterface, value: ProbeMarker): Promise<void> {
  try { await update($, markerAtom, () => value) } catch { /* ignore */ }
}

export const register: Register = (on) => {
  const rt = newProbe()
  const report = rt.report

  // ── 4 (+ /probe registration): session lifecycle and $.state across /clear ──

  on('session.start', async ($, e, next) => {
    try {
      if (report.claudeCode === null) {
        try { report.claudeCode = (await $.session.version()).version } catch { /* not available */ }
      }
      const before = await marker($)
      await observe($, rt, 'state_after_clear', 'session.start', () => ({ markerBefore: before, surface: e.surface, isInteractive: e.isInteractive }))
      await setMarker($, `session.start@${new Date().toISOString()}`)
      await $.command.register({ name: 'probe', description: 'context-gate-probe: classify (time $.model.complete) | dump', argumentHint: 'classify|dump' })
    } catch { /* ignore */ }
    return next(e)
  }).catch(pass)

  on('session.end', async ($, e, next) => {
    const before = await marker($)
    await observe($, rt, 'state_after_clear', 'session.end', () => ({ reason: e.reason, markerBefore: before }))
    return next(e)
  }).catch(pass)

  // ── 4 + 5: classic SessionStart (source) and watchPaths with a directory entry ──

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    try {
      const before = await marker($)
      await observe($, rt, 'state_after_clear', 'classic.SessionStart', () => ({ source: e.source, markerBefore: before }))
      await setMarker($, `classic.SessionStart:${e.source}@${new Date().toISOString()}`)
      const root = await $.session.root()
      const watch = [`${root}/${WATCH_DIR}`, `${root}/${WATCH_FILE}`]
      await observe($, rt, 'filechanged_watchdir', 'watchPaths', () => ({ source: e.source, added: watch, existing: r.watchPaths?.length ?? 0 }))
      return { ...r, watchPaths: [...(r.watchPaths ?? []), ...watch] }
    } catch {
      return r
    }
  }).catch(pass)

  on('classic.FileChanged', async ($, e, next) => {
    try {
      const root = await $.session.root()
      const path = String(e.file_path)
      await observe($, rt, 'filechanged_watchdir', 'classic.FileChanged', () => ({
        file_path: path,
        event: e.event,
        underWatchDir: path.startsWith(`${root}/${WATCH_DIR}/`),
        isWatchFile: path === `${root}/${WATCH_FILE}`,
      }))
    } catch { /* ignore */ }
    return next(e)
  }).catch(pass)

  // ── 1: the skill listing attachment (passed through unchanged) ──

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const r = await next(e)
    await observe($, rt, 'skill_listing', 'prompt.attachment', () => ({
      agentId: e.agentId ?? null,
      origin: e.origin?.kind ?? null,
      textLength: e.text.length,
      resultChanged: r.text !== e.text,
      hasDetail: e.detail !== undefined,
      text: e.text.slice(0, LISTING_CHARS),
    }), () => `${e.agentId ?? 'main'}|${e.text.length}`)
    return r
  }).catch(pass)

  // ── 2: tool.describe for MCP tools (deferred?) ──

  on('tool.describe', { tool: /^mcp__/ }, async ($, e, next) => {
    const r = await next(e)
    await observe($, rt, 'tool_describe_mcp', 'tool.describe', () => ({
      tool: e.tool,
      isDeferred: e.isDeferred === true,
      descriptionLength: e.description.length,
      resultIsDeferred: r.isDeferred ?? null,
      resultDescriptionLength: r.description.length,
    }), () => `${e.tool}|${e.isDeferred === true}|${e.description.length}`)
    return r
  }).catch(pass)

  // ── 3: skill.prompt vs !`…`, Skill tool ordering (seq), command.run ──

  on('skill.prompt', async ($, e, next) => {
    await observe($, rt, 'skill_prompt_bang', 'skill.prompt', () => ({
      skill: e.skill,
      hasBangPattern: /!`/.test(e.text),
      // the bundled probe-bang skill: its output present without its command means !`…` already ran
      fixtureExpanded: e.text.includes('probe-bang-expanded') && !e.text.includes('echo probe-bang-expanded'),
      textLength: e.text.length,
    }))
    return next(e)
  }).catch(pass)

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    await observe($, rt, 'skill_prompt_bang', 'tool.call:Skill', () => ({ skill: e.skill, hasArgs: lengthOf(e.args) > 0, argsLength: lengthOf(e.args), agentId: e.agentId ?? null }))
    return next(e)
  }).catch(pass)

  // ── 7: /probe classify times $.model.complete({ model: 'haiku' }); /probe (dump) summarises ──

  on('command.run', { command: 'probe' }, async ($, e) => {
    await observe($, rt, 'skill_prompt_bang', 'command.run', () => ({ command: e.command, hasArgs: e.args.trim().length > 0, origin: e.origin?.kind ?? null }))
    if (e.args.trim() === 'classify') {
      const t0 = Date.now()
      try {
        const res = await $.model.complete({
          model: 'haiku',
          system: 'Answer with exactly one label from: frontend, backend, docs.',
          prompt: 'Task: fix the CSS of the login button.',
          maxTokens: 16,
        })
        const ms = Date.now() - t0
        await observe($, rt, 'model_complete_cost', 'model.complete', () => (res.isAnswered
          ? { ms, isAnswered: true, answerLength: res.text.length, usage: res.usage }
          : { ms, isAnswered: false, reason: res.reason }))
        return { text: `probe classify: ${ms} ms, ${res.isAnswered ? `usage ${JSON.stringify(res.usage)}` : `not answered (${res.reason})`}` }
      } catch (err) {
        const ms = Date.now() - t0
        await observe($, rt, 'model_complete_cost', 'model.complete', () => ({ ms, isAnswered: false, error: String(err) }))
        return { text: `probe classify: failed: ${String(err)}` }
      }
    }
    judge(report)
    const lines = POINTS.map((p) => `${p}: ${report.points[p].status}${report.points[p].verdict ? ` (${report.points[p].verdict})` : ''}, ${report.points[p].samples.length} samples`)
    return { text: ['context-gate-probe', ...lines, 'usage: /probe classify | dump'].join('\n') }
  })

  on('command.run', async ($, e, next) => {
    await observe($, rt, 'skill_prompt_bang', 'command.run', () => ({ command: e.command, hasArgs: e.args.trim().length > 0, origin: e.origin?.kind ?? null }))
    return next(e)
  }).catch(pass)

  // ── 6: prompt.context (agentId? instructionFiles?) and turn.step (subagents, cache reads) ──

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    let root = ''
    try { root = await $.session.root() } catch { /* relPath falls back to basenames */ }
    await observe($, rt, 'prompt_context_subagent', 'prompt.context', () => ({
      blockNames: e.blocks.map((b) => b.name),
      instructionFilesDefined: e.instructionFiles !== undefined,
      instructionFilesCount: e.instructionFiles?.length ?? 0,
      instructionFileKinds: [...new Set((e.instructionFiles ?? []).map((f) => f.kind))],
      inputKeys: Object.keys(e),
      agentLikeKeys: agentKeys(e),
      // what came back from next(e): the plugins beneath (plugin order is unknown) plus the engine
      resultBlockNames: r.blocks.map((b) => b.name),
      resultInstructionFiles: (r.instructionFiles ?? []).map((f) => ({ path: relPath(root, f.path), kind: f.kind })),
      hasCursorRulesBlock: r.blocks.some((b) => b.name === 'cursorRules'),
    }), () => `${e.blocks.map((b) => b.name).join(',')}|${e.instructionFiles?.length ?? -1}|${r.blocks.map((b) => b.name).join(',')}|${r.instructionFiles?.length ?? -1}`)
    return r
  }).catch(pass)

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    await observe($, rt, 'prompt_context_subagent', 'turn.step', () => ({
      agentId: e.agentId ?? null,
      model: e.model,
      index: e.index,
      usageModel: r?.usage?.model ?? null,
      cacheReadInputTokens: r?.usage?.cache_read_input_tokens ?? null,
      stopReason: r?.stopReason ?? null,
    }))
    return r
  })

  // ── 8: prompt.compose traits ('print' under -p, 'sdk-preset') ──

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    await observe($, rt, 'prompt_compose_print', 'prompt.compose', () => ({
      traits: [...e.traits],
      model: e.model,
      promptModel: e.promptModel,
      surfaces: [...e.surfaces],
      toolsCount: e.tools.length,
      sectionsCount: r.sections.length,
    }), () => `${e.traits.join(',')}|${e.model}|${r.sections.length}`)
    return r
  }).catch(pass)

  // ── 4 (continued): the marker on each prompt, to see the state right after /clear (no prompt text) ──

  on('prompt.submit', async ($, e, next) => {
    const before = await marker($)
    await observe($, rt, 'state_after_clear', 'prompt.submit', () => ({ markerBefore: before, textLength: e.text.length }))
    return next(e)
  }).catch(pass)
}
