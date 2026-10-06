// Pure helpers of the Markdown DSL and `.mdc` providers (no `vscode`): directive completions and docs,
// document symbols of a Markdown section, `.mdc` diagnostics (core parseMdc, G010–G015) and rule-type hover.

import { parseMdc, classifyRule } from '../../../packages/core/src/mdc.ts'
import type { Diagnostic } from '../../../packages/core/src/types.ts'

export interface DirectiveDoc { name: string; snippet: string; doc: string }

/** `@`-directives of the Markdown form (core mddsl.ts DIRECTIVES), with insert snippets (VS Code syntax). */
export const DIRECTIVES: DirectiveDoc[] = [
  { name: 'if', snippet: 'if ${1:умова}\n$0\n@end', doc: 'Умова: `@if expr` … `@elif expr` … `@else` … `@end`.' },
  { name: 'elif', snippet: 'elif ${1:умова}', doc: 'Наступна гілка `@if`.' },
  { name: 'else', snippet: 'else', doc: 'Інакше (`@else if expr` — те саме, що `@elif`).' },
  { name: 'end', snippet: 'end', doc: 'Закриває `@if`, `@each`, `@repeat`, `@tier`, `@fn`, `@run`.' },
  { name: 'each', snippet: 'each ${1:r} in ${2:cursor.always}\n$0\n@end', doc: 'Цикл: `@each x[, i] in список` … `@end`.' },
  { name: 'repeat', snippet: 'repeat ${1:3}\n$0\n@end', doc: 'Повтор n разів; `i` — номер.' },
  { name: 'let', snippet: 'let ${1:name} = ${2:expr}', doc: 'Локальна змінна секції.' },
  { name: 'set', snippet: 'set ${1:name} = ${2:expr}', doc: 'Перезапис змінної.' },
  { name: 'break', snippet: 'break', doc: 'Вихід із циклу.' },
  { name: 'continue', snippet: 'continue', doc: 'Наступна ітерація циклу.' },
  { name: 'store', snippet: 'store ${1:name}', doc: 'Зберегти значення між рендерами (`to=ключ`).' },
  { name: 'run', snippet: 'run ${1:bash} cache=${2:5m} as=${3:out}\n$0\n@end', doc: 'Інлайн-скрипт (лише з білого списку, після довіри до репозиторію); результат у `as`.' },
  { name: 'call', snippet: 'call ${1:ns.fn}(${2}) as ${3:x}', doc: 'Виклик функції модуля з `@use`.' },
  { name: 'use', snippet: 'use ${1:ns} ${2:./scripts/mod.ts}', doc: 'Підключити модуль функцій під простором імен.' },
  { name: 'include', snippet: 'include ${1:docs/file.md} ${2|inline,ref,lazy|}', doc: 'Вставити файл: `inline`, `ref` (посилання) або `lazy` (за потреби).' },
  { name: 'section', snippet: 'section ${1:id} ${2|inline,ref,lazy|}', doc: 'Вставити іншу секцію за id.' },
  { name: 'skill', snippet: 'skill ${1:name} ${2|ref,inline,lazy|}', doc: 'Skill як посилання або інлайн.' },
  { name: 'rule', snippet: 'rule ${1:id} ${2|ref,inline,lazy|}', doc: 'Правило Cursor за id.' },
  { name: 'mcp', snippet: 'mcp ${1:server.tool}(${2:k=v}) as ${3:x}', doc: 'Виклик MCP-інструмента (іменовані аргументи).' },
  { name: 'lazy', snippet: 'lazy ${1:name} ${2:path} "${3:опис}"', doc: 'Застаріла форма (G180): `@include <шлях> lazy`.' },
  { name: 'tier', snippet: 'tier ${1:quick}\n$0\n@end', doc: 'Блок лише для перелічених tiers.' },
  { name: 'fn', snippet: 'fn ${1:name}(${2:a})\n$0\n@end', doc: 'Локальна функція-шаблон; виклик `@name(арг)`.' },
  { name: 'debug', snippet: 'debug ${1:expr}', doc: 'Значення виразів у `.claude/gate.debug.log` (за `debug: true`).' },
  { name: 'assert', snippet: 'assert ${1:умова}, "${2:повідомлення}"', doc: 'Перевірка під час рендера.' },
  { name: 'log', snippet: 'log ${1:повідомлення} level=${2|info,warn,error|}', doc: 'Рядок у журнал рендера.' },
  { name: 'trace', snippet: 'trace ${1|on,off|}', doc: 'Увімкнути / вимкнути trace для блоку.' },
]

const BY_NAME = new Map(DIRECTIVES.map((d) => [d.name, d]))

export function directiveDoc(name: string): DirectiveDoc | undefined {
  return BY_NAME.get(name)
}

/** Cursor right after `@name-prefix` at the start of a line (outside frontmatter): the prefix range, else undefined. */
export function directivePrefixAt(lineText: string, col: number): { start: number; prefix: string } | undefined {
  const before = lineText.slice(0, col)
  const m = /^(\s*)@([A-Za-z_-]*)$/.exec(before)
  return m ? { start: m[1]!.length + 1, prefix: m[2]! } : undefined
}

