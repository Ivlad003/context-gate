# SPEC coverage: `context-gate` vs `docs/SPEC.md`

Audit date: 2026-10-06, commit `bc3e5ec` plus the integration pass still in the working tree. The audit read the code
and ran things:

- `npm test`: 311/311 pass.
- `npm run test:mod`: 42/42 pass.
- `claude plugin validate --strict .` passes on Claude Code 2.1.291.
- CLI runs on a temp copy of `examples/basic`: `build`, `run` (with `--trace`, `--only`, `--json`, `--dry-scripts`,
  `--ctx-from session:latest`, `--diff`), `health`, `collect | decide | tokens`, `render`, `preview`,
  `deliver --dry-run`, `observe`, `signals`, `budget`, `sync`, `migrate`, `init`, `report`, `bench`, `expand --dry-run`,
  `fmt`, `example skills`, `data`, `tools`, `schema infer`, `trust`, `index`, `explain`.

Rules applied:

- The Р1–Р7 decisions override earlier sections.
- Where `docs/PROBE.md` records a mods-API difference, the PROBE way counts as DONE.
- **Excluded** because the concurrent integration pass owns them:
  - diagnostic-code renumbering and the `explain` table (G1xx/G2xx/G4xx entries)
  - moving `assemble.ts` and `parseToolHeader` into core, which also covers render-scope shape parity between the
    mod and the CLI (`git.dirty`, `cursor.*`)
  - glob helper unification
  - journal snapshots / `--ctx-from session:*` replay
  - the `run --json` shape
  - `cursor.match`
  - bench defaults

  Those items appear below only when they are part of something larger.

Effort: **S** < ½ day · **M** ½–2 days · **L** > 2 days.

## Summary

| Status | Count |
| --- | --- |
| DONE | 197 (171 numbered + 26 grouped bullets at the end of the DONE list) |
| PARTIAL | 42 |
| MISSING | 23 (G-52 `pi`/`opencode` is deferred and not assigned to a package) |
| N/A (out of scope, superseded by a Р-decision or PROBE, or operational) | 14 |
| **Total items** | **276** |

The biggest themes:

1. **Mod ↔ CLI parity in layer 3.** The CLI host is richer than the mod host: shims, `scripts.*`, `fs.glob`, `module`
   providers, the whitelist key, persisted data. The spec requires byte-identical preview and `prompt.compose`.
2. **Mod-side surfaces.** These are missing: `/gate edit`, the pipe grammar inside `/gate`, the section pane, the health
   pane, mod-written `gate.index.json` and `.trace/last.json`, and the `prompt ⚠ build` status.
3. **Unified-model breadth.** These exist only in the schema: `itemSources` `markdown-dir` and `provider`, `models`
   attributes, and the classify/brief providers.
4. **Observability.** Gaps: H011 and H012, session-context and gate-decision metrics, the debug log file, journaling of
   Always/Auto rule deliveries, and report suggestions.
5. **Release.** No README, `dist/` is not shipped, no live probe plugin, no e2e reference repo, and bench has 1 repo
   instead of 5–8.

## Gaps (PARTIAL / MISSING)

Format: **ID · status · effort · package**. Then the spec section and quote, what exists, what is missing, and the
files to change. Some IDs are skipped: G-07 was folded into G-04, G-37 into G-29/G-31, G-17 moved to N/A, and G-68
was dropped as unverified.

### Configuration and unified model

**G-01 · PARTIAL · M · WP3**
- Spec: "Єдина модель / Що ще стало абстрактним": «`models` приймає glob і атрибути (`contextWindow`, `costPer1k`), tier виводиться з порогів, якщо імені немає в мапі».
- Exists: a glob → tier map (`core/config.ts tierForModel`).
- Missing: the attribute form (`{ match, contextWindow?, costPer1k? }`) and tier inference from thresholds when no glob matches.
- Files: `packages/core/src/config.ts`, `types.ts`, `schema/context-gate.schema.json`.

**G-02 · MISSING · M · WP3**
- Spec: "Провайдери — Сигнали профілю": «`"classify": { "provider": "builtin" | "jev" | { "kind": "cli", ... } }`»; «бриф може писати й зовнішній CLI (`kind: cli`)»; «провайдери з контрактами `classify`, `brief`, `expand`».
- Exists: the builtin classifier (`$.model.complete` with JSON, `$.model.classify` as fallback) and the builtin brief in `hooks/layers/skill-gate.ts`. `classify.provider` is typed but never read.
- Missing:
  - a provider dispatch for classify and brief (`cli`: argv with stdin JSON → `{profile, confidence}` or text)
  - running the provider under trust
  - schema entries for `brief.provider`
- Files: `hooks/layers/skill-gate.ts`, `packages/core/src/types.ts`, `config.ts`.

**G-03 · MISSING · M · WP3** (needs a port addition by WP2)
- Spec: "Налагодження": «Секретні змінні з `env` (білий список у `gate.json`) у debug-виводі маскуються». PROBE #9 says to read `(await $.settings.read()).env` or a fixed literal set.
- Exists: `GateConfig.env?: string[]` (typed, in the schema). Nothing uses it.
- Missing: `env.*` in the render scope (CLI: `process.env` filtered; mod: settings env through the port), plus a mask list for WP5's debug output.
- Files: `packages/core/src/assemble.ts` (after the integration lands), `packages/cli/src/context.ts`, `hooks/layers/config.ts`. WP2 adds `$.settings.read` to the `port` in `hooks/register.ts`.

