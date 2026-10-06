// Entry of `dist/hooks-adapter.js`, the `claude-code-hooks` harness adapter (fallback without mods).
//
//   node dist/hooks-adapter.js                 settings command hook: hook JSON on stdin → hook JSON on stdout
//   node dist/hooks-adapter.js install [...]   merge hooks + skillOverrides into .claude/settings.local.json
//   node dist/hooks-adapter.js plan [...]      shiftwork contract: ticket Type/Model/Skills → JSON plan
//
// A hook never fails the session: any error → exit 0 with no output (stderr with CONTEXT_GATE_DEBUG=1).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DecisionLogEntry } from '../../core/src/types.ts'
import { detectWindows } from '../../core/src/glob.ts'
import { handleHook, type HookEnv, type HookInput } from './handle.ts'
import { appendJournal, fileExists, loadGateConfig, loadRules, loadSkills, projectRoot, readBranch, readState, writeState } from './node.ts'
import { HOOK_MARKER, hookCommand, hookEntries, installGate, mergeSettings, skillOverridesFor, unmergeSettings, type Settings } from './install.ts'
import { planForTicket } from './shiftwork.ts'

const USAGE = `context-gate hooks adapter (claude-code-hooks)

  hooks-adapter.js                       хук settings: JSON події зі stdin → JSON відповіді
  hooks-adapter.js install [опції]       додати хуки і skillOverrides у .claude/settings.local.json
      --profile <p>   профіль для skillOverrides     --tier <t> | --model <id>
      --hard          off-skills → "off" (інакше "user-invocable-only")
      --no-skill-overrides   лише хуки            --print   показати результат, нічого не писати
      --uninstall     прибрати наші хуки й ключі   --root <dir>   корінь репозиторію (типово cwd)
  hooks-adapter.js plan --type <Type> [--model <ref>] [--skills "+a -b"] [--root <dir>]
      план зміни для shiftwork-runner (JSON): profile, tier, skills, preload,
      appendSystemPrompt, pluginDirSymlinks, settings, env
`

function debug(msg: string): void {
  if (process.env.CONTEXT_GATE_DEBUG === '1') process.stderr.write(`context-gate hooks: ${msg}\n`)
}

function flags(argv: string[]): { opts: Record<string, string | true>; rest: string[] } {
  const opts: Record<string, string | true> = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { rest.push(a); continue }
    const eq = a.indexOf('=')
    if (eq > 0) { opts[a.slice(2, eq)] = a.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--') && !['hard', 'print', 'uninstall', 'no-skill-overrides', 'help'].includes(a.slice(2))) { opts[a.slice(2)] = next; i++ }
    else opts[a.slice(2)] = true
  }
  return { opts, rest }
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined)

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export function runHook(input: HookInput, env: NodeJS.ProcessEnv = process.env, now = Date.now()): { stdout: string; log: DecisionLogEntry[] } {
  const root = projectRoot(input, env)
  const { config, diagnostics } = loadGateConfig(root)
  for (const d of diagnostics) debug(`${d.code} ${d.message}`)
  const { rules } = loadRules(root, config)
  const items = loadSkills(root, env.HOME)
  const sessionId = input.session_id || 'unknown'
  const state = readState(sessionId, env)
  const hookEnv: HookEnv = {}
  for (const k of ['CONTEXT_GATE_PROFILE', 'CONTEXT_GATE_MODE', 'CONTEXT_GATE_OFF', 'CONTEXT_GATE_TICKET_TYPE', 'CONTEXT_GATE_MODEL', 'ANTHROPIC_MODEL'] as const) {
    const v = env[k]
    if (v) hookEnv[k] = v
  }
  const ctx = {
    root, config, rules, items, env: hookEnv, now,
    branch: readBranch(root),
    windows: detectWindows(root, env.OS),
    exists: (p: string) => fileExists(root, p),
  }
  const r = handleHook(input, ctx, state)
  writeState(sessionId, r.state, env)
  if (config.log?.file && r.log.length) {
    try { appendJournal(root, r.log) } catch (e) { debug(`journal: ${(e as Error).message}`) }
  }
  return { stdout: r.output ? JSON.stringify(r.output) : '', log: r.log }
}

