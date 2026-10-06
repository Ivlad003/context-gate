// Durations like '500ms', '10s', '5m', '1h', '1d', combined '1h30m'. Bare numbers are milliseconds.

const UNIT: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** Parse a duration to milliseconds; undefined when invalid. */
export function parseDuration(input: string | number | undefined | null): number | undefined {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : undefined
  if (typeof input !== 'string') return undefined
  const s = input.trim().toLowerCase()
  if (!s) return undefined
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/gy
  let total = 0
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    total += Number(m[1]) * UNIT[m[2]]
    pos = re.lastIndex
    while (s[pos] === ' ') pos++
    re.lastIndex = pos
  }
  return pos === s.length && pos > 0 ? Math.round(total) : undefined
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${+(ms / 1000).toFixed(2)}s`
}
