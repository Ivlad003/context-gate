// Small pure parsers for config-like YAML and TOML imports in prompts (SPEC «Імпорти»: `.json`, `.yaml`,
// `.toml` — парсяться на збірці). Not full implementations: they cover what data files of a repo usually
// hold and report anything else as an error with a line number instead of guessing.
//
// YAML: block mappings and sequences (nested by indentation, `- key: v` items), plain / quoted scalars,
// flow collections (`[a, b]`, `{a: 1}`), block scalars (`|`, `>`, with `-`/`+` chomping), comments, one
// document (`---` start marker, `...` end). Unsupported: anchors/aliases, tags, complex keys, multi-docs.
//
// TOML: `key = value` with bare / quoted / dotted keys, `[table]`, `[[array of tables]]`, basic / literal /
// multi-line strings, integers (`_`, 0x/0o/0b), floats (inf, nan), booleans, dates (kept as strings),
// arrays (multi-line), inline tables.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export type ParseOutcome = { ok: true; value: Json } | { ok: false; error: string; line: number }

class DataError extends Error {
  line: number
  constructor(message: string, line: number) { super(message); this.line = line }
}

const isObj = (v: unknown): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Own property only: a key such as `constructor` or `__proto__` never reads the prototype chain. */
const getOwn = (o: Record<string, Json>, k: string): Json | undefined => (Object.hasOwn(o, k) ? o[k] : undefined)

/** Defines an own enumerable key: `__proto__` becomes an ordinary key instead of replacing the prototype. */
const setOwn = (o: Record<string, Json>, k: string, v: Json): void => { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }) }

// ───────────────────────── YAML ─────────────────────────

interface YLine { indent: number; text: string; no: number }

/** Strip a trailing ` # comment` outside quotes. */
function stripYamlComment(s: string): string {
  let q = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (q) {
      if (q === '"' && c === '\\') { i++; continue }
      if (c === q) { if (q === "'" && s[i + 1] === "'") { i++; continue } q = '' }
      continue
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(s[i - 1]!))) { q = c; continue }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).replace(/\s+$/, '')
  }
  return s.replace(/\s+$/, '')
}

const YAML_KEY = /^((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[\]{},][^:#]*?))\s*:(?:\s+|$)/

function yamlNumber(s: string): number | undefined {
  if (/^[-+]?(0|[1-9][0-9_]*)$/.test(s)) return Number(s.replace(/_/g, ''))
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16)
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8)
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s)
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN
  return undefined
}

function unescapeDouble(body: string, line: number): string {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, e: string) => {
    switch (e[0]) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case '0': return '\0'
      case 'b': return '\b'
      case 'f': return '\f'
      case 'e': return '\x1b'
      case '"': return '"'
      case '/': return '/'
      case '\\': return '\\'
      case ' ': return ' '
      case 'x': case 'u': case 'U': return String.fromCodePoint(parseInt(e.slice(1), 16))
      default: throw new DataError(`невідома escape-послідовність \\${e}`, line)
    }
  })
}

function yamlScalar(raw: string, line: number): Json {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false
  if (s[0] === '&' || s[0] === '*' || s[0] === '!') throw new DataError(`якорі, посилання й теги YAML не підтримуються («${s}»)`, line)
  if (s[0] === '"') {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) throw new DataError(`незакритий рядок ${s}`, line)
    return unescapeDouble(s.slice(1, -1), line)
  }
  if (s[0] === "'") {
    if (!/^'(?:[^']|'')*'$/.test(s)) throw new DataError(`незакритий рядок ${s}`, line)
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s[0] === '[' || s[0] === '{') return parseFlow(s, line)
  if (s[0] === '|' || s[0] === '>') throw new DataError('блоковий скаляр має починатись після «ключ:» або «-»', line)
  const n = yamlNumber(s)
  if (n !== undefined) return n
  return s
}

