// Preserves JSX text as authored. JSX collapses whitespace in text children (newlines become
// spaces, blank lines vanish), which breaks Markdown paragraphs and code. Before esbuild sees a
// `.tsx` prompt, every JSX text run is rewritten into a string expression container with its raw
// content (`{"\n  Line 1\n\n  Line 2\n"}`); `@context-gate/jsx` then dedents it by Markdown rules.
//
// This is a small TS/JSX scanner, not a parser: it tracks strings, template literals, comments,
// regex literals and JSX nesting. It treats `<` as a JSX start only in expression position
// (after `(`, `,`, `=`, `:`, `?`, `[`, `{`, `}`, `;`, `!`, `&`, `|`, `>`, `=>`, `return`, ...).
// On anything it cannot follow it returns `ok: false` and the caller falls back to plain JSX rules.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', copy: '©' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e] ?? m
  })
}

const JSX_PRECEDE = new Set(['(', ',', '=', ':', '?', '[', '{', '}', ';', '!', '&', '|', '>', '', '+', '-', '*', '%', '~', '^'])
const KEYWORDS_BEFORE_EXPR = new Set(['return', 'yield', 'default', 'case', 'in', 'of', 'typeof', 'void', 'delete', 'await', 'else', 'do', 'throw', 'new'])
const REGEX_PRECEDE = new Set(['(', ',', '=', ':', '?', '[', '{', '}', ';', '!', '&', '|', '', '+', '-', '*', '%', '~', '^', '<', '>'])

class ScanError extends Error {}

export interface PreserveResult { code: string; ok: boolean; error?: string }

