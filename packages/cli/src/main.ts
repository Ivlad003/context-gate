// context-gate CLI entry (bundled into dist/cli.js). Exit codes: 0 ok, 1 failure (error diagnostics, failed
// checks, refused formatting), 2 usage error (unknown command or flag, bad arguments).

import { existsSync, realpathSync, rmSync, statSync, watch } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, relative, resolve } from 'node:path'
import pkg from '../../../package.json' with { type: 'json' }
import type { Diagnostic, Value } from '../../core/src/types.ts'
import { explain as explainCode, CODES } from '../../core/src/codes.ts'
import { parseDuration } from '../../core/src/duration.ts'
import { PIPE_STAGES, type PipeStage, type PipeStageName } from '../../core/src/gatecmd.ts'
import { buildPrompts, generateCtxTypes } from './build.ts'
import { writeEditorTypes } from './editor-types.ts'
import { bool, helpText, list, parseArgv, str, type FlagSpec, type ParsedArgv } from './argv.ts'
import { healthCommand, runCommand } from './cmd-run.ts'
import { formatSync, syncCommand, syncHookMode, syncWatchPaths } from './cmd-sync.ts'
import { exampleCommand, initCommand, migrateCommand } from './cmd-init.ts'
import { formatStageOut, runPipe, runStage } from './cmd-pipe.ts'
import { benchCommand, reportCommand } from './cmd-report.ts'
import { expandCommand, schemaInferCommand } from './cmd-expand.ts'
import { indexCommand } from './cmd-index.ts'
import { formatPrompt } from './fmt.ts'
import { buildContext, callScriptTool, loadData, loadRepo, scriptTools, setData, validDataKey } from './context.ts'
import { readTrust, setTrust, trustState, readUserSettings, userSettingsPath, trustPath, binaryWhitelist, repoCacheDir } from './settings.ts'
import { withUserSkills } from './host-node.ts'
import { ensureGitignore, findRoot, parseJsonl, posix, readOptionalStdin, readStdin, readText, walkFiles, writeText, writeJson } from './util.ts'

export const VERSION: string = (pkg as { version: string }).version

function explainAny(code: string): string {
  return explainCode(code) + '\n'
}

interface Io { out(s: string): void; err(s: string): void; stdin(): Promise<string> }

interface Command {
  summary: string
  usage: string[]
  flags: Record<string, FlagSpec>
  loose?: boolean
  extra?: string
  run(p: ParsedArgv, root: string, io: Io): Promise<number>
}

const ctxFlags: Record<string, FlagSpec> = {
  tier: { type: 'string', desc: 'tier (premium | standard | quick | будь-який з gate.json)', arg: '<tier>' },
  profile: { type: 'string', desc: 'профіль (як /gate <profile>)', arg: '<name>' },
  model: { type: 'string', desc: 'id моделі для tier через models', arg: '<id>' },
  'ctx-from': { type: 'string', desc: 'live | session:latest | session:<id> | fixtures/x.json', arg: '<src>' },
  'dry-scripts': { type: 'bool', desc: '@run/@call і cli-провайдери лише з кешу, нічого не запускати' },
}

function ctxOpts(p: ParsedArgv, root: string) {
  return {
    root,
    ...(str(p, 'tier') ? { tier: str(p, 'tier') } : {}),
    ...(str(p, 'profile') ? { profile: str(p, 'profile') } : {}),
    ...(str(p, 'model') ? { model: str(p, 'model') } : {}),
    ...(str(p, 'ctx-from') ? { ctxFrom: str(p, 'ctx-from') } : {}),
    ...(bool(p, 'dry-scripts') ? { dryScripts: true } : {}),
    ...(bool(p, 'trust-repo') ? { trustRepo: true } : {}),
  }
}

function printDiags(io: Io, ds: Diagnostic[]): void {
  for (const d of ds) io.err(`${d.severity} ${d.code}${d.path ? ` ${d.path}${d.line ? ':' + d.line : ''}` : ''} ${d.message}${d.hint ? ` (${d.hint})` : ''}\n`)
}

/**
 * Re-runs `fn` on changes under `paths` (debounced) until SIGINT. A change during a run schedules one more run
 * after it (never lost). Directories are watched rather than files: an atomic save (rename over the file) would
 * detach a watcher on the file itself, so a watched file is matched by name in its parent directory.
 */
