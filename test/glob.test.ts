import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileGlob, expandBraces, matchAny, normalizePath, detectWindows } from '../packages/core/src/glob.ts'

const cases: [pattern: string, path: string, expected: boolean, opts?: { nocase?: boolean; matchBase?: boolean }][] = [
  ['**/*.ts', 'a.ts', true],
  ['**/*.ts', 'src/a/b.ts', true],
  ['**/*.ts', 'src/a/b.tsx', false],
  ['*.ts', 'a.ts', true],
  ['*.ts', 'src/a.ts', false],
  ['*.ts', 'src/a.ts', true, { matchBase: true }],
  ['src/**', 'src', true],
  ['src/**', 'src/x/y.ts', true],
  ['src/**', 'srcx/y.ts', false],
  ['src/', 'src/a.ts', true],
  ['apps/web/**', 'apps/web/src/Button.tsx', true],
  ['apps/**/test/*.ts', 'apps/test/a.ts', true],
  ['apps/**/test/*.ts', 'apps/x/y/test/a.ts', true],
  ['a/**/b', 'a/b', true],
  ['?.md', 'a.md', true],
  ['?.md', 'ab.md', false],
  ['?.md', '/.md', false],
  ['*.{ts,tsx}', 'x.tsx', true],
  ['*.{ts,tsx}', 'x.js', false],
  ['src/{a,b{c,d}}/*.ts', 'src/bd/x.ts', true],
  ['src/{a,b{c,d}}/*.ts', 'src/b/x.ts', false],
  ['{src/**,lib}/x.ts', 'src/q/x.ts', true],
  ['{src/**,lib}/x.ts', 'lib/x.ts', true],
  ['file{1..3}.txt', 'file2.txt', true],
  ['file{1..3}.txt', 'file4.txt', false],
  ['{a}.ts', '{a}.ts', true],
  ['[abc].ts', 'b.ts', true],
  ['[abc].ts', 'd.ts', false],
  ['[!abc].ts', 'd.ts', true],
  ['[!abc].ts', 'a.ts', false],
  ['[a-c]x', 'bx', true],
  ['!*.ts', 'a.js', true],
  ['!*.ts', 'a.ts', false],
  ['a\\*b', 'a*b', true],
  ['a\\*b', 'axb', false],
  ['a.b', 'axb', false],
  ['(x)+', '(x)+', true],
  ['**/*.service.ts', 'apps/api/users.service.ts', true],
  ['./src/*.ts', 'src/a.ts', true],
  ['SRC/*.TS', 'src/a.ts', true, { nocase: true }],
  ['SRC/*.TS', 'src/a.ts', false],
  ['**', '.github/x.yml', true],
]

test('compileGlob table', () => {
  for (const [pattern, path, expected, opts] of cases) {
    assert.equal(compileGlob(pattern, opts)(path), expected, `${pattern} vs ${path}`)
  }
})

test('expandBraces nested', () => {
  assert.deepEqual(expandBraces('a{b,c{d,e}}f'), ['abf', 'acdf', 'acef'])
  assert.deepEqual(expandBraces('x'), ['x'])
  assert.deepEqual(expandBraces('a{b'), ['a{b'])
})

test('matchAny with negation', () => {
  const globs = ['src/**/*.ts', '!src/**/*.test.ts']
  assert.equal(matchAny('src/a.ts', globs), true)
  assert.equal(matchAny('src/a.test.ts', globs), false)
  assert.equal(matchAny('src/gen/a.ts', ['src/**/*.ts'], ['src/gen/**']), false)
  assert.equal(matchAny('lib/a.ts', globs), false)
  assert.equal(matchAny('a.ts', ['!b.ts']), false, 'only negatives never match')
})

test('normalizePath', () => {
  const rows: [string, string, string, { windows?: boolean }?][] = [
    ['./src/a.ts', '/repo', 'src/a.ts'],
    ['/repo/src/a.ts', '/repo', 'src/a.ts'],
    ['/repo/src/../lib/./a.ts', '/repo/', 'lib/a.ts'],
    ['/other/a.ts', '/repo', '/other/a.ts'],
    ['/repository/a.ts', '/repo', '/repository/a.ts'],
    ['src\\a.ts', '/repo', 'src/a.ts'],
    ['C:\\Repo\\Src\\a.ts', 'c:\\repo', 'Src/a.ts'],
    ['c:/repo/x.ts', 'C:/Repo', 'x.ts'],
    ['/Repo/x.ts', '/repo', '/Repo/x.ts'],
    ['/Repo/x.ts', '/repo', 'x.ts', { windows: true }],
    ['/repo', '/repo', ''],
    ['src//a.ts', '/repo', 'src/a.ts'],
  ]
  for (const [p, root, want, opts] of rows) assert.equal(normalizePath(p, root, opts), want, `${p} @ ${root}`)
})

test('detectWindows', () => {
  assert.equal(detectWindows('C:\\x'), true)
  assert.equal(detectWindows('/home/x'), false)
  assert.equal(detectWindows('/home/x', 'Windows_NT'), true)
})