**G-51 · MISSING · L · WP3** (post-MVP per Р7)
- Spec: "Провайдери — Джерела правил" and "Єдина модель — Джерела": `markdown-dir` (`frontmatter: { paths: "globs" }`, `as: "rule"`), `provider` (`field`/`pick`, `as: "always"|"rule"|"datum"`, `template: "{{ item.from }} не імпортує {{ item.to }}"`), `prompt-dir`, `claude-tools {match}`.
- Exists: only the kinds enum in the schema (`core/config.ts:53`). The CLI turns providers into bare `datum` items (`cli/context.ts:261`).
- Missing:
  - pure adapters in core (`collect` per source)
  - CLI `collectItems` wiring
  - mod delivery of markdown-dir and provider rules through layer 1, with the same dedup and statuses
- Files: `packages/core/src/items.ts`, `mdc.ts`, `packages/cli/src/context.ts`, `hooks/layers/cursor-rules.ts`, `hooks/layers/skill-gate.ts`.

### Layer 1: cursor-rules

**G-04 · PARTIAL · S · WP3**
- Spec: config `ruleSources: [{ kind: "cursor-mdc", dir: ".cursor/rules" }]` and `itemSources`.
- Exists: the CLI honours custom dirs (`cli/context.ts findMdcFiles:55`).
- Missing:
  - the mod hard-codes `RULES_DIR = '.cursor/rules'` (`hooks/layers/cursor-rules.ts:17`) and ignores `dir` and per-source `nested`
  - edge case 6: no cache drop when `$.session.root()` changes
- Files: `hooks/layers/cursor-rules.ts`.

**G-05 · PARTIAL · S · WP3**
- Spec: scenario 5: «якщо файл був згаданий через `@`, правило йде з `prompt.submit`, і журнал це показує окремим тригером»; report «Правила, які жодного разу не доставлено».
- Exists: the mod journals `rule-delivered` only for `@id` mentions and `/rule` (`cursor-rules.ts:146,161`). The hooks adapter journals every delivery.
- Missing: journaling of Always deliveries (`prompt.context`) and Auto Attached deliveries (`tool.call`, `@file`), with the trigger and agent. Without it, `report` and `observe --status never` mark delivered rules as "never".
- Files: `hooks/layers/cursor-rules.ts`.

**G-06 · PARTIAL · S · WP3**
- Spec: scenario 5: «`/gate rules` → правило є, тип Auto Attached, globs `src/api/**/*.ts`, доставлено: ні».
- Exists: `rulesReport` lists ids by type and the delivered ids by agent.
- Missing: one row per rule with its globs and a delivered yes/no per agent.
- Files: `hooks/layers/cursor-rules.ts rulesReport`.

### Layer 2: skill-gate

**G-08 · PARTIAL · M · WP3**
- Spec: "Сигнали 3": «`e.agentId` → субагент отримує tier своєї моделі»; MOD-ADAPTER: «A listing for a subagent (`e.agentId`) uses that agent's tier».
- Exists: `agentTiers` is recorded on `turn.step` and used by gates (`gates.ts tierOf`).
- Missing: the `skill_listing` rewrite for `e.agentId`, MCP deny/describe and `skill.prompt` all use the main gate. There is no per-agent `decideGate`.
- Files: `hooks/layers/skill-gate.ts` (`listingAfter`, `mcpGate`).

**G-09 · PARTIAL · M · WP5**
- Spec: "Ескалація": «У `/gate why` видно, скільки спроб і токенів коштував кожен tier на задачі».
- Exists: `escalation-suggested` and `gate-failed` events.
- Missing: an aggregate of attempts and tokens per tier per task. Build it in `report`, and in `formatWhy` once the journal snapshot work lands.
- Files: `packages/cli/src/cmd-report.ts` (later `packages/core/src/journal.ts`).

**G-10 · PARTIAL · S · WP2**
- Spec: scenario 4: «`/gate` показує, звідки кожен елемент: `manual`, `when:paths`, `tier`».
- Exists: `/gate` prints one global trigger plus the reasons (`hooks/layers/commands.ts statusText`).
- Missing: a per-item source, computed at display time from `gate.groups`, `manual.add` and the tier groups with `items.ts groupsOf`.
- Files: `hooks/layers/commands.ts`.

**G-35 · PARTIAL · S · WP3**
- Spec: "Скрипти як інструменти моделі": «`kind: tool` робить його елементом `Item` і підпорядковує групам і профілям».
- Exists: the CLI `collect` adds `# gate-tool:` items. The mod enforces only `tiers`.
- Missing: script tools as items in the mod's `ensureItems`, and a deny for `off` in `serveOwnTool`.
- Files: `hooks/layers/skill-gate.ts ensureItems`. WP1 adds the `off` check in `dsl.ts serveOwnTool`.

### Layer 3: build through the mod

**G-11 · PARTIAL · S · WP1**
- Spec: "Життєвий цикл": «перевіряє `.compiled/*.json` проти `.prompt.tsx` за `source-hash`»; «Зміна будь-якого з них [імпортів] інвалідовує збірку (`H013`)».
- Exists: the mod compares the mtime of top-level `*.prompt.tsx` only (`hooks/layers/dsl.ts loadPrompts`).
- Missing: staleness on imported sources. Edits to `shared/*.prompt.tsx`, `.md` or `.json` imports are never detected in the mod. Use `compiled.sources[]` with `$.fs.stat` mtimes, or a hash.
- Files: `hooks/layers/dsl.ts`.

