// Shared skill argument parser (SPEC "Парсинг аргументів"): the same for `/name`, CLI and `$ARGUMENTS`.
// Positional by `positional`, `--key value`, `--key=value`, flags `--dry` / `--no-dry`, quotes, `--` raw tail.

import type { ArgSpec } from './types.ts'

export type ArgValue = string | number | boolean | string[] | null | unknown
export type ParseArgsResult =
  | { ok: true; args: Record<string, ArgValue> }
  | { ok: false; error: string; usage: string }

export interface ParseArgsOptions {
  /** For `path` args: existence check relative to the repo root. */
  pathExists?: (path: string) => boolean
  /** Command name for the usage line (default `skill`). */
  name?: string
}

interface Tok { value: string; start: number; end: number; quoted: boolean }

/** Shell-like tokenizer: whitespace separates, '…' literal, "…" with backslash escapes, \x outside quotes. */
export function tokenize(input: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const n = input.length
  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++
    if (i >= n) break
    const start = i
    let v = ''
    let quoted = false
    while (i < n && !/\s/.test(input[i])) {
      const c = input[i]
      if (c === "'") {
        quoted = true
        const j = input.indexOf("'", i + 1)
        if (j < 0) { v += input.slice(i + 1); i = n; break }
        v += input.slice(i + 1, j)
        i = j + 1
      } else if (c === '"') {
        quoted = true
        i++
        while (i < n && input[i] !== '"') {
          if (input[i] === '\\' && i + 1 < n && /["\\$`]/.test(input[i + 1])) { v += input[i + 1]; i += 2; continue }
          v += input[i++]
        }
        i++
      } else if (c === '\\' && i + 1 < n) {
        v += input[i + 1]
        i += 2
      } else {
        v += c
        i++
      }
    }
    toks.push({ value: v, start, end: i, quoted })
  }
  return toks
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function findKey(spec: Record<string, ArgSpec>, raw: string): string | undefined {
  if (raw in spec) return raw
  for (const k of Object.keys(spec)) if (kebab(k) === raw || kebab(k) === kebab(raw)) return k
  return undefined
}

function typeHint(name: string, s: ArgSpec): string {
  if (s.hint) return s.hint
  switch (s.type) {
    case 'enum': return (s.values ?? []).join('|')
    case 'number': return `<${name}>`
    case 'list': return `<${name},…>`
    case 'json': return '<json>'
    case 'path': return `<${name === 'path' ? 'path' : name}>`
    default: return `<${name}>`
  }
}

/** `<tag|sha> [--format md|slack|github] [--scope <scope>] [--dry]` (no command name). */
export function argumentHint(spec: Record<string, ArgSpec>): string {
  const parts: string[] = []
  const positional = Object.entries(spec).filter(([, s]) => s.positional !== undefined && s.type !== 'rest').sort((a, b) => a[1].positional! - b[1].positional!)
  for (const [k, s] of positional) {
    const h = typeHint(k, s)
    const body = h.startsWith('<') ? h : `<${h}>`
    parts.push(s.required ? body : `[${body}]`)
  }
  for (const [k, s] of Object.entries(spec)) {
    if (s.positional !== undefined || s.type === 'rest') continue
    const flag = `--${kebab(k)}`
    const body = s.type === 'flag' ? flag : `${flag} ${typeHint(k, s)}`
    parts.push(s.required ? body : `[${body}]`)
  }
  for (const [k, s] of Object.entries(spec)) {
    if (s.type === 'rest') parts.push(`[-- <${s.hint ? s.hint.replace(/^<|>$/g, '') : k}…>]`)
  }
  return parts.join(' ')
}

export function usageLine(name: string, spec: Record<string, ArgSpec>): string {
  const hint = argumentHint(spec)
  return `/${name}${hint ? ' ' + hint : ''}`
}

function convert(name: string, s: ArgSpec, raw: string, opts: ParseArgsOptions): { value: ArgValue } | { error: string } {
  switch (s.type) {
    case 'number': {
      const v = Number(raw)
      if (raw.trim() === '' || !Number.isFinite(v)) return { error: `\`${name}\` має бути числом, отримано «${raw}»` }
      return { value: v }
    }
    case 'enum': {
      const vals = s.values ?? []
      if (!vals.includes(raw)) return { error: `\`${name}\` має бути ${vals.join('|')}` }
      return { value: raw }
    }
    case 'flag': {
      const v = raw.toLowerCase()
      if (['true', '1', 'yes', 'on', ''].includes(v)) return { value: true }
      if (['false', '0', 'no', 'off'].includes(v)) return { value: false }
      return { error: `\`${name}\` — прапорець, очікується true|false` }
    }
    case 'path': {
      const p = raw.replace(/\\/g, '/').replace(/^\.\//, '')
      if (opts.pathExists && !opts.pathExists(p)) return { error: `\`${name}\`: шлях «${p}» не існує` }
      return { value: p }
    }
    case 'list':
      return { value: raw.split(',').map((x) => x.trim()).filter(Boolean) }
    case 'json':
      try { return { value: JSON.parse(raw) as unknown } } catch { return { error: `\`${name}\` має бути валідним JSON` } }
    default:
      return { value: raw }
  }
}

function fail(name: string, spec: Record<string, ArgSpec>, error: string): ParseArgsResult {
  const usage = usageLine(name, spec)
  return { ok: false, error: `Невірні аргументи: ${error}. Використання: ${usage}`, usage }
}

/** Parse a raw argument string, a pre-split argv, or a structured object (tool call by the model). */
export function parseArgs(input: string | readonly string[] | Record<string, unknown>, spec: Record<string, ArgSpec>, opts: ParseArgsOptions = {}): ParseArgsResult {
  const name = opts.name ?? 'skill'
  if (input && typeof input === 'object' && !Array.isArray(input)) return parseArgsObject(input as Record<string, unknown>, spec, opts)
  const raw = typeof input === 'string' ? input : undefined
  const toks: Tok[] = typeof input === 'string' ? tokenize(input) : (input as readonly string[]).map((v) => ({ value: v, start: -1, end: -1, quoted: false }))
  const args: Record<string, ArgValue> = {}
  const restKey = Object.keys(spec).find((k) => spec[k].type === 'rest')
  const positional = Object.entries(spec).filter(([, s]) => s.positional !== undefined && s.type !== 'rest').sort((a, b) => a[1].positional! - b[1].positional!).map(([k]) => k)
  const extra: string[] = []
  const set = (k: string, v: ArgValue) => {
    if (spec[k].type === 'list' && Array.isArray(args[k]) && Array.isArray(v)) args[k] = [...(args[k] as string[]), ...v]
    else args[k] = v
  }
  let pos = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const v = t.value
    if (v === '--' && !t.quoted) {
      const tail = raw !== undefined ? raw.slice(t.end).replace(/^\s/, '') : toks.slice(i + 1).map((x) => x.value).join(' ')
      if (!restKey) return fail(name, spec, 'хвіст після `--` не очікується')
      args[restKey] = tail
      break
    }
    if (v.startsWith('--') && v.length > 2 && !t.quoted) {
      const eq = v.indexOf('=')
      const rawKey = eq >= 0 ? v.slice(2, eq) : v.slice(2)
      let key = findKey(spec, rawKey)
      let negated = false
      if (!key && rawKey.startsWith('no-')) {
        const k = findKey(spec, rawKey.slice(3))
        if (k && spec[k].type === 'flag') { key = k; negated = true }
      }
      if (!key) return fail(name, spec, `невідомий параметр \`--${rawKey}\``)
      const s = spec[key]
      if (s.type === 'flag') {
        if (negated) { args[key] = false; continue }
        const r = convert(key, s, eq >= 0 ? v.slice(eq + 1) : '', opts)
        if ('error' in r) return fail(name, spec, r.error)
        args[key] = r.value
        continue
      }
      let val: string
      if (eq >= 0) val = v.slice(eq + 1)
      else {
        const next = toks[i + 1]
        if (!next || (next.value.startsWith('--') && !next.quoted)) return fail(name, spec, `\`${key}\` потребує значення`)
        val = next.value
        i++
      }
      const r = convert(key, s, val, opts)
      if ('error' in r) return fail(name, spec, r.error)
      set(key, r.value)
      continue
    }
    // positional
    while (pos < positional.length && positional[pos] in args) pos++
    if (pos < positional.length) {
      const key = positional[pos++]
      const r = convert(key, spec[key], v, opts)
      if ('error' in r) return fail(name, spec, r.error)
      set(key, r.value)
    } else if (restKey) {
      extra.push(v)
    } else {
      return fail(name, spec, `зайвий аргумент «${v}»`)
    }
  }
  if (restKey && extra.length && args[restKey] === undefined) args[restKey] = extra.join(' ')
  return finish(name, spec, args)
}

function finish(name: string, spec: Record<string, ArgSpec>, args: Record<string, ArgValue>): ParseArgsResult {
  for (const [k, s] of Object.entries(spec)) {
    if (args[k] !== undefined) continue
    if (s.required) return fail(name, spec, `бракує обов'язкового аргументу \`${k}\``)
    if (s.default !== undefined) args[k] = s.default as ArgValue
    else if (s.type === 'flag') args[k] = false
    else if (s.type === 'rest') args[k] = ''
  }
  return { ok: true, args }
}

/** Structured input from a tool call: validate/convert each field against the spec. */
export function parseArgsObject(obj: Record<string, unknown>, spec: Record<string, ArgSpec>, opts: ParseArgsOptions = {}): ParseArgsResult {
  const name = opts.name ?? 'skill'
  const args: Record<string, ArgValue> = {}
  for (const [rk, v] of Object.entries(obj)) {
    const k = findKey(spec, rk)
    if (!k) return fail(name, spec, `невідомий параметр \`${rk}\``)
    const s = spec[k]
    if (v === null || v === undefined) continue
    if (s.type === 'json') { args[k] = v; continue }
    if (s.type === 'list' && Array.isArray(v)) { args[k] = v.map(String); continue }
    if (s.type === 'flag' && typeof v === 'boolean') { args[k] = v; continue }
    if (s.type === 'number' && typeof v === 'number') { args[k] = v; continue }
    const r = convert(k, s, String(v), opts)
    if ('error' in r) return fail(name, spec, r.error)
    args[k] = r.value
  }
  return finish(name, spec, args)
}

/** JSON Schema for `$.tool.register` (invoke.model: 'tool'). */
export function argsToJsonSchema(spec: Record<string, ArgSpec>): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []
  for (const [k, s] of Object.entries(spec)) {
    let p: Record<string, unknown>
    switch (s.type) {
      case 'number': p = { type: 'number' }; break
      case 'flag': p = { type: 'boolean' }; break
      case 'enum': p = { type: 'string', enum: s.values ?? [] }; break
      case 'list': p = { type: 'array', items: { type: 'string' } }; break
      case 'json': p = {}; break
      default: p = { type: 'string' }
    }
    const desc = s.description ?? (s.hint ? s.hint : undefined)
    if (desc) p.description = desc
    if (s.default !== undefined && s.default !== null) p.default = s.default
    properties[k] = p
    if (s.required) required.push(k)
  }
  const schema: Record<string, unknown> = { type: 'object', properties, additionalProperties: false }
  if (required.length) schema.required = required
  return schema
}