async function watchLoop(paths: string[], fn: () => Promise<void>, io: Io): Promise<number> {
  await fn()
  let timer: NodeJS.Timeout | undefined
  let busy = false
  let again = false
  const runOnce = async (): Promise<void> => {
    if (busy) { again = true; return }
    busy = true
    try {
      do { again = false; try { await fn() } catch (e) { io.err(String(e) + '\n') } } while (again)
    } finally { busy = false }
  }
  const trigger = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void runOnce() }, 150)
  }
  const ignored = (f: string): boolean => /(^|[\\/])\.(compiled|trace|types)([\\/]|$)|\.tmp$/.test(f)
  const watchers = paths.filter((p) => existsSync(p)).map((p) => {
    if (statSync(p).isDirectory()) return watch(p, { recursive: true }, (_e, f) => { if (!f || !ignored(String(f))) trigger() })
    const name = basename(p)
    return watch(dirname(p), (_e, f) => { if (!f || String(f) === name) trigger() })
  })
  io.err(`стежу за: ${paths.filter((p) => existsSync(p)).map((p) => posix(relative(process.cwd(), p)) || '.').join(', ')} (Ctrl+C — вихід)\n`)
  await new Promise<void>((done) => process.once('SIGINT', () => done()))
  if (timer) clearTimeout(timer)
  for (const w of watchers) w.close()
  return 0
}

async function doBuild(root: string, p: ParsedArgv, io: Io): Promise<number> {
  const repo = loadRepo(root)
  const only = list(p, 'only')
  const t0 = Date.now()
  const r = await buildPrompts({ root, dir: repo.promptDir, ...(only ? { only } : {}), ...(bool(p, 'force') ? { force: true } : {}) })
  if (repo.hasConfig) { try { generateCtxTypes({ root, config: repo.config }) } catch { /* types are best effort */ } }
  // tsconfig.json + .types/jsx/ for editors (the jsx package is not installed in user repos).
  const types = existsSync(join(root, repo.promptDir)) ? writeEditorTypes(root, repo.promptDir) : { written: [], notes: [] }
  if (types.written.length && existsSync(join(root, '.gitignore'))) ensureGitignore(root, [`${repo.promptDir.replace(/^\.\//, '').replace(/\/+$/, '')}/.types/jsx/`])
  r.written.push(...types.written)
  // Р3: a copy of .compiled in ~/.cache/context-gate/<repo>/compiled for `claude -p` without a build.
  for (const cp of r.compiled) if (!cp.diagnostics.some((d) => d.severity === 'error')) { try { writeJson(join(repo.cacheDir, 'compiled', `${cp.id}.json`), cp) } catch { /* best effort */ } }
  // …and without the orphans the build pruned from the repo (a removed prompt must not come back from the cache).
  for (const rel of r.removed ?? []) {
    const m = /\.compiled\/([^/]+\.json)$/.exec(rel)
    if (m) { try { rmSync(join(repo.cacheDir, 'compiled', m[1]!), { force: true }) } catch { /* best effort */ } }
  }
  const failed = r.diagnostics.some((d) => d.severity === 'error')
  if (bool(p, 'json')) io.out(JSON.stringify({ ok: !failed, compiled: r.compiled.map((c) => c.id), written: r.written, ...(r.removed ? { removed: r.removed } : {}), diagnostics: r.diagnostics, ms: Date.now() - t0 }) + '\n')
  else {
    printDiags(io, r.diagnostics)
    for (const n of types.notes) io.err(n + '\n')
    io.out(r.compiled.length ? `зібрано ${r.compiled.map((c) => c.id).join(', ')} за ${Date.now() - t0} мс${r.written.length ? `; записано:\n  ${r.written.join('\n  ')}` : ''}\n` : `немає *.prompt.tsx у ${repo.promptDir}\n`)
    if (r.removed?.length) io.out(`видалено (промпт прибрано або перейменовано):\n  ${r.removed.join('\n  ')}\n`)
  }
  return failed ? 1 : 0
}

async function stageCommand(name: PipeStageName, p: ParsedArgv, root: string, io: Io): Promise<number> {
  const args: Record<string, string> = {}
  for (const [k, v] of Object.entries(p.flags)) if (k !== 'root' && k !== 'help' && k !== 'trust-repo' && k !== 'user-skills') args[k] = Array.isArray(v) ? v.join(',') : String(v)
  const stage: PipeStage = { stage: name, args, positional: p.positional, ...(name === 'where' ? { expr: p.positional.join(' ') } : {}) }
  const needsInput = name !== 'collect' && name !== 'why' && name !== 'signals'
  const input = parseJsonl(needsInput ? await io.stdin() : await readOptionalStdin(io.stdin))
  if (input.bad) io.err(`пропущено ${input.bad} невалідних рядків JSONL\n`)
  const out = await runStage(stage, input.items, { root, ...(bool(p, 'trust-repo') ? { trustRepo: true } : {}) })
  if ('error' in out) { io.err(out.error + '\n'); return out.code ?? 1 }
  io.out(formatStageOut(out, { pretty: name === 'tokens' && process.stdout.isTTY }))
  return 0
}