**G-12 · PARTIAL · S · WP1**
- Spec: «`classic.FileChanged` для `.claude/prompt/**/*.tsx`, `gate.json`, `scripts/**` — інкрементальна збірка».
- Exists: only a `.prompt.tsx` change starts a build (`dsl.ts dslFileChanged`).
- Missing:
  - a rebuild when `gate.json` changes (ctx types, `when`) or a `scripts/**` file changes
  - path filtering for files outside the prompt dir
- Files: `hooks/layers/dsl.ts`.

**G-13 · PARTIAL · S · WP1** (wiring by WP2)
- Spec: «`prompt.context` (після compaction, `/clear`) — те саме, що `prompt.compose`».
- Exists: `prompt.context` only resets the rules.
- Missing: export `dslContextBefore` (the stat check) from `dsl.ts`; WP2 calls it in the `prompt.context` hook.
- Files: `hooks/layers/dsl.ts`, `hooks/register.ts`.

**G-14 · MISSING · S · WP2** (flag set by WP1)
- Spec: "Помилки збірки": «пише `H013`/`G*` у журнал і рядок стану (`prompt ⚠ build`)».
- Exists: the journal entry and the toast.
- Missing: the status-line marker. WP1 sets `rt.buildError` in `hooks/ctx.ts`; WP2 renders it in `healthLine` and the band.
- Files: `hooks/layers/ui.ts`, `hooks/ctx.ts`.

**G-15 · PARTIAL · S · WP1**
- Spec: Р3: «`claude -p` без збірки отримує промпт лише з CI-артефакту або попередньо зібраного кешу `~/.cache/context-gate/<repo>/`».
- Exists: the CLI falls back to the cache (`cli/context.ts loadCompiled`).
- Missing: the mod reads only `<prompt>/.compiled/`; it should fall back to the cache dir (home via `io.env.home()`).
- Files: `hooks/layers/dsl.ts loadPrompts`.

**G-16 · PARTIAL · S · WP3**
- Spec: Р3: «Коміт `.compiled` допускається як опція `commitCompiled: true`».
- Exists: the field is in the schema.
- Missing: nothing reads it. `init` always gitignores `.compiled/` (`cmd-init.ts:10`).
- Files: `packages/cli/src/cmd-init.ts`.

### Layer 3: compiler, imports, language

**G-18 · PARTIAL · M · WP4**
- Spec: "Імпорти": «`.json`, `.yaml`, `.toml` — парсяться на збірці».
- Exists: `.json` works. `.yaml` and `.toml` fail on purpose (`build.ts:140`).
- Missing: YAML and TOML loaders. The CLI may add dependencies, for example `yaml` and `smol-toml`.
- Files: `packages/cli/src/build.ts`, `package.json`.

**G-19 · PARTIAL · M · WP4**
- Spec: "Спільні бібліотеки промптів": «Пакет може експортувати і skills (`as="skill"`): `context-gate build` збирає їх у `.claude/skills/` … з позначкою походження в frontmatter».
- Exists: only local `*.prompt.tsx` entries are built.
- Missing: declaring package skills (for example `prompt.packages: ["@acme/prompts"]`) and building their exported skill prompts with a `source:` / `generated-by` package mark.
- Files: `packages/cli/src/build.ts` (needs a config field from WP3).

**G-20 · PARTIAL · S · WP5**
- Spec: «у `--trace` воно підписане `build-time`».
- Exists: `TraceEntry.source` allows `'build-time'`.
- Missing: nothing emits it. Label text/constant nodes in the trace.
- Files: `packages/core/src/render.ts`.

**G-21 · PARTIAL · S · WP4**
- Spec: "Межі мови": G153 «Константа, яку перевизначають після `@let`», G156 «Глибина вкладення понад ліміт» (`If` ≤ 3, `Each` ≤ 2).
- Exists: both are checked for the Markdown form only (`mddsl.ts:297,337,365`).
- Missing: `validatePrompt` for TSX ASTs (`<Let>` redefined, `<If>`/`<Each>` nesting).
- Files: `packages/cli/src/build.ts validatePrompt`.

**G-22 · PARTIAL · S · WP4**
- Spec: Р4: «без схеми тип `unknown`, і доступ до полів у виразах дає попередження `G170`».
- Exists: only the LSP emits G170. `context-gate build` validates syntax only (`defaultValidateExpr`).
- Missing: pass the LSP `checkExpr` model (or a core equivalent) into `buildPrompts` from `build-main`/`main`.
- Files: `packages/cli/src/build.ts`, `build-main.ts`.

**G-23 · PARTIAL · S · WP4**
- Spec: Р4: «поле `schema` у провайдері — JSON Schema інлайном, шлях до `.schema.json` або до `.d.ts`».
- Exists: inline objects only (`generateCtxTypes`). A string path becomes `unknown`.
- Missing: resolving `schema: "path.schema.json"` and `schema: "x.d.ts"` (re-export the type) in both the generator and the LSP model.
- Files: `packages/cli/src/build.ts generateCtxTypes`, `packages/lsp/src/model.ts`.

