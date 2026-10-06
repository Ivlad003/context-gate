# MOD-ADAPTER: how `hooks/` wires the core into Claude Code

This is the brief for implementing the `claude-code-mod` adapter. Read `docs/PROBE.md` first: it holds the exact d.ts shapes, plus the places where the API differs from SPEC.md, and those differences are already folded into this design. Field names below are the d.ts names for build 2.1.288.

## Ground rules

- The runtime has no Node and no `import()`. Imports are `import type … from 'claude-code'`, the runtime helpers `atom / read / update` from `'claude-code'`, and relative `.ts` files, `../packages/core/src/*.ts` included.
- Session state lives in `$.state` under the `'context-gate'` contract (`types/index.d.ts`), keys `gate, gateState, log, seen, manual, health, budgetsFired, trust, recentPaths, model, tier, agentTiers, ctxPercent, brief, config`. `plugin` and `key` must be **literals**: declare one `atom({ plugin: 'context-gate', key: '…' } as const, initial)` per key in `hooks/state.ts` and never build refs dynamically. Write with `update($, atom, fn)`. Before writing, strip `undefined` fields with `json(x) = JSON.parse(JSON.stringify(x))`, because `$.state.set` takes JSON only. **Never write from a `ui.render` hook.**
- Cross-session state goes in `$.store`: `trust:<repoKey>` → `{ decision, commandsHash, at }`.
- Module caches (closure variables) are disposable, since a hot reload drops them: the parsed config, the parsed `.mdc` rules, the item list, the compiled prompts, and `skillArgs: Map<skill, string>`. Every cache rebuilds lazily through `ensureConfig($)` / `ensureRules($)` / `ensureItems($)`, which `session.start` calls and every consumer guards with.
- Paths: `root = await $.session.root()`. `$.fs.*` resolves relative paths against **cwd**, so always pass `join(root, rel)`. The core works on repo-relative POSIX paths via `glob.ts normalizePath(path, root, { windows })`, where `windows = detectWindows(root, await $.env.get('OS'))`.
- Every user-facing string comes from the core (Ukrainian). The adapter only formats.
- Each layer degrades on its own. A failure is logged with `$.ui.log(…, { to: 'debug' })` and recorded in `config.disabled[layer]` for `/gate why`, never thrown. Every `on()` that can fail gets `.catch(($, e, next) => next(e))`.

## Files

```
hooks/
  register.ts      // export const register: Register = (on, options) => { installCore; installRules; installGate; installPrompt; installUi }
  state.ts         // atoms for every PluginState key + json() + small typed getters
  ctx.ts           // module caches: ensureConfig / ensureRules / ensureItems / repo paths / options
  host.ts          // makeRenderHost($, trusted): RenderHost over $.fs / $.process / $.mcp / $.state
  trust.ts         // ensureTrust($, options): Р2 trust-on-first-use
  core.ts          // session.start, classic.SessionStart, session.end, session.compact, commands
  rules.ts         // layer 1: prompt.context, tool.call(file tools), prompt.submit(@file/@rule), /rule
  gate.ts          // layer 2: prompt.submit signals, turn.step, attachment, describe, mcp deny, agent.offer, skill.prompt, budgets
  prompt.ts        // layer 3: prompt.compose, build on start, FileChanged
  ui.ts            // ui.render AbovePrompt + Pane 'gate-why'
  *.test.ts        // claude-code/testing, run via scripts/plugin-test.sh
```

`options` (userConfig) is `{ profile: string, mode: 'shadow'|'auto', trustBuild: 'ask'|'always'|'never', allowScripts: boolean, brief: boolean }`, read from `register`'s second argument. The engine re-runs `register` when the user changes these settings.

## Hooks, one by one

### Core

**`session.start`** (no matcher). It's awaited before turn one.

