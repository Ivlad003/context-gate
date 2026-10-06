# context-gate

**A runtime and DSL for Claude Code context.**

[Українська](README.uk.md)

`context-gate` is one Claude Code mod plugin (Claude Code ≥ 2.1.287) that controls what reaches the model's context:
Cursor `.mdc` rules, skills, MCP tools, subagents and the system prompt itself. Configuration lives in `.claude/` and
is committed, and the session state lives in the mod. The full design is in [`docs/SPEC.md`](docs/SPEC.md)
(Ukrainian); [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the consolidated layer-3 map.

## Install

```text
/plugin marketplace add <owner>/context-gate      # the GitHub repo, or a local clone: /plugin marketplace add ./context-gate
/plugin install context-gate@context-gate
```

The marketplace lives in this repository (`.claude-plugin/marketplace.json`, marketplace `context-gate`, plugin
`context-gate`). The plugin ships its built CLI
(`dist/cli.js`), so nothing has to be built after install; only `node` (≥ 22.18) has to be on `PATH`.
Compiling TSX prompts (`build`) also needs `esbuild`: the CLI takes it from the repository's `node_modules` (`npm i -D esbuild`)
or from the plugin after `npm --prefix "${CLAUDE_PLUGIN_ROOT}" ci --omit=dev`; everything else, `run` and skill prompts included,
works without it. Markdown prompts need no build.

The same CLI is published to npm as `context-gate` (TSX components: `@context-gate/jsx`):

```bash
npx context-gate init          # .claude/gate.json with profiles guessed from the repo, classify: shadow
```

## Quick start

```bash
cd your-repo
npx context-gate init                # writes .claude/gate.json (+ .gitignore lines)
claude                               # the mod loads; the status line shows the gate
```

In the session:

```text
/gate                 status: profile, tier, how many skills / MCP tools / rules are on
/gate why             the decision journal: who chose the profile and why
/gate rules           every Cursor rule with its type, globs and whether it was delivered
/gate frontend        fix a profile for this session; /gate +docs adds a group, /gate auto goes back
/gate apply           leave shadow mode: the gate starts filtering
/gate health          prompt health metrics (H0xx) with a "what to do" column
```

Day one is **shadow mode**: nothing is filtered, `/gate why` shows what the classifier would have chosen. After a
week, `npx context-gate report` summarises the journal, and `/gate apply` turns the gate on.

## The three layers

| Layer | What it does | Where |
| --- | --- | --- |
| 1. cursor-rules | `.cursor/rules/*.mdc` with Cursor semantics: Always rules go in after CLAUDE.md, Auto Attached rules arrive as context after the tool result of a matching Read/Edit/Write, Agent Requested rules become skills, Manual rules come in with `@id` or `/rule <id>`. Per-agent dedup, partial-read check, `strictWrite`. | `hooks/layers/cursor-rules.ts`, `packages/core/src/mdc.ts` |
| 2. skill-gate | Picks the skills, MCP tools and subagents for the task and the model: profiles built from groups, tiers by model, `when` signals (paths, branch, ticket type, expressions), a classifier once per task with hysteresis, budgets, escalation. Off items get a one-line description and `{ deny }` with "enable with `/gate +group`". | `hooks/layers/skill-gate.ts`, `packages/core/src/decide.ts` |
| 3. prompt DSL | The system prompt as TSX (or Markdown with `@` directives) compiled into a total AST, rendered on `prompt.compose`: conditions, loops, scripts (`Run`, `Call`), includes (`inline`/`ref`/`lazy`), tier variants. Static parts stay stable for the prompt cache. | `packages/jsx`, `packages/core/src/render.ts`, `hooks/layers/dsl.ts` |

A minimal prompt, `.claude/prompt/main.prompt.tsx`:

```tsx
import { Prompt, Section, Each, Tier, Run, V } from '@context-gate/jsx'

export default (
  <Prompt>
    <Section id="identity" scope="static">You are a senior TypeScript engineer on this repository.</Section>
    <Section id="rules" scope="profile" budget={4000}>
      <Each of="cursor.always" as="r"><li><V expr="r.body" /></li></Each>
    </Section>
    <Section id="workflow" scope="profile">
      <Tier is={['quick', 'standard']}>Plan 3–6 steps, show the plan, run the tests after every edit.</Tier>
    </Section>
    <Section id="repo-state" scope="volatile">
      <Run lang="bash" cache="5m" as="log">git log --oneline -5</Run>
      Recent commits: {'{{ log }}'}
    </Section>
  </Prompt>
)
```

```bash
npx context-gate build                      # → .claude/prompt/.compiled/main.json
npx context-gate run --trace --dry-scripts  # what the model gets, with a trace table
```

## `.claude/gate.json` reference

JSON Schema: [`schema/context-gate.schema.json`](schema/context-gate.schema.json). A complete example:
[`examples/basic/.claude/gate.json`](examples/basic/.claude/gate.json); a monorepo with 12 rules, 20+ skills and
3 MCP servers: [`examples/reference/`](examples/reference/).

| Field | Meaning |
| --- | --- |
| `groups` | group → kind-prefixed globs: `skill:react-*`, `tool:mcp__figma__*`, `agent:ui-reviewer`, `rule:api-*` (legacy `skillGroups`/`mcpGroups`: `context-gate migrate`) |
| `tiers` | `premium` / `standard` / `quick` (any names): `groups`, `preload` (skill bodies inlined for weaker models), `thresholds` |
| `models` | model id glob → tier, or attributes `{ match, tier?, contextWindow, costPer1k }` |
| `profiles` | name → `groups` plus `when`: `paths`, `branch`, `ticketType`, `expr` over providers |
| `classify` | `mode: shadow \| auto`, `model`, `minConfidence`, `recheckOn`, `provider: builtin \| jev \| { kind: cli }` |
| `budgets`, `onExceed` | `softContextPct` / `hardContextPct` per tier; actions `section`, `notice`, `compact` |
| `escalation` | `order` of tiers and `after: { verifyFailed, stallTurns }` → `escalation-suggested` in the journal |
| `brief` | a task brief written once per task by a strong model for weaker tiers |
| `providers` | named data sources for the DSL: `cli` (JSON stdout), `file`, `mcp`, `module`; `schema`, `cache`, `onError`, `functions` |
| `executors` | how `Run`/`Call` start a language (`python3`, `node`, `bash`, `deno`, …) |
| `itemSources` | item sources: `cursor-mdc`, `markdown-dir`, `provider` (`field`, `as`, `template`), `claude-skills`, `claude-tools` |
| `gates` | deterministic checks: `on: write \| commit \| turn \| prompt`, `run` or `provider`, `pass` expression, `message` template, `onlyNew` + `baseline`, `tiers`; builtin `read-before-write` |
| `cursorRules` | `enabled`, `nested` (rules in sub-package `.cursor/rules`), `maxCharsPerInjection`, `strictWrite` |
| `prompt` | `dir`, `runCacheDefault`, `build: auto \| never`, `commitCompiled`, `persist` |
| `health` | thresholds per code (`H001`: 12000, …) |
| `debug`, `debugLog`, `assertFail` | `@debug` evaluation and `.claude/gate.debug.log` (1 MB), a false `@assert`: `skip` or `fail` |
| `env` | env vars visible to the DSL as `env.*`, masked as `***` in debug output |
| `allowBinaries` | narrows the user's binary whitelist (`~/.claude/context-gate.json`); never widens it |
| `log` | `file: true` also writes `.claude/gate.log.jsonl` (shared with the shiftwork runner) |

Provider and gate adapters for keylang, `tsc` and eslint: [`examples/providers/`](examples/providers/).

## CLI reference

`context-gate <command> [flags]`; `context-gate <command> --help` for each one. Global flags: `--root <dir>`,
`--trust-repo`. Exit codes: 0 ok, 1 failure, 2 bad arguments.

| Command | What it does |
| --- | --- |
| **Prompts** | |
| `build` | compile `.claude/prompt/*.prompt.tsx` into `.compiled/*.json`, `prompt.lock.json` and SKILL.md |
| `run` | render the prompt, one section (`--only`) or a skill (`run <skill> --args "…"`) with the same core as `prompt.compose`; `--trace`, `--json`, `--dry-scripts`, `--ctx-from session:latest\|fixture.json`, `--diff`, `--watch`, `--debug` |
| `render` | render sections, or one section: `render prompt://<id>` |
| `health` | prompt health metrics H0xx; `--json` for CI, `--strict` exits 1 over a threshold |
| `fmt` | align `@` directives in Markdown prompts |
| `expand` | generate quick/standard variants of canonical sections into `proposals/` |
| `explain <code>` | explain a diagnostic code (`G0xx`…`G5xx`, `H0xx`, `D0xx`) |
| `index` | write `.claude/gate.index.json` for the editor |
| **Repository** | |
| `init` | create `.claude/gate.json` from the repo structure (`classify: shadow`) and `.gitignore` lines |
| `migrate` | convert legacy `skillGroups`/`mcpGroups`/`ruleSources` into `groups`/`itemSources` |
| `sync` | the fallback without mods: `.mdc` → `.claude/rules/cursor/` and skills, profile → `skillOverrides`, DSL → `.claude/prompt.generated.md`; `--watch` |
| `example skills` | copy the example skill prompts into `.claude/prompt/` |
| `trust` | trust for the repository (Р2): processes, cli/module providers, `@run`/`@call` |
| `data` | the script data store `data.*` |
| `schema infer <provider>` | draft a provider JSON Schema from a real run |
| `tools` | model tools from `.claude/prompt/scripts` (`# gate-tool:` headers) |
| **Pipeline (JSONL)** | |
| `pipe "<stages>"` | the whole pipeline in one line, the `/gate` grammar: `collect \| decide --profile x \| tokens` |
| `collect`, `normalize`, `signals`, `decide`, `budget`, `deliver --dry-run`, `observe` | pipeline stages |
| `where`, `tokens`, `on`, `off`, `why`, `take`, `sort`, `preview` | filters and views |
| **Journal** | |
| `report` | journal summary: `when` vs classifier vs manual, denies per tool with "add group X to profile Y" suggestions, rules never delivered, escalations, attempts and tokens per tier per task, runner vs mod by ticket, skill-prompt render cost |
| `bench` | prompt and item tokens before/after the gate, `unverified`, over `bench/repos.json` |

## Hooks and calls

What `claude plugin validate --strict .` reports for the mod (regenerate with `scripts/validate-calls.sh --markdown`;
CI fails when a `$` call outside [`scripts/expected-calls.txt`](scripts/expected-calls.txt) appears).

| Hook | Purpose |
| --- | --- |
| `session.start` | read `gate.json`, register `/gate` and `/rule`, build stale prompts, status line |
| `classic.SessionStart` | `watchPaths` for `.cursor/rules`, `gate.json`, prompts; reset after `/clear`, recheck after compact |
| `session.end` | state reset on `/clear` |
| `session.compact` | instructions that keep the active profile and rules |
| `classic.FileChanged` | rule cache drop, config reload, incremental prompt build |
| `command.run{command=gate}`, `command.run{command=rule}`, `command.run` | `/gate …`, `/rule <id>`, skill args from `/name args` |
| `prompt.context` | dedup reset; Always rules as instruction files after CLAUDE.md (or a `cursorRules` block) |
| `prompt.submit` | `@rule`, `@file` → Auto Attached rules, `[gate:x]`, signals, first-prompt classifier, brief, `prompt` gates |
| `prompt.attachment{type=skill_listing}` | rewrite the skills listing for the gate |
| `tool.call{tool=Read\|Edit\|Write\|NotebookEdit}` | glob rules after the result, `strictWrite`, `write` gates, read-before-write |
| `tool.call{tool=Bash}` | `commit` gates on `git commit`, failed test/lint runs count for escalation |
| `tool.call{tool=Skill}` | skill args for `skill.prompt`; disabled skills |
| `tool.call{tool=/"^mcp__"/}` | `{ deny }` for MCP tools outside the profile; serves the plugin's own tools (lazy includes, script tools) |
| `tool.describe{tool=/"^mcp__"/}` | one-line description and `isDeferred` for gated-off MCP tools |
| `agent.offer` | hide subagents outside the profile |
| `skill.prompt` | off text for a disabled skill; prompt-skill render with args |
| `turn.step` | model and agent → tier recompute; prompt-cache usage |
| `turn.complete` | `turn` gates, stall counter, budgets, escalation, journal flush |
| `session.measure` | context percent, budgets, status line |
| `prompt.compose` | render the DSL sections as `context-gate:<id>` session sections |
| `ui.render{component=AbovePrompt}`, `ui.render{component=Pane, requestId=?}` | the band; the `/gate why` and health panes |

| `$` call | Why |
| --- | --- |
| `$.fs.read`, `$.fs.list`, `$.fs.exists`, `$.fs.stat` | `gate.json`, `.mdc`, `.compiled`, skills, mtimes |
| `$.fs.write` | `.claude/gate.log.jsonl`, `gate.debug.log`, baselines, `.trace/last.json`, `gate.index.json` |
| `$.session.root`, `.id`, `.model`, `.repo`, `.usage` | root, journal key, tier, branch fallback, context percent |
| `$.session.append`, `$.session.compact` | transcript notices; `onExceed: compact` |
| `$.state.get`, `$.state.set` | session state atoms (`context-gate.*`) |
| `$.store.get`, `$.store.set`, `$.store.delete` | per-repo trust, render cache, `data.*` |
| `$.tool.register`, `$.tool.list` | lazy-include and script tools; MCP servers of the session |
| `$.command.register` | `/gate`, `/rule` |
| `$.model.classify`, `$.model.complete` | the classifier (with confidence) and the brief |
| `$.process.run`, `$.process.spawn` | `@run`, cli providers, gates, the prompt build (trusted repos only); `/gate edit` |
| `$.mcp.call` | `@mcp` and `mcp` providers (trusted repos only) |
| `$.settings.read`, `$.env.get` | user binary whitelist and the `env` block; literal `HOME`/`OS` |
| `$.clock.after` | defer `$.session.compact` past the running turn |
| `$.ui.*` | `ask` (trust), `toast`, `status`, `log`, `open`/`close` panes, `invalidate`, `resolve` |

## Run modes

| Environment | What works | Replacement |
| --- | --- | --- |
| CLI, Desktop Code tab | everything | — |
| `claude -p` (shiftwork runner, CI agent) | hooks, `@run`, filtering; no `/gate` or panes | profile from `userConfig` or `[gate:<profile>]` in the prompt; `--trust-repo`; `--append-system-prompt` for preload |
| VS Code extension, cloud sessions | hooks without UI | as for `-p` |
| Claude Code < 2.1.287, `--bare`, `allowManagedModsOnly` | the mod does not load | `npx context-gate sync` (native `.claude/rules/cursor/`, skills, `skillOverrides`, `prompt.generated.md`) or the settings-hooks adapter `dist/hooks-adapter.js` ([docs/HOOKS-ADAPTER.md](docs/HOOKS-ADAPTER.md)) |
| Cursor (same repo) | — | `.cursor/rules` stay the source; Cursor reads `.claude/skills` itself |

The shiftwork runner reads the same `gate.json` and the same journal ([docs/SHIFTWORK.md](docs/SHIFTWORK.md)).

## Security model

- **The mod is not sandboxed** and runs with the user's rights, so code from a repository runs only after
  trust-on-first-use (Р2): one prompt per repository (path + remote), covering every `process.run` and `mcp.call`
  that the repository's configuration starts (the prompt build, `@run`/`@call`, cli providers, command gates,
  `@mcp`). Until then only file reads and the plugin's own module providers run, and script sections render as
  `unverified` stubs. `/gate trust revoke` drops it; a `gate.json` with new commands asks again; `claude -p` and CI
  need `--trust-repo`.
