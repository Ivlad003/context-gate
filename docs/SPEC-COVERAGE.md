# SPEC coverage: `context-gate` vs `docs/SPEC.md`

Final audit: 2026-10-06, commit `30f4b3c` plus the cleanup pass and the mod wiring in the working tree. The first
audit (at `bc3e5ec`) listed 65 gaps; each was re-checked against the code (table below). Checks at this state:

- `npm test`: 465/465 pass. `npx tsc -p tsconfig.json`: clean.
- `npm run test:mod` (`claude plugin test`): 90/90 pass, three runs in a row. `npm run typecheck:mod`: clean.
- `claude plugin validate --strict .` passes on Claude Code 2.1.291. `scripts/validate-calls.sh`: ok.
- `npm run build:all`: builds `dist/cli.js` and `dist/hooks-adapter.js`.
- Live (`claude -p`, haiku): `scripts/e2e.sh` on `examples/reference` and `examples/basic` passes every check (Always
  rule, Auto Attached after Read, `@id` Manual rule, Markdown and compiled DSL sections, `[gate:x]` stripped, journal
  profile). Details and the probe points in docs/PROBE.md «LIVE results».

Rules applied:

- The Р1–Р7 decisions override earlier sections.
- Where `docs/PROBE.md` records a mods-API difference, the PROBE way counts as DONE.

## Summary

| Status | Count |
| --- | --- |
| DONE | 262 (197 from the first audit + the 65 former gaps) |
| PARTIAL | 0 |
| MISSING | 0 |
| N/A (out of scope, superseded by a Р-decision or PROBE, or operational) | 14 |
| **Total items** | **276** |

What is still open is operational, not code:

- **Interactive-only probe points** (G-62): whether `` !`…` `` has run before `skill.prompt`, `$.state` after
  `/clear` (the mod resets explicitly either way), `$.model.complete` latency/cost, `prompt.context` in subagents, and
  whether the model sees the rewritten skill listing. The mod lists the features resting on them under «Не перевірено
  наживо» in `/gate health` and `/gate why` (`hooks/layers/probe.ts`); flip `PROBE_POINTS` after a probe session.
- Markdown `file` providers: the CLI parses them into `{ meta, body, headings }`, the mod keeps the text.

## Re-audit of the former gaps (final)

Every item that was PARTIAL or MISSING at `bc3e5ec` was re-checked against the working tree after the WP1–WP6 commit
(`30f4b3c`), the cleanup pass (core `providers.ts`, `canonical.ts`, preload, `promptSectionDirs`, `commandGateDecision`,
the `gate-attempt` journal contract) and the mod wiring. "Was" is the old status; "Where" points at the implementation.