/** Flow collections: `[a, "b", {c: 1}]`, `{a: 1, b: [x]}`. */
function parseFlow(src: string, line: number): Json {
  let i = 0
  const ws = () => { while (i < src.length && /\s/.test(src[i]!)) i++ }
  const value = (inMap: boolean): Json => {
    ws()
    const c = src[i]
    if (c === '[') {
      i++
      const out: Json[] = []
      for (;;) {
        ws()
        if (src[i] === ']') { i++; return out }
        out.push(value(false))
        ws()
        if (src[i] === ',') { i++; continue }
        if (src[i] === ']') { i++; return out }
        throw new DataError(`очікувалось «,» або «]» у ${src}`, line)
      }
    }
    if (c === '{') {
      i++
      const out: Record<string, Json> = {}
      for (;;) {
        ws()
        if (src[i] === '}') { i++; return out }
        const k = value(true)
        ws()
        if (src[i] !== ':') throw new DataError(`очікувалось «:» у ${src}`, line)
        i++
        setOwn(out, String(k), value(false))
        ws()
        if (src[i] === ',') { i++; continue }
        if (src[i] === '}') { i++; return out }
        throw new DataError(`очікувалось «,» або «}» у ${src}`, line)
      }
    }
    if (c === '"' || c === "'") {
      const start = i
      i++
      while (i < src.length) {
        if (c === '"' && src[i] === '\\') { i += 2; continue }
        if (src[i] === c) { if (c === "'" && src[i + 1] === "'") { i += 2; continue } i++; break }
        i++
      }
      return yamlScalar(src.slice(start, i), line)
    }
    const start = i
    while (i < src.length && !/[,\]}]/.test(src[i]!) && !(inMap && src[i] === ':' && /[\s,\]}]|$/.test(src[i + 1] ?? ''))) i++
    return yamlScalar(src.slice(start, i), line)
  }
  const v = value(false)
  ws()
  if (i < src.length) throw new DataError(`зайві символи після колекції: «${src.slice(i)}»`, line)
  return v
}

