// Regressions from the 2026-10-06 review, core globs, .mdc rules and prompt helpers: invalid classes (M53),
// out-of-root paths (M54), quoted glob lists (M55), rule-id collisions (M41), scoped packages (L52),
// brace padding (L48), IDE line suffixes (M52), `[gate:…]` flags (M23 core part, L47), reserved names (L46).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileGlob, expandBraces, globError, isRepoRelative, matchAny } from '../packages/core/src/glob.ts'
import { autoRulesFor, expandFileRefs, loadRuleSources, parseGlobList, parseMdc, ruleIdFromPath, ruleMatches } from '../packages/core/src/mdc.ts'
import type { RuleSourceFs } from '../packages/core/src/mdc.ts'
import { extractMentions, extractPromptFlag, parseGateCommand, promptFlagAction } from '../packages/core/src/gatecmd.ts'
import { mergeDefaults } from '../packages/core/src/config.ts'

test('an invalid class range matches nothing instead of throwing; globError reports it', () => {
  for (const g of ['src/[z-a]*.ts', '[9-0]']) {
    assert.doesNotThrow(() => compileGlob(g)('src/a.ts'), g)
    assert.equal(compileGlob(g)('src/a.ts'), false, g)
    assert.doesNotThrow(() => matchAny('src/a.ts', [g, 'src/**']), g)
    assert.ok(globError(g), g)
  }
  assert.equal(globError('src/**/*.{ts,tsx}'), undefined)
  const { rule, diagnostics } = parseMdc('---\nglobs: src/[z-a]*.ts, *.md\n---\nbody', { path: '.cursor/rules/x.mdc', id: 'x' })
  assert.deepEqual(rule.globs, ['*.md'])
  assert.ok(diagnostics.some((d) => d.code === 'G016'))
  assert.doesNotThrow(() => autoRulesFor([rule], 'src/a.ts'))
})

test('glob details: zero-padded ranges, classes never match `/`, `**/**/` runs stay fast', () => {
  assert.deepEqual(expandBraces('m/{001..003}_x'), ['m/001_x', 'm/002_x', 'm/003_x'])
  assert.deepEqual(expandBraces('{1..3}'), ['1', '2', '3'])
  assert.equal(compileGlob('migrations/{001..050}_*.sql')('migrations/001_init.sql'), true)
  assert.equal(compileGlob('a[.-0]b')('a/b'), false)
  assert.equal(compileGlob('a[.-0]b')('a.b'), true)
  const deep = '**/'.repeat(8) + 'x.ts'
  const path = Array.from({ length: 30 }, (_, i) => `d${i}`).join('/') + '/y.ts'
  const t = Date.now()
  assert.equal(compileGlob(deep)(path), false)
  assert.ok(Date.now() - t < 1000, 'no exponential backtracking')
  assert.equal(compileGlob(deep)('a/b/x.ts'), true)
})

test('paths outside the repo root never match repo rules', () => {
  const rows: [string, boolean][] = [['src/a.json', true], ['a.json', true], ['/home/u/.claude/settings.json', false], ['../sib/a.json', false], ['C:/x/a.json', false], ['src/../../a.json', false], ['src/../a.json', true]]
  for (const [p, inside] of rows) assert.equal(isRepoRelative(p), inside, p)
  const rule = { globs: ['**/*.json'], negGlobs: [] as string[], type: 'auto' as const }
  assert.equal(ruleMatches(rule, '/home/u/.claude/settings.json'), false)
  assert.equal(ruleMatches(rule, '../other/package.json'), false)
  assert.equal(ruleMatches(rule, 'package.json'), true)
})

test('parseGlobList: quoted comma lists without brackets', () => {
  const rows: [string, string[]][] = [
    ['"src/**/*.ts", "test/**/*.ts"', ['src/**/*.ts', 'test/**/*.ts']],
    ["'*.ts', '*.tsx'", ['*.ts', '*.tsx']],
    ['"src/**, !src/gen/**"', ['src/**', '!src/gen/**']],
    ['*.ts, *.{js,jsx}', ['*.ts', '*.{js,jsx}']],
    ['["a/*.ts", "b/*.ts"]', ['a/*.ts', 'b/*.ts']],
  ]
  for (const [v, want] of rows) assert.deepEqual(parseGlobList(v), want, v)
  const { rule } = parseMdc('---\nglobs: "src/**/*.ts", "test/**/*.ts"\n---\nbody', { path: '.cursor/rules/x.mdc', id: 'x' })
  assert.equal(ruleMatches(rule, 'test/a.ts'), true)
})