**G-24 · MISSING · L · WP4** (post-bench, increment 3)
- Spec: Р1 level 2: «TS-трансформер на ts-morph, який переписує вирази в позиціях `when/test/of/children` у AST-вузли … компілятор відмовляє всьому, що не входить у підмножину (`G160`)».
- Exists: level 1 (string expressions, `V`, the `` e`…` `` tag).
- Missing: the transformer.
- Files: new `packages/jsx/src/transform.ts`, `packages/cli/src/build.ts`.

**G-25 · PARTIAL · S · WP4**
- Spec: Р5: «Провайдер `scripts` — цукор, який компілюється в `Use`+`Call`; … `tiers[*].preload` — у `<Skill mode="inline" />` в автоматично згенерованій секції `preload`; `store=` на `Run` — у `Store`. У AST лишаються лише канонічні вузли; старі записи приймаються … з попередженням `G180`».
- Exists: `Lazy` → `include lazy` with G180.
- Missing:
  - `store=` on `Run`/`Call` stays in the AST without G180 (JSX and Markdown)
  - `scripts.*` is resolved at runtime, not desugared
  - preload is a hand-built text section in the mod, not `Skill inline` nodes
- Files: `packages/jsx/src/components.ts`, `packages/core/src/mddsl.ts`.

### Skills as prompts

**G-26 · PARTIAL · M · WP4**
- Spec: Р6 and "Що генерує збірка": «fallback — попередньо відрендерене тіло з дефолтними аргументами і позначкою, що воно статичне».
- Exists: SKILL.md holds the `` !`…` `` line plus an HTML-comment hint (`build.ts renderSkillMd:252`).
- Missing: an optional pre-rendered body with default args, marked `static`, for example `prompt.skillBody: "live" | "static" | "both"`.
- Files: `packages/cli/src/build.ts`.

**G-27 · PARTIAL · S · WP1**
- Spec: `tiers={['standard','premium']}` on `<Prompt as="skill">`; «`path` (перевіряється існування відносно кореня)».
- Exists: the CLI enforces `skill.tiers` (`render.ts:1072`).
- Missing:
  - the mod's `renderSkill` builds the section without `tier`, so skill tiers are ignored
  - `parseArgs` runs without `pathExists`
- Files: `hooks/layers/dsl.ts renderSkill`.

**G-28 · PARTIAL · S · WP5**
- Spec: «`/gate why` показує, скільки разів його викликали, з якими аргументами і скільки коштував рендер (`H*`)».
- Exists: `skill-render` events, and `report` counts renders.
- Missing: args samples and the render cost (ms, chars) in `report`.
- Files: `packages/cli/src/cmd-report.ts`.

### Script executors, function calls, data

**G-29 · PARTIAL (bug) · S · WP1**
- Spec: Р2: «Білий список бінарників — лише в user-settings (`~/.claude/context-gate.json`), репозиторій може його тільки звужувати».
- Exists: the CLI reads `allowBinaries` and narrows it by `gate.json allowBinaries` (`cli/settings.ts:36`, `cli/context.ts:49`).
- Missing:
  - **the mod reads key `binaries`** (`hooks/layers/host.ts:47`), so one settings file means different things to the mod and the CLI
  - the mod's default list differs (adds `uv` and `jq`, and `deno` is missing from the default executors)
  - the mod ignores repo narrowing
- Files: `hooks/layers/host.ts`.

**G-30 · PARTIAL · M · WP1**
- Spec: "Автономний інтерпретатор": «тим самим кодом ядра, що й хук `prompt.compose`, тому результат збігається байт у байт»; "Скрипти як провайдер": `{{ scripts.changed_files() }}`; `fs.glob(...)`.
- Exists: the CLI callables are `git.log`, `fs.examples`, `fs.glob`, `fs.exists`, `cursor.match` and `scripts.*` (`cli/context.ts:344`). The mod has `fs.examples`, `git.log` and cli `functions`.
- Missing: `scripts.*`, `fs.glob` and `fs.exists` in the mod host. Today they give G157 in Claude Code but work in the CLI. `cursor.match` is excluded (integration).
- Files: `hooks/layers/host.ts`.

**G-31 · PARTIAL · M · WP1**
- Spec: "Виклик функцій" shim table (JS/TS, Python with `dataclass`/`Pydantic → __dict__`, bash `source file; fn`, `callTemplate`); G158 «валідатор один раз на сесію питає у shim-а список експортів».
- Exists: full shims in the CLI (`packages/cli/src/shims.ts`, `__exports__`). The mod has inline node and python shims only.
- Missing: the bash shim, `callTemplate`, dataclass conversion and `__exports__`/G158 in the mod. Move the shim sources (pure strings) to `packages/core/src/shims.ts` and use them from both hosts.
- Files: `hooks/layers/host.ts`, `packages/cli/src/shims.ts` → `packages/core/src/shims.ts`, `packages/cli/src/host-node.ts` (import only).

**G-32 · PARTIAL · M · WP1**
- Spec: «`module`-провайдер — TypeScript-файл у каталозі плагіна або `.claude/prompt/lib/*.ts`».
- Exists: the CLI runs repo `module` providers (`moduleCall`).
- Missing: the mod skips non-builtin `module` providers (`host.ts providerData` → `continue`). Run them through the node shim when trusted.
- Files: `hooks/layers/host.ts`.

