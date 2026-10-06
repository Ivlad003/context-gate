import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseToml, parseYaml } from '../packages/cli/src/dataformats.ts'

const ok = (r: ReturnType<typeof parseYaml>) => { assert.ok(r.ok, r.ok ? '' : `${r.error} @${r.line}`); return r.ok ? r.value : undefined }

test('parseYaml: config-like documents', () => {
  const cases: [string, string, unknown][] = [
    ['scalars', 'a: 1\nb: 1.5\nc: true\nd: null\ne: ~\nf: text here\ng: "q: \\"x\\"\\n"\nh: \'it\'\'s\'\ni: -3\nj: 0x1f\n', { a: 1, b: 1.5, c: true, d: null, e: null, f: 'text here', g: 'q: "x"\n', h: "it's", i: -3, j: 31 }],
    ['comments and doc marker', '# top\n---\na: 1 # trailing\nurl: http://x.y/#frag\n...\nignored: true\n', { a: 1, url: 'http://x.y/#frag' }],
    ['nested maps', 'db:\n  host: localhost\n  port: 5432\n  opts:\n    ssl: false\nname: x\n', { db: { host: 'localhost', port: 5432, opts: { ssl: false } }, name: 'x' }],
    ['sequences', 'list:\n  - a\n  - 2\nsame:\n- x\n- y\nnested:\n  - - 1\n    - 2\n  - [3, 4]\n', { list: ['a', 2], same: ['x', 'y'], nested: [[1, 2], [3, 4]] }],
    ['sequence of maps', 'terms:\n  - name: API\n    type: tech\n  - name: UI\n    tags: [a, "b c"]\n  -\n    late: 1\n', { terms: [{ name: 'API', type: 'tech' }, { name: 'UI', tags: ['a', 'b c'] }, { late: 1 }] }],
    ['flow map multi-line', 'm: {a: 1,\n  b: [x, y]}\n', { m: { a: 1, b: ['x', 'y'] } }],
    ['block literal', 'text: |\n  line 1\n    indented\n  line 3\nnext: 1\n', { text: 'line 1\n  indented\nline 3\n', next: 1 }],
    ['block folded strip', 'f: >-\n  a\n  b\n\n  c\n', { f: 'a b\nc' }],
    ['block keep', 'k: |+\n  a\n\nz: 1\n', { k: 'a\n\n', z: 1 }],
    ['empty value and quoted key', '"my key": v\nempty:\nlast: 1\n', { 'my key': 'v', empty: null, last: 1 }],
    ['top-level list', '- 1\n- two\n', [1, 'two']],
    ['empty document', '# nothing\n', null],
  ]
  for (const [name, src, want] of cases) assert.deepEqual(ok(parseYaml(src)), want, name)
})

test('parseYaml: unsupported or broken input is an error with a line', () => {
  const cases: [string, string, RegExp, number][] = [
    ['anchor', 'a: &x 1\nb: *x\n', /якорі/, 1],
    ['bad indent', 'a:\n  b: 1\n c: 2\n', /відступ/, 3],
    ['duplicate key', 'a: 1\na: 2\n', /повторюється/, 2],
    ['multi-doc', 'a: 1\n---\nb: 2\n', /кілька/, 2],
    ['tab indent', 'a:\n\tb: 1\n', /табуляція/, 2],
    ['unclosed string', 'a: "x\n', /незакритий/, 1],
    ['merge key', 'a:\n  <<: {b: 1}\n', /злиття/, 2],
  ]
  for (const [name, src, re, line] of cases) {
    const r = parseYaml(src)
    assert.ok(!r.ok, name)
    if (!r.ok) { assert.match(r.error, re, name); assert.equal(r.line, line, name) }
  }
})

test('parseToml: tables, arrays, strings, numbers', () => {
  const src = [
    '# config',
    'title = "TOML \\"x\\" \\u00e9"',
    "path = 'C:\\no\\escape'",
    'multi = """',
    'one',
    'two"""',
    "lit = '''",
    "raw \\n'''",
    '[owner]',
    'name = "Tom" # trailing',
    'dob = 1979-05-27T07:32:00-08:00',
    'day = 1979-05-27',
    '[database]',
    'ports = [ 8000, 8001,',
    '  8002, ]',
    'enabled = true',
    'temp = { cpu = 79.5, case = 72.0, deep.x = 1 }',
    'n = 1_000',
    'hex = 0xff',
    'oct = 0o17',
    'bin = 0b101',
    'f = -1.5e3',
    'inf = -inf',
    '[a.b]',
    'c = 1',
    '[[products]]',
    'name = "Hammer"',
    '[[products]]',
    'name = "Nail"',
    'dotted.key = "v"',
    '"quoted key" = 2',
  ].join('\n')
  const r = parseToml(src)
  assert.ok(r.ok, r.ok ? '' : `${r.error} @${r.line}`)
  assert.deepEqual(r.ok && r.value, {
    title: 'TOML "x" é', path: 'C:\\no\\escape', multi: 'one\ntwo', lit: 'raw \\n',
    owner: { name: 'Tom', dob: '1979-05-27T07:32:00-08:00', day: '1979-05-27' },
    database: { ports: [8000, 8001, 8002], enabled: true, temp: { cpu: 79.5, case: 72, deep: { x: 1 } }, n: 1000, hex: 255, oct: 15, bin: 5, f: -1500, inf: -Infinity },
    a: { b: { c: 1 } },
    products: [{ name: 'Hammer' }, { name: 'Nail', dotted: { key: 'v' }, 'quoted key': 2 }],
  })
})

test('parseToml: errors with a line', () => {
  const cases: [string, string, RegExp, number][] = [
    ['duplicate key', 'a = 1\na = 2\n', /двічі/, 2],
    ['duplicate table', '[t]\nx = 1\n[t]\n', /двічі/, 3],
    ['missing =', 'a 1\n', /«=»/, 1],
    ['bad value', 'a = nope\n', /невідоме значення/, 1],
    ['unclosed string', 'a = "x\n', /незакритий/, 1],
    ['junk after value', 'a = 1 2\n', /кінець рядка/, 1],
    ['inline table is frozen', 't = { a = 1 }\n[t]\n', /значення/, 2],
  ]
  for (const [name, src, re, line] of cases) {
    const r = parseToml(src)
    assert.ok(!r.ok, name)
    if (!r.ok) { assert.match(r.error, re, name); assert.equal(r.line, line, name) }
  }
})
