// TSX level 2 (SPEC Р1): native TS expressions in runtime positions of context-gate components are rewritten
// into expression strings of the core language before esbuild sees the file, so
//
//   <Section when={ctx.gate.profile.in(['frontend', 'backend'])}>   →  when={`gate.profile in ["frontend", "backend"]`}
//   <If test={ctx.ctx.percent > ctx.budgets.soft}>                   →  test={`ctx.percent > budgets.soft`}
//   Гілка {ctx.git.branch}.                                          →  Гілка {`{{ git.branch }}`}.
//   <Skill mode={ctx.gate.tier === 'quick' ? 'inline' : 'ref'} />    →  <If test=…><Skill mode={'inline'} /><Else><Skill mode={'ref'} /></Else></If>
//
// Only the subset the runtime interpreter can evaluate is accepted: member access on `ctx` and on runtime
// locals (parameters of `Each` callbacks over runtime lists), comparisons, `&&`/`||`/`??`/`!`, ternaries,
// arithmetic, literals, arrays, `.in([...])`/`.includes(x)`/`.at(i)`, `Math.min/max/abs/round/floor/ceil`
// and calls of provider / module functions (`ctx.fs.examples(...)`, `ctx.gitx.commitsSince(...)`). Build-time
// sub-expressions (no `ctx` inside) are folded in as literals at build time (`${__cgLit(x)}`). Everything
// else that touches `ctx` is G160 with a hint to move the logic into a provider or a pipe filter.
//
// Opt-in: `prompt.transform: "level2"` in gate.json, or a `// @context-gate level2` pragma in the file.
// The rewrite keeps every line where it was (padding newlines go inside `{…}`), so source maps, section
// source lines and diagnostics still point at the authored code. TypeScript is loaded lazily (the `typescript`
// package of the repo or of context-gate); without it a level-2 file is a build error.

import { createRequire } from 'node:module'
import { join } from 'node:path'
import type * as TS from 'typescript'
import type { Diagnostic } from '../../core/src/types.ts'

export const LEVEL2_PRAGMA = /^\s*\/\/\s*@context-gate\s+level2\b/m

/** Components whose props listed here are runtime expressions (level 1: strings). */
const EXPR_PROPS = new Set(['when', 'test', 'of', 'n', 'value', 'expr', 'rows', 'threshold', 'match'])
/** Props passed through by level 1 as-is (literal data, nested expressions handled by the component). */
const PASS_PROPS = new Set(['args', 'kwargs', 'children', 'key', 'cells', 'exprs'])
const JSX_MODULE = '@context-gate/jsx'
/** Level-1 helpers whose result already is an expression string. */
const LEVEL1_HELPERS = new Set(['e', 'expr', 'ref'])
const MATH_BUILTINS = new Set(['min', 'max', 'abs', 'round', 'floor', 'ceil'])
/** JS methods that would run on build-time proxies, not on runtime data: G160 with a pipe-filter hint. */
const JS_METHODS = new Set([
  'map', 'filter', 'reduce', 'reduceRight', 'forEach', 'join', 'slice', 'splice', 'sort', 'toSorted', 'reverse', 'concat', 'find', 'findIndex', 'findLast',
  'some', 'every', 'indexOf', 'lastIndexOf', 'flat', 'flatMap', 'keys', 'values', 'entries', 'toString', 'toUpperCase', 'toLowerCase', 'trim',
  'trimStart', 'trimEnd', 'split', 'replace', 'replaceAll', 'startsWith', 'endsWith', 'substring', 'substr', 'padStart', 'padEnd', 'repeat',
  'match', 'matchAll', 'charAt', 'toFixed', 'push', 'pop', 'shift', 'unshift', 'fill', 'with', 'localeCompare', 'normalize', 'valueOf',
])
const FILTER_HINT: Record<string, string> = { map: 'map("поле")', filter: 'where("поле", значення)', join: 'join(", ")', sort: 'sort("поле")', slice: 'take(n)', length: 'len' }

