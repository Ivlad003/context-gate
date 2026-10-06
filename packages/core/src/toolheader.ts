// `# gate-tool:` script headers (SPEC «Виконавці скриптів»): the leading comment block of
// `.claude/prompt/scripts/*`. Shared by the CLI (`index`, `tools`, items) and the mod (tool registration).

import type { Diagnostic } from './types.ts'

export interface ToolHeader {
  /** `# gate-tool: <name>` */
  name: string
  description?: string
  /** JSON Schema built from `# input: { "path": "string" }` (shorthand types) or a full schema. */
  inputSchema: Record<string, unknown>
  /** `# tiers: quick, standard` */
  tiers?: string[]
  /** 1-based line of the `gate-tool` header. */
  line: number
}

const COMMENT = /^\s*(?:#|\/\/|--|;)\s?(.*)$/
const SHORTHAND = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])

function shorthandToSchema(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    const opt = v.endsWith('?')
    const t = opt ? v.slice(0, -1) : v
    if (t.endsWith('[]')) return { type: 'array', items: shorthandToSchema(t.slice(0, -2)) }
    if (t.includes('|')) return { enum: t.split('|').map((x) => x.trim()) }
    return SHORTHAND.has(t) ? { type: t } : { type: 'string', description: t }
  }
  if (Array.isArray(v)) return { type: 'array', items: v.length ? shorthandToSchema(v[0]) : {} }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.type === 'string' && (o.properties || o.items || SHORTHAND.has(o.type))) return o
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [k, x] of Object.entries(o)) {
      properties[k] = shorthandToSchema(x)
      if (!(typeof x === 'string' && x.endsWith('?'))) required.push(k)
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
  }
  return {}
}

/**
 * Parses the leading comment block of a script (after an optional shebang). Returns undefined when the
 * file has no `gate-tool:` header. Unknown keys are ignored; a bad `input:` gives a G2xx diagnostic.
 */
export function parseToolHeader(text: string): { header?: ToolHeader; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const fields: Record<string, { value: string; line: number }> = {}
  let lastKey: string | undefined
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const l = lines[i]!
    if (i === 0 && l.startsWith('#!')) continue
    if (!l.trim()) { if (Object.keys(fields).length) break; continue }
    const m = COMMENT.exec(l)
    if (!m) break
    const body = m[1]!
    const kv = /^(gate-tool|description|input|tiers)\s*:\s*(.*)$/.exec(body.trim())
    if (kv) { lastKey = kv[1]!; fields[lastKey] = { value: kv[2]!.trim(), line: i + 1 }; continue }
    // Continuation lines of a multi-line `input:` / `description:`.
    if (lastKey && (lastKey === 'input' || lastKey === 'description') && /^\s{2,}\S/.test(body)) {
      fields[lastKey]!.value += (lastKey === 'input' ? '' : ' ') + body.trim()
      continue
    }
    lastKey = undefined
  }
  const nameField = fields['gate-tool']
  if (!nameField) return { diagnostics }
  const name = nameField.value
  if (!/^[A-Za-z_][\w-]{0,63}$/.test(name)) {
    diagnostics.push({ code: 'G220', severity: 'error', message: `gate-tool: невірне ім'я інструмента «${name}»`, line: nameField.line, hint: 'латиниця, цифри, _ або -' })
    return { diagnostics }
  }
  let inputSchema: Record<string, unknown> = { type: 'object', properties: {} }
  const input = fields.input
  if (input && input.value) {
    try {
      inputSchema = shorthandToSchema(JSON.parse(input.value))
      if (inputSchema.type !== 'object') inputSchema = { type: 'object', properties: { input: inputSchema }, required: ['input'] }
    } catch (e) {
      diagnostics.push({ code: 'G221', severity: 'error', message: `gate-tool ${name}: input не є JSON (${(e as Error).message})`, line: input.line, hint: '# input: { "path": "string" }' })
    }
  }
  const tiers = fields.tiers?.value ? fields.tiers.value.split(/[\s,]+/).filter(Boolean) : undefined
  const header: ToolHeader = { name, inputSchema, line: nameField.line, ...(fields.description?.value ? { description: fields.description.value } : {}), ...(tiers?.length ? { tiers } : {}) }
  return { header, diagnostics }
}

/**
 * Function-level tools (SPEC «Функції як інструменти моделі»): every comment block of a module that holds a
 * `gate-tool: <fn>` line declares the export `<fn>` a model tool. Blocks are parsed like the leading header.
 */
export function parseToolHeaders(text: string): { headers: ToolHeader[]; diagnostics: Diagnostic[] } {
  const headers: ToolHeader[] = []
  const diagnostics: Diagnostic[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    if (!COMMENT.test(lines[i]!) || (i === 0 && lines[i]!.startsWith('#!'))) { i++; continue }
    const start = i
    while (i < lines.length && COMMENT.test(lines[i]!) && !(i === 0 && lines[i]!.startsWith('#!'))) i++
    const block = lines.slice(start, i)
    if (!block.some((l) => /^\s*(?:#|\/\/|--|;)\s?\s*gate-tool\s*:/.test(l))) continue
    const r = parseToolHeader(block.join('\n'))
    for (const d of r.diagnostics) diagnostics.push({ ...d, ...(d.line !== undefined ? { line: d.line + start } : {}) })
    if (r.header && !headers.some((h) => h.name === r.header!.name)) headers.push({ ...r.header, line: r.header.line + start })
  }
  return { headers, diagnostics }
}
