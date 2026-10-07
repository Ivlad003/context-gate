// Entry of `dist/hooks-adapter.js`, the `claude-code-hooks` harness adapter (fallback without mods).
//
//   node dist/hooks-adapter.js                 settings command hook: hook JSON on stdin → hook JSON on stdout
//   node dist/hooks-adapter.js install [...]   merge hooks + skillOverrides into .claude/settings.local.json
//   node dist/hooks-adapter.js plan [...]      shiftwork contract: ticket Type/Model/Skills → JSON plan
//
// A hook never fails the session: any error → exit 0 with no output (stderr with CONTEXT_GATE_DEBUG=1).
// `install` and `plan` report their errors on stderr with exit 1.

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DecisionLogEntry } from '../../core/src/types.ts'
import { detectWindows } from '../../core/src/glob.ts'
import { handleHook, HOOK_ENV_KEYS, type HookEnv, type HookInput, type SessionState } from './handle.ts'
import { appendJournal, backupPath, fileExists, hasState, loadGateConfig, loadRules, loadSkills, modPluginEnabled, parentSessionId, projectRoot, readBranch, installRecordPath, readInstallRecord, readState, updateState, writeFileAtomic, writeInstallRecord } from './node.ts'
import { HOOK_MARKER, hookCommand, hookEntries, installGate, isOurHook, mergeSettings, skillOverridesFor, unknownProfiles, unmergeSettings, type Settings } from './install.ts'
import { planForTicket } from './shiftwork.ts'

