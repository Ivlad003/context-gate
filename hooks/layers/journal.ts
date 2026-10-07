// Decision journal: 200-entry ring in io.state, optional `.claude/gate.log.jsonl` (config log.file).
// Metadata only: never the user's prompt text, file contents or command output. Exception, behind
// `log.file` only: `snapshot` entries (core journal.ts contract) carry our own render scope and the
// rendered system-prompt text, truncated, for `context-gate run --ctx-from session:…`.


import { LOG_MAX, pruneSnapshots, toJsonl } from '../../packages/core/src/journal.ts'
import { json, pushRing } from '../state.ts'
import type { LogEntry } from '../state.ts'
import { type Io, type Runtime, debug, join, now } from '../ctx.ts'

export const LOG_FILE = '.claude/gate.log.jsonl'
/** Rotation target: the oldest lines past the caps, one generation kept. */
export const LOG_ROTATED = '.claude/gate.log.1.jsonl'
const FILE_MAX_LINES = 5000
/** Well under the 4 MiB `$.fs.read` limit, so the file stays readable for the next flush. */
const FILE_MAX_BYTES = 2 * 1024 * 1024
/** Entries kept in memory while the file cannot be written. */
const BUFFER_MAX = 500
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

/** File-only entry (`snapshot`, `gate-attempt`): too large or too frequent for the state ring; dropped without
 *  `log.file`. `buffered` waits for the next flush (every FLUSH_EVERY entries, turn.complete, session.end). */
export async function pushFileEntry(io: Io, rt: Runtime, entry: LogEntry, opts: { buffered?: boolean } = {}): Promise<void> {
  if (!rt.cfg?.log?.file) return
  rt.journalBuffer.push(toJsonl({ ...entry, event: entry.kind ?? 'decision' }))
  if (!opts.buffered || rt.journalBuffer.length >= FLUSH_EVERY) await flushJournal(io, rt)
}

/** No append API: every flush re-reads the file and writes it back with the new lines appended, so lines other
 *  writers appended meanwhile (another session, the hooks adapter, pi/opencode, the shiftwork runner) survive (R1).
 *  An existing file that cannot be read (over 4 MiB, EACCES) is never overwritten. Past FILE_MAX_LINES or
 *  FILE_MAX_BYTES the oldest lines (down to half the caps) move to `gate.log.1.jsonl`, replacing the previous rotation:
 *  between the two files at least one full generation is always kept. */
export function flushJournal(io: Io, rt: Runtime): Promise<void> {
  const run = (rt.journalFlush ?? Promise.resolve()).then(() => flushNow(io, rt))
  rt.journalFlush = run.catch(() => undefined)
  return run
}

async function flushNow(io: Io, rt: Runtime): Promise<void> {
  if (!rt.journalBuffer.length || !rt.root) return
  const path = join(rt.root, LOG_FILE)
  try {
    const t = await io.fs.read(path).catch(() => undefined)
    let current = typeof t === 'string' ? t : undefined
    if (current === undefined) {
      if (await io.fs.exists(path).catch(() => true)) {
        if (rt.journalBuffer.length > BUFFER_MAX) rt.journalBuffer = rt.journalBuffer.slice(-BUFFER_MAX)
        if (!rt.journalBlocked) {
          rt.journalBlocked = true
          debug(io, `journal: ${LOG_FILE} не читається — нові записи не пишуться, щоб не стерти історію`)
          try { io.ui.toast(`context-gate: ${LOG_FILE} не читається (завеликий?) — журнал не пишеться`, { timeoutMs: 8000 }) } catch { /* no surface */ }
        }
        return
      }
      current = ''
    }
    rt.journalBlocked = false
    const buffer = rt.journalBuffer.join('')
    rt.journalBuffer = []
    let text = pruneSnapshots((current && !current.endsWith('\n') ? current + '\n' : current) + buffer)
    const lines = text.split('\n')
    // Past a cap, rotate a whole generation (down to half the cap), not just the few lines over it: a rotation per
    // flush would replace gate.log.1.jsonl with ~FLUSH_EVERY lines each time and lose the rest (R1).
    let cut = 0
    if (lines.length > FILE_MAX_LINES || utf8Bytes(lines, 0) > FILE_MAX_BYTES) {
      cut = Math.max(0, lines.length - Math.floor(FILE_MAX_LINES / 2))
      while (cut < lines.length - 1 && utf8Bytes(lines, cut) > FILE_MAX_BYTES / 2) cut += Math.max(1, Math.floor((lines.length - cut) / 4))
    }
    if (cut > 0) {
      await io.fs.write(join(rt.root, LOG_ROTATED), lines.slice(0, cut).join('\n') + '\n')
      text = lines.slice(cut).join('\n')
    }
    await io.fs.write(path, text)
  } catch (err) {
    debug(io, `journal write failed: ${String((err as Error)?.message ?? err)}`)
  }
}

/** UTF-8 size of `lines[from..]` joined by newlines (Cyrillic is two bytes a character). */
function utf8Bytes(lines: readonly string[], from: number): number {
  let n = 0
  for (let i = from; i < lines.length; i++) {
    const l = lines[i]
    n += l.length + 1
    for (let j = 0; j < l.length; j++) if (l.charCodeAt(j) > 0x7f) n += l.charCodeAt(j) > 0x7ff ? 2 : 1
  }
  return n
}
