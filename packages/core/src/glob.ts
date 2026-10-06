// Dependency-free glob matcher (SPEC "Шар 1 — cursor-rules", "Glob-матчинг").
// Supports `**`, `*`, `?`, `{a,b}` (nested, numeric ranges `{1..3}`), `[...]` / `[!...]`,
// leading `!` negation, backslash escapes. Paths are POSIX, repo-relative.
// Note: `*` and `**` also match dotfiles (more inclusive than minimatch's default).

export interface GlobOptions {
  /** Case-insensitive match (Windows). */
  nocase?: boolean
  /** Pattern without `/` matches the basename at any depth (`*.ts` ≡ `**\/*.ts`). */
  matchBase?: boolean
}

export type Matcher = (path: string) => boolean

const MAX_EXPANSIONS = 1024
const cache = new Map<string, RegExp>()

/** Brace expansion: `a{b,c{d,e}}` → `ab`, `acd`, `ace`. Escaped braces and single-alternative braces stay literal. */
export function expandBraces(pattern: string): string[] {
  const open = findOpenBrace(pattern)
  if (open < 0) return [pattern]
  const close = findMatchingBrace(pattern, open)
  if (close < 0) return [pattern]
  const inner = pattern.slice(open + 1, close)
  const pre = pattern.slice(0, open)
  const post = pattern.slice(close + 1)
  let alts = splitTopLevel(inner)
  if (alts.length === 1) {
    const range = /^(-?\d+)\.\.(-?\d+)$/.exec(inner)
    if (range) {
      const a = Number(range[1]), b = Number(range[2])
      const step = a <= b ? 1 : -1
      alts = []
      for (let i = a; step > 0 ? i <= b : i >= b; i += step) {
        alts.push(String(i))
        if (alts.length > MAX_EXPANSIONS) break
      }
    } else {
      // `{a}` is literal: escape the braces and continue after them.
      return expandBraces(post).map((p) => pre + '\\{' + inner + '\\}' + p).slice(0, MAX_EXPANSIONS)
    }
  }
  const out: string[] = []
  const posts = expandBraces(post)
  for (const alt of alts) {
    for (const a of expandBraces(pre + alt)) {
      for (const p of posts) {
        out.push(a + p)
        if (out.length >= MAX_EXPANSIONS) return out
      }
    }
  }
  return out
}

function findOpenBrace(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === '[') { const c = findClassEnd(s, i); if (c > 0) { i = c; continue } }
    if (s[i] === '{') return i
  }
  return -1
}

function findMatchingBrace(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') { i++; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** Split on commas that are not inside nested braces. */
export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue }
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

function findClassEnd(s: string, open: number): number {
  let i = open + 1
  if (s[i] === '!' || s[i] === '^') i++
  if (s[i] === ']') i++
  for (; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === ']') return i
    if (s[i] === '/') return -1
  }
  return -1
}

const RE_SPECIAL = /[.+^$|()[\]{}\\*?]/

function escapeRe(ch: string): string {
  return RE_SPECIAL.test(ch) ? '\\' + ch : ch
}

/** Convert one brace-free glob to a regex source (anchored by the caller). */
function globToSource(pat: string, matchBase: boolean): string {
  if (pat.startsWith('./')) pat = pat.slice(2)
  while (pat.startsWith('/')) pat = pat.slice(1)
  if (pat.endsWith('/')) pat += '**'
  let src = ''
  let i = 0
  const n = pat.length
  while (i < n) {
    const ch = pat[i]
    if (ch === '\\') {
      if (i + 1 < n) src += escapeRe(pat[i + 1])
      i += 2
      continue
    }
    if (ch === '/' && pat.slice(i + 1) === '**') {
      // trailing `/**` also matches the directory itself
      src += '(?:/.*)?'
      i = n
      continue
    }
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        const atStart = i === 0 || pat[i - 1] === '/'
        let j = i
        while (pat[j] === '*') j++
        const atEnd = j === n || pat[j] === '/'
        if (atStart && atEnd) {
          if (j === n) { src += '.*'; i = j; continue }
          // `**/` → zero or more directories
          src += '(?:.*/)?'
          i = j + 1
          continue
        }
        src += '[^/]*'
        i = j
        continue
      }
      src += '[^/]*'
      i++
      continue
    }
    if (ch === '?') { src += '[^/]'; i++; continue }
    if (ch === '[') {
      const end = findClassEnd(pat, i)
      if (end < 0) { src += '\\['; i++; continue }
      let body = pat.slice(i + 1, end)
      let neg = false
      if (body[0] === '!' || body[0] === '^') { neg = true; body = body.slice(1) }
      let cls = ''
      for (let k = 0; k < body.length; k++) {
        const c = body[k]
        if (c === '\\' && k + 1 < body.length) { cls += '\\' + body[k + 1]; k++; continue }
        if (c === '^' || c === '\\' || c === '[' || c === ']') cls += '\\' + c
        else cls += c
      }
      src += neg ? `[^/${cls}]` : `[${cls}]`
      i = end + 1
      continue
    }
    src += escapeRe(ch)
    i++
  }
  if (matchBase && !pat.includes('/')) src = '(?:.*/)?' + src
  return src
}