function scriptPath(): string {
  try { return fileURLToPath(import.meta.url) } catch { return resolve(process.argv[1] ?? 'dist/hooks-adapter.js') }
}

function install(argv: string[]): number {
  const { opts } = flags(argv)
  if (opts.help) { process.stdout.write(USAGE); return 0 }
  const root = resolve(str(opts.root) ?? process.cwd())
  const settingsPath = join(root, '.claude', 'settings.local.json')
  let existing: Settings = {}
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings } catch (e) {
      process.stderr.write(`${settingsPath} не парситься: ${(e as Error).message}\n`)
      return 1
    }
  }
  const { config, diagnostics } = loadGateConfig(root)
  for (const d of diagnostics) process.stderr.write(`${d.severity} ${d.code}: ${d.message}\n`)
  const items = loadSkills(root)
  const managedSkills = items.map((i) => i.name)
  let next: Settings
  let gateInfo = ''
  if (opts.uninstall) next = unmergeSettings(existing, managedSkills)
  else {
    let script = scriptPath()
    if (!script.endsWith(HOOK_MARKER)) script = join(dirname(script), '..', '..', '..', 'dist', HOOK_MARKER)
    const add: Parameters<typeof mergeSettings>[1] = { hooks: hookEntries(hookCommand(script)) }
    if (!opts['no-skill-overrides']) {
      const gate = installGate(config, items, { profile: str(opts.profile), tier: str(opts.tier), model: str(opts.model), hard: !!opts.hard })
      add.skillOverrides = skillOverridesFor(gate, { hard: !!opts.hard })
      add.managedSkills = managedSkills
      gateInfo = `профіль ${gate.profile ?? '—'}, tier ${gate.tier}: skills увімк. ${gate.skills.on.length + gate.skills.preload.length}, лише назва ${gate.skills.nameOnly.length}, вимк. ${gate.skills.off.length}`
    }
    next = mergeSettings(existing, add)
  }
  const text = JSON.stringify(next, null, 2) + '\n'
  if (opts.print) { process.stdout.write(text); return 0 }
  mkdirSync(dirname(settingsPath), { recursive: true })
  if (existsSync(settingsPath)) {
    const bak = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(settingsPath, bak)
    process.stdout.write(`резервна копія: ${bak}\n`)
  }
  writeFileSync(settingsPath, text)
  process.stdout.write(`${opts.uninstall ? 'прибрано з' : 'записано в'} ${settingsPath}${gateInfo ? `\n${gateInfo}` : ''}\n`)
  if (!opts.uninstall) process.stdout.write('Профіль на сесію: CONTEXT_GATE_PROFILE=<p> або [gate:<p>] у промпті; застосування без профілю: CONTEXT_GATE_MODE=auto.\n')
  return 0
}

function plan(argv: string[]): number {
  const { opts } = flags(argv)
  if (opts.help) { process.stdout.write(USAGE); return 0 }
  const root = resolve(str(opts.root) ?? process.cwd())
  const { config, diagnostics } = loadGateConfig(root)
  for (const d of diagnostics) process.stderr.write(`${d.severity} ${d.code}: ${d.message}\n`)
  const items = loadSkills(root)
  const p = planForTicket(config, { ticketType: str(opts.type), model: str(opts.model), skills: str(opts.skills), items, branch: readBranch(root) }, Date.now())
  // Absolute symlink targets for the runner's temp plugin dir.
  const out = { ...p, pluginDirSymlinks: p.pluginDirSymlinks.map((s) => resolve(root, s)) }
  delete (out as Partial<typeof out>).gate
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  return 0
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'install') return install(rest)
  if (cmd === 'plan') return plan(rest)
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(USAGE); return 0 }
  try {
    const raw = await readStdin()
    if (!raw.trim()) return 0
    const input = JSON.parse(raw) as HookInput
    const { stdout } = runHook(input)
    if (stdout) process.stdout.write(stdout + '\n')
  } catch (e) {
    debug((e as Error).stack ?? String(e))
  }
  return 0
}

const isEntry = (() => {
  try { return resolve(process.argv[1] ?? '') === scriptPath() } catch { return false }
})()
if (isEntry) main().then((c) => { process.exitCode = c }, () => { process.exitCode = 0 })