**G-33 · PARTIAL · S · WP1**
- Spec: «`store=<ключ>` записує результат у `$.store` … і дублює у `.claude/prompt/data/<ключ>.json`, якщо `persist: true`».
- Exists: the CLI writes both. The mod writes only `$.store` (`dsl.ts persistData`).
- Missing: the data file when `prompt.persist` is set (`io.fs.write`).
- Files: `hooks/layers/dsl.ts`.

**G-34 · PARTIAL · S · WP5**
- Spec: «Результат кешується за хешем файлу, імені функції і аргументів».
- Exists: the call cache key is `call:<module path>:<fn>:<args>` (`render.ts:550,884`).
- Missing: the file content hash. Today an edited module serves stale results until the cache expires. Add `host.fileHash?` or include it in the key.
- Files: `packages/core/src/render.ts`, plus both hosts (one line each).

**G-36 · MISSING · M · WP1** (after `toolheader.ts` lands)
- Spec: "Функції як інструменти моделі": «`# gate-tool: next_version` … функція доступна і DSL під час рендера, і моделі».
- Exists: `# gate-tool:` makes the whole script a tool.
- Missing: function-level tools, a header naming an export that is served through the module shim.
- Files: `packages/core/src/toolheader.ts`, `hooks/layers/dsl.ts`, `packages/cli/src/context.ts` (`tools`).

### Includes and lazy

**G-69 · PARTIAL · S · WP1**
- Spec: «`@lazy`-інструменти і `ref`-рядки використовують його ж, тож у журналі видно, яку секцію модель запросила і скільки разів».
- Exists: lazy tools are served (`dsl.ts serveOwnTool`).
- Missing: a journal event (`kind: 'debug', trigger: 'lazy'`, ref, count) when the model calls `get_<name>`.
- Files: `hooks/layers/dsl.ts`.

### Debugging

**G-38 · MISSING · S · WP5**
- Spec: «Файл `.claude/gate.debug.log` пишеться лише при `debug: true` у `gate.json` або `--debug` у CLI, обрізається до 1 МБ».
- Exists: `.gitignore` lines only.
- Missing: the writer and the CLI `--debug` flag. The mod part goes through `io.fs.write` (WP1).
- Files: `packages/cli/src/cmd-run.ts` (WP5); `hooks/layers/dsl.ts` (WP1).

**G-39 · MISSING · S · WP5** (needs G-03)
- Spec: «Секретні змінні з `env` … у debug-виводі маскуються».
- Missing: masking in the `debug` trace entries.
- Files: `packages/core/src/render.ts`.

**G-40 · PARTIAL · S · WP1**
- Spec: «У Claude Code — у pane `/gate why` з фільтром `| where kind=debug`, і в `$.ui.log` з `to: "debug"`».
- Exists: the mod never passes `debug: cfg.debug` to `renderPrompt`, so `@debug` is never evaluated in the mod.
- Missing: forwarding debug trace entries to `io.ui.log(…, { to: 'debug' })` and to the journal (`kind: 'debug'`).
- Files: `hooks/layers/dsl.ts`.

**G-41 · PARTIAL · S · WP5** (+ WP1 and WP3)
- Spec: debug table: `@assert` → «`D001` і, за `assertFail`, … `skip` / `fail` — trace, журнал, `/gate health`»; `@log level=…` → trace and journal.
- Exists: `D001` diagnostics and trace. `RenderOptions.assertFail` exists.
- Missing:
  - `assertFail` in `GateConfig` and the schema (WP3)
  - the CLI passes it through (WP5, `cmd-run.ts`)
  - the mod journals D001 and `@log` entries (WP1)
  - D001 is listed in health (WP5, `health.ts`)

### Prompt health

**G-42 · MISSING · M · WP5**
- Spec: health table: «Гейти — скільки разів спрацювали, середній час, false positives за ручними «все одно» — `H011` гейт блокує > 30 % спроб».
- Exists: H011 is only in the code table.
- Missing:
  - per-gate attempts, blocks and ms counters
  - a manual-override signal (for example `/gate off` after a deny)
  - the metric itself
- Files: `hooks/layers/gates.ts`, `packages/core/src/health.ts`.

**G-43 · MISSING · M · WP5** (wiring by WP2)
- Spec: health table rows «Контекст сесії — `ctx.percent`, компакції за сесію, токени кешу з `result.usage` на `turn.step`», «Рішення gate — профіль, confidence, ручні перевизначення, deny», «Вартість — `H012` промпт > 40 % вхідних токенів»; PROBE turn.step: «`usage.cache_read_input_tokens` measures prompt-cache hits (health H002)».
- Exists: H002 is estimated from section hashes.
- Missing:
  - the three metrics and H012
  - H002 from real usage
  - WP2 captures `res.usage` after `yield* next(e)` in the `turn.step` hook
- Files: `packages/core/src/health.ts`, `hooks/register.ts`.

**G-44 · PARTIAL · S · WP5**
- Spec: H004 «найдовші `@run` і провайдери; cache hit rate»; H009 «скільки skills без опису».
- Exists: totals only.
- Missing: top-N slow runs from the trace, the cache hit ratio, and the count of nameOnly / description-less skills.
- Files: `packages/core/src/health.ts`.