export interface TransformResult {
  code: string
  diagnostics: Diagnostic[]
  /** True when anything was rewritten. */
  changed: boolean
}

export interface TransformOptions {
  /** Repo-relative path for diagnostics. */
  path: string
}

let tsCache: { mod?: typeof TS; error?: string } | undefined

/** Loads `typescript` from the repo first, then from context-gate itself. */
export function loadTypescript(root: string): { mod?: typeof TS; error?: string } {
  if (tsCache?.mod) return tsCache
  for (const base of [join(root, 'package.json'), import.meta.url]) {
    try {
      const mod = createRequire(base)('typescript') as typeof TS
      if (mod && typeof mod.createSourceFile === 'function') { tsCache = { mod }; return tsCache }
    } catch { /* next */ }
  }
  tsCache = { error: 'TSX рівня 2 потребує пакета typescript (npm i -D typescript)' }
  return tsCache
}

export function wantsLevel2(src: string, configTransform: unknown): boolean {
  return configTransform === 'level2' || LEVEL2_PRAGMA.test(src.slice(0, 4000))
}

class Reject extends Error {
  node: TS.Node
  hint: string
  constructor(message: string, node: TS.Node, hint = 'винести у module-провайдер або pipe-фільтр') { super(message); this.node = node; this.hint = hint }
}

interface Out { s: string; p: number }

const P = { cond: 2, nullish: 3, or: 4, and: 5, eq: 6, rel: 7, add: 8, mul: 9, unary: 10, atom: 11 }

