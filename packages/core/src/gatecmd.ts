// `/gate` command grammar (SPEC "Інтерфейс користувача", pipe grammar in "Єдина модель"),
// `[gate:<profile>]` prompt flag and `@mentions`.

export type PipeStageName =
  | 'collect' | 'normalize' | 'signals' | 'decide' | 'budget' | 'render' | 'deliver' | 'observe'
  | 'where' | 'tokens' | 'on' | 'off' | 'why' | 'take' | 'sort' | 'preview'

export const PIPE_STAGES: readonly PipeStageName[] = ['collect', 'normalize', 'signals', 'decide', 'budget', 'render', 'deliver', 'observe', 'where', 'tokens', 'on', 'off', 'why', 'take', 'sort', 'preview']

export interface PipeStage {
  stage: PipeStageName
  /** `key=value` and `--key value` pairs; `--flag` → 'true'. */
  args: Record<string, string>
  /** Bare words (e.g. `take 3`). */
  positional: string[]
  /** For `where`: the raw filter expression. */
  expr?: string
}

export type GateCommand =
  | { cmd: 'status' }
  | { cmd: 'profile'; profile: string }
  | { cmd: 'groups'; add: string[]; remove: string[] }
  | { cmd: 'off' }
  | { cmd: 'auto' }
  | { cmd: 'new' }
  | { cmd: 'why'; close?: boolean }
  | { cmd: 'shadow' }
  | { cmd: 'apply' }
  | { cmd: 'rules' }
  | { cmd: 'health' }
  | { cmd: 'build' }
  | { cmd: 'help' }
  | { cmd: 'render'; id: string }
  /** `/gate edit <id>`: the browser editor (packages/editor-web) for a prompt file or section. */
  | { cmd: 'edit'; id: string }
  | { cmd: 'trust'; action: 'revoke' }
  | { cmd: 'pipe'; stages: PipeStage[] }

export type GateParse = GateCommand | { error: string }

const SIMPLE = new Set(['off', 'auto', 'new', 'shadow', 'apply', 'rules', 'health', 'build', 'help'])

/** Words `/gate <word>` reads as a subcommand or pipe stage, never as a profile (a profile with such a name is
 * reachable only as `/gate profile <name>` or `[gate:<name>]`; config validation warns, G316). */
export const RESERVED_GATE_WORDS: readonly string[] = [...new Set([...SIMPLE, ...PIPE_STAGES, 'why', 'render', 'edit', 'trust'])]

/** Split on `|` outside quotes. */
function splitPipe(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | undefined
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = undefined; continue }
    if (c === '"' || c === "'") { q = c; cur += c; continue }
    if (c === '|') { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out
}

function words(s: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

function parseStage(text: string): PipeStage | { error: string } {
  const t = text.trim()
  if (!t) return { error: 'G503 Порожня стадія pipe між `|`' }
  const ws = words(t)
  const name = ws[0]
  if (!(PIPE_STAGES as readonly string[]).includes(name)) {
    return { error: `G501 Невідома стадія «${name}». Відомі: ${PIPE_STAGES.join(', ')}` }
  }
  const stage: PipeStage = { stage: name as PipeStageName, args: {}, positional: [] }
  if (name === 'where') {
    stage.expr = t.slice(name.length).trim()
    if (!stage.expr) return { error: 'G508 Порожній фільтр where' }
    return stage
  }
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i]
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      if (eq > 2) { stage.args[w.slice(2, eq)] = w.slice(eq + 1); continue }
      const key = w.slice(2)
      if (!key) return { error: `G504 Невірний аргумент «${w}» у стадії ${name}` }
      const next = ws[i + 1]
      if (next !== undefined && !next.startsWith('--') && !/^[\w.-]+=/.test(next)) { stage.args[key] = next; i++ }
      else stage.args[key] = 'true'
      continue
    }
    const kv = /^([\w.-]+)=(.*)$/.exec(w)
    if (kv) { stage.args[kv[1]] = kv[2]; continue }
    if (w.includes('=')) return { error: `G504 Невірний аргумент «${w}» у стадії ${name}` }
    stage.positional.push(w)
  }
  return stage
}

export interface ParseGateOptions {
  /** Known profile names: a bare word not in the list → G502. */
  profiles?: readonly string[]
}