const STAGE_HELP: Partial<Record<PipeStageName, [string, string[]]>> = {
  collect: ['усі елементи (rules, skills, agents, tools, sections, provider data) як JSONL', ['collect [--kind rule,skill] [--id name]']],
  normalize: ['дедуплікація за id, cost, нормалізація globs', ['collect | context-gate normalize']],
  signals: ['сигнали живого репозиторію (paths, branch, tier, profile)', ['signals']],
  decide: ['рішення gate на кожен елемент (decision: on | nameOnly | off | preload)', ['collect | context-gate decide [--profile p] [--model id] [--tier t] [--paths a,b]']],
  budget: ['довгі елементи → on-demand (nameOnly)', ['… | context-gate budget [--max-chars 30000] [--total <tokens>]']],
  render: ['рендер секцій (kind=section) і тексти інших елементів; або одна секція: render prompt://<id>', ['… | context-gate render [--tier t]', 'render prompt://<id> [--tier t]']],
  tokens: ['підсумок символів/токенів (усього, увімкнено, за kind і decision)', ['… | context-gate tokens']],
  preview: ['людський перегляд відрендереного', ['… | context-gate render | context-gate preview']],
  deliver: ['що зробить harness-адаптер (лише --dry-run)', ['… | context-gate deliver --dry-run [--adapter claude-code-mod|static]']],
  observe: ['лічильники з .claude/gate.log.jsonl на кожен елемент', ['… | context-gate observe [--since 7d] [--status never|delivered|denied|enabled]']],
  where: ['фільтр як у /gate … | where', ["… | context-gate where 'kind=rule group=frontend'"]],
  take: ['перші n', ['… | context-gate take 5']],
  sort: ['сортування за полем (-поле — спадання)', ['… | context-gate sort -chars']],
  on: ['лише увімкнені', ['… | context-gate on']],
  off: ['лише вимкнені', ['… | context-gate off']],
  why: ['журнал рішень таблицею (--json — JSONL)', ['why [--n 50] [--json]']],
}

/** Boolean flags of the stages: declared, so `render --json prompt://x` never takes the target as the flag's value. */
const STAGE_BOOLS: Record<string, FlagSpec> = {
  json: { type: 'bool', desc: 'JSON / JSONL' },
  trace: { type: 'bool', desc: 'trace рендера' },
  markers: { type: 'bool', desc: 'маркери меж секцій' },
  'dry-scripts': { type: 'bool', desc: '@run/@call лише з кешу' },
  'dry-run': { type: 'bool', desc: 'лише показати' },
}

function stage(name: PipeStageName): Command {
  const [summary, usage] = STAGE_HELP[name] ?? [name, [name]]
  return { summary, usage, flags: STAGE_BOOLS, loose: true, extra: 'Стадія pipe: JSONL на stdin → JSONL на stdout; аргументи — будь-які --ключ значення стадії.', run: (p, root, io) => stageCommand(name, p, root, io) }
}