1. `await $.command.register({ name: 'gate', description, argumentHint })` and `{ name: 'rule', … }`. This already lives in the skeleton.
2. `ensureConfig($)`: `text = await $.fs.read(join(root, '.claude/gate.json')).catch(() => undefined)` → `config.ts loadConfig(text)` (which runs `validateConfig` + `normalizeConfig` + `mergeDefaults`). Diagnostics go to `config: { ok, disabled, diagnostics }`. When the config is invalid, layer 2 is disabled with the reason, and layer 1 keeps running.
3. `model = await $.session.model()` → `tierForModel(config, model)` → `update(model)`, `update(tier)`.
4. Detect `.claude/rules/cursor/` (`$.fs.exists`). If it exists, set `config.disabled.rules = '…'` (SPEC edge case 7).
5. When `manual` is empty and `options.profile` is set, seed `manual.profile = options.profile`.
6. Kick off the prompt build (see layer 3) without awaiting it: `void buildIfStale($)`.
7. `$.tool.register` for every compiled skill with `invoke.model === 'tool'`: `{ name, description, inputSchema: argsToJsonSchema(skill.args) }`.
8. `return next(e)`.

**`classic.SessionStart`** (no matcher). `const r = await next(e)`.

- `e.source === 'clear'` → `resetConversationState($)`. `'compact'` → set `manual.recheck` when `config.classify.recheckOn` includes `compact`.
- Always return `{ ...r, watchPaths: [...(r.watchPaths ?? []), ...watchList] }`. `watchList` holds absolute paths: `.claude/gate.json`, each `.cursor/rules/*.mdc` that exists, the `.claude/prompt/*.prompt.tsx` files, and the `scripts/**` files the config names. PROBE item 5 decides whether a directory entry works.

**`session.end`** with matcher `{ reason: 'clear' }` → `resetConversationState($)`, then `next(e)`. The chain shares a 1.5 s bound, so keep it to state writes only.

`resetConversationState`: `seen = []`, `budgetsFired = []`, `gateState = { turn: 0 }`, `recentPaths = []`, `agentTiers = {}`, `brief = null`, `health = null`. `manual`, `gate`, `trust` and `log` are kept, and a log entry `{ trigger: 'clear' }` is pushed. If PROBE item 4 shows that `$.state` does not survive `/clear`, this reset is a harmless no-op.

**`session.compact`** (no matcher). When `e.trigger === 'precompute'`, return `next(e)`. Otherwise call `next({ ...e, instructions: [e.instructions, keepText(gate, seen)].filter(Boolean).join('\n\n') })`, where `keepText` lists the active profile, tier and delivered rule ids. After `next` resolves, set `manual.recheck` when `recheckOn` includes `compact`, and push the log entry `{ trigger: 'compact' }`.

**`command.run`** with matcher `{ command: 'gate' }`. `cmd = gatecmd.ts parseGateCommand(e.args)` dispatches as follows:

- status (no args) → `{ text: formatStatus }`, built from `decide.ts statusLine(gate, { ctxPct })` plus the on/off lists.
- `<profile>` / `+g` / `-g` / `off` / `auto` → `update(manual, …)`, then `recompute($, 'manual')` (see below), then `{ text }`.
- `new` → `manual.recheck = true`.
- `shadow` / `apply` → `manual.mode`.
- `why` → `$.ui.open({ id: 'gate-why', title: 'gate why' })`, then `{ text: formatWhy(log, 50) }`. `why off` → `$.ui.close({ id: 'gate-why' })`.
- `rules` → the delivered rules from `seen`, grouped by agent.
- `health` → `health.ts formatHealth(computeHealth(…))`.
- `build` → `buildAll($, { force: true })`, whose errors go to the pane.
- `trust revoke` → `$.store.delete('trust:'+key)` and `trust.decision = 'unknown'`.
- An unknown subcommand → `{ text: usageLine… }`.

**`command.run`** with matcher `{ command: 'rule' }` → layer 1, `/rule <id>`.

**`recompute($, trigger)`** is the one place that calls `decideGate`:

