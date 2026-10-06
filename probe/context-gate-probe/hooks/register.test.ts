// Runs under `claude plugin test probe/context-gate-probe` (the engine's own host, no Node).
import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

const ROOT = '/repo'
const OUT = `${ROOT}/.claude/probe.json`
const ENGINE = { kind: 'engine' } as const
const LISTING = '- probe-skill: a skill the probe sees\n'

/** The engine beneath the probe: root, env, fs.write and command.register answered from memory. */
function mount(on: On): { files: Map<string, string>; commands: string[] } {
  const files = new Map<string, string>()
  const commands: string[] = []
  on('session.root', () => ({ value: ROOT }))
  on('session.version', () => ({ value: { version: '9.9.9', base: '9.9.9' } }) as never)
  on('env.get', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  return { files, commands }
}

const report = (files: Map<string, string>) => JSON.parse(files.get(OUT) ?? 'null')

describe('context-gate-probe', () => {
  test('session.start registers /probe and writes probe.json with every point', async ($, on) => {
    const repo = mount(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    expect(repo.commands).toEqual(['probe'])
    const r = report(repo.files)
    expect(r.claudeCode).toBe('9.9.9')
    expect(r.points.state_after_clear.status).toBe('observed')
    expect(r.points.skill_listing.status).toBe('not-fired')
    expect(Object.keys(r.points).length).toBe(8)
  })

  test('the skill listing passes through unchanged and is captured verbatim', async ($, on) => {
    const repo = mount(on)
    on('prompt.attachment', ($, e) => ({ text: e.text }))
    const r = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE } as never)
    expect(r.text).toBe(LISTING)
    const sample = report(repo.files).points.skill_listing.samples[0]
    expect(sample.text).toBe(LISTING)
    expect(sample.resultChanged).toBe(false)
  })

  test('prompt.compose under -p records the print trait and judges it', async ($, on) => {
    const repo = mount(on)
    on('prompt.compose', () => ({ sections: [] }))
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: ['print'] })
    const p = report(repo.files).points.prompt_compose_print
    expect(p.samples[0].traits).toEqual(['print'])
    expect(p.verdict).toBe('works')
  })

  test('/probe classify times $.model.complete and records usage', async ($, on) => {
    const repo = mount(on)
    const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    on('model.complete', () => ({ value: { isAnswered: true, text: 'frontend', usage } }) as never)
    const { text } = await $.command.run({ command: 'probe', args: 'classify', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)
    expect(text).toContain('probe classify:')
    const p = report(repo.files).points.model_complete_cost
    expect(p.samples[0].usage).toEqual(usage)
    expect(p.verdict).toBe('works')
  })

  test('prompt.context records both the input and what next(e) returned (paths and kinds only)', async ($, on) => {
    const repo = mount(on)
    on('prompt.context', () => ({
      blocks: [{ name: 'claudeMd', text: 'x' }, { name: 'cursorRules', text: 'secret rule body' }],
      instructionFiles: [
        { path: `${ROOT}/CLAUDE.md`, kind: 'project', content: 'c' },
        { path: '/home/u/.claude/CLAUDE.md', kind: 'user', content: 'c' },
      ],
    }) as never)
    await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'x' }], instructionFiles: [{ path: `${ROOT}/CLAUDE.md`, kind: 'project', content: 'c' }] })
    const s = report(repo.files).points.prompt_context_subagent.samples[0]
    expect(s.blockNames).toEqual(['claudeMd'])
    expect(s.instructionFilesDefined).toBe(true)
    expect(s.instructionFilesCount).toBe(1)
    expect(s.resultBlockNames).toEqual(['claudeMd', 'cursorRules'])
    expect(s.hasCursorRulesBlock).toBe(true)
    expect(s.resultInstructionFiles).toEqual([{ path: 'CLAUDE.md', kind: 'project' }, { path: 'CLAUDE.md', kind: 'user' }])
    expect(JSON.stringify(s)).not.toContain('secret rule body')
  })
})
