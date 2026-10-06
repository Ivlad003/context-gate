// Dev entry: `node packages/cli/src/build-main.ts <root> [--types] [only...]` builds prompts of a repo.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildPrompts, checkStale, generateCtxTypes } from './build.ts'
import type { GateConfig } from '../../core/src/types.ts'

const argv = process.argv.slice(2)
const root = resolve(argv.find((a) => !a.startsWith('--')) ?? '.')
const only = argv.filter((a) => !a.startsWith('--')).slice(1)

if (argv.includes('--types')) {
  const config = JSON.parse(readFileSync(join(root, '.claude/gate.json'), 'utf8')) as GateConfig
  generateCtxTypes({ root, config })
  console.log('ctx.d.ts written')
}
if (argv.includes('--stale')) {
  console.log(JSON.stringify(checkStale({ root }), null, 2))
} else {
  const t = Date.now()
  const r = await buildPrompts({ root, only: only.length ? only : undefined })
  for (const d of r.diagnostics) console.log(`${d.severity} ${d.code} ${d.path ?? ''}${d.line ? ':' + d.line : ''} ${d.message}${d.hint ? ` (${d.hint})` : ''}`)
  console.log(`built ${r.compiled.map((c) => c.id).join(', ') || 'nothing'} in ${Date.now() - t} ms; written:\n  ${r.written.join('\n  ')}`)
  if (r.diagnostics.some((d) => d.severity === 'error')) process.exitCode = 1
}