```ts
const { gate, state, log } = decideGate(config, signals, gateState, items, { recheck, recheckReason, prevModel, evalExpr, now })
await update($, gateAtom, () => json(gate)); await update($, gateStateAtom, () => json(state))
await update($, logAtom, buf => pushLog(buf, json(log)))          // journal.ts, 200 entries
if (setChanged(prev, gate)) { $.ui.invalidate('prompt.attachment'); $.ui.invalidate('tool.describe') }
```

- `signals: Signals` is built from `manual`, `recentPaths`, the branch, `model`, the classifier proposal and `data`.
- **Branch:** `$.session.repo()` has no branch. Read `await $.fs.read(join(repo.root, '.git/HEAD'))` and take what follows `ref: refs/heads/`. A worktree's `.git` file holds a `gitdir:` line, so follow it once. Fall back to `$.process.run(['git','branch','--show-current'])`, which is a read-only host git and needs no trust.
- In `mode === 'shadow'` (from `manual.mode ?? options.mode ?? config.classify.mode`), the classifier result only lands in `gate.proposed`, and the adapter marks the stored decision `shadow: true` and filters nothing (see "Shadow mode" below). `decideGate` never applies anything itself.
- With `config.log.file`, append the JSONL to `.claude/gate.log.jsonl`. There's no append API, so keep an in-module buffer and flush it with `$.fs.write` every N entries and on `session.end`.

### Layer 1: cursor-rules

`ensureRules($)`: `$.fs.list(join(root, '.cursor/rules'))`. With `cursorRules.nested`, walk the subdirectories too: `$.fs.list` isn't recursive, so skip `node_modules` and `.git`, and cap the depth at 6. For each `*.mdc`, `parseMdc(text, { path, id, dirPrefix })` (with `ruleIdFromPath`) → `MdcRule[]`, then `ruleToItem` builds the items. The cache key is the sorted list of `name:mtimeMs`. When the key changes the cache rebuilds; it is checked on `prompt.context`, on `classic.FileChanged`, and at most once per 2 s from `tool.call`.

**`prompt.context`** (no matcher). It runs once per conversation and again after compaction or `/clear`.

1. `seen = []`, so rules are re-delivered after compaction.
2. Re-check the rule and prompt mtimes (`$.fs.stat(...).mtimeMs`).
3. `r = await next(e)`. Take the always rules that are `on` in `gate.rules` (or all of them when the gate is off or not configured) and run `packInjections(always, cursorRules.maxCharsPerInjection)`.
4. When `e.instructionFiles !== undefined`, return `{ ...r, instructionFiles: [...(r.instructionFiles ?? e.instructionFiles), ...always.map(rule => ({ path: join(root, rule.path), kind: 'project', content: rule.body }))] }`. The engine frames these files the way it frames CLAUDE.md, after the project's own files. Otherwise, insert the block `{ name: 'cursorRules', text: packed.text }` right after the `claudeMd` block in `r.blocks`.
5. Add `main:<id>` to `seen` for every included rule. Rules in `packed.deferred` stay unseen and appear only as pointer lines.

**`tool.call`** with matcher `{ tool: ['Read', 'Edit', 'Write', 'NotebookEdit'] }`.

```ts
const file = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
const rel = normalizePath(file, root, { windows })
pushRecent(rel)                                    // recentPaths, cap 50 (also a layer-2 signal)
// strictWrite: Write to a new file (await $.fs.exists(file) === false) with an unseen matching auto rule
//   → return { deny: frameRule(rule) + 'Повтори запис з урахуванням правила.' }   (no next)
const r = await next(e)
if (r.deny !== undefined || r.isError) return r
if (e.tool === 'Read' && isPartialReadResult(e, r)) return r   // isPartialRead(e) || result.file.truncatedByTokenCap || result.type === 'file_unchanged'
// a Read of a .mdc file itself counts as delivering that rule only when it was not partial
const agent = e.agentId ?? 'main'
const hits = autoRules.filter(rule => matchAny(rel, rule.globs, rule.negGlobs, { windows }) && !seen.has(`${agent}:${rule.id}`))
if (hits.length === 0) return r
const packed = packInjections(hits.map(rule => ({ ...rule, body: frameRule(rule) })), maxChars)
seen += packed.included.map(id => `${agent}:${id}`)
return { ...r, context: [...(r.context ?? []), packed.text] }
```

