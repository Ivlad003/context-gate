import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODES, explain } from '../packages/core/src/codes.ts'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const SCAN = ['packages', 'hooks', 'bench', 'editors/vscode/src']
const SKIP = new Set(['node_modules', 'dist', '.compiled', '.types', '.trace'])

function sources(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}

test('every diagnostic code literal in source exists in core CODES', () => {
  const missing: string[] = []
  const files = SCAN.flatMap(d => sources(join(ROOT, d)))
  assert.ok(files.length > 50, 'scanned the source tree')
  for (const f of files) {
    if (f.endsWith(join('core', 'src', 'codes.ts'))) continue
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/['"`]([GHD]\d{3})['"`]/g)) {
      if (!CODES[m[1]!]) missing.push(`${relative(ROOT, f)}: ${m[1]}`)
    }
  }
  assert.deepEqual([...new Set(missing)], [])
})

test('codes table: titles and explanations are present; explain knows every code', () => {
  for (const [code, info] of Object.entries(CODES)) {
    assert.match(code, /^[GHD]\d{3}$/)
    assert.ok(info.title && info.explain, code)
    assert.match(explain(code), new RegExp(`^${code} — `))
  }
})