| ID | Area | Was | Now | Where |
| --- | --- | --- | --- | --- |
| G-01 | Configuration and unified model | PARTIAL | DONE | `packages/core/src/config.ts`, `types.ts`, `schema/context-gate.schema.json`. |
| G-02 | Configuration and unified model | MISSING | DONE | `hooks/layers/skill-gate.ts`, `packages/core/src/types.ts`, `config.ts`. |
| G-03 | Configuration and unified model | MISSING | DONE | env whitelist via `$.settings.read` (`hooks/layers/config.ts ensureEnv`); `envMask` masks the render trace (`renderOptions.secrets`), `$.ui.log` debug lines, `.claude/gate.debug.log`, `.trace/last.json` and journal snapshots (`hooks/layers/dsl.ts`); test `hooks/dsl.test.ts` «G-03 …» |
| G-51 | Configuration and unified model | MISSING | DONE | `packages/core/src/items.ts`, `mdc.ts`, `packages/cli/src/context.ts`, `hooks/layers/cursor-rules.ts`, `hooks/layers/skill-gate.ts`. |
| G-04 | Layer 1: cursor-rules | PARTIAL | DONE | custom `cursor-mdc` dirs and `nested`; edge case 6: `cursor-rules.ts checkRoot` drops the rule/config/prompt caches when `$.session.root()` moves; test `hooks/rules.test.ts` «a moved session root …» |
| G-05 | Layer 1: cursor-rules | PARTIAL | DONE | `hooks/layers/cursor-rules.ts`. |
| G-06 | Layer 1: cursor-rules | PARTIAL | DONE | `hooks/layers/cursor-rules.ts rulesReport`. |
| G-08 | Layer 2: skill-gate | PARTIAL | DONE | `hooks/layers/skill-gate.ts` (`listingAfter`, `mcpGate`). |
| G-09 | Layer 2: skill-gate | PARTIAL | DONE | `packages/cli/src/cmd-report.ts`, core `report.ts tierCosts`. |
| G-10 | Layer 2: skill-gate | PARTIAL | DONE | `hooks/layers/commands.ts`. |
| G-35 | Layer 2: skill-gate | PARTIAL | DONE | `hooks/layers/skill-gate.ts ensureItems`. `dsl.ts serveOwnTool` denies `off`. |
| G-11 | Layer 3: build through the mod | PARTIAL | DONE | compose-time build (2 s) and H013 in `hooks/layers/dsl.ts` |
| G-12 | Layer 3: build through the mod | PARTIAL | DONE | `hooks/layers/dsl.ts`. |
| G-13 | Layer 3: build through the mod | PARTIAL | DONE | `hooks/layers/dsl.ts`, `hooks/register.ts`. |
| G-14 | Layer 3: build through the mod | MISSING | DONE | `hooks/layers/ui.ts`, `hooks/ctx.ts`. |
| G-15 | Layer 3: build through the mod | PARTIAL | DONE | `hooks/layers/dsl.ts loadPrompts`. |
| G-16 | Layer 3: build through the mod | PARTIAL | DONE | `packages/cli/src/cmd-init.ts`. |
| G-18 | Layer 3: compiler, imports, language | PARTIAL | DONE | `packages/cli/src/build.ts`, `package.json`. |
| G-19 | Layer 3: compiler, imports, language | PARTIAL | DONE | `packages/cli/src/build.ts`. |
| G-20 | Layer 3: compiler, imports, language | PARTIAL | DONE | `packages/core/src/render.ts`. |
| G-21 | Layer 3: compiler, imports, language | PARTIAL | DONE | `packages/cli/src/build.ts validatePrompt`. |
| G-22 | Layer 3: compiler, imports, language | PARTIAL | DONE | `packages/cli/src/build.ts`, `build-main.ts`. |
| G-23 | Layer 3: compiler, imports, language | PARTIAL | DONE | `packages/cli/src/build.ts generateCtxTypes`, `packages/lsp/src/model.ts`. |
| G-24 | Layer 3: compiler, imports, language | MISSING | DONE | new `packages/jsx/src/transform.ts`, `packages/cli/src/build.ts`. |
| G-25 | Layer 3: compiler, imports, language | PARTIAL | DONE | `packages/jsx/src/components.ts`, `packages/core/src/mddsl.ts`. |
| G-26 | Skills as prompts | PARTIAL | DONE | `packages/cli/src/build.ts`. |
| G-27 | Skills as prompts | PARTIAL | DONE | `hooks/layers/dsl.ts renderSkill`. |
| G-28 | Skills as prompts | PARTIAL | DONE | `packages/cli/src/cmd-report.ts`. |
| G-29 | Script executors, function calls, data | PARTIAL (bug) | DONE | `hooks/layers/host.ts`. |
| G-30 | Script executors, function calls, data | PARTIAL | DONE | `hooks/layers/host.ts`. |
| G-31 | Script executors, function calls, data | PARTIAL | DONE | `hooks/layers/host.ts`, `packages/cli/src/shims.ts` → `packages/core/src/shims.ts`, `packages/cli/src/host-node.ts` (import only). |
| G-32 | Script executors, function calls, data | PARTIAL | DONE | `hooks/layers/host.ts`. |
| G-33 | Script executors, function calls, data | PARTIAL | DONE | `hooks/layers/dsl.ts`. |
| G-34 | Script executors, function calls, data | PARTIAL | DONE | `packages/core/src/render.ts`, plus both hosts (one line each). |
| G-36 | Script executors, function calls, data | MISSING | DONE | `packages/core/src/toolheader.ts`, `hooks/layers/dsl.ts`, `packages/cli/src/context.ts` (`tools`). |
| G-69 | Includes and lazy | PARTIAL | DONE | `hooks/layers/dsl.ts`. |
| G-38 | Debugging | MISSING | DONE | `packages/cli/src/cmd-run.ts`; `hooks/layers/dsl.ts`. |
| G-39 | Debugging | MISSING | DONE | `packages/core/src/render.ts`. |
| G-40 | Debugging | PARTIAL | DONE | `hooks/layers/dsl.ts`. |
| G-41 | Debugging | PARTIAL | DONE |  |
| G-42 | Prompt health | MISSING | DONE | `hooks/layers/gates.ts`, `packages/core/src/health.ts`. |
| G-43 | Prompt health | MISSING | DONE | mod `dsl.ts recordHealth` passes `compactions` (`rt.compactions`, reset on `/clear`) and `decision` (profile, classifier confidence, manual overrides); CLI `cmd-run.ts healthCommand` reads both from the journal since the last `clear` |
| G-44 | Prompt health | PARTIAL | DONE | `skillsNoDescription` from the captured skill listing (`parseSkillListing`) in `dsl.ts recordHealth` |
| G-45 | Prompt health | PARTIAL | DONE | `/gate` «звідки» lines (core `pipeline.ts itemProvenance`) |
| G-46 | User interface and editor | MISSING | DONE | `hooks/layers/commands.ts`, `hooks/register.ts`, `packages/core/src/gatecmd.ts`. |
| G-47 | User interface and editor | MISSING | DONE | `hooks/layers/ui.ts`, `commands.ts`, `register.ts`. |
| G-48 | User interface and editor | MISSING | DONE | `packages/core/src/pipeline.ts`, `packages/cli/src/cmd-pipe.ts`, `hooks/layers/commands.ts`. |
| G-49 | User interface and editor | MISSING | DONE | new `hooks/layers/index.ts`, `packages/cli/src/cmd-index.ts`, `hooks/register.ts`. |
| G-50 | User interface and editor | MISSING | DONE | `hooks/layers/dsl.ts`. |
| G-67 | User interface and editor | PARTIAL | DONE | `packages/cli/src/cmd-expand.ts`. |
| G-53 | Providers and gates | PARTIAL | DONE | `hooks/layers/gates.ts`. |
| G-54 | Providers and gates | MISSING | DONE | `hooks/layers/dsl.ts`. The CLI parity part goes in `packages/core/src/assemble.ts` after the integration. |
| G-55 | Report and escalation | PARTIAL | DONE | `packages/cli/src/cmd-report.ts`. |
| G-56 | Run modes and transpiler | MISSING | DONE | `packages/cli/src/cmd-sync.ts`. |
| G-52 | Run modes and transpiler | MISSING | DONE | `packages/adapters/pi`, `packages/adapters/opencode` |
| G-57 | Tests, validation, release, plan | PARTIAL | DONE | new `hooks/lifecycle.test.ts`. |
| G-58 | Tests, validation, release, plan | MISSING | DONE | new `examples/reference/`, `scripts/e2e.sh`. |
| G-59 | Tests, validation, release, plan | PARTIAL | DONE | the call list in SPEC.md stays as written (the user's spec); the allow-list is `scripts/expected-calls.txt`, checked by `scripts/validate-calls.sh`; CI skips the live part without the `claude` CLI |
| G-60 | Tests, validation, release, plan | MISSING | DONE | new `README.md`. |
| G-61 | Tests, validation, release, plan | PARTIAL | DONE | `scripts/e2e.sh` (live, 2026-10-06: Always, Auto after Read, @mention Manual, Markdown + compiled DSL sections, `[gate:x]` stripped, journal profile — all pass on `examples/reference` and `examples/basic`) |
| G-62 | Tests, validation, release, plan | MISSING | DONE | `hooks/layers/probe.ts` `PROBE_POINTS` / `PROBE_REQUIREMENTS` (`requires: [probe:<point>]`), listed under «Не перевірено наживо» in `/gate health` and `/gate why` (test `hooks/probe.test.ts`); LIVE results in docs/PROBE.md. Still interactive-only: skill.prompt `` !`…` ``, `$.state` after `/clear`, `$.model.complete` cost, subagent `prompt.context`, the listing rewrite seen by the model |
| G-63 | Tests, validation, release, plan | MISSING | DONE | Priompt/POML rows in the SPEC.md comparison table; Р7 note points to docs/ARCHITECTURE.md for the layer-3 order |
| G-64 | Tests, validation, release, plan | PARTIAL | DONE | `bench/repos.json`, `examples/*`. |
| G-65 | Tests, validation, release, plan | MISSING | DONE | `test/provider-examples.test.ts` (keylang provider trusted/untrusted, tsc gate + baseline, example gate.json validate); mod `onlyNew` in `hooks/gate.test.ts` |
| G-66 | Tests, validation, release, plan | PARTIAL | DONE | `test/` or `bench/`. |

## Work packages

The WP1–WP6 plan that used to be here is done (commit `30f4b3c` and the cleanup pass); see git history for the
package split.

## DONE (compact)

### Architecture and the event map

1. One hooks module `hooks/register.ts` with layers under `hooks/layers/`. The core `packages/core` has no Claude Code dependency.
2. `session.start` reads the config and registers `/gate` and `/rule` (`register.ts:141`, `session.ts sessionStart`, `commands.ts registerCommands`).
3. `prompt.context` resets dedup and adds Always rules (`register.ts:189`, `cursor-rules.ts rulesContextBefore/After`).
4. `prompt.submit` handles `@rule`, `@file` → Auto, signals and the first-prompt classifier (`register.ts:196`, `skill-gate.ts gatePromptSubmit`).
5. `tool.call` on Read/Edit/Write/NotebookEdit: glob rules after the result, per-agent dedup, partial-read check (`register.ts:220`, `cursor-rules.ts rulesAfterFile`).
6. `tool.call /^mcp__/` answers `{deny}` with «увімкни через /gate +name» (`register.ts:249`, `skill-gate.ts mcpGate`, `decide.ts denyText`).
7. `prompt.attachment {skill_listing}` rewrites the listing (`register.ts:211`, `items.ts parseSkillListing/renderSkillListing`).
8. `tool.describe`: a short description and `isDeferred` (PROBE #7). `agent.offer`: `{isOffered:false}` (`register.ts:256,258`).
9. `skill.prompt`: the off text, plus prompt-skill rendering (`register.ts:260`, `dsl.ts skillPrompt`).
10. `prompt.compose`: `context-gate:<id>` session sections ordered by scope (`dsl.ts composeAfter`).
11. `turn.step` is an async-generator observer (PROBE) (`register.ts:267`, `skill-gate.ts observeStep`).
12. `session.measure` and `turn.complete` drive budgets and the band (`register.ts:272,278`, `budgets.ts`).
13. `command.run {gate, rule}`. `ui.render {AbovePrompt, Pane}`.
14. `{deny}` is answered in `tool.call`, not `tool.check`.

### Configuration `.claude/gate.json`

15. Every field in the example is typed and in the JSON Schema (`core/types.ts`, `core/config.ts`, `schema/context-gate.schema.json`).
16. `skillGroups`/`mcpGroups` take globs over names (`items.ts groupMatches`).
17. `tiers` with `preload`, and `models` globs → tier (`config.ts tierForModel`).
18. `profiles.when` checks before the classifier; several matches union (`decide.ts:138`).
19. `classify` modes `shadow` and `auto`, `minConfidence`, `recheckOn` (`decide.ts:107`, `session.ts recheckOn`).
20. `budgets`/`onExceed`: section, notice, compact (`budgets.ts act`).
21. `cursorRules.nested` and `maxCharsPerInjection`.
22. Priority order manual → when → classifier → tier → `standard` with a warning (`decide.ts:78–194`).
23. The schema is validated on `session.start`. A schema error disables layer 2 and the reason shows in `/gate` and `/gate why` (`hooks/layers/config.ts`).

### Layer 1: cursor-rules

24. Four rule types (`mdc.ts classifyRule:107`).
25. Always rules go in as instruction files after CLAUDE.md, with a `cursorRules` block as fallback (PROBE prompt.context).
26. Auto Attached rules come as context after the tool result, framed `Contents of <path> (Cursor rule <id>):` (`mdc.ts frameRule:273`).
27. Agent Requested rules → `.claude/skills/cursor-<id>/SKILL.md` through `context-gate sync` (`mdc.ts transpileAgentRule:254`).
28. Manual rules through `@id` and `/rule <id>` (`cursor-rules.ts ruleCommand`).
29. A linear frontmatter parser: comma lists respect `{a,b}`, inline arrays and YAML lists work, `!neg`, BOM and CRLF are handled, no frontmatter → Manual (`mdc.ts parseMdc:114`, `parseGlobList:42`).
30. `@file` in a rule body → «див. файл …» (`mdc.ts expandFileRefs:81`).
31. Path normalization relative to the root, case-insensitive on Windows (`glob.ts normalizePath`, `detectWindows`).
32. Dedup `seen` keyed `<agent|main>:<rule>`, reset on `prompt.context`.
33. Edge case 1: a partial or token-capped Read of the `.mdc` doesn't count as delivery (`cursor-rules.ts isPartial`).
34. Edge case 2: `strictWrite` deny (`rulesBeforeFile`).
35. Edge case 3: `@file` in `prompt.submit`.
36. Edge case 4: `nested` with a dir prefix (`nestedRuleDirs`, `ruleIdFromPath`).
37. Edge case 5: the `maxCharsPerInjection` pointer line (`mdc.ts packInjections:282`).
38. Edge case 6: rule cache, FileChanged via `watchPaths`, and a 2 s mtime recheck (PROBE #10).
39. Edge case 7: when `.claude/rules/cursor/` exists the layer turns off, and `/gate why` says so (`hooks/layers/config.ts:29`).
40. NotebookEdit reads `notebook_path` (PROBE #11).

### Layer 2: skill-gate

41. A `Gate` object and a pure `decideGate` (`decide.ts:78`).
42. Signal 1: `/gate <p>`, `+g/-g`, `off`, `auto`.
43. Signal 2: `when.paths` from mentions and recent paths, branch from `.git/HEAD` (PROBE #3; `skill-gate.ts readBranch`).
44. Signal 3: the model from `turn.step`, with a `model-change` recompute.
45. Signal 4: the classifier via `$.model.complete` with JSON and a `classify` fallback below `minConfidence` (PROBE #1; `skill-gate.ts classify`).
46. Shadow journals only and shows `(frontend?)`. Auto applies at `confidence ≥ minConfidence`.
47. Hysteresis: 2 turns, or a manual change, `/gate new` or compaction (`decide.ts:167–183`).
48. The listing keeps `on`, shows `nameOnly` without a description, and drops `off`.
49. `skill.prompt` off text «Skill <name> вимкнено профілем <p>. Увімкни: /gate +<group>» (`decide.ts skillOffText`).
50. A `preload` section in `prompt.compose` (`dsl.ts preloadSection`).
51. MCP: a one-line description, `isDeferred: true`, and `{deny}` with the same text. Own tools are excluded.
52. `agent.offer {isOffered:false}`.
53. Budgets read `context.percent` on measure and complete. Thresholds come per tier. `onExceed` fires once per crossing and re-arms. Notice = toast + `session.append` (PROBE #2). Compact runs deferred via `clock.after` (PROBE #8) with keep-profile/rules instructions.
54. After compaction, `seen` resets and the profile is rechecked (`session.ts compactAfter`).
55. The decision journal: a 200-entry ring in `$.state` plus optional `.claude/gate.log.jsonl` (`core/journal.ts pushLog`, `hooks/layers/journal.ts`).
56. `invalidate('prompt.attachment'/'tool.describe')` only when the set changes (`skill-gate.ts recompute:134`).

### Layer 3: TSX and the build

57. The `.prompt.tsx` → `.compiled/<id>.json` build: esbuild, run in Node with a 10 s timeout, `sourceHash` and `sources` (`build.ts buildPrompts:377`, `buildEntry:283`).
58. All components exist: Prompt, Section, If/Else, Each, Let, Set, Store, Repeat, Break, Continue, Run, Use, Call, Include (`path`/`text`/`section`), Skill, Rule, Mcp, Lazy, Tier, Fence, List, Table, V, Debug, Assert, Log, Trace (`jsx/components.ts`).
59. `Section` props `id`, `scope`, `when`, `budget`, `after`, `tier`. A same-id engine section is replaced (`dsl.ts composeAfter`).
60. HTML-like tags render to Markdown, and text normalizes by Markdown rules (`render.ts el`, `cli/jsx-text.ts`).
61. Custom components inline with recursion → G151 (`jsx/core.ts:355`).
62. Builtins `<CursorRules match>`, `<Examples glob n>`, `<HealthWarning>` (`components.ts:392–415`).
63. Arbitrary TS in runtime positions → G160 (`jsx/core.ts exprOf/ref`).
64. Static sections render once per session by hash. Profile and volatile come later, volatile last (`dsl.ts staticText`, `render.ts orderSections`).
65. `Run` without `cache` in `static` → G163 (`build.ts:238`).
66. `budget` truncates with a marker (`render.ts truncate`).
67. The runtime reads only `.compiled`, and `run`, health and preview share it.
68. Mod build: a background build on `session.start` when stale and trusted.
69. Mod build: a synchronous `prompt.compose` rebuild when it fits in 2 s, otherwise the previous build plus H013 (`dsl.ts syncBuild`).
70. Mod build: `/gate build`.
71. Build errors keep the previous `.compiled`, log H013, and toast the first 3 lines. A missing node gives a hint (`dsl.ts buildPrompts:101`).
72. No build under `-p` (`buildStale` when `!interactive`).
73. A one-time trust ask via `$.ui.ask` stored in `$.store`. `trustBuild` in userConfig. `prompt.build: never` (`hooks/layers/trust.ts`, `dsl.ts trustOnPrompt`).
74. The build is visible to `validate` as `process.run`.

### Prompts as skills

75. `<Prompt as="skill" name description args invoke tiers>` (`components.ts Prompt`).
76. SKILL.md gets `name`, `description`, `argument-hint` from the schema, and `disable-model-invocation` for `invoke.model: false`. Its body is the `` !`node … run <name> --args "$ARGUMENTS" --ctx-from live` `` line (`build.ts renderSkillMd`).
77. The mod renders on `skill.prompt` with args from `tool.call {Skill}`, `command.run` or the text (PROBE #6; `dsl.ts skillPrompt`, `captureSkillArgs`).
78. One argument parser for `/name`, the CLI and `$ARGUMENTS`: positional, `--k v`, `--k=v`, flags, quotes, `--` rest, and the types string, number, enum, flag, path, list, json and rest (`core/argparse.ts`).
79. A parse error renders the `usage` section with Ukrainian text (`argparse.ts usageLine`; verified on `run release-notes --args "--format bad"`).
80. `invoke.model: 'tool'` → `$.tool.register` with the JSON Schema from the args (`dsl.ts registerSkillTools`, `argsToJsonSchema`).
81. A prompt skill is an `Item kind=skill` with `provenance: prompt-tsx` (`cli/context.ts:237`).
82. A `skill-render` journal event.
83. Three examples in `examples/skills/`, installed by `context-gate example skills`.

### Imports

84. `.prompt.tsx` components inline. A duplicate section id → G161 (`build.ts validatePrompt`, `render.ts:1077`).
85. Plain `.ts`/`.tsx` helpers run at build time.
86. `.json` imports. `.md`, `.txt` and `.mdc` import as text with a `meta` frontmatter (`build.ts:136`).
87. `node_modules` libraries are used at build time only.
88. `ctx.*` is never evaluated at build time.
89. `sources [{path, hash}]` invalidate the build (CLI `checkStale`, H013).
90. `.compiled` over 2 MB → G162 (`build.ts:352`).
91. `.cursor/rules/*.mdc`, `AGENTS.md` and similar import as data.
92. Shared libraries under `.claude/prompt/shared/` (`examples/basic`).

### Language limits, variables, loops

93. A total AST with a step limit of 10 000 per section → G155 (`render.ts:605`).
94. The pipe-filter whitelist: take, sort, grep, map (template), join, truncate, fence, unique, where, len, plus round and ago (`expr.ts FILTERS:33`).
95. `@fn` with no recursion → G151 (`mddsl.ts`).
96. Provider calls only at the head of a chain → G154 (`expr.ts`).
97. Codes G151, G152, G154, G155, G157, G159 and G160 are emitted.
98. `@let`/`@set` are section-scoped, and `store`/`data.*` cross sections.
99. Arithmetic, min/max/abs/round/floor/ceil, comparisons, `&& || !`, `?:`, string `+`, `len`, `in`, `~`, `??`, `.at()`. Division by zero → null (`expr.ts`).
100. `@repeat n` ≤ 1000 with `i`, and `@break`/`@continue` in each and repeat (`render.ts:726`, G152).
101. State across sessions via `@store` → `data.*` (CLI files and the cache; the mod `$.store`).
102. The full Markdown DSL parser: if/elif/else, each, let, set, repeat, store, run, call, use, include, section, skill, rule, mcp, lazy, tier, fn, debug, assert, log, trace (`core/mddsl.ts`).

### Executors, scripts, data

103. `executors` as command templates with `{code}` as an arg or stdin, plus timeout and env (`host-node.ts`, `host.ts DEFAULT_EXECUTORS`).
104. Input `{ctx, args}` on stdin. JSON stdout → structure, else a string.
105. `onError` unverified/skip/fail. stderr goes to diagnostics, never the prompt (`render.ts failure/execRun`).
106. `@run` takes the language first (bash by default). `as=` names the result; without it the result is `run`.
107. The `scripts` provider in the CLI: lang by extension or shebang, cache by hash (`cli/scripts.ts`, `context.ts script`).
108. `# gate-tool:` headers register tools on `session.start` when trusted (mod `dsl.ts registerScriptTools`; CLI `tools`), with `tiers`.
109. Limits: trust-gated, `allowScripts` under `-p`, binary whitelist (CLI), data only via stdin, a 2 s render budget, and the `[run: python, 0.4 s, 212 B]` stub (`render.ts runStub:118`).
110. A two-pass render: the data pass, then the text pass (`render.ts renderAll:300`).
111. `store=` with `persist` → `.claude/prompt/data/<key>.json` (CLI `context.ts setData`).
112. `data.*` carries `fetchedAt`, `stale` and `| ago` (`render.ts materializeData`).
113. `context-gate data set|get|list`.
114. `needs=` dependencies, one parallel wave per round with a single budget, and a stale previous value marked unverified (`render.ts execute/execRun`).
115. `@use` in frontmatter or a section. `Call`/`@call … as x cache= store=`.
116. One process per module per batch (`render.ts execCalls:397`).
117. The three call forms (`{{ }}`, `@let`, `@call`).
118. External functions aren't pipe filters (G154).
119. CLI shims node/python/bash with `__exports__` → G158 (`cli/shims.ts`, `cmd-run.ts`).

### Includes

120. `inline`/`ref`/`lazy` modes. The `@include`, `@section`, `@skill`, `@rule`, `@mcp … as x` and `@lazy` directives (`mddsl.ts:414–457`, `render.ts include:935`).
121. Cycles and depth > 3 → G159.
122. `@section` renders once and is reused. A section included as `ref` is suppressed from the output (`render.ts suppressIncluded:1042`).
123. `@skill inline` works the same as preload.
124. `@mcp` is a provider: its result is data (`render.ts execOther`).
125. Lazy → a `get_<name>` tool, mod and CLI (`host.ts registerLazy:183`).
126. `prompt://<id>` in `@section`, `/gate render` and `context-gate render [prompt://]<id>`.

### Standalone interpreter and live preview

127. `context-gate run` with `[id]`, `--tier`, `--profile`, `--model`, `--ctx-from live|session:*|fixture`, `--trace`, `--json`, `--only`, `--dry-scripts`, `--watch`, `--diff`, `--args`, `--markers` (verified).
128. The trace table: inclusion and reasons, `@if` branches, `let` values, run/call/mcp with source and ms, tokens, codes.
129. VS Code preview with tier/profile/ctx-from toggles, a "run scripts" button, hover from the trace, and click-to-directive (`editors/vscode`, docs/EDITOR.md).

### Debugging

130. `@debug` never reaches the prompt. A test checks byte-identical text with and without debug (`test/render.test.ts:150`).
131. `@assert` is always evaluated → D001, skip or fail. `@trace on|off`. Values are truncated to 2000 chars. With `debug: false`, debug isn't evaluated (`render.ts:778–802`).

### Prompt health

132. Metrics H001–H008, H009 (mod, listing chars), H010 (mod, denies) and H013, with thresholds from `gate.json health` (`core/health.ts computeHealth`).
133. `/gate health` and `context-gate health [--json] [--strict]` give the same report with a «Що зробити» column.
134. The status line `prompt 8.1k (static 76%) · ◌ N` next to the band's `ctx %` (`ui.ts healthLine`).
135. Bench reads the health JSON. Health makes no model calls.

### Layer 3a: tier-adaptive prompts

136. Tier variant files `<id>.<tier>.md` take precedence over directives. `@tier` with no argument means "not premium" (`mddsl.ts tierVariantOf:171`, `resolveTierVariant:597`).
137. `fs.examples(glob, n)`: the n smallest files, deterministic (`cli/context.ts pickExamples`, `host.ts examples`).
138. The builtin `read-before-write` gate, plus command gates on write, commit, turn and prompt, filtered by `tiers` (premium off by default) (`hooks/layers/gates.ts`).
139. The brief: `$.model.complete` with `brief.model`, first prompt and non-premium tiers only, `maxChars`, cached by text hash, `userConfig.brief` for `-p` (`skill-gate.ts brief`).
140. `context-gate expand` → `proposals/` with `generated-by`, `generated-at` and `source-hash`. It regenerates only changed sections. `--dry-run` and `--force` (`cmd-expand.ts`).
141. Escalation: `escalation-suggested` in the journal plus a toast «… — перейди на standard: /model sonnet», counted by verifyFailed and stallTurns (`skill-gate.ts checkEscalation`).

### Providers

142. Provider kinds `cli`, `file` (JSON, Markdown, `pick`), `mcp` (mod only; the CLI marks it unverified, G205) and `module` (builtin `git`, `fs`). `functions` with `{id}` placeholders, `cache`, `onError` (`cli/context.ts`, `host.ts providerData`).
143. Reserved names `git`, `fs`, `cursor`, `gate`, `ctx`, `session`.
144. Gates: `run` with `{changedPaths}`, `pass` as an expression over `exitCode`/`stdout`/`result`, a `message` template, `onlyNew` and `baseline`. A failure gives `{deny}`; a pass leaves no trace (`gates.ts runCommandGate`).
145. `when.expr` over providers (`decide.ts:56`, `skill-gate.ts evalWhen`).
146. Statuses ok, fail and unverified, with `◌ N` in the status line.
147. `explain`, `fmt [--check]` and proposals (`expand`, `schema infer`).

### Unified model and pipeline

148. The `Item` type with kind, id, attach, cost, provenance and status (`core/types.ts:29`).
149. Unified `groups` with kind prefixes. Legacy formats → G310 plus `context-gate migrate` with a backup (`config.ts normalizeConfig:343`, `migrateConfig:433`).
150. Pipeline stages run as CLI commands over JSONL: collect, normalize, signals, decide, budget, render, deliver `--dry-run`, observe `--since --status`, where, tokens, on, off, why, take, sort, preview (verified).
151. `context-gate pipe "<grammar>"`. An unknown stage → G501.
152. Pipe filters in DSL expressions are pure and in the core.
153. Harness adapters: `claude-code-mod`, `claude-code-hooks` (`packages/hooks-adapter`) and `static` (`sync`). The core imports no adapter.

### User interface

154. `/gate` subcommands: status, `<profile>`, `+g`/`-g`, `off`, `auto`, `new`, `why [off]`, `shadow`/`apply`, `rules`, `health`, `build`, `render prompt://<id>`, `trust revoke`. Also `/rule <id>` (`hooks/layers/commands.ts`).
155. The band `gate frontend · tier standard · skills 5/23 · mcp 2/6 · rules 3 · ctx 38%`. Shadow shows `(frontend?)`, and the band highlights past soft (`ui.ts gateLine/bandProps`, `decide.ts statusLine`).
156. The `/gate why` pane: the last 50 decisions, the prompt sections with length and scope, and the «Застосувати запропонований профіль» and «Скинути до auto» buttons (`ui.ts whyPane`).
157. Under `-p`: `userConfig` profile and mode. A `[gate:<profile>]` prefix is stripped in `prompt.submit` (`gatecmd.ts extractPromptFlag`). Headless sessions get `ui.status`.

### Editor and autocomplete index

158. The tsserver plugin: G1xx/G170/G171/G172 diagnostics, completion, hover with trace values, «винести в Lazy» and «згенерувати quick-варіант» actions, document symbols (`packages/lsp`).
159. `ctx.d.ts` generated from `gate.json` and provider schemas (`build.ts generateCtxTypes`).
160. The thin VS Code client (`editors/vscode`).
161. The browser editor with CodeMirror 6, a REPL, preview via `run --dry-scripts`, and a token/Host/Origin/path-safe API (`packages/editor-web`).
162. The `context-gate index` command. The editor runs no project code and no LLM.

### Scenarios

163. 1: `init` guesses profiles from the structure with `classify: shadow` (`cmd-init.ts guessProfiles`).
164. 2: the full flow (when.paths → frontend, Auto rule on Read, listing cut, MCP deny).
165. 3: covered except per-subagent tiers (G-08).
166. 6: shadow reasons such as «… 0.62 < 0.7 …», plus `report` counts by trigger.
167. 7: `budget` per section, `@lazy`, and `onExceed` compact.
168. 8: the deny text and `/gate +backend`.
169. 9: `sync` fallback, and the layer turns off on `.claude/rules/cursor`.
170. 10: `expand` → proposals with a `source-hash` guard.
171. 11: `when.ticketType` in the mod and the hooks adapter, plus shiftwork `planForTicket`. 12: `bench --before --after` (tokens, unverified).

### Run modes

All are DONE, counted in the totals above:

- CLI and the desktop Code tab.
- `claude -p`: hooks, filtering, profile from userConfig or `[gate:x]`, no build.
- VS Code extension and cloud sessions: hooks without UI.
- Below 2.1.287: `context-gate sync`:
  - `.mdc` → `.claude/rules/cursor/*.md` and `.claude/skills/cursor-*`
  - profiles → `skillOverrides` in `settings.local.json`
  - DSL → `.claude/prompt.generated.md`, imported from CLAUDE.md
  - `--watch` via `fs.watch`
- The shiftwork contract (`hooks-adapter/src/shiftwork.ts`, `plan` CLI, docs/SHIFTWORK.md).

### Tests, validation, security, performance

All are DONE:

- Table-driven unit tests: 465 pass. Mod tests via `claude plugin test`: 90 pass.
- `claude plugin validate --strict` passes. The name `context-gate` isn't reserved. The marketplace manifest exists.
- No `$.http`. `.mdc` and DSL text stay data. The classifier gets only the prompt text and paths. The journal holds metadata only.
- Rules and DSL parse once and cache in the module closure. `tool.call` matches globs over the cache. The classifier runs at most once per task. `@run` caches for 5 min by default with a 2 s total budget.

### Design decisions

All are DONE:

- **Р1** level 1: string expressions, `<V>`, LSP checks against `ctx.d.ts`. Operators on a ref are reported as G160, not intercepted.
- **Р2** trust-on-first-use, keyed by path + remote: it covers `process.run` and `mcp.call`, untrusted runs render as unverified stubs, the user whitelist can only be narrowed by the repo (CLI), `--trust-repo`, `/gate trust revoke`, and a re-ask when commands change (`hooks/layers/trust.ts`, `cli/settings.ts`).
- **Р3**: `.compiled/` gitignored, `prompt.lock.json` committed, builds on `session.start`, in the LSP and in CI, plus the CLI cache fallback.
- **Р4**: an inline `schema`, `schema infer` → proposals, builtin provider types (`jsx/ctx.ts`).
- **Р5**: `Lazy` → `Include lazy` with G180.
- **Р6**: the static PROBE (docs/PROBE.md).
- **Р7**: every MVP-slice item is present.

### Plan stages

All are DONE:

- Stage 2: core + cursor-rules.
- Stage 3: the transpiler.
- Stage 4: shadow.
- Stage 5: apply.
- Stage 6: DSL with prompt-cache measurement by hash.
- Stage 6a: tier-adaptive prompts.
- Stage 7: the shiftwork contract.
- Stage 7a: index, LSP, VS Code, browser editor, and the four provider kinds.
- Stage 8: marketplace, validate and the README (G-60).
- Checklist "Що перевірити": items 1, 2, 5 and 6 resolved via the d.ts; 2, 5 and 8 confirmed live, 3, 4, 6 (subagents) and 7 are interactive-only (G-62, docs/PROBE.md).

## N/A

| Item | Why |
| --- | --- |
| Model routing and provider fallback | Out of scope ("Мета і межі") |
| Editing skills themselves | Out of scope |
| Support for other IDEs (except Cursor reading `.claude/skills`) | Out of scope |
| Cursor running in the same repo | Nothing to do: `.cursor/rules` stays the source |
| `$.ui.notice` for the hard threshold | PROBE #2: toast + `session.append` (DONE) |
| `ENABLE_TOOL_SEARCH=auto` fallback | PROBE #7: `isDeferred: true` (DONE) |
| `skill_listing` `e.detail` | PROBE #5: parse `e.text` (DONE) |
| `$.plugin.root()` as a call | PROBE #4: it's a property |
| `$.session.repo()` branch | PROBE #3: `.git/HEAD` (DONE) |
| Proxy interception of operators | Forbidden by Р1 |
| «імпорти обмежені @context-gate/jsx і локальними компонентами» | Superseded by the "Імпорти" section, which allows `node_modules` libraries at build time |
| Brief output going to `proposals/` | The brief is per-task runtime context in `$.state` ("Бриф задачі"); proposals are for committed artifacts |
| MVP exit criterion and stage 6a/7a acceptance criteria (≥ 80 % agreement, Verify parity) | Operational. The metrics exist (`report` shadow match, `verifyFirstTry`) |
| Old estimates (3–4 weeks) | Superseded by Р7 |
