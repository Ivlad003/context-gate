// CLI argv parsing: `--flag`, `--key value`, `--key=value`, `--no-flag`, `-h`, `--` tail. Per-command specs.

export type FlagType = 'bool' | 'string' | 'list'
export interface FlagSpec { type: FlagType; desc: string; short?: string; arg?: string }

export interface ParsedArgv { flags: Record<string, string | boolean | string[]>; positional: string[]; tail: string[]; errors: string[] }

export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  root: { type: 'string', desc: 'корінь репозиторію (за замовчуванням — найближчий з .claude/ або .git від cwd)', arg: '<dir>' },
  'trust-repo': { type: 'bool', desc: 'довіряти репозиторію на цей запуск (CI, claude -p): дозволяє процеси й cli-провайдери' },
  'user-skills': { type: 'bool', desc: '--no-user-skills: не читати ~/.claude/skills (відтворювані collect/report/bench; або CONTEXT_GATE_NO_USER_SKILLS=1)' },
  help: { type: 'bool', desc: 'довідка', short: 'h' },
}

/** `loose`: unknown `--key [value]` are accepted (pipe stages take arbitrary stage args). */
export function parseArgv(argv: readonly string[], spec: Record<string, FlagSpec>, loose = false): ParsedArgv {
  const all = { ...GLOBAL_FLAGS, ...spec }
  const shorts = new Map(Object.entries(all).filter(([, s]) => s.short).map(([k, s]) => [s.short!, k]))
  const out: ParsedArgv = { flags: {}, positional: [], tail: [], errors: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') { out.tail = argv.slice(i + 1) as string[]; break }
    if (/^-[A-Za-z]$/.test(a)) {
      const k = shorts.get(a.slice(1))
      if (!k) { out.errors.push(`невідомий прапорець ${a}`); continue }
      out.flags[k] = true
      continue
    }
    if (!a.startsWith('--') || a === '-') { out.positional.push(a); continue }
    const eq = a.indexOf('=')
    let key = eq > 0 ? a.slice(2, eq) : a.slice(2)
    let inline: string | undefined = eq > 0 ? a.slice(eq + 1) : undefined
    let neg = false
    if (!all[key] && key.startsWith('no-') && all[key.slice(3)]?.type === 'bool') { key = key.slice(3); neg = true }
    const s = all[key]
    if (!s) {
      if (!loose) { out.errors.push(`невідомий прапорець --${key}`); continue }
      const next = argv[i + 1]
      if (inline !== undefined) out.flags[key] = inline
      // A target (`prompt://x`) is never an unknown flag's value.
      else if (next !== undefined && !next.startsWith('--') && !/^prompt:\/\//.test(next)) { out.flags[key] = next; i++ }
      else out.flags[key] = true
      continue
    }
    if (s.type === 'bool') {
      if (inline !== undefined) out.flags[key] = !/^(false|0|no|off)$/i.test(inline)
      else out.flags[key] = !neg
      continue
    }
    if (inline === undefined) {
      const next = argv[i + 1]
      if (next === undefined) { out.errors.push(`--${key} потребує значення${s.arg ? ` ${s.arg}` : ''}`); continue }
      inline = next
      i++
    }
    if (s.type === 'list') {
      const cur = out.flags[key]
      out.flags[key] = [...(Array.isArray(cur) ? cur : []), ...inline.split(',').map((x) => x.trim()).filter(Boolean)]
    } else out.flags[key] = inline
  }
  return out
}

export const str = (p: ParsedArgv, k: string): string | undefined => (typeof p.flags[k] === 'string' ? (p.flags[k] as string) : undefined)
export const bool = (p: ParsedArgv, k: string): boolean => p.flags[k] === true
export const list = (p: ParsedArgv, k: string): string[] | undefined => (Array.isArray(p.flags[k]) ? (p.flags[k] as string[]) : typeof p.flags[k] === 'string' ? [p.flags[k] as string] : undefined)

export function helpText(name: string, summary: string, usage: string[], spec: Record<string, FlagSpec>, extra?: string): string {
  const lines = [`context-gate ${name} — ${summary}`, '', 'Використання:', ...usage.map((u) => `  context-gate ${u}`)]
  const flags = Object.entries({ ...spec, ...GLOBAL_FLAGS })
  if (flags.length) {
    lines.push('', 'Прапорці:')
    const left = flags.map(([k, s]) => `  ${s.short ? `-${s.short}, ` : ''}--${k}${s.type !== 'bool' ? ` ${s.arg ?? '<v>'}` : ''}`)
    const w = Math.min(34, Math.max(...left.map((l) => l.length)) + 2)
    flags.forEach(([, s], i) => lines.push(left[i]!.padEnd(w) + s.desc))
  }
  if (extra) lines.push('', extra)
  return lines.join('\n') + '\n'
}