const USAGE = `context-gate hooks adapter (claude-code-hooks)

  hooks-adapter.js                       хук settings: JSON події зі stdin → JSON відповіді
  hooks-adapter.js install [опції]       додати хуки і skillOverrides у .claude/settings.local.json
      --profile <p>   профіль для skillOverrides     --tier <t> | --model <id>
      --hard          off-skills → "off" (інакше "user-invocable-only")
      --no-skill-overrides   лише хуки            --print   показати результат, нічого не писати
      --uninstall     прибрати наші хуки й ключі   --root <dir>   корінь репозиторію (типово cwd)
      --model-switch  ще й хук PostModelSwitch (tier за /model; потрібна нова версія Claude Code)
      --with-mod      встановити, хоча плагін-mod context-gate увімкнено (обидва діятимуть)
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
    if (next !== undefined && !next.startsWith('--') && !['hard', 'print', 'uninstall', 'no-skill-overrides', 'help', 'model-switch', 'with-mod'].includes(a.slice(2))) { opts[a.slice(2)] = next; i++ }
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

export interface RunHookOptions {
  /** Installed with `--with-mod`: run even when the context-gate mod plugin is enabled. */
  withMod?: boolean
}

export function runHook(input: HookInput, env: NodeJS.ProcessEnv = process.env, now = Date.now(), opts: RunHookOptions = {}): { stdout: string; log: DecisionLogEntry[] } {
  const root = projectRoot(input, env)
  // O3: with the mod plugin enabled the mod delivers rules and denies itself; both would do it twice.
  if (!opts.withMod && env.CONTEXT_GATE_HOOKS !== 'force') {
    const where = modPluginEnabled(root, env)
    if (where) {
      debug(`mod plugin enabled in ${where}: hooks adapter skips ${input.hook_event_name}`)
      if (input.hook_event_name !== 'SessionStart' || (input.source && input.source !== 'startup')) return { stdout: '', log: [] }
      const msg = `context-gate: плагін-mod увімкнено (${where}), hooks-адаптер нічого не робить, щоб не дублювати правила. Якщо mod у цій версії Claude Code не працює, встанови адаптер з --with-mod або задай CONTEXT_GATE_HOOKS=force.`
      return { stdout: JSON.stringify({ systemMessage: msg }), log: [] }
    }
  }
  const { config, diagnostics } = loadGateConfig(root)
  for (const d of diagnostics) debug(`${d.code} ${d.message}`)
  const { rules } = loadRules(root, config)
  const items = loadSkills(root, env.HOME)
  const sessionId = input.session_id || 'unknown'
  const hookEnv: HookEnv = {}
  for (const k of HOOK_ENV_KEYS) {
    const v = env[k]
    if (v) hookEnv[k] = v
  }
  const ctx = {
    root, config, rules, items, env: hookEnv, now,
    branch: readBranch(root),
    windows: detectWindows(root, env.OS),
    exists: (p: string) => fileExists(root, p),
  }
  // A fork has a new session_id: seed its state from the parent's (manual override, read set, delivered rules).
  let seed: SessionState | undefined
  if (input.hook_event_name === 'SessionStart' && input.source === 'fork' && !hasState(sessionId, env)) {
    const parent = parentSessionId(input.transcript_path, sessionId)
    if (parent && hasState(parent, env)) seed = readState(parent, env)
  }
  const { result: r, error } = updateState(sessionId, env, (state) => handleHook(input, ctx, seed ?? state))
  // A state write failure (read-only cache, full disk) must not swallow the decision already computed (L84).
  if (error) debug(`state: ${error.message}`)
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
  const { config, diagnostics, present } = loadGateConfig(root)
  for (const d of diagnostics) process.stderr.write(`${d.severity} ${d.code}: ${d.message}\n`)
  // Keys a previous install wrote and the user has not changed since: only those are ours to replace (L85).
  const owned = existsSync(installRecordPath(settingsPath))
    ? Object.entries(readInstallRecord(settingsPath)).filter(([k, v]) => existing.skillOverrides?.[k] === v).map(([k]) => k)
    : legacyOwned(existing, root)
  let next: Settings
  let gateInfo = ''
  let written: Record<string, string> | undefined
  if (opts.uninstall) {
    next = unmergeSettings(existing, owned)
    written = {}
  } else {
    const mod = modPluginEnabled(root)
    if (mod && !opts['with-mod'] && !opts.print) {
      process.stderr.write(`context-gate: плагін-mod увімкнено в ${mod}; mod і хуки разом доставлятимуть правила двічі. Вимкни плагін або повтори з --with-mod.\n`)
      return 1
    }
    let script = scriptPath()
    if (!script.endsWith(HOOK_MARKER)) script = join(dirname(script), '..', '..', '..', 'dist', HOOK_MARKER)
    if (/[\\/]_npx[\\/]/.test(script)) process.stderr.write(`увага: ${script} лежить у кеші npx; після його очищення хуки зламаються. Встанови пакет локально або глобально.\n`)
    const command = hookCommand(script, 'node', opts['with-mod'] ? ['--with-mod'] : [])
    const add: Parameters<typeof mergeSettings>[1] = { hooks: hookEntries(command, 10, { modelSwitch: !!opts['model-switch'] }) }
    const explicit = !!(str(opts.profile) || str(opts.tier) || str(opts.model))
    const unknown = unknownProfiles(config, str(opts.profile))
    if (unknown.length) {
      const known = Object.keys(config.profiles ?? {}).join(', ') || '—'
      process.stderr.write(`error G502: профіль ${unknown.join(', ')} не оголошено в gate.json. Відомі: ${known}\n`)
      return 1
    }
    if (opts['no-skill-overrides']) gateInfo = 'skillOverrides не змінено (--no-skill-overrides)'
    else if (!present || (!explicit && config.classify?.mode !== 'auto')) {
      // Shadow mode filters nothing at runtime (M38): a default install must not hide skills statically either, so
      // what an earlier --profile/--tier install hid (our owned keys) goes; the user's own keys stay.
      add.skillOverrides = {}
      add.managedSkills = owned
      written = {}
      const dropped = owned.length ? `; прибрано ${owned.length} ключ(ів) попереднього встановлення` : ''
      gateInfo = present ? `shadow-режим без --profile/--tier/--model: нічого не приховано${dropped}` : `gate.json немає: нічого не приховано${dropped}`
    } else {
      const gate = installGate(config, loadSkills(root), { profile: str(opts.profile), tier: str(opts.tier), model: str(opts.model), hard: !!opts.hard })
      // A key the user set by hand wins over ours: only free or owned keys are written.
      add.skillOverrides = Object.fromEntries(Object.entries(skillOverridesFor(gate, { hard: !!opts.hard })).filter(([k]) => existing.skillOverrides?.[k] === undefined || owned.includes(k)))
      add.managedSkills = owned
      written = add.skillOverrides
      gateInfo = `профіль ${gate.profile ?? '—'}, tier ${gate.tier}: skills увімк. ${gate.skills.on.length + gate.skills.preload.length}, лише назва ${gate.skills.nameOnly.length}, вимк. ${gate.skills.off.length}`
    }
    next = mergeSettings(existing, add)
  }
  const text = JSON.stringify(next, null, 2) + '\n'
  if (opts.print) { process.stdout.write(text); return 0 }
  if (existsSync(settingsPath)) {
    // Outside the repo: the copy holds the same local env and permissions (tokens) and must not be committed (L86).
    const bak = backupPath(settingsPath)
    mkdirSync(dirname(bak), { recursive: true })
    copyFileSync(settingsPath, bak)
    process.stdout.write(`резервна копія: ${bak}\n`)
  }
  writeFileAtomic(settingsPath, text)
  if (written) writeInstallRecord(settingsPath, written)
  process.stdout.write(`${opts.uninstall ? 'прибрано з' : 'записано в'} ${settingsPath}${gateInfo ? `\n${gateInfo}` : ''}\n`)
  if (!opts.uninstall) process.stdout.write('Профіль на сесію: CONTEXT_GATE_PROFILE=<p> або [gate:<p>] у промпті; застосування без профілю: CONTEXT_GATE_MODE=auto.\n')
  return 0
}

/** Overrides values an install writes (`skillOverridesFor`). */
const OUR_OVERRIDES = new Set(['name-only', 'user-invocable-only', 'off'])

/**
 * Owned override keys of an install made before install records existed (or whose record is gone: cache cleared,
 * HOME changed, repo moved): when the settings hold our hook, the keys of this repo's skills with a value we write
 * are taken as ours, as the pre-record uninstall did. Without our hook nothing is ours.
 */
function legacyOwned(existing: Settings, root: string): string[] {
  const ours = Object.values(existing.hooks ?? {}).some((list) => (Array.isArray(list) ? list : []).some((m) => Array.isArray(m?.hooks) && m.hooks.some((h) => isOurHook(h))))
  if (!ours) return []
  const skills = new Set(loadSkills(root).filter((i) => i.kind === 'skill').map((i) => i.name))
  return Object.entries(existing.skillOverrides ?? {}).filter(([k, v]) => skills.has(k) && OUR_OVERRIDES.has(String(v))).map(([k]) => k)
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

/** A subcommand's error goes to stderr with exit 1 (L87): only hook mode is fail-silent. */
function command(name: string, fn: () => number): number {
  try { return fn() } catch (e) {
    process.stderr.write(`context-gate hooks ${name}: ${(e as Error).message}\n`)
    debug((e as Error).stack ?? String(e))
    return 1
  }
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'install') return command('install', () => install(rest))
  if (cmd === 'plan') return command('plan', () => plan(rest))
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(USAGE); return 0 }
  try {
    const raw = await readStdin()
    if (!raw.trim()) return 0
    const input = JSON.parse(raw) as HookInput
    const { stdout } = runHook(input, process.env, Date.now(), { withMod: process.argv.slice(2).includes('--with-mod') })
    if (stdout) process.stdout.write(stdout + '\n')
  } catch (e) {
    debug((e as Error).stack ?? String(e))
  }
  return 0
}

/** Node realpaths the main module but not argv[1]: compare both resolved, or a symlinked bin never runs (M75). */
export function isMainModule(argv1: string | undefined, modulePath: string): boolean {
  if (!argv1) return false
  const real = (p: string): string => { try { return realpathSync(p) } catch { return resolve(p) } }
  return real(resolve(argv1)) === real(modulePath)
}

const isEntry = (() => {
  try { return isMainModule(process.argv[1], scriptPath()) } catch { return false }
})()
if (isEntry) main().then((c) => { process.exitCode = c }, () => { process.exitCode = 1 })