Keep `r` whole: spreading the object keeps `ref`, so core reuses its own messages.

**`prompt.submit`** (no matcher, shared with layer 2; one hook for both, in `gate.ts`). `extractPromptFlag(e.text)` handles `[gate:x]` and gives back the stripped text plus the flag. `extractMentions(text)` gives the `@path` and `@ruleId` mentions. Paths go to `recentPaths`, and the auto rules matching them are packed as for `tool.call`. A mention of a manual rule id adds `frameRule(rule)`. The result is `next({ ...e, text, context: [...(e.context ?? []), ...ruleBlocks, ...gateBlocks] })`. Context must be attached **before** `next`.

**`/rule <id>`**: find a manual or agent rule by id. Return `{ text: 'Застосовано правило <id>', context: [frameRule(rule)] }`, add `main:<id>` to `seen`, and push the log entry `{ kind: 'rule-delivered' }`. An unknown id returns the usage line plus the list of manual ids.

**`classic.FileChanged`** (no matcher; filter `e.file_path` yourself). A `.mdc` path drops the rules cache. `gate.json` drops the config cache and runs `recompute($, 'config')`. A `.prompt.tsx` or `scripts/` path starts the incremental build (layer 3). The hook then returns `next(e)`.

### Layer 2: skill-gate

`ensureItems($)` collects items from three sources:

- `parseSkillListing` → `skillListingItems`, fed by the listing text captured in the attachment hook below.
- `$.tool.list()`, where `mcp: true` gives `kind: 'tool'`.
- `$.agent.list()` plus the agent names seen in `agent.offer`.

The rules come from layer 1. The result is normalized with `items.ts normalizeItems`.

**`prompt.submit`**: signals. After the layer 1 work, the first prompt of a task (`gateState.turn === 0` or `manual.recheck`) triggers the classifier when `config.classify` is set, unless `manual.profile` or a `when` match already decided. The classifier runs as follows:

```ts
const r = await $.model.complete({ model: config.classify.model ?? 'haiku', maxTokens: 64, timeoutMs: 8000,
  system: CLASSIFY_SYSTEM /* answer JSON {"profile": one of [...], "confidence": 0..1} */, prompt: text.slice(0, 4000) })
const parsed = r.isAnswered ? parseClassify(r.text, profiles) : undefined   // fallback: $.model.classify(text, labels) → confidence = minConfidence - 0.01
```

Then `recompute($, 'prompt')`, which increments `gateState.turn`. When `brief` is on and the tier is in `config.brief.tiers`, and the brief cache for this task is missing, a brief is generated through `$.model.complete({ model: config.brief.model ?? 'opus', … })` → `brief`. This step is optional, sits behind `options.brief`, and runs in the background with the result injected on the next prompt.

**`turn.step`** (no matcher, an observer). It **must** be an async generator:

```ts
on('turn.step', async function* ($, e, next) {
  if (e.agentId === undefined && e.model !== (await read($, model))) { /* tierForModel → update(model,tier); recompute($,'model-change') */ }
  if (e.agentId !== undefined && !(e.agentId in agentTiers)) { /* agentTiers[e.agentId] = tierForModel(config, e.model).tier */ }
  const res = yield* next(e)
  // health: res.usage?.cache_read_input_tokens vs input → stablePct estimate
  return res
})
```

Do no slow work here. State writes are fine.

