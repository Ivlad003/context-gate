// G-62: features that rest on unverified probe points are listed as «не перевірено наживо».
import { describe, expect } from 'claude-code/testing'

import { PROBE_POINTS, PROBE_REQUIREMENTS, unverifiedRequirements } from './layers/probe.ts'
import { newRuntime, readOptions } from './ctx.ts'
import { RUN, mountRepo, test } from './testkit.ts'

describe('probe requirements', () => {
  test('every requirement names a known probe point', ($) => {
    void $
    for (const r of PROBE_REQUIREMENTS) for (const p of r.requires) expect(PROBE_POINTS[p.replace(/^probe:/, '')]).toBeDefined()
  })

  test('a requirement is open while any of its points is unverified; verified points close it', ($) => {
    void $
    const rt = newRuntime(readOptions({}))
    const open = unverifiedRequirements(rt).map((o) => o.feature)
    expect(open).toContain('скидання стану на /clear')
    expect(open).not.toContain('секції DSL у claude -p')
    const all = Object.fromEntries(Object.keys(PROBE_POINTS).map((k) => [k, { status: 'verified' as const }]))
    expect(unverifiedRequirements(rt, all)).toEqual([])
  })

  test('/gate health and /gate why list the unverified features in use', async ($, on) => {
    mountRepo(on, { files: { '.claude/gate.json': JSON.stringify({ groups: {}, profiles: {}, classify: { mode: 'shadow' } }) } })
    const h = await $.command.run({ command: 'gate', args: 'health', ...RUN })
    expect(h.text).toContain('Не перевірено наживо')
    expect(h.text).toContain('probe:state-after-clear')
    expect(h.text).toContain('probe:model-complete-cost')
    const why = await $.command.run({ command: 'gate', args: 'why', ...RUN })
    expect(why.text).toContain('probe:skill-listing-rewrite')
  })
})