/** Compile a (possibly negated) glob to a cached RegExp; negation is NOT applied here. */
export function globToRegExp(pattern: string, opts: GlobOptions = {}): RegExp {
  const key = `${opts.nocase ? 'i' : ''}${opts.matchBase ? 'b' : ''}\0${pattern}`
  const hit = cache.get(key)
  if (hit) return hit
  const alts = expandBraces(pattern).map((p) => globToSource(p, !!opts.matchBase))
  const re = new RegExp(`^(?:${alts.join('|')})$`, opts.nocase ? 'i' : '')
  if (cache.size > 5000) cache.clear()
  cache.set(key, re)
  return re
}

/** Split leading `!` (each one toggles negation). */
export function splitNegation(pattern: string): { negated: boolean; pattern: string } {
  let negated = false
  let p = pattern
  while (p.startsWith('!')) { negated = !negated; p = p.slice(1) }
  return { negated, pattern: p }
}

export function compileGlob(pattern: string, opts: GlobOptions = {}): Matcher {
  const { negated, pattern: p } = splitNegation(pattern.trim())
  const re = globToRegExp(p, opts)
  return negated ? (path) => !re.test(path) : (path) => re.test(path)
}

/** True when `path` matches some positive glob and no negative one.
 * Globs starting with `!` inside `globs` count as negative too. */
export function matchAny(path: string, globs: readonly string[], negGlobs: readonly string[] = [], opts: GlobOptions = {}): boolean {
  let hit = false
  const negs: string[] = [...negGlobs]
  for (const g of globs) {
    const { negated, pattern } = splitNegation(g.trim())
    if (negated) { negs.push(pattern); continue }
    if (!hit && pattern && globToRegExp(pattern, opts).test(path)) hit = true
  }
  if (!hit) return false
  for (const g of negs) if (g && globToRegExp(g, opts).test(path)) return false
  return true
}

export function hasGlobChars(s: string): boolean {
  return /[*?[\]{}]/.test(s)
}

// ───────────────────────── Paths ─────────────────────────

const DRIVE = /^[A-Za-z]:(?:\/|$)/

/** Detect a Windows host from `OS` env or the shape of cwd/root. */
export function detectWindows(cwdOrRoot?: string, osEnv?: string): boolean {
  if (osEnv && /windows/i.test(osEnv)) return true
  return !!cwdOrRoot && (DRIVE.test(cwdOrRoot.replace(/\\/g, '/')) || cwdOrRoot.startsWith('\\\\'))
}

function collapse(p: string): string {
  const abs = p.startsWith('/')
  const parts = p.split('/')
  const out: string[] = []
  for (let k = 0; k < parts.length; k++) {
    const seg = parts[k]
    if (seg === '' || seg === '.') {
      if (k === 0 && abs) out.push('')
      continue
    }
    if (seg === '..' && out.length && out[out.length - 1] !== '..' && !(out.length === 1 && (out[0] === '' || DRIVE.test(out[0] + '/')))) {
      out.pop()
      continue
    }
    out.push(seg)
  }
  if (abs && out.length === 1 && out[0] === '') return '/'
  return out.join('/')
}

/** Normalise `path` to a POSIX path relative to `root`. Absolute paths outside root stay absolute (POSIX slashes). */
export function normalizePath(path: string, root: string, opts: { windows?: boolean } = {}): string {
  let s = path.replace(/\\/g, '/')
  let r = root.replace(/\\/g, '/')
  const windows = opts.windows ?? (detectWindows(r) || DRIVE.test(s))
  s = collapse(s)
  r = collapse(r)
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1)
  const isAbs = s.startsWith('/') || DRIVE.test(s)
  if (!isAbs) return s
  const cmpS = windows ? s.toLowerCase() : s
  const cmpR = windows ? r.toLowerCase() : r
  if (cmpS === cmpR) return ''
  const prefix = cmpR.endsWith('/') ? cmpR : cmpR + '/'
  if (r && cmpS.startsWith(prefix)) return s.slice(prefix.length)
  return s
}