**`prompt.attachment`** with matcher `{ type: 'skill_listing' }`. Cache `e.text` (the item source). When the gate is off or undecided, return `next(e)`. Otherwise call `renderSkillListing(parseSkillListing(e.text), gate.items)` and return `{ text }`. `nameOnly` entries keep the name without a description, and `off` entries are dropped. When the parse fails (an unknown format), log `H009` and return `next(e)`. A listing for a subagent (`e.agentId`) uses that agent's tier. The answer is cached per attachment; `recompute` invalidates it.

**`tool.describe`** with matcher `{ tool: /^mcp__/ }`. Our own tools (`/^mcp__context-gate__/`) return `next(e)`. Otherwise, when `gate.items['tool:'+e.tool] === 'off'`, return `{ description: denyText('tool', e.tool, gate, config), isDeferred: true }`, where the description is one line ending in «вимкнено профілем … /gate +group». Everything else returns `next(e)`.

**`tool.call`** with matcher `{ tool: /^mcp__/ }`. Our own tools are served by the layer 3 handlers. A gated-off tool gets `{ deny: denyText('tool', e.tool, gate, config) }` without `next`, and the log entry `{ kind: 'deny' }` is pushed (it counts toward `H010`). Everything else returns `next(e)`.

**`tool.call`** with matcher `{ tool: 'Skill' }`. Store `skillArgs.set(e.skill, e.args ?? '')`. A skill decided `off` gets `{ deny: skillOffText(e.skill, gate, config) }` before it loads. Otherwise return `next(e)`.

**`skill.prompt`** (no matcher). Decided `off` → `{ text: skillOffText(e.skill, gate, config) }`. Our own prompt skill (one with a compiled `skill`) → `args = skillArgs.get(e.skill) ?? argsFromText(e.text)` → `parseArgs(args, spec)`. A parse error returns `{ text: usage section }`. Otherwise `renderPrompt(skill.body …)` with `scope.args` and gives `{ text }`, and the log entry `{ kind: 'skill-render' }` is pushed. Everything else returns `next(e)`. PROBE item 3 decides how the `` !`…` `` line is handled.

**`agent.offer`** (no matcher). `gate.agents.off.includes(e.agent)` → `{ isOffered: false }`, otherwise `next(e)`. This is post-MVP and sits behind apply mode.

**`session.measure`** (no matcher) and **`turn.complete`** (main loop only, `e.agentId === undefined`). `pct = e.context.percent` (on `turn.complete`, read `(await $.session.usage()).context.percent`) → `update(ctxPercent)`. Thresholds come from `budgetFor(config, tier)`. On a threshold crossing not yet in `budgetsFired`:

| `onExceed` action | Effect |
| --- | --- |
| `section` | `budgetsFired` gets the threshold; the section turns on at the next `prompt.compose` (scope `ctx.budget`) |
| `notice` | `$.ui.toast(text.replace('{pct}', pct), { timeoutMs: 10000 })` plus `$.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })` for a lasting transcript line. **Not `$.ui.notice`**, which is tool-dialog only |
| `compact` | `$.clock.after(0, () => $.session.compact({ instructions }).catch(log))`, because it rejects while a turn runs |

Both hooks return `next(e)`.

### Layer 3: the prompt DSL

**Build.** In `session.start` (background) and in `/gate build`:

1. `ensureTrust($)` (see Trust).
2. For each `.claude/prompt/**/*.prompt.tsx`, compare `$.fs.stat(src).mtimeMs` with `.compiled/<id>.json` (the stat and its `sourceHash`).
3. When anything is stale: `$.process.run(['node', join($.plugin.root, 'dist/cli.js'), 'build', '--json'], { cwd: root, timeoutMs: 30000 })`.
4. `exitCode !== 0` → keep the old `.compiled`, log `H013`, and show the first 3 diagnostics in a toast. A rejection (no `node`, a timeout) is handled the same way, with a hint.

Markdown prompts (`.claude/prompt/*.md`) need no build: `mddsl.ts parseMarkdownPrompt` runs in-process.

**`prompt.compose`** (no matcher):