- **Binary whitelist** lives only in user settings (`~/.claude/context-gate.json`); a repository can narrow it
  (`allowBinaries`), never widen it.
- **No network** from the DSL: `$.http` is never called. Data reaches scripts through stdin as JSON.
- **Repository text is data.** `.mdc` and DSL files never become commands; provider results are data.
- **The classifier** gets only the prompt text and paths, never file contents.
- **The journal** holds metadata only (no prompt text, file contents or command output). Debug output masks the
  values of whitelisted `env` variables.
- **Organisation rules win:** every `deny` is answered in `tool.call`, never in `tool.check`, so `sec-default` and
  managed `PreToolUse` hooks go first.

## Development

```bash
npm ci
npm test                 # node:test unit tests (test/**/*.test.ts)
npx tsc -p tsconfig.json
npm run build            # dist/cli.js (committed: the installed plugin runs it)
npm run build:hooks-adapter
npm run typecheck:mod && npm run test:mod   # needs the claude CLI
npm run validate:mod     # claude plugin validate --strict .
scripts/validate-calls.sh                   # $ calls vs scripts/expected-calls.txt
scripts/e2e.sh           # one claude -p turn on examples/reference with probe/context-gate-probe
```

`dist/cli.js` and `dist/hooks-adapter.js` are committed; CI rebuilds them and fails on a diff. The live API probe
for the open mods-API questions is [`probe/`](probe/README.md); the static results are in
[`docs/PROBE.md`](docs/PROBE.md). Bench: [`bench/`](bench/README.md).

## License

MIT