**G-45 · PARTIAL · S · WP2**
- Spec: «Pane `/gate health` — повну таблицю з колонкою «що зробити»».
- Exists: `/gate health` returns Markdown text.
- Missing: a pane (`$.ui.open({ id: 'gate-health' })` and a `ui.render` Pane hook).
- Files: `hooks/layers/commands.ts`, `hooks/layers/ui.ts`, `hooks/register.ts`.

### User interface and editor

**G-46 · MISSING · M · WP2**
- Spec: "Клієнти": «Браузерний редактор (`/gate edit <id>` → `$.process.spawn` локального сервера …)».
- Exists: `packages/editor-web` (standalone, `--json` prints `{url}`).
- Missing:
  - the `/gate edit` subcommand in `gatecmd` and the mod
  - `$.process.spawn` in the port
  - reading the URL line and showing it
- Files: `hooks/layers/commands.ts`, `hooks/register.ts`, `packages/core/src/gatecmd.ts`.

**G-47 · MISSING · M · WP2**
- Spec: «Pane у Claude Code — перегляд секції, її рендер, токени, кнопки «відкрити в редакторі» і «перерендерити»».
- Missing: a section pane (for example `/gate render prompt://<id>` opens it) with the two buttons.
- Files: `hooks/layers/ui.ts`, `commands.ts`, `register.ts`.

**G-48 · MISSING · M · WP2**
- Spec: «Всередині Claude Code та сама граматика через `/gate`: `/gate collect kind=skill | where group=frontend | off` або `/gate why | where status=unverified`. Парсер команди один для CLI і для `/gate`».
- Exists: `gatecmd` parses pipes, but the mod answers «Pipe-команди … виконує CLI» (`commands.ts:142`).
- Missing: pure stage executors in core (`packages/cli/src/cmd-pipe.ts runStage` → `packages/core/src/pipeline.ts`) over the mod's items, gate and journal.
- Files: `packages/core/src/pipeline.ts`, `packages/cli/src/cmd-pipe.ts`, `hooks/layers/commands.ts`.

**G-49 · MISSING · M · WP2**
- Spec: «Індекс `.claude/gate.index.json`. Mod перезаписує його на `session.start`, після `/gate`, при `classic.FileChanged` …»; the table rows «Інструменти — `$.tool.list()`», «Skills … листинг skills», «Змінні контексту рендера … останній `prompt.compose`».
- Exists: the CLI `context-gate index` (config, sections, rules, symbols).
- Missing:
  - the mod writer
  - the session-only fields (tools, MCP servers, listing skills, last-compose values)
  - share the index builder with `cmd-index.ts` through core
- Files: new `hooks/layers/index.ts`, `packages/cli/src/cmd-index.ts`, `hooks/register.ts`.

**G-50 · MISSING · S · WP1**
- Spec: EDITOR/LSP hover «значення з останнього trace» (`.trace/last.json` from «останній `run --json` / `prompt.compose`»).
- Missing: the mod writes `.claude/prompt/.trace/last.json` (scope and trace) after `prompt.compose`, throttled.
- Files: `hooks/layers/dsl.ts`.

**G-67 · PARTIAL · M · WP4**
- Spec: "Шар 3а — expand" and the LSP code action «згенерувати quick-варіант».
- Exists: `expand` works on canonical Markdown sections only. `expand --only <tsx-section>` prints «Канонічних Markdown-секцій … немає», so the TSX code action does nothing.
- Missing: TSX sections (render to Markdown, and propose `<Tier is="quick">` or `<id>.quick.md`).
- Files: `packages/cli/src/cmd-expand.ts`.

### Providers and gates

**G-53 · PARTIAL · S · WP5**
- Spec: `{ "name": "architecture", "on": "commit", "provider": "arch", "run": [...], "pass": "len(result.violations) == 0" }`.
- Exists: `run`, `pass`, `message`, `onlyNew` and `baseline` (`hooks/layers/gates.ts`).
- Missing: `gates[].provider` is ignored. Expose the provider's data in the `pass`/`message` scope, or allow a gate without `run` that reads the provider.
- Files: `hooks/layers/gates.ts`.

**G-54 · MISSING · S · WP1**
- Spec: "Контракти виходу і гейти": «Для tier нижче `premium` вмикається секція `plan-then-act` (план → правка → перевірка)».
- Missing: a builtin section, toggled off when the repo defines its own section with that id.
- Files: `hooks/layers/dsl.ts`. The CLI parity part goes in `packages/core/src/assemble.ts` after the integration.

### Report and escalation

**G-55 · PARTIAL · S · WP5**
- Spec: scenario 8: «Якщо такі deny повторюються для одного профілю, `report` пропонує додати групу в профіль»; scenario 11: «`report` порівнює рішення обох за `ticketId` у журналі».
- Exists: deny counts and shadow agreement.
- Missing:
  - a "suggest `+group` for profile X" line (with `enablingGroup`)
  - a runner (`data.adapter: shiftwork`) vs mod comparison per `data.ticket`
- Files: `packages/cli/src/cmd-report.ts`.

### Run modes and transpiler

**G-56 · MISSING · S · WP4**
- Spec: "Транспілятор": «із watch-режимом через `fs.watch` і запуском із `SessionStart` settings-hook (`reloadSkills: true`)».
- Exists: `sync --watch`.
- Missing: `sync --install-hook`, which writes a SessionStart hook running `context-gate sync` with `reloadSkills: true` into `settings.local.json`. Reuse the hooks-adapter `mergeSettings`.
- Files: `packages/cli/src/cmd-sync.ts`.