1. When `e.traits` includes `bare`, or `analysis` with no cache, return `next(e)`.
2. `r = await next(e)`.
3. Check mtimes for staleness. A synchronous rebuild runs only when it fits in 2 s (`timeoutMs: 2000`); otherwise the previous `.compiled` stays and `H013` is logged.
4. `result = renderPrompt(sections, scope, host, { tier, … })` (render.ts), where `scope` holds `gate`, `ctx: { percent }`, `session: { model: e.model }`, `cursor` and `data`, and `host` is the `RenderHost` from `host.ts`.
5. Map each `RenderedSection` with `included` to `{ id: 'context-gate:' + s.id, text: s.text, scope: 'session' }`. The DSL `scope` only orders the sections (static, then profile, then volatile, plus `after`). Every one is `session`, because `shared` text is cached across organisations and must stay engine-only.
6. Return `{ sections: [...r.sections, ...ours] }`. When a DSL section declares `replace: '<engine id>'`, swap it in place, provided the shared/session order still holds.
7. Write `health` (`computeHealth` → hashes and stable share), and push the log entry `{ kind: 'health' }` when a code fires.

**`RenderHost`** (`host.ts`):

- `readFile(p)` → `$.fs.read(join(root, p)).catch(() => undefined)`.
- `run` → trusted plus `options.allowScripts` plus the executor binary on the user whitelist → `$.process.run(argv, { cwd: root, stdin, timeoutMs })`. A rejection maps to `{ exitCode: -1, stdout: '', stderr: String(err), ms }`.
- `call` → the language shim through `run`.
- `mcp` → `$.mcp.call(server, tool, args)` (trusted only) → `structuredContent ?? text of content`.
- `cacheGet` / `cacheSet` → `$.store` under `cache:<repoKey>:<key>`. Mind the 4 MiB total: entries carry an LRU of `at` values.
- `itemBody` → layer 1 rules plus the skill bodies from `$.fs.read('.claude/skills/<n>/SKILL.md')`.
- `now` → a value captured once per dispatch from `await $.clock.now()`, because the interface is synchronous.
- `trusted` → `trust.decision === 'trusted'`.

Untrusted runs render as `unverified` stubs inside the core.

**Our tools.** `tool.call` with matcher `{ tool: /^mcp__context-gate__/ }`: parse with `parseArgs(e /* object */, spec)` (the `parseArgsObject` path), render the skill body, and return `{ result: text }`. Lazy includes (`registerLazy`) use the same path under `get_<name>`.

### Trust (SPEC Р2)

`ensureTrust($)`:

1. `key = repo.root + '|' + (repo.remote ?? '')`.
2. `options.trustBuild === 'always'` → trusted; `'never'` → denied.
3. Otherwise read the stored `$.store.get('trust:'+key)`. When `commandsHash` matches `hash(config commands)`, take its decision.
4. Otherwise, when interactive (`session.start` `e.isInteractive`, kept in the module), ask with `await $.ui.ask('Зібрати промпти й дозволити скрипти з цього репозиторію?', ['Так, довіряю', 'Ні'])`. Compare the answer to the labels exactly. A rejection (dismissed, or `-p`) counts as "unknown for now" and is not stored.
5. Store the answer and update `trust`.

Until a repo is trusted, only plugin modules and file reads run.

### UI

**`ui.render`** with matcher `{ component: 'AbovePrompt' }`. When `e.props.hasSurvey`, return `next(e)`. Otherwise read the atoms `gate`, `tier`, `ctxPercent`, `health` and `config` (each read subscribes) and build the line with `health.ts statusLine(...)`, or with `decide.ts statusLine(gate, { ctxPct })` until `health.ts` lands. The line looks like `gate frontend · tier standard · skills 5/23 · mcp 2/6 · rules 3 · ctx 38%`, with `(frontend?)` in shadow mode. Draw it as `Text({ children, wrap: 'truncate', color: pct >= soft ? 'warning' : undefined, dimColor: pct < soft })`, sized to `e.props.bodyColumns`. Do no `$.state.set` here.

