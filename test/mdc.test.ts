import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMdc, parseGlobList, ruleToItem, transpileAgentRule, transpileRuleToClaudeRule, frameRule, packInjections, isPartialRead, ruleIdFromPath, expandFileRefs, ruleMatches, autoRulesFor } from '../packages/core/src/mdc.ts'
import type { MdcRule, RuleType } from '../packages/core/src/types.ts'

const p = (text: string, dirPrefix?: string) => parseMdc(text, { path: '.cursor/rules/x.mdc', id: 'x', dirPrefix })

test('type classification table', () => {
  const rows: [string, RuleType][] = [
    ['---\nalwaysApply: true\n---\nbody', 'always'],
    ['---\nalwaysApply: true\nglobs: *.ts\ndescription: d\n---\nbody', 'always'],
    ['---\nglobs: *.ts\nalwaysApply: false\n---\nbody', 'auto'],
    ['---\nglobs: *.ts\ndescription: d\n---\nbody', 'auto'],
    ['---\ndescription: Use for API work\n---\nbody', 'agent'],
    ['---\ndescription:\nglobs:\nalwaysApply: false\n---\nbody', 'manual'],
    ['just a body, no frontmatter', 'manual'],
  ]
  for (const [text, type] of rows) assert.equal(p(text).rule.type, type, text)
})

test('globs forms', () => {
  const rows: [string, string[], string[]][] = [
    ['globs: *.ts', ['*.ts'], []],
    ['globs: *.ts, *.tsx', ['*.ts', '*.tsx'], []],
    ['globs: src/{a,b}/**, *.md', ['src/{a,b}/**', '*.md'], []],
    ['globs: ["a/**", "b/*.ts"]', ['a/**', 'b/*.ts'], []],
    ["globs: ['x/{c,d}.ts', 'y']", ['x/{c,d}.ts', 'y'], []],
    ['globs:\n  - "src/**"\n  - lib/*.ts\n  - !lib/gen/**', ['src/**', 'lib/*.ts'], ['lib/gen/**']],
    ['globs: src/**, !src/**/*.test.ts', ['src/**'], ['src/**/*.test.ts']],
    ['globs: "*.ts" # comment', ['*.ts'], []],
  ]
  for (const [fm, globs, neg] of rows) {
    const { rule } = p(`---\n${fm}\n---\nbody`)
    assert.deepEqual(rule.globs, globs, fm)
    assert.deepEqual(rule.negGlobs, neg, fm)
  }
  assert.deepEqual(parseGlobList('a,{b,c},d'), ['a', '{b,c}', 'd'])
})

test('BOM and CRLF', () => {
  const { rule } = p('﻿---\r\ndescription: "Quoted: desc"\r\nglobs: *.ts\r\nalwaysApply: false\r\n---\r\nline1\r\nline2\r\n')
  assert.equal(rule.description, 'Quoted: desc')
  assert.deepEqual(rule.globs, ['*.ts'])
  assert.equal(rule.body, 'line1\nline2')
  assert.equal(rule.type, 'auto')
})

test('description quoting', () => {
  assert.equal(p("---\ndescription: 'it''s'\n---\n").rule.description, "it's")
  assert.equal(p('---\ndescription: plain text here\n---\n').rule.description, 'plain text here')
  assert.equal(p('---\ndescription: >\n  folded line one\n  two\n---\n').rule.description, 'folded line one two')
})

test('diagnostics: unterminated, unknown key, bad alwaysApply, empty glob', () => {
  const unterminated = p('---\ndescription: x\nbody')
  assert.equal(unterminated.rule.type, 'manual')
  assert.ok(unterminated.diagnostics.some((d) => d.code === 'G010'))
  const d = p('---\nfoo: 1\nalwaysApply: maybe\nglobs: a,,b\n---\n').diagnostics.map((x) => x.code)
  assert.ok(d.includes('G011') && d.includes('G012') && d.includes('G013'))
  assert.ok(p('---\nglobs: !a\n---\n').diagnostics.some((x) => x.code === 'G015'))
})

test('nested dir prefix', () => {
  const { rule } = p('---\nglobs: src/**, *.ts, !src/gen/**\n---\nb', 'packages/api')
  assert.equal(rule.id, 'packages/api/x')
  assert.deepEqual(rule.globs, ['packages/api/src/**', 'packages/api/**/*.ts'])
  assert.deepEqual(rule.negGlobs, ['packages/api/src/gen/**'])
  assert.deepEqual(ruleIdFromPath('packages/api/.cursor/rules/db/x.mdc'), { id: 'db/x', dirPrefix: 'packages/api/' })
  assert.deepEqual(ruleIdFromPath('.cursor/rules/react.mdc'), { id: 'react', dirPrefix: '' })
})

test('@file references', () => {
  const body = 'Follow the template:\n@templates/service.ts\nSee also @docs/api.md, and email a@b.com.\n```\n@not/a/ref.ts\n```\n`@code.ts` stays'
  const r = expandFileRefs(body)
  assert.deepEqual(r.fileRefs, ['templates/service.ts', 'docs/api.md'])
  assert.match(r.body, /^див\. файл templates\/service\.ts$/m)
  assert.match(r.body, /See also див\. файл docs\/api\.md, and/)
  assert.match(r.body, /a@b\.com/)
  assert.match(r.body, /@not\/a\/ref\.ts/)
  assert.match(r.body, /`@code\.ts`/)
  const { rule } = p('---\nalwaysApply: true\n---\n@x/y.ts')
  assert.deepEqual(rule.fileRefs, ['x/y.ts'])
})