export function preserveJsxText(src: string): PreserveResult {
  const edits: { start: number; end: number; text: string }[] = []
  let i = 0
  let prev = '' // last significant char in JS mode
  let prevWord = ''
  const n = src.length

  const fail = (msg: string): never => { throw new ScanError(`${msg} (позиція ${i})`) }

  const skipString = (q: string) => {
    i++
    while (i < n) {
      const c = src[i]!
      if (c === '\\') { i += 2; continue }
      if (c === q) { i++; return }
      if (c === '\n' && q !== '`') fail('незакритий рядок')
      i++
    }
    fail('незакритий рядок')
  }

  const skipTemplate = () => {
    i++ // `
    while (i < n) {
      const c = src[i]!
      if (c === '\\') { i += 2; continue }
      if (c === '`') { i++; return }
      if (c === '$' && src[i + 1] === '{') { i += 2; js(true); continue }
      i++
    }
    fail('незакритий шаблонний рядок')
  }

  const skipRegex = () => {
    i++
    let cls = false
    while (i < n) {
      const c = src[i]!
      if (c === '\\') { i += 2; continue }
      if (c === '\n') fail('незакритий regex')
      if (cls) { if (c === ']') cls = false }
      else if (c === '[') cls = true
      else if (c === '/') { i++; while (i < n && /[a-z]/i.test(src[i]!)) i++; return }
      i++
    }
    fail('незакритий regex')
  }

  const skipComment = (): boolean => {
    if (src[i] === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; return true }
    if (src[i] === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) fail('незакритий коментар'); i = e + 2; return true }
    return false
  }

  const skipWs = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i]!)) i++
      if (!skipComment()) return
    }
  }

  /** JS/TS mode. With `untilBrace`, returns after consuming the matching `}`. */
  function js(untilBrace: boolean): void {
    let depth = 0
    prev = '{'
    prevWord = ''
    while (i < n) {
      const c = src[i]!
      if (/\s/.test(c)) { i++; continue }
      if (skipComment()) continue
      if (c === '"' || c === "'") { skipString(c); prev = 'a'; prevWord = ''; continue }
      if (c === '`') { skipTemplate(); prev = 'a'; prevWord = ''; continue }
      if (c === '{') { depth++; i++; prev = '{'; prevWord = ''; continue }
      if (c === '}') {
        if (depth === 0) { if (untilBrace) { i++; return } fail('зайва }') }
        depth--; i++; prev = '}'; prevWord = ''; continue
      }
      if (c === '/') {
        if (REGEX_PRECEDE.has(prev) || KEYWORDS_BEFORE_EXPR.has(prevWord)) { skipRegex(); prev = 'a'; prevWord = ''; continue }
        i++; prev = '/'; prevWord = ''; continue
      }
      if (c === '<') {
        const next = src[i + 1] ?? ''
        const exprPos = JSX_PRECEDE.has(prev) || KEYWORDS_BEFORE_EXPR.has(prevWord)
        if (exprPos && (/[A-Za-z_$>]/.test(next))) { element(); prev = 'a'; prevWord = ''; continue }
        i++; prev = '<'; prevWord = ''; continue
      }
      if (/[A-Za-z_$]/.test(c)) {
        const s = i
        while (i < n && /[\w$]/.test(src[i]!)) i++
        prevWord = src.slice(s, i)
        prev = KEYWORDS_BEFORE_EXPR.has(prevWord) ? '' : 'a'
        continue
      }
      if (/[0-9]/.test(c)) { while (i < n && /[\w.]/.test(src[i]!)) i++; prev = 'a'; prevWord = ''; continue }
      // `=>`: the `>` keeps expression position; `)`/`]` end an operand.
      i++
      prev = c === ')' || c === ']' ? 'a' : c
      prevWord = ''
    }
    if (untilBrace) fail('незакрита {')
  }

  /** At `<` of a JSX element or fragment. */
  function element(): void {
    i++ // <
    skipWs()
    if (src[i] === '>') { i++; children(); return }
    const s = i
    while (i < n && /[\w$.:-]/.test(src[i]!)) i++
    if (i === s) fail('очікувалось ім\'я тегу')
    // attributes
    for (;;) {
      skipWs()
      const c = src[i]
      if (c === undefined) fail('незакритий тег')
      if (c === '/' && src[i + 1] === '>') { i += 2; return }
      if (c === '>') { i++; children(); return }
      if (c === '{') { i++; js(true); continue } // spread or comment
      if (/[A-Za-z_$]/.test(c!)) {
        while (i < n && /[\w$:-]/.test(src[i]!)) i++
        skipWs()
        if (src[i] !== '=') continue
        i++
        skipWs()
        const v = src[i]
        if (v === '"' || v === "'") { const e = src.indexOf(v, i + 1); if (e < 0) fail('незакритий атрибут'); i = e + 1; continue }
        if (v === '{') { i++; js(true); continue }
        if (v === '<') { element(); continue }
        fail('невірне значення атрибута')
      }
      fail(`неочікуваний символ «${c}» у тезі`)
    }
  }

  /** JSX children until the matching closing tag. */
  function children(): void {
    for (;;) {
      const s = i
      while (i < n && src[i] !== '<' && src[i] !== '{') i++
      if (i > s) {
        const raw = src.slice(s, i)
        // Newlines are repeated as JS whitespace inside the container so line numbers (and source maps) stay intact.
        edits.push({ start: s, end: i, text: `{${JSON.stringify(decodeEntities(raw))}${'\n'.repeat(raw.split('\n').length - 1)}}` })
      }
      if (i >= n) fail('незакритий JSX-елемент')
      if (src[i] === '{') { i++; js(true); continue }
      // `<`
      let j = i + 1
      while (j < n && /\s/.test(src[j]!)) j++
      if (src[j] === '/') {
        const e = src.indexOf('>', j)
        if (e < 0) fail('незакритий закривальний тег')
        i = e + 1
        return
      }
      element()
    }
  }

  try {
    js(false)
  } catch (err) {
    if (err instanceof ScanError) return { code: src, ok: false, error: err.message }
    throw err
  }
  if (!edits.length) return { code: src, ok: true }
  let out = ''
  let last = 0
  for (const e of edits) { out += src.slice(last, e.start) + e.text; last = e.end }
  return { code: out + src.slice(last), ok: true }
}