**`ui.render`** with matcher `{ component: 'Pane', requestId: 'gate-why' }`. Show the last `log` rows that fit `e.viewport?.rows`, as a table of turn, trigger, profile, changes and reason. Under it list the `health.sections` (id, chars, scope). In shadow mode there's a Button `{ key: 'apply', label: 'Застосувати запропонований профіль', onPress: () => applyProposed($) }`, plus `{ key: 'auto', label: 'Скинути до auto' }`. Handlers write state with `update()`, since that's allowed outside the render.

In headless runs (`-p`), with no `AbovePrompt`: when `e.surface === null` on `session.start`, mirror the line into `$.ui.status(line)` instead. Desktop draws `AbovePrompt` too.

## Invalidation and prompt cache

The skill listing, the tool descriptions and `prompt.context` are cached by the engine. Call `$.ui.invalidate('prompt.attachment')` and `$.ui.invalidate('tool.describe')` **only** when `recompute` changes the effective set: compare the old and new `gate.items` maps. Hysteresis in `decideGate` keeps that rare. Never invalidate `prompt.context` mid-conversation, because it rewrites the first message and costs the whole cache.

## As built: what `claude plugin validate --strict` imposes

The validator (2.1.29x) reads the hooks module statically, and three of its rules shaped `hooks/`:

- **`$` never crosses an import.** `$` may be passed only to functions declared in the same file. So `hooks/register.ts` holds every hook and a `port($)` object that spells each engine call (`$.fs.read(path)`, `$.env.get('OS')`, ...). The layers in `hooks/layers/*.ts` are plain functions over that port (`io: Io`, `hooks/ctx.ts`) and the module runtime (`rt: Runtime`). `next` stays in `register.ts` too: layers return what to do, and the hook calls `next`.
- **One hook per event and matcher.** Events several layers share (`prompt.submit`, `tool.call` on file tools, `tool.call /^mcp__/`, `classic.FileChanged`, `session.start`) are composed in `register.ts` from layer functions (`gatesBeforeFile` → `rulesBeforeFile` → `next` → `gatesAfterFile` → `rulesAfterFile`).
- **State refs are consts of the hooks file.** The 15 atoms live in `register.ts` (`readState` / `updateState` switch on the key); layers use `io.read('gate')` / `io.update('seen', fn)`. `state.ts` keeps `INITIAL` and the helpers. A `.catch` handler must be a top-level function of that file (`pass`).

`hooks/tsconfig.json` sets `noUncheckedIndexedAccess: false`, because the core (`packages/core/src`) is compiled into the module and is not written for it. Tests live in `hooks/*.test.ts` with an in-memory repository in `hooks/testkit.ts`. `$.ui.ask` is not an op the test kit can answer, and a test's `session.append` hook does not see a plugin's `$.session.append`.

## As built: what the mod shares with the CLI

The mod and `context-gate` render the same prompts the same way because both call the same core functions:

- **Assembly** (`packages/core/src/assemble.ts`): `assemblePrompts` (compiled prompts sorted by id, then Markdown in path order; `<id>.<tier>.md` variants replace their section for the tier; skill prompts apart), `buildScope` (the render scope: `gate`, `git`, `fs`, `cursor`, `session`, `ctx`, `budgets`, `args`, `data`, then providers, never overriding builtins), `skillArgs` / `usageText` for prompt skills. `hooks/layers/dsl.ts` keeps only the port work (listing `.claude/prompt`, reading files, the gate from state). `test/mod-parity.test.ts` renders one fixture through `composeSections` over a fake port and through `runCommand({ markers: false })` and compares the bytes.
- **Callables**: `cursor.match(path)` (core `cursorMatch` → `ruleMatches`) and `fs.examples(glob, n)` (core `selectExamples` + `exampleValue`) on both hosts; `cursor.always | auto | agent | manual` are scope lists.
- **Cursor glob matching**: core `mdc.ts ruleMatches(rule, path, { nocase })` / `autoRulesFor`: a slash-less glob matches the basename at any depth, `!` globs exclude, nested rule dirs are prefixed by `parseMdc`. The mod, the hooks adapter and the CLI use it, with `nocase` from `detectWindows`.
- **Script tools**: core `toolheader.ts parseToolHeader` (`# gate-tool:`, `# input:` shorthand → JSON Schema).
- **Binary whitelist**: core `binaryWhitelist(user, repo)`: `~/.claude/context-gate.json` `allowBinaries` (default `DEFAULT_BINARIES`) narrowed by gate.json `allowBinaries`.
- **Diagnostic codes**: every code any package emits is in `packages/core/src/codes.ts` (`test/codes.test.ts` scans the sources).