const rule = (over: Partial<MdcRule>): MdcRule => ({ id: 'r', path: '.cursor/rules/r.mdc', type: 'auto', globs: ['src/**'], negGlobs: ['src/gen/**'], alwaysApply: false, body: 'BODY', fileRefs: [], ...over })

test('ruleToItem', () => {
  const it = ruleToItem(rule({}))
  assert.equal(it.id, 'rule:r')
  assert.equal(it.attach.when, 'paths')
  assert.deepEqual(it.attach.globs, ['src/**', '!src/gen/**'])
  assert.equal(it.cost.chars, 4)
  assert.equal(it.ruleType, 'auto')
  assert.equal(ruleToItem(rule({ type: 'always' })).attach.when, 'always')
  assert.equal(ruleToItem(rule({ type: 'agent' })).attach.when, 'on-demand')
  assert.equal(ruleToItem(rule({ type: 'manual' })).attach.when, 'manual')
})

test('transpile', () => {
  const skill = transpileAgentRule(rule({ type: 'agent', id: 'db/migrations', description: 'Use for DB: migrations' }))
  assert.match(skill, /^---\nname: cursor-db-migrations\ndescription: "Use for DB: migrations"\n---\n/)
  assert.match(skill, /BODY\n$/)
  assert.match(transpileAgentRule(rule({ type: 'manual' })), /disable-model-invocation: true/)
  const auto = transpileRuleToClaudeRule(rule({}))!
  assert.match(auto, /^---\npaths:\n {2}- "src\/\*\*"\n---\n/)
  assert.match(auto, /src\/gen\/\*\*/)
  assert.ok(!/^---/.test(transpileRuleToClaudeRule(rule({ type: 'always' }))!))
  assert.equal(transpileRuleToClaudeRule(rule({ type: 'agent' })), undefined)
})

test('frameRule and packInjections', () => {
  assert.equal(frameRule(rule({})), 'Contents of .cursor/rules/r.mdc (Cursor rule r):\nBODY')
  const rules = [rule({ id: 'a', path: 'a.mdc', body: 'x'.repeat(50) }), rule({ id: 'b', path: 'b.mdc', body: 'y'.repeat(500) }), rule({ id: 'c', path: 'c.mdc', body: 'z' })]
  const packed = packInjections(rules, 200)
  assert.deepEqual(packed.included, ['a', 'c'])
  assert.deepEqual(packed.deferred, ['b'])
  assert.match(packed.text, /також діє: b\.mdc, прочитай за потреби$/)
  assert.ok(!packed.text.includes('yyy'))
})

test('isPartialRead', () => {
  assert.equal(isPartialRead({ file_path: 'a' }), false)
  assert.equal(isPartialRead({ file_path: 'a', offset: 10 }), true)
  assert.equal(isPartialRead({ file_path: 'a', limit: 0 }), true)
  assert.equal(isPartialRead(null), false)
})

const ruleOf = (globs: string, dirPrefix?: string): MdcRule => parseMdc(`---\nglobs: ${globs}\nalwaysApply: false\n---\nbody`, { path: 'x.mdc', id: 'x', ...(dirPrefix ? { dirPrefix } : {}) }).rule

for (const [name, globs, prefix, path, nocase, want] of [
  ['slash-less glob matches basename at root', '*.ts', undefined, 'a.ts', false, true],
  ['slash-less glob matches basename at depth', '*.ts', undefined, 'src/deep/a.ts', false, true],
  ['slash-less glob: other extension', '*.ts', undefined, 'src/a.tsx', false, false],
  ['path glob anchors at root', 'src/**/*.ts', undefined, 'lib/src/a.ts', false, false],
  ['path glob', 'src/**/*.ts', undefined, 'src/x/a.ts', false, true],
  ['negation excludes', '"src/**, !src/gen/**"', undefined, 'src/gen/a.ts', false, false],
  ['negation leaves others', '"src/**, !src/gen/**"', undefined, 'src/a.ts', false, true],
  ['negation of slash-less', '"*.ts, !*.d.ts"', undefined, 'types/x.d.ts', false, false],
  ['nested prefix: slash-less under the dir', '*.ts', 'packages/api/', 'packages/api/src/a.ts', false, true],
  ['nested prefix: outside the dir', '*.ts', 'packages/api/', 'packages/web/a.ts', false, false],
  ['nested prefix: path glob', 'src/*.ts', 'packages/api/', 'packages/api/src/a.ts', false, true],
  ['case-sensitive by default', '*.TS', undefined, 'a.ts', false, false],
  ['nocase (Windows)', '*.TS', undefined, 'src/a.ts', true, true],
  ['leading ./ and backslashes tolerated', 'src/**/*.ts', undefined, '.\\src\\a.ts', false, true],
] as const) {
  test(`ruleMatches: ${name}`, () => assert.equal(ruleMatches(ruleOf(globs, prefix), path, { nocase }), want))
}

test('autoRulesFor: only Auto Attached rules', () => {
  const auto = ruleOf('*.ts')
  const always = parseMdc('---\nglobs: *.ts\nalwaysApply: true\n---\nb', { path: 'y.mdc', id: 'y' }).rule
  assert.deepEqual(autoRulesFor([auto, always], 'src/a.ts').map((r) => r.id), ['x'])
})
