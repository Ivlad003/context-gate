// Provider helpers shared by the CLI (`cli/context.ts Providers`), the mod (`hooks/layers/host.ts`) and the
// harness adapters: the exit-code decision of `cli` providers, `pick`, loose stdout parsing, `file` values.
// Pure: no Node, no I/O.

import type { ProviderConfig, Value } from './types.ts'

/** `pick: ["a", "b.c"]` keeps only those (dotted) fields of an object value; other values pass through. */
export function pickFields(v: Value, pick: readonly string[] | undefined): Value {
  if (!pick?.length || !v || typeof v !== 'object' || Array.isArray(v)) return v
  const out: Record<string, Value> = {}
  for (const p of pick) {
    const parts = p.split('.')
    let cur: Value | undefined = v
    for (const k of parts) cur = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, Value>)[k] : undefined
    if (cur === undefined) continue
    let o = out
    for (const k of parts.slice(0, -1)) o = (o[k] ??= {}) as Record<string, Value>
    o[parts[parts.length - 1]!] = cur
  }
  return out
}

/** stdout of a provider: JSON when it parses, else the trimmed text; empty output is `null`. */
export function parseLoose(stdout: string): Value {
  const t = stdout.trim()
  if (!t) return null
  try { return JSON.parse(t) as Value } catch { return t }
}

export type ProviderResult = { ok: true; value: Value } | { ok: false; error: string }

/**
 * Whether a `cli` provider run produced data (SPEC «Провайдери»: `eslint -f json` exits 1 with valid JSON).
 * An exit code in `okExitCodes` (default `[0]`) is success and stdout is parsed loosely. Any other exit code is
 * success only with `parseOnError: true` and stdout that parses as JSON. Otherwise the result is an error (the
 * caller applies `onError`).
 */
export function providerResultOk(cfg: Pick<ProviderConfig, 'okExitCodes' | 'parseOnError'>, exitCode: number, stdout: string): ProviderResult {
  const okCodes = cfg.okExitCodes?.length ? cfg.okExitCodes : [0]
  if (okCodes.includes(exitCode)) return { ok: true, value: parseLoose(stdout) }
  if (cfg.parseOnError) {
    const t = stdout.trim()
    if (t) {
      try { return { ok: true, value: JSON.parse(t) as Value } } catch { /* not JSON */ }
    }
    return { ok: false, error: `exit ${exitCode}, stdout не є JSON (parseOnError)` }
  }
  return { ok: false, error: `exit ${exitCode}` }
}

/**
 * Value of a `file` provider from its text: `.json` is parsed (then `pick`), other files are the text itself.
 * Markdown (`{ meta, body, headings }`) is left to the caller (it needs a frontmatter parser): `markdown: true`.
 */
export function fileProviderValue(path: string, text: string, pick?: readonly string[]): { value: Value } | { error: string } | { markdown: true } {
  if (/\.json$/i.test(path)) {
    try { return { value: pickFields(JSON.parse(text) as Value, pick) } } catch (e) { return { error: `JSON: ${(e as Error).message}` } }
  }
  if (/\.mdx?$/i.test(path)) return { markdown: true }
  return { value: text }
}

/**
 * Provider data an adapter without a trust model can produce (claude-code-hooks, pi, opencode): `file`
 * providers with a `.json` or text file (Markdown: its text). `cli`, `module` and `mcp` start processes or need
 * the engine, so they give `undefined` (the caller reports `G208`). `read` gets a repo-relative path.
 */
export function staticProviderValue(cfg: { providers?: Record<string, ProviderConfig> }, name: string, read: (path: string) => string | undefined): Value | undefined {
  const p = cfg.providers?.[name]
  if (!p || p.kind !== 'file' || !p.path) return undefined
  if (/^\//.test(p.path) || p.path.split(/[\\/]/).includes('..')) return undefined
  const text = read(p.path.replace(/^\.\//, ''))
  if (text === undefined) return undefined
  const f = fileProviderValue(p.path, text, p.pick)
  return 'value' in f ? f.value : 'markdown' in f ? markdownProviderValue(text) : undefined
}

// ───────────────────────── Markdown frontmatter + Markdown file providers ─────────────────────────

function scalar(v: string): unknown {
  const s = v.trim()
  if (s === '') return ''
  if (s === 'true' || s === 'false') return s === 'true'
  if (s === 'null' || s === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== '')
  return s
}

/** Splits `---` frontmatter (lenient, no YAML library: `globs: *.ts` must survive). */
export function splitFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, unknown> = {}
  let lastKey: string | undefined
  for (const line of m[1]!.split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line)
    if (item && lastKey) {
      const cur = meta[lastKey]
      meta[lastKey] = [...(Array.isArray(cur) ? cur : cur === '' || cur === undefined ? [] : [cur]), scalar(item[1]!)]
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) { lastKey = kv[1]!; meta[lastKey] = scalar(kv[2]!) }
  }
  return { meta, body: text.slice(m[0].length) }
}

/** Markdown `file` provider value, identical in the CLI and the mod: `{ meta, body, headings }`. */
export function markdownProviderValue(text: string): Value {
  const { meta, body } = splitFrontmatter(text)
  const headings = [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({ level: m[1]!.length, text: m[2]!.trim() }))
  return { meta: JSON.parse(JSON.stringify(meta)) as Value, body, headings }
}