export function parseYaml(text: string): ParseOutcome {
  const raw = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const lines: string[] = [...raw]
  // Document markers: an optional leading `---`, an optional trailing `...`; a second `---` is a multi-doc.
  let first = 0
  while (first < lines.length && (!lines[first]!.trim() || lines[first]!.trim().startsWith('#') || lines[first]!.startsWith('%'))) first++
  if (lines[first]?.trim() === '---') lines[first] = ''
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!
    if (t === '...' ) { lines.length = i; break }
    if (t === '---' || t.startsWith('--- ')) return { ok: false, error: 'кілька YAML-документів у файлі не підтримуються', line: i + 1 }
    if (/^\t/.test(t)) return { ok: false, error: 'табуляція у відступі YAML', line: i + 1 }
  }

  const info = (i: number): YLine | undefined => {
    const l = lines[i]
    if (l === undefined) return undefined
    const text = stripYamlComment(l)
    const indent = /^ */.exec(l)![0].length
    return { indent, text: text.slice(indent), no: i + 1 }
  }
  const nextContent = (i: number): number => {
    while (i < lines.length) { const x = info(i)!; if (x.text) return i; i++ }
    return i
  }

  /** Block scalar after `|`/`>` header on line i; returns [value, next line index]. */
  const blockScalar = (header: string, i: number, parentIndent: number): [string, number] => {
    const m = /^([|>])([+-]?)(\d?)([+-]?)$/.exec(header.trim())
    if (!m) throw new DataError(`невірний заголовок блокового скаляра «${header}»`, i + 1)
    const folded = m[1] === '>'
    const chomp = m[2] || m[4]
    let j = i + 1
    const body: string[] = []
    let ind = m[3] ? parentIndent + Number(m[3]) : -1
    while (j < lines.length) {
      const l = lines[j]!
      if (!l.trim()) { body.push(''); j++; continue }
      const li = /^ */.exec(l)![0].length
      if (ind < 0) { if (li <= parentIndent) break; ind = li }
      if (li < ind) break
      body.push(l.slice(ind))
      j++
    }
    // Trailing blank lines belong to chomping.
    let trail = 0
    while (body.length && body[body.length - 1] === '') { body.pop(); trail++ }
    let out: string
    if (folded) {
      out = ''
      for (let k = 0; k < body.length; k++) {
        const cur = body[k]!
        if (k === 0) { out = cur; continue }
        const prev = body[k - 1]!
        if (cur === '' ) out += '\n'
        else if (prev === '' || /^\s/.test(cur) || /^\s/.test(prev)) out += (prev === '' ? '' : '\n') + cur
        else out += ' ' + cur
      }
    } else out = body.join('\n')
    if (chomp === '-') { /* strip */ } else if (chomp === '+') out += '\n'.repeat(trail + (body.length ? 1 : 0))
    else if (body.length) out += '\n'
    return [out, j]
  }

  /** Parses the block node starting at content line i with exactly `indent`. Returns [value, next index]. */
  const block = (i: number, indent: number): [Json, number] => {
    const x = info(i)!
    if (x.text === '-' || x.text.startsWith('- ')) return seq(i, indent)
    if (YAML_KEY.test(x.text)) return map(i, indent)
    // A lone scalar (possibly a multi-line plain scalar): join continuation lines.
    let j = i + 1
    const parts = [x.text]
    for (; j < lines.length; j++) {
      const y = info(j)!
      if (!y.text) continue
      if (y.indent <= indent) break
      parts.push(y.text)
    }
    return [yamlScalar(parts.join(' '), x.no), j]
  }

  const valueAfter = (rest: string, i: number, indent: number, line: number): [Json, number] => {
    const r = rest.trim()
    if (r.startsWith('|') || r.startsWith('>')) return blockScalar(r, i, indent)
    if (r) {
      // Flow collections may span lines until brackets balance.
      if (r[0] === '[' || r[0] === '{') {
        let text = r
        let j = i + 1
        const balanced = (s: string) => { let d = 0; let q = ''; for (let k = 0; k < s.length; k++) { const c = s[k]!; if (q) { if (c === '\\' && q === '"') { k++; continue } if (c === q) q = ''; continue } if (c === '"' || c === "'") q = c; else if (c === '[' || c === '{') d++; else if (c === ']' || c === '}') d-- } return d <= 0 }
        while (!balanced(text) && j < lines.length) { const y = info(j)!; text += ' ' + y.text; j++ }
        return [yamlScalar(text, line), j]
      }
      // Plain multi-line scalar continuation.
      let j = i + 1
      const parts = [r]
      for (; j < lines.length; j++) {
        const y = info(j)!
        if (!y.text) { continue }
        if (y.indent <= indent) break
        if (/^["']/.test(r)) break
        parts.push(y.text)
      }
      if (parts.length === 1) j = i + 1
      return [yamlScalar(parts.join(' '), line), j]
    }
    const n = nextContent(i + 1)
    if (n >= lines.length) return [null, n]
    const y = info(n)!
    if (y.indent > indent) return block(n, y.indent)
    if (y.indent === indent && (y.text === '-' || y.text.startsWith('- '))) return seq(n, indent)
    return [null, i + 1]
  }

  const seq = (i: number, indent: number): [Json, number] => {
    const out: Json[] = []
    let j = i
    for (;;) {
      j = nextContent(j)
      if (j >= lines.length) break
      const x = info(j)!
      if (x.indent < indent) break
      if (x.indent > indent) throw new DataError('невірний відступ у списку', x.no)
      if (!(x.text === '-' || x.text.startsWith('- '))) break
      const content = x.text === '-' ? '' : x.text.slice(2).replace(/^ +/, '')
      if (!content) {
        // An empty item (`-`, `- # note`) is null unless a deeper-indented block follows: a sibling `- c` at the
        // same indent is the next item, not this item's value (that rule is for `key:` values only).
        const k = nextContent(j + 1)
        if (k < lines.length && info(k)!.indent > indent) { const [v, n] = valueAfter('', j, indent, x.no); out.push(v); j = n }
        else { out.push(null); j = j + 1 }
        continue
      }
      const col = indent + (x.text.length - content.length)
      if ((content === '-' || content.startsWith('- ') || YAML_KEY.test(content)) && content[0] !== '[' && content[0] !== '{') {
        lines[j] = ' '.repeat(col) + content
        const [v, n] = block(j, col)
        out.push(v)
        j = n
        continue
      }
      const [v, n] = valueAfter(content, j, indent, x.no)
      out.push(v)
      j = n
    }
    return [out, j]
  }

  const map = (i: number, indent: number): [Json, number] => {
    const out: Record<string, Json> = {}
    let j = i
    for (;;) {
      j = nextContent(j)
      if (j >= lines.length) break
      const x = info(j)!
      if (x.indent < indent) break
      if (x.indent > indent) throw new DataError('невірний відступ', x.no)
      if (x.text === '-' || x.text.startsWith('- ')) break
      const m = YAML_KEY.exec(x.text)
      if (!m) {
        if (x.text.startsWith('? ')) throw new DataError('складні ключі YAML («? ») не підтримуються', x.no)
        throw new DataError(`очікувалось «ключ: значення», знайдено «${x.text}»`, x.no)
      }
      const kRaw = m[1]!.trim()
      const key = kRaw[0] === '"' || kRaw[0] === "'" ? String(yamlScalar(kRaw, x.no)) : kRaw
      if (key === '<<') throw new DataError('злиття ключів YAML («<<») не підтримується', x.no)
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new DataError(`ключ «${key}» повторюється`, x.no)
      const [v, n] = valueAfter(x.text.slice(m[0].length), j, indent, x.no)
      setOwn(out, key, v)
      j = n
    }
    return [out, j]
  }

  try {
    const start = nextContent(0)
    if (start >= lines.length) return { ok: true, value: null }
    const x = info(start)!
    const [v, n] = block(start, x.indent)
    const rest = nextContent(n)
    if (rest < lines.length) throw new DataError(`неочікуваний рядок «${info(rest)!.text}» (відступ?)`, rest + 1)
    return { ok: true, value: v }
  } catch (e) {
    if (e instanceof DataError) return { ok: false, error: e.message, line: e.line }
    throw e
  }
}

// ───────────────────────── TOML ─────────────────────────

export function parseToml(text: string): ParseOutcome {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  let i = 0
  const lineAt = (p: number) => src.slice(0, p).split('\n').length
  const fail = (msg: string): never => { throw new DataError(msg, lineAt(i)) }
  const root: Record<string, Json> = {}
  let cur: Record<string, Json> = root
  /** Tables defined by a header or a dotted key (no redefinition); inline tables / arrays are frozen. */
  const defined = new Set<object>()
  const frozen = new Set<object>()

  const wsInline = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++ }
  const skipComment = () => { if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++ }
  const ws = () => { for (;;) { while (i < src.length && /\s/.test(src[i]!)) i++; if (src[i] === '#') { skipComment(); continue } return } }
  const eol = () => {
    wsInline(); skipComment()
    if (i < src.length && src[i] !== '\n') fail(`очікувався кінець рядка, знайдено «${src.slice(i, i + 12)}»`)
  }

  const basicString = (): string => {
    if (src.startsWith('"""', i)) {
      i += 3
      if (src[i] === '\n') i++
      let out = ''
      for (;;) {
        if (i >= src.length) fail('незакритий багаторядковий рядок')
        if (src.startsWith('"""', i)) {
          let n = 3
          while (src[i + n] === '"' && n < 5) n++
          out += '"'.repeat(n - 3)
          i += n
          return out
        }
        if (src[i] === '\\') {
          if (/^\\[ \t]*\n/.test(src.slice(i, i + 64))) { i++; while (i < src.length && /\s/.test(src[i]!)) i++; continue }
          out += escape(); continue
        }
        out += src[i++]
      }
    }
    i++
    let out = ''
    for (;;) {
      const c = src[i]
      if (c === undefined || c === '\n') fail('незакритий рядок')
      if (c === '"') { i++; return out }
      if (c === '\\') { out += escape(); continue }
      out += c
      i++
    }
  }
  const escape = (): string => {
    const e = src[i + 1]
    i += 2
    switch (e) {
      case 'b': return '\b'
      case 't': return '\t'
      case 'n': return '\n'
      case 'f': return '\f'
      case 'r': return '\r'
      case 'e': return '\x1b'
      case '"': return '"'
      case '\\': return '\\'
      case 'u': case 'U': {
        const n = e === 'u' ? 4 : 8
        const hex = src.slice(i, i + n)
        if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) fail('невірний \\u-escape')
        i += n
        return String.fromCodePoint(parseInt(hex, 16))
      }
      default: return fail(`невідома escape-послідовність \\${e}`)
    }
  }
  const literalString = (): string => {
    if (src.startsWith("'''", i)) {
      i += 3
      if (src[i] === '\n') i++
      const end = src.indexOf("'''", i)
      if (end < 0) fail('незакритий багаторядковий рядок')
      let e = end
      while (src[e + 3] === "'" && e - end < 2) e++
      const out = src.slice(i, e)
      i = e + 3
      return out
    }
    i++
    const end = src.indexOf("'", i)
    const nl = src.indexOf('\n', i)
    if (end < 0 || (nl >= 0 && nl < end)) fail('незакритий рядок')
    const out = src.slice(i, end)
    i = end + 1
    return out
  }

  const key = (): string[] => {
    const parts: string[] = []
    for (;;) {
      wsInline()
      const c = src[i]
      if (c === '"') parts.push(basicString())
      else if (c === "'") parts.push(literalString())
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i))
        if (!m) fail('очікувався ключ')
        parts.push(m![0])
        i += m![0].length
      }
      wsInline()
      if (src[i] === '.') { i++; continue }
      return parts
    }
  }

  const value = (): Json => {
    const c = src[i]
    if (c === '"') return basicString()
    if (c === "'") return literalString()
    if (c === '[') {
      i++
      const out: Json[] = []
      for (;;) {
        ws()
        if (src[i] === ']') { i++; frozen.add(out); return out }
        out.push(value())
        ws()
        if (src[i] === ',') { i++; continue }
        if (src[i] === ']') { i++; frozen.add(out); return out }
        fail('очікувалось «,» або «]» у масиві')
      }
    }
    if (c === '{') {
      i++
      const out: Record<string, Json> = {}
      wsInline()
      if (src[i] === '}') { i++; frozen.add(out); return out }
      for (;;) {
        const k = key()
        if (src[i] !== '=') fail('очікувалось «=» в inline-таблиці')
        i++
        wsInline()
        setPath(out, k, value(), true)
        wsInline()
        if (src[i] === ',') { i++; continue }
        if (src[i] === '}') { i++; frozen.add(out); return out }
        fail('очікувалось «,» або «}» в inline-таблиці')
      }
    }
    const m = /^[^\s,\]}#]+(?: [0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?/.exec(src.slice(i))
    if (!m) return fail('очікувалось значення')
    const tok = m![0]
    i += tok.length
    if (tok === 'true') return true
    if (tok === 'false') return false
    if (/^[+-]?(inf|nan)$/.test(tok)) return tok.endsWith('nan') ? NaN : tok.startsWith('-') ? -Infinity : Infinity
    if (/^0x[0-9a-fA-F_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ''), 16)
    if (/^0o[0-7_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ''), 8)
    if (/^0b[01_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ''), 2)
    if (/^[+-]?(0|[1-9](_?[0-9])*)$/.test(tok)) return Number(tok.replace(/_/g, ''))
    if (/^[+-]?(0|[1-9](_?[0-9])*)(\.[0-9](_?[0-9])*)?([eE][+-]?[0-9](_?[0-9])*)?$/.test(tok)) return Number(tok.replace(/_/g, ''))
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(tok)) return tok
    return fail(`невідоме значення «${tok}»`)
  }

  const setPath = (table: Record<string, Json>, path: string[], v: Json, inline = false) => {
    let t = table
    for (let k = 0; k < path.length - 1; k++) {
      const p = path[k]!
      const next = getOwn(t, p)
      if (next === undefined) { const n: Record<string, Json> = {}; setOwn(t, p, n); if (!inline) defined.add(n); t = n; continue }
      if (!isObj(next) || frozen.has(next)) fail(`ключ «${path.slice(0, k + 1).join('.')}» уже має значення`)
      t = next as Record<string, Json>
    }
    const last = path[path.length - 1]!
    if (Object.prototype.hasOwnProperty.call(t, last)) fail(`ключ «${path.join('.')}» визначено двічі`)
    setOwn(t, last, v)
  }

  const tableAt = (path: string[], array: boolean): Record<string, Json> => {
    let t = root
    for (let k = 0; k < path.length; k++) {
      const p = path[k]!
      const last = k === path.length - 1
      let next = getOwn(t, p)
      if (last && array) {
        if (next === undefined) { next = []; setOwn(t, p, next) }
        if (!Array.isArray(next) || frozen.has(next)) fail(`«${path.join('.')}» не є масивом таблиць`)
        const n: Record<string, Json> = {}
        ;(next as Json[]).push(n)
        defined.add(n)
        return n
      }
      if (next === undefined) { const n: Record<string, Json> = {}; setOwn(t, p, n); next = n; if (last) defined.add(n); t = n; continue }
      if (Array.isArray(next) && !frozen.has(next)) { const lastEl = next[next.length - 1]; if (!isObj(lastEl)) fail(`«${p}» не є таблицею`); t = lastEl as Record<string, Json>; continue }
      if (!isObj(next) || frozen.has(next)) fail(`«${path.slice(0, k + 1).join('.')}» уже має значення`)
      const tbl = next as Record<string, Json>
      if (last) { if (defined.has(tbl)) fail(`таблицю [${path.join('.')}] визначено двічі`); defined.add(tbl) }
      t = tbl
    }
    return t
  }

  try {
    for (;;) {
      ws()
      if (i >= src.length) break
      if (src[i] === '[') {
        const array = src[i + 1] === '['
        i += array ? 2 : 1
        const path = key()
        if (array ? !src.startsWith(']]', i) : src[i] !== ']') fail('незакритий заголовок таблиці')
        i += array ? 2 : 1
        eol()
        cur = tableAt(path, array)
        continue
      }
      const k = key()
      if (src[i] !== '=') fail(`очікувалось «=» після ключа «${k.join('.')}»`)
      i++
      wsInline()
      setPath(cur, k, value())
      eol()
    }
    return { ok: true, value: root }
  } catch (e) {
    if (e instanceof DataError) return { ok: false, error: e.message, line: e.line }
    throw e
  }
}