/** Parse `/gate …` (the leading `/gate` is optional). */
export function parseGateCommand(input: string, opts: ParseGateOptions = {}): GateParse {
  let s = input.trim().replace(/^\/?gate\b/, '').trim()
  if (!s) return { cmd: 'status' }
  if (s.includes('|')) {
    const parts = splitPipe(s)
    const stages: PipeStage[] = []
    for (const p of parts) {
      const st = parseStage(p)
      if ('error' in st) return st
      stages.push(st)
    }
    return { cmd: 'pipe', stages }
  }
  const ws = words(s)
  const head = ws[0]
  if (head.startsWith('+') || head.startsWith('-')) {
    const add: string[] = []
    const remove: string[] = []
    for (const w of ws) {
      // `+a,b` is accepted as two groups
      const sign = w[0]
      const names = w.slice(1).split(',').map((x) => x.trim()).filter(Boolean)
      if ((sign !== '+' && sign !== '-') || !names.length) return { error: `G506 «${w}»: очікується +група або -група` }
      ;(sign === '+' ? add : remove).push(...names)
    }
    return { cmd: 'groups', add, remove }
  }
  if (head === 'profile' && ws.length === 2) {
    // Explicit form: also reaches profiles named like a subcommand (`/gate profile build`).
    if (opts.profiles && !opts.profiles.includes(ws[1])) {
      return { error: `G502 Невідомий профіль «${ws[1]}». Відомі: ${opts.profiles.join(', ') || '—'}` }
    }
    return { cmd: 'profile', profile: ws[1] }
  }
  if (head === 'why') {
    if (ws.length === 1) return { cmd: 'why' }
    if (ws.length === 2 && ws[1] === 'off') return { cmd: 'why', close: true }
    return { error: `G504 /gate why приймає лише «off», отримано «${ws.slice(1).join(' ')}»` }
  }
  if (head === 'render') {
    const ref = ws[1]
    if (!ref) return { error: 'G505 /gate render prompt://<id>: бракує id' }
    const id = ref.replace(/^prompt:\/\//, '')
    if (!id) return { error: 'G505 /gate render prompt://<id>: бракує id' }
    return { cmd: 'render', id }
  }
  if (head === 'edit') {
    const id = (ws[1] ?? '').replace(/^prompt:\/\//, '')
    if (!id) return { error: 'G505 /gate edit <id>: бракує id секції або файлу промпту' }
    if (ws.length > 2) return { error: `G504 /gate edit приймає один id, отримано «${ws.slice(1).join(' ')}»` }
    if (!/^[\w./@-]+$/.test(id) || id.split('/').includes('..')) return { error: `G505 /gate edit: невірний id «${id}»` }
    return { cmd: 'edit', id }
  }
  if (head === 'trust') {
    if (ws[1] === 'revoke' && ws.length === 2) return { cmd: 'trust', action: 'revoke' }
    return { error: `G507 Невідома дія trust «${ws.slice(1).join(' ')}». Підтримується: /gate trust revoke` }
  }
  if ((PIPE_STAGES as readonly string[]).includes(head) && !SIMPLE.has(head)) {
    const st = parseStage(s)
    if ('error' in st) return st
    return { cmd: 'pipe', stages: [st] }
  }
  if (SIMPLE.has(head)) {
    if (ws.length > 1) return { error: `G504 /gate ${head} не приймає аргументів` }
    return { cmd: head } as GateCommand
  }
  if (ws.length > 1) return { error: `G502 Невідома підкоманда «${s}»` }
  if (opts.profiles && !opts.profiles.includes(head)) {
    return { error: `G502 Невідомий профіль «${head}». Відомі: ${opts.profiles.join(', ') || '—'}` }
  }
  return { cmd: 'profile', profile: head }
}

// ───────────────────────── Prompt helpers ─────────────────────────

/** Prompt-flag words that are commands, not profiles: `[gate:off]` = `/gate off`, `[gate:auto]`, `[gate:new]`. */
export type PromptFlagAction = 'off' | 'auto' | 'new'

const FLAG_ACTIONS: readonly string[] = ['off', 'auto', 'new']

/** `[gate:frontend] fix the button` → { profile: 'frontend', text: 'fix the button' }. The name is any run of
 * non-space characters, as `/gate <name>` accepts (`[gate:фронт]`). `[gate:off|auto|new]` are commands, not
 * profiles: check `promptFlagAction(flag.profile)` before treating the word as a profile. */
export function extractPromptFlag(text: string): { profile?: string; text: string } {
  const m = /^\s*\[gate:\s*([^\]\s]+)\s*\]\s*/u.exec(text)
  if (!m) return { text }
  return { profile: m[1], text: text.slice(m[0].length) }
}

/** The command a prompt-flag word stands for (`[gate:off]` = `/gate off`, `[gate:auto]`, `[gate:new]`), or
 * undefined for a profile name. Every adapter must use this, so `[gate:off]` never pins a profile named `off`. */
export function promptFlagAction(word: string | undefined): PromptFlagAction | undefined {
  return word !== undefined && FLAG_ACTIONS.includes(word) ? (word as PromptFlagAction) : undefined
}

/** A line/column suffix of an IDE file reference: `#L10-20`, `#L5`, `#L10-L20`, `:12`, `:12:3`, `:10-20`. */
const REF_SUFFIX = /(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:-\d+)?)$/

/** `@path/with.ext` → file; bare `@id` → rule id candidate. Code spans and fences are skipped; emails are ignored. */
export function extractMentions(text: string): { files: string[]; rules: string[] } {
  const files = new Set<string>()
  const rules = new Set<string>()
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const plain = line.replace(/`[^`]*`/g, ' ')
    const re = /(^|[\s(\[{,;])@("[^"]+"|[^\s"'`()<>\[\]{},;]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(plain))) {
      let ref = m[2]
      if (ref.startsWith('"')) ref = ref.slice(1, -1)
      ref = ref.replace(/[.,;:!?]+$/, '').replace(REF_SUFFIX, '')
      if (!ref || ref.includes('@')) continue
      if (ref.includes('/') || /\.[A-Za-z0-9]+$/.test(ref)) files.add(ref.replace(/^\.\//, ''))
      else if (/^[\w-]+$/.test(ref)) rules.add(ref)
    }
  }
  return { files: [...files], rules: [...rules] }
}