export const COMMANDS: Record<string, Command> = {
  build: {
    summary: 'зібрати .claude/prompt/*.prompt.tsx у .compiled/*.json, prompt.lock.json і SKILL.md',
    usage: ['build [--only id,…] [--watch] [--json] [--force]'],
    flags: { only: { type: 'list', desc: 'лише ці промпти (id або шлях)', arg: '<ids>' }, watch: { type: 'bool', desc: 'перезбирати при зміні .claude/prompt/**, gate.json' }, json: { type: 'bool', desc: 'результат JSON (для mod-а)' }, force: { type: 'bool', desc: 'перезаписати SKILL.md, написаний вручну (без generated-by: context-gate)' } },
    async run(p, root, io) {
      if (!bool(p, 'watch')) return doBuild(root, p, io)
      const repo = loadRepo(root)
      return watchLoop([join(root, repo.promptDir), join(root, '.claude', 'gate.json'), join(root, repo.promptDir, 'scripts')], async () => { await doBuild(root, p, io) }, io)
    },
  },
  run: {
    summary: 'відрендерити промпт, секцію або skill тим самим ядром, що й prompt.compose',
    usage: ['run [id] [--tier t] [--profile p] [--model m] [--ctx-from src] [--trace] [--json]', 'run <skill> --args "$ARGUMENTS"', 'run --only <section> --json --dry-scripts', 'run --diff session:latest'],
    flags: {
      ...ctxFlags,
      only: { type: 'string', desc: 'одна секція з повним контекстом', arg: '<id>' },
      trace: { type: 'bool', desc: 'таблиця trace після тексту (секції, @if, @run, токени, коди)' },
      json: { type: 'bool', desc: 'те саме структурою (і .claude/prompt/.trace/last.json)' },
      markers: { type: 'bool', desc: 'маркери меж секцій (за замовчуванням так; --no-markers — текст як у prompt.compose)' },
      args: { type: 'string', desc: 'аргументи skill-промпту одним рядком (як $ARGUMENTS)', arg: '"<args>"' },
      diff: { type: 'string', desc: 'різниця з тим, що модель отримала (session:latest)', arg: '<src>' },
      watch: { type: 'bool', desc: 'перерендер при зміні .claude/prompt/**, gate.json, scripts/' },
      build: { type: 'bool', desc: 'автозбірка застарілого TSX (за замовчуванням, якщо довірено; --no-build вимикає)' },
      debug: { type: 'bool', desc: '@debug обчислюється і пишеться в .claude/gate.debug.log (як debug: true у gate.json)' },
    },
    extra: 'Для skill-промпту помилка аргументів друкує секцію usage (код виходу 0 — це текст для моделі).',
    async run(p, root, io) {
      const once = async (): Promise<number> => {
        const id = p.positional[0]?.replace(/^prompt:\/\//, '')
        const r = await runCommand({
          ...ctxOpts(p, root),
          ...(id ? { id } : {}),
          ...(str(p, 'only') ? { only: str(p, 'only')!.replace(/^prompt:\/\//, '') } : {}),
          trace: bool(p, 'trace'),
          json: bool(p, 'json'),
          ...(p.flags.markers === false ? { markers: false } : {}),
          ...(str(p, 'args') !== undefined ? { argsRaw: str(p, 'args') } : p.tail.length ? { argsRaw: p.tail.join(' ') } : {}),
          ...(str(p, 'diff') ? { diff: str(p, 'diff') } : {}),
          ...(p.flags.build === false ? { autoBuild: false } : {}),
          ...(bool(p, 'debug') ? { debug: true } : {}),
        })
        io.out(r.stdout)
        if (r.stderr) io.err(r.stderr)
        return r.code
      }
      if (!bool(p, 'watch')) return once()
      const repo = loadRepo(root)
      return watchLoop([join(root, repo.promptDir), join(root, '.claude', 'gate.json')], async () => { io.out('\x1b[2J\x1b[H'); await once() }, io)
    },
  },
  health: {
    summary: 'метрики промпту H0xx (розмір, стабільна частка, час, unverified, урізання, застарілий .compiled)',
    usage: ['health [--json] [--strict]'],
    flags: { ...ctxFlags, json: { type: 'bool', desc: 'звіт JSON (CI, bench)' }, strict: { type: 'bool', desc: 'код виходу 1, якщо якась метрика поза порогом' } },
    async run(p, root, io) {
      const r = await healthCommand({ ...ctxOpts(p, root), json: bool(p, 'json'), strict: bool(p, 'strict') })
      io.out(r.stdout)
      return r.code
    },
  },
  explain: {
    summary: 'пояснення коду діагностики (G0xx…G5xx, H0xx, D0xx)',
    usage: ['explain <code>'],
    flags: {},
    async run(p, _root, io) {
      const c = p.positional[0]
      if (!c) { io.err('використання: context-gate explain <code>\n'); return 2 }
      io.out(explainAny(c))
      return CODES[c.trim().toUpperCase()] ? 0 : 1
    },
  },
  fmt: {
    summary: 'вирівняти директиви Markdown-промптів (лише рядки @…; текст не змінюється)',
    usage: ['fmt [--check] [files…]'],
    flags: { check: { type: 'bool', desc: 'лише перевірити: код 1, якщо щось треба відформатувати' } },
    async run(p, root, io) {
      const repo = loadRepo(root)
      const files = p.positional.length ? p.positional.map((f) => posix(relative(root, resolve(process.cwd(), f)))) : walkFiles(root, { under: repo.promptDir }).filter((f) => f.endsWith('.md') && !f.includes('/proposals/'))
      let bad = 0
      for (const f of files) {
        const src = readText(join(root, f))
        if (src === undefined) { io.err(`немає файлу ${f}\n`); bad++; continue }
        const r = formatPrompt(src)
        if (r.refused) { io.err(`${f}${r.line ? ':' + r.line : ''}: не форматую — ${r.refused}\n`); bad++; continue }
        if (!r.changed) continue
        if (bool(p, 'check')) { io.out(`потребує fmt: ${f}\n`); bad++ }
        else { writeText(join(root, f), r.text, root); io.out(`відформатовано ${f}\n`) }
      }
      return bad ? 1 : 0
    },
  },
  init: {
    summary: 'створити .claude/gate.json із профілями зі структури репозиторію (classify: shadow) і .gitignore',
    usage: ['init [--force] [--dry-run] [--commit-compiled]'],
    flags: { force: { type: 'bool', desc: 'перезаписати наявний gate.json' }, 'dry-run': { type: 'bool', desc: 'лише надрукувати JSON' }, 'commit-compiled': { type: 'bool', desc: 'prompt.commitCompiled: true — .compiled/ комітиться (не в .gitignore)' } },
    async run(p, root, io) {
      const r = initCommand(root, { force: bool(p, 'force'), dryRun: bool(p, 'dry-run'), commitCompiled: bool(p, 'commit-compiled') })
      ;(r.code ? io.err : io.out)(r.out)
      return r.code
    },
  },
  migrate: {
    summary: 'перевести gate.json зі skillGroups/mcpGroups/ruleSources у groups/itemSources (з резервною копією)',
    usage: ['migrate [--dry-run]'],
    flags: { 'dry-run': { type: 'bool', desc: 'надрукувати новий JSON, не записувати' } },
    async run(p, root, io) {
      const r = migrateCommand(root, { dryRun: bool(p, 'dry-run') })
      ;(r.code ? io.err : io.out)(r.out)
      return r.code
    },
  },
  sync: {
    summary: 'static-адаптер без mods: .mdc → .claude/rules/cursor + skills, профіль → skillOverrides, DSL → prompt.generated.md',
    usage: ['sync [--profile p] [--tier t] [--watch]', 'sync --agents-md AGENTS.md[,GEMINI.md]', 'sync --install-hook | --uninstall-hook', 'sync --hook'],
    flags: { ...ctxFlags, watch: { type: 'bool', desc: 'перегенеровувати при змінах' }, json: { type: 'bool', desc: 'результат JSON' }, 'no-prompt': { type: 'bool', desc: 'без prompt.generated.md' }, 'no-overrides': { type: 'bool', desc: 'без skillOverrides' }, hard: { type: 'bool', desc: 'вимкнені skills → off (інакше user-invocable-only: /name лишається)' }, hook: { type: 'bool', desc: 'режим SessionStart-хука: stdout — JSON (reloadSkills, коли змінились skills)' }, 'install-hook': { type: 'bool', desc: 'записати SessionStart settings-хук «sync --hook» у .claude/settings.local.json' }, 'uninstall-hook': { type: 'bool', desc: 'прибрати цей хук' }, 'agents-md': { type: 'list', desc: 'ті самі секції без volatile — між маркерами у файлах для інших агентних CLI (AGENTS.md, …)', arg: '<file,…>' } },
    async run(p, root, io) {
      const hookMode = bool(p, 'hook') ? 'hook' : bool(p, 'install-hook') ? 'install' : bool(p, 'uninstall-hook') ? 'uninstall' : undefined
      if (hookMode) { const r = await syncHookMode({ ...ctxOpts(p, root), noPrompt: bool(p, 'no-prompt'), noOverrides: bool(p, 'no-overrides'), hard: bool(p, 'hard') }, hookMode); io.out(r.out); if (r.err) io.err(r.err); return r.code }
      const once = async (): Promise<number> => {
        const r = await syncCommand({ ...ctxOpts(p, root), noPrompt: bool(p, 'no-prompt'), noOverrides: bool(p, 'no-overrides'), hard: bool(p, 'hard'), agentsMd: list(p, 'agents-md') })
        io.out(bool(p, 'json') ? JSON.stringify(r) + '\n' : formatSync(r))
        return 0
      }
      if (!bool(p, 'watch')) return once()
      return watchLoop(syncWatchPaths(root, loadRepo(root).promptDir), async () => { await once() }, io)
    },
  },
  pipe: {
    summary: 'увесь конвеєр одним рядком (граматика /gate): "collect | decide --profile x | tokens"',
    usage: ['pipe "collect --kind rule | where group=frontend | tokens"'],
    flags: {},
    async run(p, root, io) {
      const text = p.positional.join(' ')
      if (!text) { io.err('використання: context-gate pipe "<стадія> | <стадія> …"\n'); return 2 }
      const input = parseJsonl(await readOptionalStdin(io.stdin)).items
      const out = await runPipe(text.includes('|') ? text : text + ' | take 1000000', input, { root, ...(bool(p, 'trust-repo') ? { trustRepo: true } : {}) })
      if ('error' in out) { io.err(out.error + '\n'); return out.code ?? 1 }
      io.out(formatStageOut(out))
      return 0
    },
  },
  data: {
    summary: 'сховище даних скриптів data.* (.claude/prompt/data/<key>.json + кеш)',
    usage: ['data set <key> [--ttl 1h] < file.json', 'data get <key>', 'data list'],
    flags: { ttl: { type: 'string', desc: 'вік, після якого data.<key>.stale = true', arg: '<duration>' }, 'no-persist': { type: 'bool', desc: 'лише в кеш, без файлу в репозиторії' } },
    async run(p, root, io) {
      const [action, key] = p.positional
      const repo = loadRepo(root)
      if (action === 'list') { io.out(loadData(repo).map((e) => e.key).join('\n') + '\n'); return 0 }
      if (!key || (action !== 'set' && action !== 'get')) { io.err('використання: context-gate data set <key> < file.json | data get <key> | data list\n'); return 2 }
      if (!validDataKey(key)) { io.err(`невірний ключ «${key}» (латиниця, цифри, . _ -)\n`); return 2 }
      if (action === 'get') {
        const e = loadData(repo).find((x) => x.key === key)
        if (!e) { io.err(`data.${key} не знайдено\n`); return 1 }
        io.out(JSON.stringify(e.value, null, 2) + '\n')
        return 0
      }
      const text = await io.stdin()
      let value: Value
      try { value = JSON.parse(text) as Value } catch (e) { io.err(`stdin не є JSON: ${(e as Error).message}\n`); return 2 }
      const ttl = str(p, 'ttl')
      if (ttl && parseDuration(ttl) === undefined) { io.err(`невірна тривалість --ttl ${ttl}\n`); return 2 }
      const written = setData(repo, key, value, { ...(ttl ? { cache: ttl } : {}), persist: p.flags['no-persist'] !== true && p.flags.persist !== false })
      io.out(`data.${key} оновлено${written.length ? `: ${written.join(', ')}` : ' (кеш)'}\n`)
      return 0
    },
  },
  schema: {
    summary: 'вивести чернетку JSON Schema провайдера з реального запуску → proposals/<provider>.schema.json',
    usage: ['schema infer <provider> [--print]'],
    flags: { print: { type: 'bool', desc: 'надрукувати, не записувати' }, 'dry-scripts': ctxFlags['dry-scripts']! },
    async run(p, root, io) {
      const [action, provider] = p.positional
      if (action !== 'infer' || !provider) { io.err('використання: context-gate schema infer <provider>\n'); return 2 }
      const r = await schemaInferCommand({ ...ctxOpts(p, root), provider, print: bool(p, 'print') })
      ;(r.code ? io.err : io.out)(r.out)
      return r.code
    },
  },
  expand: {
    summary: 'згенерувати quick/standard-варіанти канонічних Markdown-секцій у proposals/ (claude -p)',
    usage: ['expand [--model opus] [--only id] [--tiers quick,standard] [--dry-run] [--force]'],
    flags: { model: { type: 'string', desc: 'модель для claude -p (за замовчуванням opus)', arg: '<model>' }, only: { type: 'list', desc: 'лише ці секції', arg: '<ids>' }, tiers: { type: 'list', desc: 'tiers варіантів', arg: '<tiers>' }, 'dry-run': { type: 'bool', desc: 'надрукувати інструкції, не викликати модель' }, force: { type: 'bool', desc: 'перегенерувати навіть з тим самим source-hash' } },
    extra: 'Бінарник claude можна підмінити змінною CONTEXT_GATE_CLAUDE.',
    async run(p, root, io) {
      const r = await expandCommand(root, { ...(str(p, 'model') ? { model: str(p, 'model') } : {}), ...(list(p, 'only') ? { only: list(p, 'only') } : {}), ...(list(p, 'tiers') ? { tiers: list(p, 'tiers') } : {}), dryRun: bool(p, 'dry-run'), force: bool(p, 'force') })
      ;(r.code ? io.err : io.out)(r.out)
      return r.code
    },
  },
  report: {
    summary: 'звіт за журналом: when vs класифікатор vs вручну, deny по інструментах, недоставлені правила, ескалації',
    usage: ['report [--since 7d] [--json]'],
    flags: { since: { type: 'string', desc: 'вікно (7d, 24h або дата)', arg: '<dur>' }, json: { type: 'bool', desc: 'JSON' } },
    async run(p, root, io) {
      const r = await reportCommand(root, { ...(str(p, 'since') ? { since: str(p, 'since') } : {}), json: bool(p, 'json'), ...(bool(p, 'trust-repo') ? { trustRepo: true } : {}) })
      io.out(r.out)
      return r.code
    },
  },
  bench: {
    summary: 'токени промпту й елементів до/після gate, unverified — по bench/repos.json або заданих теках',
    usage: ['bench [--before] [--after] [dirs…] [--profile p] [--tier t] [--json] [--user-skills]'],
    flags: { before: { type: 'bool', desc: 'колонка без gate' }, after: { type: 'bool', desc: 'колонка з gate' }, json: { type: 'bool', desc: 'JSON' }, profile: ctxFlags.profile!, tier: ctxFlags.tier!, model: ctxFlags.model! },
    async run(p, root, io) {
      // Bench numbers never depend on the machine: user skills only with an explicit --user-skills.
      const r = await withUserSkills(p.flags['user-skills'] === true, () => benchCommand(root, p.positional, { before: bool(p, 'before'), after: bool(p, 'after'), json: bool(p, 'json'), ...(str(p, 'profile') ? { profile: str(p, 'profile') } : {}), ...(str(p, 'tier') ? { tier: str(p, 'tier') } : {}), ...(str(p, 'model') ? { model: str(p, 'model') } : {}), ...(bool(p, 'trust-repo') ? { trustRepo: true } : {}) }))
      io.out(r.out)
      return r.code
    },
  },
  example: {
    summary: 'скопіювати приклади skills-промптів плагіна в .claude/prompt/',
    usage: ['example skills [--force]'],
    flags: { force: { type: 'bool', desc: 'перезаписати наявні' } },
    async run(p, root, io) {
      const r = exampleCommand(root, p.positional[0], { force: bool(p, 'force'), dir: loadRepo(root).promptDir })
      ;(r.code ? io.err : io.out)(r.out)
      return r.code
    },
  },
  trust: {
    summary: 'довіра до репозиторію (Р2): процеси, cli/module-провайдери, @run/@call',
    usage: ['trust [status]', 'trust grant', 'trust revoke', 'trust deny'],
    flags: { json: { type: 'bool', desc: 'JSON' } },
    async run(p, root, io) {
      const action = p.positional[0] ?? 'status'
      const repo = loadRepo(root)
      if (action === 'grant' || action === 'revoke' || action === 'deny') {
        const key = setTrust(root, repo.config, action === 'grant' ? 'trusted' : action === 'deny' ? 'denied' : 'revoke')
        io.out(`${action === 'grant' ? 'довірено' : action === 'deny' ? 'заборонено' : 'довіру скасовано'}: ${key}\n`)
        return 0
      }
      if (action !== 'status') { io.err(`G507 Невідома дія trust «${action}» (status | grant | revoke | deny)\n`); return 2 }
      const st = trustState(root, repo.config, { flag: bool(p, 'trust-repo') })
      const settings = readUserSettings()
      const info = { key: st.key, trusted: st.trusted, source: st.source, store: trustPath(), settings: userSettingsPath(), allowBinaries: [...binaryWhitelist(settings)], cache: repoCacheDir(root), record: readTrust().repos[st.key] ?? null }
      if (bool(p, 'json')) io.out(JSON.stringify(info) + '\n')
      else {
        const why = { flag: '--trust-repo', settings: 'trustBuild у налаштуваннях', store: 'збережене рішення', none: 'ще не вирішено (context-gate trust grant)', changed: 'команди в gate.json змінились — підтверди знову (trust grant)', denied: 'заборонено (trust revoke, потім grant)' }[st.source]
        io.out(`${st.trusted ? 'довірений' : 'не довірений'} — ${why}\nключ: ${st.key}\nбілий список: ${info.allowBinaries.join(', ')} (${info.settings})\nкеш: ${info.cache}\n`)
      }
      return 0
    },
  },
  index: {
    summary: 'записати .claude/gate.index.json для редактора (профілі, групи, секції, правила, символи; без вмісту файлів)',
    usage: ['index [--print]'],
    flags: { print: { type: 'bool', desc: 'надрукувати, не записувати' }, ...ctxFlags },
    async run(p, root, io) {
      const r = await indexCommand({ ...ctxOpts(p, root), print: bool(p, 'print') })
      io.out(r.out)
      return r.code
    },
  },
  tools: {
    summary: 'інструменти моделі: # gate-tool: у .claude/prompt/scripts і над експортами модулів (lib, module-провайдери, use); --call виконує один',
    usage: ['tools [--json]', "tools --call <name> [--input '{\"k\":1}'] [--trust-repo]"],
    flags: { json: { type: 'bool', desc: 'JSON' }, call: { type: 'string', desc: 'виконати інструмент як mod (гейт, tiers, довіра)', arg: '<name>' }, input: { type: 'string', desc: 'вхід інструмента (JSON-обʼєкт)', arg: '<json>' }, ...ctxFlags },
    async run(p, root, io) {
      const name = str(p, 'call')
      if (name) {
        let input: Record<string, Value> = {}
        const raw = str(p, 'input')
        if (raw) {
          try { input = JSON.parse(raw) as Record<string, Value> } catch (e) { io.err(`--input: не JSON (${(e as Error).message})\n`); return 2 }
          if (!input || typeof input !== 'object' || Array.isArray(input)) { io.err('--input: потрібен JSON-обʼєкт\n'); return 2 }
        }
        const ctx = await buildContext(ctxOpts(p, root))
        const r = await callScriptTool(ctx, name, input)
        if ('deny' in r) { io.err(r.deny + '\n'); return 1 }
        io.out(r.result.endsWith('\n') ? r.result : r.result + '\n')
        return 'isError' in r ? 1 : 0
      }
      const repo = loadRepo(root)
      const { tools, diagnostics } = scriptTools(repo)
      printDiags(io, diagnostics)
      const bad = diagnostics.filter((d) => d.severity === 'error').length
      io.out(bool(p, 'json') ? JSON.stringify(tools) + '\n' : tools.length ? tools.map((t) => `${t.name} — ${t.description ?? ''} (${t.path}${t.fn ? `#${t.fn}` : ''}${t.tiers ? `; tiers ${t.tiers.join(', ')}` : ''})`).join('\n') + '\n' : 'немає інструментів із # gate-tool:\n')
      return bad ? 1 : 0
    },
  },
  version: {
    summary: 'версія',
    usage: ['version'],
    flags: {},
    async run(_p, _root, io) { io.out(`context-gate ${VERSION}\n`); return 0 },
  },
}

for (const s of PIPE_STAGES) {
  if (s === 'render') continue
  COMMANDS[s] ??= stage(s)
}
// `render prompt://<id>` renders one section; plain `render` with JSONL on stdin is the pipe stage.
COMMANDS.render = {
  ...stage('render'),
  async run(p, root, io) {
    const target = p.positional[0]
    if (!target) return stageCommand('render', p, root, io)
    return COMMANDS.run!.run({ ...p, positional: [], flags: { ...p.flags, only: target.replace(/^prompt:\/\//, ''), markers: p.flags.markers ?? false } }, root, io)
  },
}

export function mainHelp(): string {
  const names = Object.keys(COMMANDS)
  const w = Math.max(...names.map((n) => n.length)) + 2
  const groups: [string, string[]][] = [
    ['Промпти', ['build', 'run', 'render', 'health', 'fmt', 'expand', 'explain', 'index']],
    ['Репозиторій', ['init', 'migrate', 'sync', 'example', 'trust', 'data', 'schema', 'tools']],
    ['Конвеєр (JSONL)', ['pipe', ...PIPE_STAGES.filter((s) => s !== 'render')]],
    ['Журнал', ['report', 'bench']],
    ['', ['version']],
  ]
  const lines = [`context-gate ${VERSION} — runtime і DSL для контексту Claude Code`, '', 'Використання: context-gate <команда> [прапорці]   (context-gate <команда> --help — довідка команди)']
  for (const [title, cmds] of groups) {
    lines.push('', ...(title ? [`${title}:`] : []))
    for (const c of cmds) if (COMMANDS[c]) lines.push(`  ${c.padEnd(w)}${COMMANDS[c]!.summary}`)
  }
  lines.push('', 'Глобальні прапорці: --root <dir>, --trust-repo, -h/--help. Коди виходу: 0 успіх, 1 помилка, 2 невірні аргументи.')
  return lines.join('\n') + '\n'
}

/**
 * `--trust-repo` in CI (risk S10): on `pull_request_target` the checkout may be a fork's code running with the
 * base repo's secrets, so the flag is refused unless CONTEXT_GATE_TRUST_PR_TARGET=1; on other `pull_request*`
 * events it works but warns that the PR's TSX, `@run` and cli providers execute.
 */
export function ciTrustCheck(env: Record<string, string | undefined>): { allow: boolean; warning?: string } {
  const ev = env.GITHUB_EVENT_NAME ?? ''
  if (ev === 'pull_request_target' && env.CONTEXT_GATE_TRUST_PR_TARGET !== '1') return { allow: false, warning: 'context-gate: --trust-repo проігноровано на pull_request_target — код PR (TSX, @run, cli-провайдери) виконався б із секретами базового репозиторію. CONTEXT_GATE_TRUST_PR_TARGET=1 — якщо це свідомо.' }
  if (ev.startsWith('pull_request')) return { allow: true, warning: `context-gate: --trust-repo на ${ev}: код PR (TSX, @run, cli-провайдери) виконується з правами цього job-а.` }
  return { allow: true }
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [name, ...rest] = argv
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    if (name === 'help' && rest[0] && COMMANDS[rest[0]]) { const c = COMMANDS[rest[0]]!; io.out(helpText(rest[0], c.summary, c.usage, c.flags, c.extra)); return 0 }
    io.out(mainHelp())
    return name ? 0 : 2
  }
  if (name === '--version' || name === '-v') { io.out(`context-gate ${VERSION}\n`); return 0 }
  const cmd = COMMANDS[name]
  if (!cmd) { io.err(`Невідома команда «${name}». context-gate --help — перелік команд.\n`); return 2 }
  const p = parseArgv(rest, cmd.flags, cmd.loose)
  if (bool(p, 'help')) { io.out(helpText(name, cmd.summary, cmd.usage, cmd.flags, cmd.extra)); return 0 }
  if (p.errors.length) { io.err(p.errors.join('\n') + `\ncontext-gate ${name} --help — довідка.\n`); return 2 }
  const root = str(p, 'root') ? resolve(str(p, 'root')!) : findRoot(process.cwd())
  if (bool(p, 'trust-repo')) {
    const t = ciTrustCheck(process.env)
    if (t.warning) io.err(t.warning + '\n')
    if (!t.allow) p.flags['trust-repo'] = false
  }
  try {
    return await withUserSkills(p.flags['user-skills'] !== false, () => cmd.run(p, root, io))
  } catch (e) {
    io.err(`context-gate ${name}: ${(e as Error)?.stack ?? String(e)}\n`)
    return 1
  }
}

const isEntry = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (isEntry) {
  const io: Io = { out: (s) => { process.stdout.write(s) }, err: (s) => { process.stderr.write(s) }, stdin: readStdin }
  main(process.argv.slice(2), io).then((code) => { process.exitCode = code }, (e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exitCode = 1 })
}
