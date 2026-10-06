// Decision journal: 200-entry ring in io.state, optional `.claude/gate.log.jsonl` (config log.file).
// Metadata only: never the user's prompt text, file contents or command output. Exception, behind
// `log.file` only: `snapshot` entries (core journal.ts contract) carry our own render scope and the
// rendered system-prompt text, truncated, for `context-gate run --ctx-from session:…`.


import { LOG_MAX, pruneSnapshots, toJsonl } from '../../packages/core/src/journal.ts'
import { json, pushRing } from '../state.ts'
import type { LogEntry } from '../state.ts'
import { type Io, type Runtime, debug, join, now } from '../ctx.ts'

export const LOG_FILE = '.claude/gate.log.jsonl'
const FILE_MAX_LINES = 5000
const FLUSH_EVERY = 5

export async function journal(io: Io, rt: Runtime, entry: Partial<LogEntry> & { kind: string }): Promise<void> {
  const turn = entry.turn ?? (await io.read('gateState').then((g) => g.turn, () => 0))
  const full: LogEntry = json({ ts: now(), turn, trigger: entry.trigger ?? entry.kind, tier: entry.tier ?? '', enabled: [], disabled: [], reason: [], ...entry })
  await pushEntry(io, rt, full)
}

export async function pushEntry(io: Io, rt: Runtime, entry: LogEntry): Promise<void> {
  await io.update('log', (buf) => pushRing(buf, json(entry), LOG_MAX))
  if (rt.cfg?.log?.file) {
    rt.journalBuffer.push(toJsonl({ ...entry, event: entry.kind ?? 'decision' }))
    if (rt.journalBuffer.length >= FLUSH_EVERY) await flushJournal(io, rt)
  }
}

/** File-only entry (`snapshot`): too large for the state ring; dropped without `log.file`. */
export async function pushFileEntry(io: Io, rt: Runtime, entry: LogEntry): Promise<void> {
  if (!rt.cfg?.log?.file) return
  rt.journalBuffer.push(toJsonl({ ...entry, event: entry.kind ?? 'decision' }))
  await flushJournal(io, rt)
}

/** No append API: keep the file's text in memory and write it whole. */
export async function flushJournal(io: Io, rt: Runtime): Promise<void> {
  if (!rt.journalBuffer.length || !rt.root) return
  const path = join(rt.root, LOG_FILE)
  try {
    if (rt.journalText === undefined) {
      const t = await io.fs.read(path).catch(() => '')
      rt.journalText = typeof t === 'string' ? t : ''
    }
    let text = rt.journalText + rt.journalBuffer.join('')
    rt.journalBuffer = []
    text = pruneSnapshots(text)
    const lines = text.split('\n')
    if (lines.length > FILE_MAX_LINES) text = lines.slice(lines.length - FILE_MAX_LINES).join('\n')
    rt.journalText = text
    await io.fs.write(path, text)
  } catch (err) {
    debug(io, `journal write failed: ${String((err as Error)?.message ?? err)}`)
  }
}