/** Escapes a string for the body of a template literal so its cooked value is the string itself. */
function tpl(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

export function transformLevel2(ts: typeof TS, src: string, opts: TransformOptions): TransformResult {
  const sf = ts.createSourceFile(opts.path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const diagnostics: Diagnostic[] = []
  const K = ts.SyntaxKind

  // Local names of @context-gate/jsx imports: local → imported name.
  const imports = new Map<string, string>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== JSX_MODULE) continue
    const nb = st.importClause?.namedBindings
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) imports.set(el.name.text, (el.propertyName ?? el.name).text)
  }
  const ctxNames = new Set([...imports].filter(([, imp]) => imp === 'ctx').map(([local]) => local))
  if (!ctxNames.size) return { code: src, diagnostics, changed: false }

  type Edit = { start: number; end: number; text: string }
  const edits: Edit[] = []
  let needIf = false
  let needLit = false

  const lineOf = (n: TS.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const reject = (e: Reject) => diagnostics.push({ code: 'G160', severity: 'error', message: `TSX рівня 2: ${e.message}`, path: opts.path, line: lineOf(e.node), hint: e.hint })

  /** Source text of [start, end) with the edits strictly inside applied. */
  const sliceWithEdits = (start: number, end: number): string => {
    const inner = edits.filter((e) => e.start >= start && e.end <= end).sort((a, b) => a.start - b.start)
    let out = ''
    let at = start
    for (const e of inner) { if (e.start < at) continue; out += src.slice(at, e.start) + e.text; at = e.end }
    return out + src.slice(at, end)
  }
  const replace = (start: number, end: number, text: string) => {
    for (let k = edits.length - 1; k >= 0; k--) if (edits[k]!.start >= start && edits[k]!.end <= end) edits.splice(k, 1)
    edits.push({ start, end, text })
  }
  /** Newlines of the original range not present in `text` (to keep line numbers). */
  const pad = (start: number, end: number, text: string) => '\n'.repeat(Math.max(0, (src.slice(start, end).match(/\n/g)?.length ?? 0) - (text.match(/\n/g)?.length ?? 0)))

  const tagName = (n: TS.JsxOpeningLikeElement): string | undefined => (ts.isIdentifier(n.tagName) ? imports.get(n.tagName.text) : undefined)

  /** Does the expression read `ctx` or a runtime local? (Property names and nested functions' own params excluded.) */
  const isRuntime = (e: TS.Node, locals: Set<string>): boolean => {
    let hit = false
    const visit = (n: TS.Node): void => {
      if (hit) return
      if (ts.isIdentifier(n)) {
        const p = n.parent
        if (p && ts.isPropertyAccessExpression(p) && p.name === n) return
        if (p && (ts.isPropertyAssignment(p) && p.name === n)) return
        if (ctxNames.has(n.text) || locals.has(n.text)) hit = true
        return
      }
      ts.forEachChild(n, visit)
    }
    visit(e)
    return hit
  }

  const isLevel1Helper = (e: TS.Expression): boolean => {
    const x = skipParens(e)
    if (ts.isTaggedTemplateExpression(x) && ts.isIdentifier(x.tag)) return LEVEL1_HELPERS.has(imports.get(x.tag.text) ?? '')
    if (ts.isCallExpression(x) && ts.isIdentifier(x.expression)) return LEVEL1_HELPERS.has(imports.get(x.expression.text) ?? '')
    return false
  }
  const skipParens = (e: TS.Expression): TS.Expression => {
    let x = e
    for (;;) {
      if (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression
      else return x
    }
  }

  /** Member path segments rooted at ctx/local (`ctx.gate.tier` → ['gate','tier']), or undefined. */
  const memberPath = (e: TS.Expression, locals: Set<string>): { root: 'ctx' | 'local'; segs: string[]; optional: boolean[] } | undefined => {
    const x = skipParens(e)
    if (ts.isIdentifier(x)) {
      if (ctxNames.has(x.text)) return { root: 'ctx', segs: [], optional: [] }
      if (locals.has(x.text)) return { root: 'local', segs: [x.text], optional: [false] }
      return undefined
    }
    if (ts.isPropertyAccessExpression(x)) {
      const base = memberPath(x.expression, locals)
      if (!base) return undefined
      return { root: base.root, segs: [...base.segs, x.name.text], optional: [...base.optional, !!x.questionDotToken] }
    }
    return undefined
  }

  /** TS expression → core expression source. Throws Reject for anything outside the subset. */
  const tr = (e: TS.Expression, locals: Set<string>): Out => {
    const x = skipParens(e)
    if (!isRuntime(x, locals)) return buildTime(x)
    if (ts.isIdentifier(x)) {
      if (ctxNames.has(x.text)) throw new Reject('`ctx` без поля не є значенням', x, 'звернись до поля: ctx.gate.tier, ctx.git.branch, …')
      return { s: x.text, p: P.atom }
    }
    if (ts.isPropertyAccessExpression(x)) {
      const obj = skipParens(x.expression)
      if (ts.isIdentifier(obj) && ctxNames.has(obj.text)) return { s: x.name.text, p: P.atom }
      const o = tr(x.expression, locals)
      return { s: `${wrap(o, P.atom)}${x.questionDotToken ? '?.' : '.'}${x.name.text}`, p: P.atom }
    }
    if (ts.isElementAccessExpression(x)) {
      const arg = skipParens(x.argumentExpression)
      // `ctx['gate']` first: translating the bare `ctx` would reject it («ctx без поля»).
      if (ts.isIdentifier(skipParens(x.expression)) && ctxNames.has((skipParens(x.expression) as TS.Identifier).text) && ts.isStringLiteralLike(arg)) return { s: arg.text, p: P.atom }
      const o = tr(x.expression, locals)
      return { s: `${wrap(o, P.atom)}[${tr(arg, locals).s}]`, p: P.atom }
    }
    if (ts.isPrefixUnaryExpression(x)) {
      const op = x.operator === K.ExclamationToken ? '!' : x.operator === K.MinusToken ? '-' : x.operator === K.PlusToken ? '+' : undefined
      if (!op) throw new Reject(`оператор ${ts.tokenToString(x.operator)} не підтримується`, x)
      const a = tr(x.operand, locals)
      return op === '+' ? a : { s: `${op}${wrap(a, P.unary)}`, p: P.unary }
    }
    if (ts.isBinaryExpression(x)) {
      const map: Partial<Record<number, [string, number]>> = {
        [K.EqualsEqualsEqualsToken]: ['==', P.eq], [K.EqualsEqualsToken]: ['==', P.eq], [K.ExclamationEqualsEqualsToken]: ['!=', P.eq], [K.ExclamationEqualsToken]: ['!=', P.eq],
        [K.LessThanToken]: ['<', P.rel], [K.LessThanEqualsToken]: ['<=', P.rel], [K.GreaterThanToken]: ['>', P.rel], [K.GreaterThanEqualsToken]: ['>=', P.rel],
        [K.PlusToken]: ['+', P.add], [K.MinusToken]: ['-', P.add], [K.AsteriskToken]: ['*', P.mul], [K.SlashToken]: ['/', P.mul], [K.PercentToken]: ['%', P.mul],
        [K.AmpersandAmpersandToken]: ['&&', P.and], [K.BarBarToken]: ['||', P.or], [K.QuestionQuestionToken]: ['??', P.nullish],
      }
      const m = map[x.operatorToken.kind]
      if (!m) throw new Reject(`оператор «${x.operatorToken.getText(sf)}» не підтримується в рантайм-виразі`, x)
      const [op, p] = m
      const l = tr(x.left, locals)
      const r = tr(x.right, locals)
      return { s: `${wrap(l, p)} ${op} ${wrap(r, p + 1)}`, p }
    }
    if (ts.isConditionalExpression(x)) {
      const t = tr(x.condition, locals)
      return { s: `${wrap(t, P.nullish)} ? ${wrap(tr(x.whenTrue, locals), P.cond)} : ${wrap(tr(x.whenFalse, locals), P.cond)}`, p: P.cond }
    }
    if (ts.isArrayLiteralExpression(x)) {
      for (const el of x.elements) if (ts.isSpreadElement(el)) throw new Reject('spread у масиві не підтримується', el)
      return { s: `[${x.elements.map((el) => tr(el, locals).s).join(', ')}]`, p: P.atom }
    }
    if (ts.isTemplateExpression(x)) {
      const parts: string[] = []
      if (x.head.text) parts.push(JSON.stringify(x.head.text))
      for (const span of x.templateSpans) {
        parts.push(wrap(tr(span.expression, locals), P.add + 1))
        if (span.literal.text) parts.push(JSON.stringify(span.literal.text))
      }
      if (!x.head.text) parts.unshift('""')
      return { s: parts.join(' + '), p: P.add }
    }
    if (ts.isCallExpression(x)) return call(x, locals)
    if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) throw new Reject('функція в рантайм-виразі', x, 'для списків — <Each of={…}>{x => …}</Each> або pipe-фільтр; інакше — module-провайдер')
    if (ts.isObjectLiteralExpression(x)) throw new Reject("об'єкт у рантайм-виразі не підтримується", x)
    if (ts.isTaggedTemplateExpression(x)) throw new Reject('тегований шаблон у рантайм-виразі', x)
    throw new Reject(`конструкція «${x.getText(sf).slice(0, 40)}» не входить у підмножину виразів`, x)
  }

  const wrap = (o: Out, min: number) => (o.p < min ? `(${o.s})` : o.s)

  /** A build-time sub-expression: literal text, or folded at build time through `__cgLit`. */
  const buildTime = (x: TS.Expression): Out => {
    if (ts.isStringLiteralLike(x)) return { s: JSON.stringify(x.text), p: P.atom }
    if (ts.isNumericLiteral(x)) return { s: String(Number(x.text)), p: P.atom }
    if (x.kind === K.TrueKeyword) return { s: 'true', p: P.atom }
    if (x.kind === K.FalseKeyword) return { s: 'false', p: P.atom }
    if (x.kind === K.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined')) return { s: 'null', p: P.atom }
    if (ts.isPrefixUnaryExpression(x) && x.operator === K.MinusToken && ts.isNumericLiteral(x.operand)) return { s: `-${Number(x.operand.text)}`, p: P.unary }
    if (ts.isArrayLiteralExpression(x) && x.elements.every((el) => !ts.isSpreadElement(el))) return { s: `[${x.elements.map((el) => buildTime(skipParens(el)).s).join(', ')}]`, p: P.atom }
    needLit = true
    return { s: `\u0000\${__cgLit(${x.getText(sf)})}\u0000`, p: P.atom }
  }

  const call = (x: TS.CallExpression, locals: Set<string>): Out => {
    const callee = skipParens(x.expression)
    const args = () => x.arguments.map((a) => {
      if (ts.isSpreadElement(a)) throw new Reject('spread в аргументах не підтримується', a)
      return tr(a, locals).s
    })
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text
      const obj = callee.expression
      // Math.min(...) & co. → builtins.
      if (ts.isIdentifier(obj) && obj.text === 'Math' && MATH_BUILTINS.has(name)) return { s: `${name}(${args().join(', ')})`, p: P.atom }
      const objRuntime = isRuntime(obj, locals)
      if (objRuntime && name === 'in') {
        if (x.arguments.length !== 1) throw new Reject('.in() приймає один аргумент (список)', x)
        return { s: `${wrap(tr(obj, locals), P.rel + 1)} in ${wrap(tr(x.arguments[0]!, locals), P.rel + 1)}`, p: P.rel }
      }
      if (name === 'includes' && x.arguments.length === 1 && (objRuntime || isRuntime(x.arguments[0]!, locals))) {
        return { s: `${wrap(tr(x.arguments[0]!, locals), P.rel + 1)} in ${wrap(tr(obj, locals), P.rel + 1)}`, p: P.rel }
      }
      if (objRuntime && name === 'at') {
        if (x.arguments.length !== 1) throw new Reject('.at() приймає один аргумент', x)
        return { s: `${wrap(tr(obj, locals), P.atom)}.at(${args()[0]})`, p: P.atom }
      }
      const path = memberPath(callee, locals)
      if (path && path.root === 'ctx' && path.segs.length >= 2 && !path.optional.some(Boolean) && !JS_METHODS.has(name)) {
        return { s: `${path.segs.join('.')}(${args().join(', ')})`, p: P.atom }
      }
      if (objRuntime) {
        const hint = FILTER_HINT[name] ? `використай pipe-фільтр: ${obj.getText(sf)} | ${FILTER_HINT[name]} — або module-провайдер` : 'pipe-фільтр (take, sort, grep, map, join, where, len, …) або module-провайдер'
        throw new Reject(`метод .${name}() над рантайм-значенням обчислився б на збірці`, x, hint)
      }
    }
    throw new Reject(`виклик «${callee.getText(sf).slice(0, 40)}(…)» з рантайм-аргументами (змішування збірки й рантайму)`, x, 'перенеси обчислення у module-провайдер або використай pipe-фільтр (ctx.commits | sort("date"))')
  }

  /** Final template-literal text for an expression source (with `__cgLit` holes). */
  const toTemplate = (s: string, wrapPlaceholder: boolean): string => {
    const body = s.split('\u0000').map((part, k) => (k % 2 === 1 ? part : tpl(part))).join('')
    return '`' + (wrapPlaceholder ? `{{ ${body} }}` : body) + '`'
  }

  /** `cond ? A : B` / `cond && A` with a runtime condition and build-time / JSX branches → If/Else markup. */
  const liftConditional = (e: TS.Expression, locals: Set<string>): { head: string; tail: string } | undefined => {
    const x = skipParens(e)
    let cond: TS.Expression, a: TS.Expression, b: TS.Expression | undefined
    if (ts.isConditionalExpression(x)) { cond = x.condition; a = x.whenTrue; b = x.whenFalse }
    else if (ts.isBinaryExpression(x) && x.operatorToken.kind === K.AmpersandAmpersandToken) { cond = x.left; a = x.right }
    else return undefined
    if (!isRuntime(cond, locals)) return undefined
    const branchOk = (y: TS.Expression | undefined) => !y || !isRuntime(y, locals) || ts.isJsxElement(skipParens(y)) || ts.isJsxSelfClosingElement(skipParens(y)) || ts.isJsxFragment(skipParens(y))
    if (!branchOk(a) || !branchOk(b)) return undefined
    const test = tr(cond, locals).s
    const branch = (y: TS.Expression | undefined): string => {
      if (!y) return ''
      const z = skipParens(y)
      if (z.kind === K.NullKeyword || z.kind === K.FalseKeyword || (ts.isIdentifier(z) && z.text === 'undefined')) return ''
      if (ts.isJsxElement(z) || ts.isJsxSelfClosingElement(z) || ts.isJsxFragment(z)) return sliceWithEdits(z.getStart(sf), z.end)
      return `{${sliceWithEdits(z.getStart(sf), z.end)}}`
    }
    needIf = true
    const els = b ? branch(b) : ''
    return { head: `<__cgIf test={${toTemplate(test, false)}`, tail: `}>${branch(a)}${els ? `<__cgElse>${els}</__cgElse>` : ''}</__cgIf>` }
  }

  const visit = (n: TS.Node, locals: Set<string>): void => {
    // Each over a runtime list: the callback's parameters are runtime locals in its body.
    if (ts.isJsxElement(n) && tagName(n.openingElement) === 'Each') {
      const ofAttr = attr(n.openingElement, 'of')
      const ofRuntime = !!ofAttr && (ofAttr.initializer === undefined || ts.isStringLiteral(ofAttr.initializer) || (ts.isJsxExpression(ofAttr.initializer) && !!ofAttr.initializer.expression && isRuntime(ofAttr.initializer.expression, locals)))
      visit(n.openingElement, locals)
      for (const c of n.children) {
        if (ts.isJsxExpression(c) && c.expression && (ts.isArrowFunction(skipParens(c.expression)) || ts.isFunctionExpression(skipParens(c.expression)))) {
          const fn = skipParens(c.expression) as TS.ArrowFunction | TS.FunctionExpression
          const inner = new Set(locals)
          if (ofRuntime) {
            for (const p of fn.parameters) {
              if (ts.isIdentifier(p.name)) inner.add(p.name.text)
              else reject(new Reject('деструктуризація параметра <Each> над рантайм-списком', p, 'звертайся до полів: {r => r.name}'))
            }
            // Rewritten strings name the parameters as authored; pin them (the bundler may rename parameters).
            const tagEnd = n.openingElement.tagName.end
            const names = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''))
            if (names[0] && !attr(n.openingElement, 'as')) edits.push({ start: tagEnd, end: tagEnd, text: ` as=${JSON.stringify(names[0])}` })
            if (names[1] && !attr(n.openingElement, 'index')) edits.push({ start: tagEnd, end: tagEnd, text: ` index=${JSON.stringify(names[1])}` })
          }
          visit(fn.body, inner)
        } else visit(c, locals)
      }
      visit(n.closingElement, locals)
      return
    }
    if (ts.isJsxElement(n)) {
      // Children first: a prop lifted into If/Else re-emits the element with its rewritten children.
      for (const c of n.children) visit(c, locals)
      visit(n.openingElement, locals)
      return
    }
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      jsxAttrs(n, locals)
      return
    }
    if (ts.isJsxExpression(n) && n.expression && n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      const e = n.expression
      ts.forEachChild(e, (c) => visit(c, locals))
      if (ts.isArrowFunction(skipParens(e)) || ts.isFunctionExpression(skipParens(e))) return
      if (!isRuntime(e, locals) || isLevel1Helper(e)) return
      const start = n.getStart(sf)
      try {
        const lifted = liftConditional(e, locals)
        if (lifted !== undefined) { replace(start, n.end, lifted.head + pad(start, n.end, lifted.head + lifted.tail) + lifted.tail); return }
        const s = tr(e, locals).s
        const text = `{${toTemplate(s, true)}${pad(start, n.end, '')}}`
        replace(start, n.end, text)
      } catch (err) {
        if (!(err instanceof Reject)) throw err
        reject(err)
        // Neutralize the rejected expression so the build does not report its JS evaluation again.
        replace(start, n.end, `{${JSON.stringify('')}${pad(start, n.end, '')}}`)
      }
      return
    }
    ts.forEachChild(n, (c) => visit(c, locals))
  }

  const attr = (el: TS.JsxOpeningLikeElement, name: string): TS.JsxAttribute | undefined =>
    el.attributes.properties.find((p): p is TS.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name)

  const jsxAttrs = (el: TS.JsxOpeningLikeElement, locals: Set<string>): void => {
    const comp = tagName(el)
    let liftable: { a: TS.JsxAttribute; cond: TS.ConditionalExpression } | undefined
    for (const p of el.attributes.properties) {
      if (!ts.isJsxAttribute(p) || !p.initializer || !ts.isJsxExpression(p.initializer) || !p.initializer.expression) {
        if (ts.isJsxSpreadAttribute(p)) visit(p.expression, locals)
        continue
      }
      const name = ts.isIdentifier(p.name) ? p.name.text : ''
      const e = p.initializer.expression
      ts.forEachChild(e, (c) => visit(c, locals))
      if (!comp || !isRuntime(e, locals) || isLevel1Helper(e)) continue
      try {
        if (EXPR_PROPS.has(name)) {
          if (ts.isArrowFunction(skipParens(e))) continue
          const start = p.initializer.getStart(sf)
          let s: string
          try { s = tr(e, locals).s } catch (err) {
            if (!(err instanceof Reject)) throw err
            reject(err)
            replace(start, p.initializer.end, `{"null"${pad(start, p.initializer.end, '')}}`)
            continue
          }
          replace(start, p.initializer.end, `{${toTemplate(s, false)}${pad(start, p.initializer.end, '')}}`)
          continue
        }
        if (PASS_PROPS.has(name)) continue
        const x = skipParens(e)
        if (memberPath(x, locals)) continue // a plain path: level 1 references handle it (`title={ex.path}`)
        if (ts.isConditionalExpression(x) && !isRuntime(x.whenTrue, locals) && !isRuntime(x.whenFalse, locals)) {
          if (liftable) throw new Reject(`<${comp}>: кілька пропсів з рантайм-умовою`, x, 'розбий на <If>/<Else> вручну')
          liftable = { a: p, cond: x }
          continue
        }
        throw new Reject(`<${comp} ${name}={…}>: проп «${name}» не є рантайм-виразом`, x, `для умовного значення — тернарний вираз із константами (${name}={ctx.gate.tier === 'quick' ? 'a' : 'b'}) або <If>`)
      } catch (err) {
        if (err instanceof Reject) reject(err)
        else throw err
      }
    }
    if (liftable) {
      // Re-emit the whole element twice with the prop fixed to each branch, under If/Else.
      const owner = ts.isJsxOpeningElement(el) ? el.parent : el
      const start = owner.getStart(sf)
      const init = liftable.a.initializer!
      const before = sliceWithEdits(start, init.getStart(sf))
      const after = sliceWithEdits(init.end, owner.end)
      const a = `${before}{${liftable.cond.whenTrue.getText(sf)}}${after}`
      const b = `${before}{${liftable.cond.whenFalse.getText(sf)}}${after}`
      try {
        const test = tr(liftable.cond.condition, locals).s
        needIf = true
        const head = `<__cgIf test={${toTemplate(test, false)}`
        const body = `}>${a.replace(/\n/g, ' ')}<__cgElse>${b.replace(/\n/g, ' ')}</__cgElse></__cgIf>`
        replace(start, owner.end, `${head}${pad(start, owner.end, '')}${body}`)
      } catch (err) {
        if (err instanceof Reject) reject(err)
        else throw err
      }
    }
  }

  visit(sf, new Set())
  if (!edits.length) return { code: src, diagnostics, changed: false }
  let code = sliceWithEdits(0, src.length)
  const inject: string[] = []
  if (needIf) inject.push('If as __cgIf', 'Else as __cgElse')
  if (needLit) inject.push('exprLiteral as __cgLit')
  // Same first line: line numbers of the file stay intact.
  if (inject.length) code = `import { ${inject.join(', ')} } from '${JSX_MODULE}';` + code
  return { code, diagnostics, changed: true }
}
