// Runs under `claude plugin test .` (the engine's own host, no Node).
import { describe, expect } from 'claude-code/testing'

import { test } from './testkit.ts'

import { bandLine } from './register.ts'

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
} as const

const RUN = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

describe('context-gate core', () => {
  test('bandLine fills dashes for an empty state', () => {
    expect(bandLine({ profile: null, tier: null, ctx: null })).toBe('gate — · tier — · ctx —%')
    expect(bandLine({ profile: undefined, proposed: 'frontend', tier: 'standard', ctx: 38 })).toBe(
      'gate (frontend?) · tier standard · ctx 38%',
    )
  })

  test('session.start registers /gate and /rule', async ($, on) => {
    const names: string[] = []
    on('command.register', ($, e) => {
      names.push(e.name)
      return { value: { command: e.name } }
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(names).toEqual(['gate', 'rule'])
  })

  test('/gate answers the status line with no decision yet', async $ => {
    const { text } = await $.command.run({ command: 'gate', ...RUN })
    expect(text).toContain('gate — · tier — · ctx —%')
  })

  test('/rule without an id prints usage', async $ => {
    const { text } = await $.command.run({ command: 'rule', ...RUN })
    expect(text).toBe('Використання: /rule <id>')
  })

  test('the band draws one line on terminal and desktop', async $ => {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'context-gate', surface, component: 'AbovePrompt', props: BAND_PROPS })
      const found = await ui.find({ type: 'Text', text: /^gate — · tier — · ctx —%$/ })
      expect(found).toBeDefined()
      await ui.unmount()
    }
  })
})