test('rule ids: custom cursor-mdc dirs keep the subdir; nested prefixes never collide; duplicates reported', () => {
  assert.deepEqual(ruleIdFromPath('config/rules/api/x.mdc', ['config/rules']), { id: 'api/x', dirPrefix: '' })
  assert.deepEqual(ruleIdFromPath('./config/rules/x.mdc', ['./config/rules/']), { id: 'x', dirPrefix: '' })
  const files: Record<string, string> = {
    'config/rules/api/x.mdc': '---\nglobs: src/api/**\n---\napi',
    'config/rules/db/x.mdc': '---\nglobs: src/db/**\n---\ndb',
    '.cursor/rules/api/y.mdc': '---\nalwaysApply: true\n---\nroot',
    'api/.cursor/rules/y.mdc': '---\nalwaysApply: true\n---\nnested',
  }
  const fs: RuleSourceFs = {
    list(dir) {
      const pre = dir ? dir + '/' : ''
      const names = new Map<string, 'file' | 'dir'>()
      for (const p of Object.keys(files)) if (p.startsWith(pre)) { const rest = p.slice(pre.length); const [head, ...tail] = rest.split('/'); names.set(head!, tail.length ? 'dir' : 'file') }
      return [...names].map(([name, kind]) => ({ name, kind }))
    },
    read: (p) => files[p],
  }
  const cfg = mergeDefaults({ itemSources: [{ kind: 'cursor-mdc', dir: 'config/rules' }], cursorRules: { nested: true } })
  const { rules, diagnostics } = loadRuleSources(cfg, fs)
  const ids = rules.map((r) => r.id).sort()
  assert.deepEqual(ids, ['api/x', 'api/y', 'db/x'])
  assert.ok(diagnostics.some((d) => d.code === 'G001' && d.severity === 'warning' && /api\/y/.test(d.message)))
  // `api/.cursor/rules/y.mdc` → `api/y` (prefix always applied).
  assert.equal(parseMdc('body', { path: 'api/.cursor/rules/api/y.mdc', id: 'api/y', dirPrefix: 'api/' }).rule.id, 'api/api/y')
})

test('expandFileRefs: npm scopes are not file refs', () => {
  const { body, fileRefs } = expandFileRefs('Install @types/node and import from @angular/core. See @src/a.ts and @./b.md.')
  assert.deepEqual(fileRefs, ['src/a.ts', './b.md'])
  assert.match(body, /@types\/node/)
  assert.match(body, /@angular\/core/)
})

test('extractMentions: IDE line suffixes are stripped', () => {
  const r = extractMentions('fix @src/app/page.tsx#L10-20 and @Button.tsx#L5, @a/b.ts:12 @c.ts:3:4 @d.ts#L1-L9')
  assert.deepEqual(r.files, ['src/app/page.tsx', 'Button.tsx', 'a/b.ts', 'c.ts', 'd.ts'])
})

test('[gate:…] flag: any non-space name; off/auto/new are commands', () => {
  assert.deepEqual(extractPromptFlag('[gate:фронт] виправ кнопку'), { profile: 'фронт', text: 'виправ кнопку' })
  const rows: [string, string | undefined][] = [['off', 'off'], ['auto', 'auto'], ['new', 'new'], ['frontend', undefined], [undefined as unknown as string, undefined]]
  for (const [w, want] of rows) assert.equal(promptFlagAction(w), want, String(w))
})

test('/gate profile <name> reaches profiles named like subcommands', () => {
  assert.deepEqual(parseGateCommand('/gate profile build'), { cmd: 'profile', profile: 'build' })
  assert.deepEqual(parseGateCommand('/gate build'), { cmd: 'build' })
  assert.ok('error' in parseGateCommand('/gate profile nope', { profiles: ['build'] }))
})