/** `@tier <names>` position: tier-name completion after the directive. */
export function tierListAt(lineText: string, col: number): boolean {
  return /^\s*@tier(\s+[\w-]+,?)*\s+[\w-]*$/.test(lineText.slice(0, col))
}

/** `@word` at a column (for hover). */
export function directiveAt(lineText: string, col: number): { name: string; start: number; end: number } | undefined {
  const m = /^(\s*)@([A-Za-z_][\w-]*)/.exec(lineText)
  if (!m) return undefined
  const start = m[1]!.length
  const end = start + 1 + m[2]!.length
  return col >= start && col <= end ? { name: m[2]!, start, end } : undefined
}

export interface MdSymbol { name: string; detail: string; kind: 'section' | 'block' | 'function' | 'variable'; line: number; endLine: number; children: MdSymbol[] }

/** Outline of a Markdown section: the section (frontmatter `id` or file name) with its blocks and names. */
export function markdownSymbols(text: string, fileName: string): MdSymbol[] {
  const lines = text.split('\n')
  let i = 0
  let id = (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.md$/, '')
  let scope = ''
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---')
    if (end > 0) {
      for (let k = 1; k < end; k++) {
        const m = /^(id|scope):\s*["']?([^"'\n]*?)["']?\s*$/.exec(lines[k]!)
        if (m?.[1] === 'id' && m[2]) id = m[2]
        if (m?.[1] === 'scope') scope = m[2] ?? ''
      }
      i = end + 1
    }
  }
  const root: MdSymbol = { name: id, detail: scope ? `секція (${scope})` : 'секція', kind: 'section', line: 0, endLine: Math.max(0, lines.length - 1), children: [] }
  const stack: MdSymbol[] = [root]
  let inFence = false
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim()
    if (/^(```|~~~)/.test(t)) inFence = !inFence
    if (inFence) continue
    const m = /^@([A-Za-z_][\w-]*)\s*(.*)$/.exec(t)
    if (!m) continue
    const [, name, rest] = m as unknown as [string, string, string]
    const top = stack[stack.length - 1]!
    if (name === 'end') { if (stack.length > 1) { stack.pop()!.endLine = i } continue }
    if (['if', 'each', 'repeat', 'tier', 'fn', 'run'].includes(name)) {
      const s: MdSymbol = { name: name === 'fn' ? (/^[\w-]+/.exec(rest)?.[0] ?? 'fn') : `@${name} ${rest}`.trim(), detail: name === 'fn' ? `@fn ${rest}` : '', kind: name === 'fn' ? 'function' : 'block', line: i, endLine: i, children: [] }
      top.children.push(s)
      stack.push(s)
      continue
    }
    if (name === 'let' || name === 'set' || name === 'use') {
      const v = /^([A-Za-z_][\w-]*)/.exec(rest)
      if (v) top.children.push({ name: v[1]!, detail: `@${name} ${rest}`, kind: 'variable', line: i, endLine: i, children: [] })
    }
  }
  return [root]
}

/** `.mdc` diagnostics of core `parseMdc` (G010–G015), 1-based lines. */
export function mdcDiagnostics(text: string, relPath: string): Diagnostic[] {
  const id = (relPath.split('/').pop() ?? relPath).replace(/\.mdc$/, '')
  return parseMdc(text, { path: relPath, id }).diagnostics
}

const TYPE_TEXT: Record<string, string> = {
  always: '**Always** — у контексті кожної сесії (`alwaysApply: true`).',
  auto: '**Auto Attached** — підключається, коли модель читає / пише файл, що збігається з `globs`.',
  agent: '**Agent Requested** — модель бачить опис і читає правило за потреби (`description` без globs).',
  manual: '**Manual** — лише за згадкою `@назва` у промпті.',
}

/** Hover for the frontmatter of an `.mdc`: the rule type and its trigger. */
export function mdcHover(text: string, relPath: string): string {
  const id = (relPath.split('/').pop() ?? relPath).replace(/\.mdc$/, '')
  const { rule } = parseMdc(text, { path: relPath, id })
  const type = classifyRule(rule)
  const lines = [`context-gate: правило \`${rule.id}\``, '', TYPE_TEXT[type] ?? type]
  if (rule.globs.length) lines.push('', `globs: ${rule.globs.map((g) => `\`${g}\``).join(', ')}`)
  if (rule.negGlobs.length) lines.push(`виключено: ${rule.negGlobs.map((g) => `\`!${g}\``).join(', ')}`)
  if (rule.description) lines.push('', `опис: ${rule.description}`)
  return lines.join('\n')
}

/** 0-based line range of the frontmatter block (`---` … `---`), or undefined. */
export function frontmatterLines(text: string): [number, number] | undefined {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---')
  return [0, end < 0 ? lines.length - 1 : end]
}