**G-52 · MISSING · L · deferred**
- Spec: harness adapters `pi`, `opencode` («через shiftwork, пізніше»); Р7 increment 3.
- Missing: everything. Not in any package below.

### Tests, validation, release, plan

**G-57 · PARTIAL · M · WP2**
- Spec: "Тести": «хуки — `claude plugin test` … по тесту на кожну подію з карти».
- Exists: 42 mod tests.
- Missing: tests for these events:
  - `classic.SessionStart` (watchPaths, `source: clear` reset, `compact` recheck)
  - `session.end {clear}`
  - `session.compact` (instructions keep the profile and rules)
  - `classic.FileChanged` (`.mdc`, `gate.json`)
  - `turn.step` (model change → tier quick → recompute; subagent tier)
- Files: new `hooks/lifecycle.test.ts`.

**G-58 · MISSING · M · WP5**
- Spec: «наскрізна перевірка — `claude --plugin-dir ./context-gate` на еталонному репозиторії з `.cursor/rules`, 20+ skills і 3 MCP, де `context-report`-подібний хук на `prompt.context` підтверджує, що правила справді дійшли».
- Missing: the reference repo fixture and a script (`scripts/e2e.sh`) running `claude -p` with a probe hook.
- Files: new `examples/reference/`, `scripts/e2e.sh`.

**G-59 · PARTIAL · S · WP5**
- Spec: "Валідація перед релізом": the expected call list.
- Exists: validate passes. The actual list adds these, all PROBE-sanctioned: `$.clock.after`, `$.env.get`, `$.fs.write`, `$.mcp.call`, `$.model.complete`, `$.session.append`, `$.session.compact`, `$.store.delete`, `$.tool.list`.
- Missing:
  - a committed expected list
  - a CI diff against the `validate` output, so regressions are caught
  - the spec list itself needs updating
- Files: `.github/workflows/ci.yml`, new `scripts/validate-calls.sh`, `docs/SPEC.md`.

**G-60 · MISSING · S · WP5**
- Spec: plan stage 8: «README з таблицею `hooks:`/`calls:`».
- Missing: there is no `README.md` at all.
- Files: new `README.md`.

**G-61 · PARTIAL · M · WP5**
- Spec: «CLI збірки лежить у самому плагіні (`$.plugin.root()` + `dist/cli.js`)»; SKILL.md runs `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"`.
- Exists: `dist/` is gitignored and the marketplace `source: "./"`.
- Missing: a release path that ships the built `dist/cli.js` and `dist/hooks-adapter.js` (a release branch or tag with the build, or a `postinstall`). Today an installed plugin can't build prompts or render SKILL.md.
- Files: `package.json`, `.github/workflows/`, `.claude-plugin/marketplace.json`.

**G-62 · MISSING · M · WP5**
- Spec: Р6 stage 0: «окремий плагін-spike `context-gate-probe` з одним хуком на кожну точку, який пише результат у `probe.json` … кожна функція, що залежить від точки, отримує `requires: [probe:<name>]`»; checklist "Що перевірити в `.d.ts`".
- Exists: PROBE.md resolves the static items. 8 LIVE items remain open (skill_listing fixture, deferred `tool.describe`, `` !`…` `` timing, `$.state` after `/clear`, watchPaths dirs, subagent `prompt.context`, classify cost, compose under `-p`).
- Missing: the probe plugin, `probe.json` → PROBE.md, and `requires:` flags.
- Files: new `probe/` (its own `.claude-plugin`), `docs/PROBE.md`.

**G-63 · MISSING · S · WP5**
- Spec: Р7: «наступна правка документа — консолідація: шар 3 як один розділ … Priompt і POML — у таблицю «Хто вже зробив»».
- Files: `docs/SPEC.md`.

**G-64 · PARTIAL · M · WP5**
- Spec: «`bench/` на 5–8 репозиторіях».
- Exists: `bench/run.ts` and `context-gate bench`. `repos.json` has 1 repo. Bench defaults are excluded.
- Missing: 4–7 more reference repos (fixtures or pinned clones).
- Files: `bench/repos.json`, `examples/*`.

**G-65 · MISSING · M · WP5**
- Spec: stage 7a: «провайдери … `ruleSources` і декларативні `gates[]` — з keylang, tsc і eslint як першими адаптерами в `examples/`».
- Missing: example `gate.json` setups (and fixtures) for tsc (`typecheck` gate with `onlyNew`), eslint (a `cli` provider with `schema`) and keylang (an `arch` provider plus provider rule sources once G-51 lands).
- Files: new `examples/adapters/`.

**G-66 · PARTIAL · S · WP5**
- Spec: "Продуктивність": «Ціль: без `@run` жоден хук не перевищує 5 мс».
- Exists: caches in closures.
- Missing: any measurement. Add a timing test over the testkit (or a bench mode) for `tool.call`, `prompt.compose` and `prompt.attachment`.
- Files: `test/` or `bench/`.

## Work packages (parallel, disjoint file ownership)

All packages start **after the integration pass lands**. It currently touches `render.ts`, `codes.ts`, `assemble.ts`,
`journal.ts`, `cursor-rules.ts`, `mddsl.ts`, `context.ts`, `cmd-run.ts`, `main.ts`, `examples.ts`, `decide.ts`,
`mdc.ts`, `types.ts` and `toolheader.ts`. Rebase on it first.