### Shadow mode

`decideGate` only decides; applying is the adapter's call. With `classify.mode: "shadow"` (or `/gate shadow`) and no manual signal, `recompute` stores the decision with `gate.shadow = true`, drops `profile` and keeps the proposal in `gate.proposed`. Nothing is filtered: the skill listing, tool descriptions, MCP calls and agents pass through, and Always/Auto rules are delivered as without a gate. The band and `/gate` show `gate (frontend?) · … · skills 30/30 · mcp 6/6` (core `statusLine` counts everything as on in shadow), and `/gate` labels the off lists «пропозиція, не застосовано». `/gate apply` or a manual `/gate <profile>` applies. The hooks adapter does the same (`isApplied` false → deny decisions are only logged).

### Journal snapshots (`log.file: true`)

With `log.file`, each `prompt.compose` whose render changed appends one `snapshot` entry to `.claude/gate.log.jsonl`, and each prompt-skill render appends a `skill-render` entry. The contract lives in core `journal.ts`:

```
{ kind: 'snapshot', trigger: 'compose', tier, profile?, data: { sessionId, model, ctxPercent, tier, profile, scope?, text? } }
{ kind: 'skill-render', trigger: 'skill', tier, data: { sessionId, model, ctxPercent, skill, args, ms, chars, status } }
```

`scope` is our render scope (no user prompt text; `args` stripped), dropped beyond 40 000 JSON chars; `text` is our rendered system-prompt text, cut at 20 000 chars. Snapshots go to the file only (never the 200-entry state ring), and the file keeps the last 20. The CLI reads them with core `findSnapshot`: `context-gate run --ctx-from session:latest|<id>` renders against the snapshot scope (and the last skill `args`), `run --diff session:…` diffs against its `text`.

### Builds

The mod runs `node <plugin>/dist/cli.js build --only <repo-relative .prompt.tsx>`; `--only` also takes a prompt id.

## Tests (`hooks/*.test.ts`, `npm run test:mod`)

The test body is `test(name, async ($, on) => …)`. `$` calls take the whole event input, e.g. `$.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })`. The test's own `on` hooks sit beneath the plugin and stand for the engine. Any `$` op the plugin calls during the test must be answered there, with an op result shaped `{ value }`:

- `on('command.register', ($, e) => ({ value: { command: e.name } }))`
- `on('fs.read', …)`, `on('fs.list', …)`, `on('fs.stat', …)` with an in-memory repo fixture
- `on('session.start', ($, e) => ({ cwd: e.cwd }))`

Cover these:

- the four rule types through `$.tool.call({ tool: 'Read', file_path })`, checking the result's `context`
- dedup per `agentId`
- partial reads
- the MCP deny
- the `skill_listing` rewrite (`$.prompt.attachment({ type: 'skill_listing', text: FIXTURE, origin: { kind: 'engine' } })`)
- `/gate` subcommands
- the band on `terminal` and `desktop` through `$.ui.mount`

`scripts/plugin-test.sh` stages `.claude-plugin`, `hooks`, `types` and `packages/core/src` into a temp folder. At the repo root, `claude plugin test` would also load the `node:test` files in `test/` and fail them.