Shared files have a single owner:

- `types.ts`, `config.ts` and the schema: WP3
- `hooks/register.ts` (the `port`, hook wiring): WP2
- `hooks/ctx.ts` (`Runtime`): WP1
- `render.ts`: WP5

Others request changes from the owner through the "needs" line.

### WP1: Mod prompt runtime parity (layer 3 in Claude Code)

- **Owns:** `hooks/layers/dsl.ts`, `hooks/layers/host.ts`, `hooks/ctx.ts`, new `packages/core/src/shims.ts` (moved from `packages/cli/src/shims.ts`; `packages/cli/src/host-node.ts` gets the import change only), `hooks/dsl.test.ts`.
- **Gaps:** G-11, G-12, G-13 (dsl side), G-15, G-27, G-29, G-30, G-31, G-32, G-33, G-36, G-40, G-41 (mod journal), G-50, G-54, G-69. It also sets `rt.buildError` for G-14 and the `off` check for G-35.
- **Needs:** WP2 to wire `dslContextBefore` into `prompt.context` (one line). WP3 for the `assertFail` and `env` config fields.
- **Effort:** about 4–5 days.

### WP2: Mod UI, commands, index, lifecycle tests

- **Owns:** `hooks/register.ts`, `hooks/layers/commands.ts`, `hooks/layers/ui.ts`, `hooks/layers/session.ts`, new `hooks/layers/index.ts`, `packages/core/src/gatecmd.ts`, `packages/core/src/pipeline.ts`, `packages/cli/src/cmd-pipe.ts`, `packages/cli/src/cmd-index.ts`, `types/index.d.ts` (new state keys), new `hooks/lifecycle.test.ts`, `hooks/register.test.ts`, `test/cli-pipe.test.ts`.
- **Gaps:** G-10, G-14, G-45, G-46, G-47, G-48, G-49, G-57.
- **Plumbing for others:** `$.settings.read` and `$.process.spawn` in the port (G-03, G-46), `turn.step` usage capture (G-43), `dslContextBefore` wiring (G-13).
- **Effort:** about 4–5 days.

### WP3: Config, item sources, rules, gate decisions

- **Owns:** `packages/core/src/types.ts`, `config.ts`, `decide.ts`, `items.ts`, `mdc.ts`, `schema/context-gate.schema.json`, `hooks/layers/skill-gate.ts`, `hooks/layers/cursor-rules.ts`, `hooks/layers/config.ts`, `packages/cli/src/context.ts` (`collectItems` / source adapters only), `packages/cli/src/cmd-init.ts`, `hooks/gate.test.ts`, `hooks/rules.test.ts`, `test/config.test.ts`, `test/items.test.ts`, `test/decide.test.ts`.
- **Gaps:** G-01, G-02, G-03, G-04, G-05, G-06, G-08, G-16, G-35, G-51.
- **Lands first (small):** the config fields other packages need: `assertFail`, `debugLog`, `prompt.packages` (G-19), `models` attributes, `classify.provider`, `brief.provider`.
- **Effort:** about 5–6 days (G-51 alone is about 2–3).

### WP4: Compiler, build and authoring tooling

- **Owns:** `packages/cli/src/build.ts`, `build-main.ts`, `packages/jsx/src/**`, `packages/core/src/mddsl.ts`, `packages/cli/src/cmd-expand.ts`, `packages/cli/src/cmd-sync.ts`, `packages/lsp/src/model.ts`, `test/build.test.ts`, `test/jsx.test.ts`, `test/mddsl.test.ts`, `test/cli-sync.test.ts`.
- **Gaps:** G-18, G-19, G-21, G-22, G-23, G-25, G-26, G-56, G-67. G-24 (the level 2 transformer, L) is optional and post-bench.
- **Effort:** about 4 days, plus about 5 for G-24.

### WP5: Render core, observability, release

- **Owns:** `packages/core/src/render.ts`, `packages/core/src/health.ts`, `packages/cli/src/cmd-run.ts`, `packages/cli/src/cmd-report.ts`, `hooks/layers/gates.ts`, `bench/**`, new `examples/adapters/` and `examples/reference/`, new `probe/`, new `README.md`, `docs/SPEC.md`, `docs/PROBE.md`, `.github/workflows/ci.yml`, `package.json` (scripts/release), new `scripts/e2e.sh` and `scripts/validate-calls.sh`, `test/render.test.ts`, `test/health.test.ts`.
- **Gaps:** G-09, G-20, G-28, G-34, G-38, G-39, G-41 (render/CLI/health), G-42, G-43 (core), G-44, G-53, G-55, G-58, G-59, G-60, G-61, G-62, G-63, G-64, G-65, G-66.
- **Effort:** about 6–8 days. It can split into WP5a (code: render, health, report, gates, debug) and WP5b (release, docs, probe, e2e, examples, bench); those two share no files.

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

- Table-driven unit tests: 311 pass. Mod tests via `claude plugin test`: 42 pass.
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
- Stage 8: marketplace and validate. The README is missing (G-60).
- Checklist "Що перевірити": items 1, 2, 5 and 6 resolved via the d.ts. 3, 4, 7 and 8 are LIVE (G-62).

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
