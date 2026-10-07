# Виправлення за ревю 2026-10-06

Джерела: звіт ревю реалізації (189 унікальних підтверджених багів: 6 high, 84 medium, 99 low) і брейншторм продакшн-ризиків від 2026-10-06. Тут — що виправлено, що ні і чому. Описи фіксів — англійською, як їх записали виконавці.

> **Як читати.** Розділи «Не виправлено» нижче — це звіти пакетів до інтеграції. Частину пунктів, які пакет не міг закрити у своїх файлах (M56, M59, H05 у render.ts, M60, M41, M46, M05, M19, M2 та інші), потім закрив інтегратор: див. розділ «Застосовано інтегратором» у кінці.

## core-expr

Файли: `packages/core/src/{expr,shims,argparse,toolheader,duration,sha256}.ts`

### Виправлено

- **H05** — Shared-structure DAG values no longer cause exponential walks.
- **H06** — Doubling a list with '+' is charged step(a.length+b.length) and size-capped through own().
- **M51 (ReDoS via ~ / grep) + L43 (G107 once per process, unbounded regexCache)** — Replaced V8 backtracking RegExp for `~` and grep with a built-in linear-time Pike VM.
- **M59 (expr part)** — min/max builtins use a loop instead of Math.min(...spread), so lists of 100k+ items do not throw RangeError.
- **parser stack overflow (sweep)** — Parser.expr limits nesting to 200 levels.
- **L41** — Dashes join a member segment only for the store key directly under the root `data` (data.api-endpoints, data?.x-y).
- **L42** — The string tokenizer decodes \uXXXX, \u{…}, \xHH, \b, \f, \v and \0, so every string JSON.stringify emits round-trips, lone surrogates included..
- **L44** — sort decorates keys once, with composite keys turned into charged text.
- **L45** — The fence filter uses the new exported fenceText(body, lang): the fence is one backtick longer than the longest backtick run in the data, as CommonMark requires.
- **L31 (argparse part)** — findKey uses hasOwnProperty, so --constructor, --toString, hasOwnProperty and __proto__ are reported as unknown parameters in both argv and tool-call objects.
- **L67** — A new isFullSchema() treats an object as a full schema only when one of these holds: a schema-only key (properties, items, enum, const, anyOf, oneOf, allOf, $ref, $schema) has a non-string value, or `type` is a primitive and every other key is a JSON-Schema keyword whose value is not a shorthand type name.
- **L65** — The Python shim dumps each result with allow_nan=False inside the per-call try.
- **L66** — The bash shim now: (1) clears its positional parameters before `source`; (2) saves the module's shell options, reading errexit from $- because `set +o` inside $( ) drops it; (3) runs the loop with +e +u +o pipefail; (4) restores the module's options inside each call's command substitution.
- **sha256 lone surrogates (sweep)** — utf8() now encodes lone surrogates as U+FFFD, as Node Buffer and createHash do.

### Не виправлено

- **M56 (@fn expansion blowup)** — It is in packages/core/src/mddsl.ts:565, not in expr.ts, so it is outside my files. *Потрібно:* other package (mddsl owner)
- **M59 (render.ts part)** — normalizeMarkdown at render.ts:137 still uses Math.min(...indents), and render.ts:362 uses Math.max(...spent). I do not own that file. *Потрібно:* other package (render.ts owner), see deferred_cross_file
- **H05 (render.ts walkers)** — stableJson, snapshot (the @run stdin), JSON.stringify in trace/debug and toText for {{ }} output in render.ts do not charge the budget. Expression-built values are now capped at 2^20 cells and 256 depth, so a single walk is bounded. But a @repeat that prints a near-cap DAG thousands of times is only bounded by steps × 1M cells until render.ts calls chargeValue. *Потрібно:* other package (render.ts owner), see deferred_cross_file
- **O8 @run ts without type stripping** — Adding --experimental-strip-types or --input-type=module-typescript to DEFAULT_EXECUTORS.node or NODE_SHIM breaks Node versions that do not know the flag (Node 20 or early 22 fails with 'bad option'). Doing it safely needs a decision on supported Node versions, or host-side version detection. *Потрібно:* human decision
- **regex engine speed** — The Pike VM costs about 70 ns per (char × instruction) in JS. That is linear and charged at 1 step per 1024 units, so a 10k-step budget allows about 10M units (~1 s). Large greps over script output now cost visibly more steps than before. A faster pure-JS DFA cache could be added later if needed. *Потрібно:* design (only if real prompts hit G155 on grep)

## core-render

Файли: `packages/core/src/{render,mddsl,assemble,health,codes,runjson,examples}.ts`

### Виправлено

- **M65 / R3** — The @run key (used for the in-render result, dedupe and the persisted cache) now hashes the code plus its stdin input: args, loop items, @let values and the scope except per-turn ctx/session.
- **store must not overwrite good data** — store=, @store and @call store only persist a result that was really produced (status ok, not a stub, no onError).
- **M63** — An @if whose test reads data that is not ready yet (a result miss, or a pending run/call variable or a @let derived from one) renders its branch speculatively.
- **M67** — Pending tracking: an Interp.unready set plus a missCount.
- **M66** — A @run blocked by needs= on a name nothing produces is recorded.
- **M64** — @let now binds in the section frame, or the @fn call frame, matching SPEC and G153.
- **M61** — When a module batch throws (RenderHost.call cannot report per-call errors) and budget is left, each call is retried on its own.
- **M62** — The render budget now covers @call, providers and @mcp, not only @run.
- **M69** — CompiledPrompt.uses is no longer merged into one global map.
- **M68** — Lazy tool names: when get_<name> is already taken by another ref, or the name has no ASCII letters or digits, a 6-hex hash of the ref is appended.
- **M04 (render parts)** — Secrets are masked before serialization and truncation.
- **M58 / duration drift** — Deleted parseDurationMs.
- **M60** — parseStdout turns number-looking output into a number only when it is finite and prints back exactly.
- **M59 (render/mddsl part)** — normalizeMarkdown and mddsl dedent find the minimum indent with a loop instead of spreading into Math.min (no RangeError on 200k lines)..
- **L61 + fence length** — Budget truncation closes a fence left open by the cut (CommonMark tracking in the new exported openFenceAt) and never splits a surrogate pair.
- **L60** — materializeData adds fetchedAt and stale to object values as non-enumerable fields.
- **M56** — @fn expansion: the call graph is checked statically (unknown G001, arity G004, recursion G151) without expanding bodies, and the discarded validation expansion pass is gone.
- **M57** — When an argument names an earlier parameter of the same function, arguments are bound to __fnN_i temporaries in the caller frame first, then the parameters.
- **L55** — Fence tracking follows CommonMark: a fence closes only with the same character, at least as long, with no info string.
- **L54** — `\{{` is a literal `{{` in Markdown text, including inside fences.
- **L53** — New MarkdownParseOptions.tiers.
- **L57** — The first word of @include/@section/@skill/@rule is the path or name even when quoted; a quoted word after it is the description.
- **L58** — printMarkdownNodes prints an else that is a single if as @elif (flat, one @end, no G156).
- **L56** — @break/@continue in an @fn body reachable from a call site outside any loop gives G005 at expansion.
- **L49 / P1 (H002)** — The H002 fallback is now the share of the unchanged prefix (same id and hash at the same position; it stops at the first changed or moved section).
- **L50 (H003)** — Drift counts changed content: the span between the common prefix and suffix of the section texts, in tokens.
- **L32** — assemblePrompts (compiled ids, Markdown paths) and dataScope sort with a locale-independent code-unit comparator instead of localeCompare..
- **codes table** — Added G016 and G314–G317, which other packages' in-flight edits now emit, so test/codes.test.ts passes.

### Не виправлено

- **M66 parse-time check** — A parse-time G207 warning for needs= names with no producer breaks test/mddsl.test.ts:129, which asserts the exact diagnostics of a file using needs=a,b with no producers. I do not own that test, so only the render-time G207 was implemented. *Потрібно:* Decide whether to update mddsl.test.ts, then add the parse-time and LSP check
- **L54 (no interpolation inside fences)** — SPEC is silent, and the existing test 'fenced code is not parsed for directives but is interpolated' requires `{{ }}` inside fences to evaluate. I added the `\{{` escape instead. *Потрібно:* Human or spec decision
- **M61 contract** — A real per-call error channel needs RenderHost.call to return { results, errors } (types.ts plus both hosts). I mitigated it in core with a per-call retry when budget remains. *Потрібно:* Change in types.ts and the hosts (see deferred)
- **M04 prompt text / other sinks** — The rendered prompt text is not masked: SPEC says masking applies to debug output only, and masking would change what the model sees. The scope dumps in .trace/last.json, gate.index.json, run --json and the journal are written by files I do not own. maskValue and secretValues are exported for them. *Потрібно:* Changes in other packages (see deferred) plus a spec decision on masking the text
- **P1 freeze system prompt / P3 E2BIG / negative cache** — These are adapter- and host-level mitigations (freezing the system prompt per conversation, slimming stdin, negative caching with backoff). They are outside render/mddsl/health. *Потрібно:* Adapter/host design
- **M59 expr part** — evalBuiltin min/max in expr.ts still spreads the list into Math.min/Math.max; expr.ts is not one of my files. *Потрібно:* Change in expr.ts
- **M60 shims part** — shims.ts parseLoose has the same lossy-number problem; shims.ts is not one of my files. *Потрібно:* Change in shims.ts

## core-decide

Файли: `packages/core/src/{decide,config,glob,mdc,items,gatecmd,report,journal,gateindex,pipeline,types,toolheader-none}.ts and schema/context-gate.schema.json and types/index.d.ts`

### Виправлено

- **group negation (pl-theory decide.ts:230; prod-risk 'заперечення стає ескалацією')** — An item excluded by a group's `!` entry now counts as grouped (new items.ts `mentionedInGroups`, positive matches only), so it goes off instead of falling back to the more permissive ungrouped default.
- **preload negation / removal vs preload (pl-theory decide.ts:217,231)** — Negated `tiers[*].preload` entries (`!skill:a`, `skill:!a`) are ignored instead of preloading every skill.
- **M21 (core part, decide.ts:180)** — New `DecideOptions.advance` (default true).
- **M22 (core part, decide.ts:94)** — New `DecideOptions.modelAttrs` is passed to tierForModel, so the context-window/cost thresholds (G-01) decide the tier for an unmatched model id instead of falling back to standard..
- **M23/M5 (core part), L47** — `extractPromptFlag` takes any run of non-space characters (`[gate:фронт]`), so non-ASCII profiles are applied and stripped.
- **M52** — extractMentions strips IDE suffixes (`#L10-20`, `#L5`, `#L1-L9`, `:12`, `:3:4`, `:10-20`), so `@src/app/page.tsx#L10-20` and `@Button.tsx#L5` yield file paths..
- **L46** — New exported `RESERVED_GATE_WORDS`.
- **M53** — globToRegExp no longer throws on an invalid class such as `[z-a]`.
- **M54** — New `isRepoRelative(path)`.
- **M55** — parseGlobList splits quoted comma lists without brackets (`"a", "b"`) into separate globs.
- **M41 (core part)** — `ruleIdFromPath(path, sourceDirs?)`: under a custom cursor-mdc dir the id is the path below that dir (`api/x`).
- **M04 (gateindex.ts:89, config.ts:617)** — varsOf writes env keys with `***` values, both top-level `env` and `providers.env`.
- **S2 / M05 / H01 (core validator)** — New G314 (error) from `configPathDiagnostics`/`repoPathProblem`, run in validateConfig.
- **L34 / L36 / O5 tier validation** — G305 now also covers gates[].tiers, brief.tiers and budgets.tiers keys.
- **L35** — G312 checks the effective merged budget (DEFAULT_BUDGET, then budgets.default, then budgets.tiers[t]) for default and for each tier..
- **R6 (config version)** — Schema gets `version` (integer ≥1) and the core gets CONFIG_VERSION=1.
- **L37 / O5 model ids** — normalizeModelId strips any `<region>.anthropic.` prefix (global, apac, us-gov, …) and keeps the last segment of ARN and gateway paths (`anthropic/…`, `openrouter/anthropic/…`).
- **L33 (core part)** — commandAllowed judges an argv[0] that contains a path as a path.
- **L31 (items.ts:184, decide.ts)** — New `ownEntry` own-property lookup is used in resolveGroupRef, expandGroups, the classifier `known` check, the manual-profile check, profile groups, enablingGroup and pipeline itemProvenance.
- **L38** — `profileParts(profile, cfg)` treats a declared profile whose name contains `+` (c++) as one profile.
- **L39** — New `DecideOptions.nocase` is passed into when.paths matching..
- **L40** — parseClassify tries each balanced `{…}` candidate, respecting strings, and returns the first one that parses with a known profile..
- **L64 (core part)** — logOf copies signals.ticketId and signals.ticketType into decision data.
- **M2 (core part: measurable agreement)** — New `shadowAgreement(entries)` in report.ts.
- **L62** — tierCosts counts gate-attempt `pass` and `block` as attempts.
- **L63** — denySuggestions resets the running profile on every decision except verify rows, so a decision without a profile no longer leaves a stale one in effect..
- **L51** — formatWhy skips decision entries with trigger 'verify' (shiftwork Verify passes)..
- **L59** — observeCounts uses report's exported `deniedItem` (handles the mod's `data.skill`) and skips denies with `data.shadow === true`..
- **L52** — expandFileRefs treats a ref as a file only if it starts with `./` or `../`, ends with `/`, or has an extension on its last segment.
- **L48 and glob details** — Zero-padded brace ranges keep their padding (`{001..050}`).
- **O1 (partial)** — Ungrouped `mcp__ide__*` tools (the harness IDE bridge) stay on in decideGate.

### Не виправлено

- **O1 (ungrouped MCP default on / defaults.mcp)** — Turning every ungrouped MCP tool on contradicts the current documented behaviour and an existing test (test/decide.test.ts:47 expects mcp__other__x off). Only the mcp__ide__* exception was made. *Потрібно:* human decision (spec/defaults), then a test update
- **glob catastrophic backtracking for `*a*a*a…ab`** — Needs a non-regex (linear) glob matcher. Only the `**/**/` runs were collapsed. *Потрібно:* design (rewrite matcher)
- **pl-theory design items: `when` OR vs AND, unanchored when.branch, union ratchet, `-profile` removing shared groups, gitignore-style re-inclusion, matchBase depth vs Cursor, integer-key ordering in models** — These are semantic and design changes the spec does not settle. Changing them silently would alter decisions for existing configs. *Потрібно:* human decision / spec update
- **M19 (when.expr / when.ticketType never filled)** — The core already supports both. The adapters must fill signals.data and ticketType (and now ticketId). *Потрібно:* other packages (hooks mod, hooks-adapter, adapters/common)
- **L32 assemble.ts localeCompare, L49/L50 health.ts H002/H003** — These files are not owned by core-decide in this run. *Потрібно:* other package
- **G014-style new codes registration** — G016, G314, G315, G316 and G317 are emitted with an explicit severity, so they behave correctly now. codes.ts is not mine, so test/codes.test.ts ('every diagnostic code literal exists in CODES') fails until they are added. *Потрібно:* codes.ts owner (see deferred)
- **M2 full (data.wouldApply, label writer, log.file in init, log only on change)** — Only the core metric was done. The writers live in the mod, CLI init and cmd-report. *Потрібно:* other packages

## hooks-guard

Файли: `hooks/layers/{gates,trust,host,journal,session,config,budgets}.ts, hooks/ctx.ts, hooks/state.ts, hooks/register.ts, hooks/testkit.ts`

### Виправлено

- **H01 (data #69/#200/#226)** — onlyNew baselines: `gates[].baseline` must be repo-relative (insideRoot); the file is written only for a trusted repo and only when its real target (symlinks resolved, a link itself refused) stays inside the repo; otherwise the baseline lives in memory for the session.
- **H02 (host part, data #204)** — New readRepoFile/insideRealRoot/writableInsideRoot in host.ts: lexical insideRoot plus $.fs.stat({resolve:true}) realPath containment against the resolved root (Windows case-insensitive).
- **M08 / L (data #73/#221)** — COMMIT_RE replaced by isGitCommit(): splits lists/pipelines/$( )/backticks, finds any `git` word, skips global options with their values (-C, -c, --git-dir, --work-tree, ...), subcommand must be exactly `commit` (commit-tree excluded)..
- **M09 / S13 (data #76)** — expandArgv: whole-element {file} becomes one argv word; inside a larger element (sh -c script, --file={file}) only paths without shell syntax are substituted, otherwise the gate refuses with a message; paths outside the repo refused/dropped (also {changedPaths}); leading '-' defused as ./-x; function replacer so `$&` stays literal.
- **M10 (data #84)** — onlyNew compares position-free keys (strips (l,c), :l:c, leading l:c, 'line N'; JSON violations drop line/column/range/...
- **M11 (data #74)** — gateProvider builds its host with makeRenderHost + providerConfigs(promptDir), so module providers (gate.json and <prompt dir>/lib) run through the shim when trusted; an unavailable provider is a visible skip (or a block with failClosed)..
- **M12 (data #83)** — Baseline is captured before the first edit of the session for every onlyNew gate without one (pass records []), and on the first run only while no edits happened; a failure after edits with no baseline is reported as all-new instead of silently becoming the baseline.
- **M13 (data #85)** — `write` command gates moved after next(e) (gatesAfterWrite in register.ts tool.call): they check the new content; a failure is appended to the tool result context (and counts as a failed verification) instead of a pre-edit deny.
- **M14 / R2 (data #77)** — cacheSet goes through cachePut: a `cache-index` store key tracks size/time of every cache entry, total bounded to ~1.5 MB (oldest evicted), 64 KB per entry, first write per runtime sweeps unindexed `cache:*` keys (legacy/orphans); trust/data keys never evicted.
- **M16 / R1 (data #61/#75/#210)** — flushJournal re-reads the file on every flush and appends (serialized per runtime), never writes when an existing file cannot be read (buffer capped, one toast), and rotates the oldest lines past 5000 lines or 2 MiB (UTF-8) into .claude/gate.log.1.jsonl instead of cutting them.
- **M17 (data #79)** — classic.SessionStart source resume/fork and session.end reason resume reset the conversation (readFiles, changedPaths, seen, turn, budgets, caches) like /clear..
- **M25 (data #231)** — needsTrust also covers classify/brief cli providers and module providers (matches commandsHash), so the trust question is asked..
- **M26 / R8 subagent part (data #72) + L10 (data #89)** — session.compact with agentId passes instructions through, skips compactAfter (no recheck, no static cache clear, no compaction count) and forgets only that agent's `seen` keys; a vetoed/skipped compaction ({skip}) no longer counts, clears the cache or schedules reclassification..
- **S1 + L09 (data #202/#205/#219) + FNV->sha256** — Trust is bound to sha256(commandsHash ⊕ surfaceHash).
- **S5** — allowedBinary (executors, cli providers, shims, scripts) and command gates require a bare argv[0] (no path), so ./tools/node or /tmp/x/git never start; executors[].env may not set PATH, NODE_OPTIONS, NODE_PATH, PYTHONPATH/STARTUP/HOME, BASH_ENV, ENV, PERL5*, RUBY*, LD_*, DYLD_* (dropped with a debug line)..
- **S6 / R7** — A skipped gate (untrusted, whitelist, -p, provider unavailable, path argv) is shown once per session per reason (toast + debug); gate.json `failClosed: true` turns the skip into a block.
- **S14** — New config.set hook: another plugin's $.config.set or a bridge may not set context-gate trustBuild=always or allowScripts=true (only origin composer); .catch denies for those keys..
- **L03 (data #88)** — ensureSession memoises the bootstrap promise (rt.boot); ready is set only after bootstrap succeeds, so concurrent hooks on a fresh runtime await it instead of seeing an empty config; sessionStart resets rt.boot..
- **L02 (data #233)** — On a gate.json schema error, well-typed cursorRules booleans (enabled/nested/strictWrite) of the broken file still apply to the default config, so a disabled cursor-rules layer stays off; only layer 2 is disabled..
- **testkit** — testkit: `links` option (symlinks: read/write follow, stat reports isLink and realPath with resolve); fs.stat answers realPath.

### Не виправлено

- **M15 (data #227)** — Provider onError skip/fail at section level and the null-vs-{unverified:true} representation span the render options in dsl.ts (RenderOptionsExt.onError never set), core mdc.ts providerRules (relies on {unverified:true} for G203) and the CLI. Changing providerData alone would drop G203 for provider rule sources. *Потрібно:* other package (dsl.ts owner + core/CLI) coordinated design
- **L01 / R5 (data #80)** — Persisting readFiles/changedPaths across hot reloads needs a new $.state key (types/index.d.ts PluginState + atom) or a store-backed list; a reload cannot be told apart from a test/first hook without session.start, so 'unknown → allow' would break existing rbw semantics. *Потрібно:* human decision + types/index.d.ts change
- **R8 (rest)** — Keeping the profile when no candidate reaches minConfidence after compaction and not re-briefing after compaction live in skill-gate.ts (hooks-skill package). Subagent and vetoed compactions are fixed here. *Потрібно:* other package (skill-gate.ts)
- **S2 (prompt.dir, itemSources.dir, debugLog.path)** — Those joins live in dsl.ts / cursor-rules.ts / core config validation, not in my files; baseline (H01) is fixed here. *Потрібно:* other package (core validateConfig G3xx + dsl.ts)
- **S1 (remaining)** — No auto-build removal from compose/session.start (dsl.ts/session buildStale is triggered only when trusted, and trust now re-asks when TSX/lib change, which covers the PR-checkout flow). Fingerprint uses size+mtime: a same-size change with a forged mtime is not re-hashed until the fingerprint changes. prompt.packages versions and CLI trust store unification not covered. *Потрібно:* design decision (per-render content hashing cost) + CLI package
- **S8 (allowMcp)** — @mcp already requires trust in the mod (host.mcp and render.ts check trusted) and is now in the trust hash; a user-level allowMcp list / first-call confirmation is a new feature needing userConfig/schema. *Потрібно:* design
- **S14 (project-scope settings)** — Whether project .claude/settings.json can feed PluginOptions is unverified (LIVE probe); PluginOptions carry no scope, so the mod cannot tell. Only $.config.set from other plugins/bridge is guarded. *Потрібно:* live probe

## hooks-skill

Файли: `hooks/layers/{skill-gate,dsl,cursor-rules,commands,ui,editor,index}.ts`

### Виправлено

- **M21 (+ low dup 'model-change/gate.json recomputes count as hysteresis turns')** — recompute() is now serialized per runtime and passes core decideGate `advance` = (trigger === 'prompt'): /gate commands, why-pane buttons, gate.json reloads and model changes no longer move gateState.turn or the hysteresis counter, so `/gate apply` before the first prompt keeps the classifier and brief, and a profile switch needs two real prompts.
- **M22 (+ low dup in skill-gate.ts:183 and dsl buildScope)** — recompute passes modelAttrs {contextWindow} (core decideGate option) so a threshold-inferred tier (G-01) survives; materialize keeps the stored gate.tier; dsl buildScope uses the stored main-loop tier (and modelTier for another model, i.e.
- **M20 / risk M4** — `applied` = mode auto, or manual profile/off (or the runner's plan profile); `/gate +g`/`-g` alone keep shadow (they edit the proposal).
- **M23 / risk M5** — `[gate:off]` sets manual.off, `[gate:auto]` resets manual and rechecks, `[gate:new]` rechecks; any other word is applied as a profile only when gate.json declares it (profileParts with cfg), else G502 toast + journal and the flag is ignored (still stripped from the prompt)..
- **M24 / risk R8** — gatePromptSubmit separates 'reclassify' (turn 0 or any recheck) from 'new task' (turn 0, /gate new, [gate:new], [gate:auto]); a compaction recheck re-derives the profile (classifier runs) but no longer resets escalation counters nor generates a new brief..
- **M18** — When gate.json becomes invalid, recompute clears the stored gate (null), invalidates prompt.attachment/tool.describe if it was applied and refreshes the band; gateFor returns null without rt.config; offerAgent offers everything; cursor-rules readGate(io, rt) and dsl preloadOf(io, rt) ignore a stored gate without config..
- **O1** — New refineGate() post-processes every core decision in the mod (recompute, materialize, per-agent gateFor): an MCP tool that no group mentions (personal server, claude.ai connector) and any mcp__ide__* stays on (explicitly grouped tools still follow the profile); reasons are rewritten ('MCP поза профілем вимкнено: …' only for really denied servers, plus 'MCP без групи в gate.json не фільтрується: …'); the decision log carries data.passthrough; one toast per session and server set when applied..
- **risk M10 (mod part)** — refineGate: a plugin skill `ns:name` that no group names in full follows the groups that name its bare `name` (on if such a group is active, off otherwise)..
- **M19 (mod part, when.expr)** — recompute and the first-prompt dry decision fill signals.data for when.expr (git.branch, session, tier and provider data via makeRenderHost/providerData, only when some profile has an expr); ticketType/ticketId and CONTEXT_GATE_PROFILE are read through optional port methods (planEnv) — wired once register.ts/ctx.ts expose them (deferred)..
- **M06, M07, risk M13** — skill.prompt no longer reads a per-name last-writer map: tool.call Skill (allowed for the calling agent's gate) and a typed `/name` (command.run) queue invocations per skill (cap 8, TTL 10 min, denied calls never queued).
- **M02** — repoCacheDir no longer matches by basename prefix: only dirs named with this root's own hash count, trying the engine's remote, '' and the standard spellings of the remote (https/http/scp/ssh/git, with/without .git) via new remoteSpellings()..
- **M05** — promptDir() falls back to .claude/prompt for an absolute or `..` prompt.dir (all reads, .trace/last.json, data/ writes, scripts/lib go through it); extra prompt-dir section dirs and cursor-mdc / markdown-dir rule source dirs outside the root are skipped..
- **M04 (mod part)** — .trace/last.json and journal snapshots: scope.env values replaced by *** (scopeForDisk) and the whole body masked structurally with core maskSecretsDeep before serialization (a secret with quote/backslash no longer survives, JSON stays valid)..
- **M01** — checkRoot flushes the old root's pending journal lines before switching, then resets per-repo evidence: journal/debug-log text, snapshot/debug/trace keys, readFiles, changedPaths, trustAsked/trustCache, buildAttempted/buildError, lastRender/lastHealth, prompts, recentPaths, seen, the fresh-seen set; clears the stored gate and drops a pinned manual profile the new gate.json does not declare.
- **L05** — Mentioned rule ids resolve exactly or by a unique `/`-suffix (findRule; also /rule <id>); an `@a/b` mention without extension that equals a rule id is that rule, not a file..
- **L06** — rulesContextBefore keeps the `main:` keys the latest prompt delivered (its @file/@id context rides the message prompt.context precedes) instead of wiping them..
- **L04** — seen keeps main plus the 16 most recently seen subagents (addSeen); agentTiers capped at 64 entries; /gate rules shows main plus the 8 most recent subagents..
- **L07** — serveOwnTool uses gateFor(io, rt, e.agentId) and the subagent's agentTiers entry for the profile gate and the `# tiers:` check; denies journal the agent..
- **risk M1** — Auto Attached rules are no longer gated by the profile (the glob is their gate), so a task that moves into another area still gets that area's rules.
- **risk M12** — recompute invalidates prompt.context when the set of Always rules switched off by the gate changes (Always rules no longer stay frozen at the conversation's first profile); otherwise prompt.context is left alone to keep the cached first message..
- **risks P4/P5** — In shadow mode the classifier and the brief wait at most SHADOW_GRACE_MS (1.5 s, session clock; a test clock that never fires leaves the call to finish): a late classifier answer lands as its own serialized 'classify' decision with keepTurn; a late brief is injected into the next prompt.
- **risk O7** — `/gate why <item>` (mod-side, pipes untouched): decision in force, groups that mention the item and which are active, mode, denies so far, how to enable; a missing item lists likely reasons (listing not seen yet, no MCP tools, rules layer off, claude-tools match).
- **risk P1** — Non-system delivery path exists (prompt.submit context).

### Не виправлено

- **M03 (mod part)** — The mod already follows the 'shadow is neutral' rule (no preload, no gate.profile in the render scope in shadow); I kept it, since that is consistent with risk M3 and with hooks/dsl.test.ts:188. Parity needs changes in CLI/hooks-adapter/pi/opencode. *Потрібно:* other packages (see deferred_cross_file)
- **M19 ticketType / CONTEXT_GATE_* env** — $.env.get needs literal names in register.ts and the Io.env port lives in ctx.ts; skill-gate.ts already reads optional port methods planProfile/ticketType/ticket. *Потрібно:* register.ts + ctx.ts change (deferred_cross_file)
- **L08** — readOptions (ctx.ts) maps an unset userConfig mode to 'shadow', so an explicit 'shadow' cannot be told apart from unset. *Потрібно:* ctx.ts readOptions change, then effectiveMode: `if (rt.options.mode) return rt.options.mode`
- **P1 freeze / H002 hint / H014** — Freezing all system sections per conversation was not done (a large SPEC change). H014 does not exist in core codes; the H002 hint text ('move to volatile') lives in packages/core/src/codes.ts. Default stays 'system' because changing it would break existing hooks/dsl.test.ts expectations and SPEC:285. *Потрібно:* human decision on the default; core codes.ts/health.ts owner
- **risk M8** — verifyFailed / stallTurns counting lives in gates.ts (not owned). *Потрібно:* gates.ts owner
- **risk M4 '/clear resets pins', risk P4 model-change debounce** — /clear handling is in session.ts; model-change debounce is a design decision (the tier still switches on the next step, though no longer as a hysteresis turn). *Потрібно:* session.ts owner / design
- **risk M10 'ungrouped skills → on'** — Would contradict SPEC (skills outside the profile are name-only) and existing tests; only the namespace matching part was done. *Потрібно:* human decision

## cli

Файли: `packages/cli/src/*.ts and bench/ and test/cli-misc.test.ts`

### Виправлено

- **H04** — findRoot walks up once: the nearest directory with .git or .claude/gate.json wins, so a nested repo beats an ancestor's gate.json.
- **H02 (cli part)** — New util safeJoin(root, rel): lexical check, then realpath of the deepest existing ancestor must stay inside realpath(root).
- **H03** — Invalid store keys are refused with a G001 warning in run diagnostics.
- **M29** — The SKILL.md live line now passes --args '$ARGUMENTS' in single quotes.
- **M30** — The live line uses node "$CLAUDE_PLUGIN_ROOT/dist/cli.js" when CLAUDE_PLUGIN_ROOT is set.
- **M31** — Only the line after the sentinel is parsed, inside try/catch, and a parse failure becomes a G164 for that entry.
- **M32** — New pruneOrphans: ids in the previous lock but not in the new one (removed or renamed prompt; old ids of a cleanly rebuilt entry are dropped from the lock) lose their .compiled/<id>.json and their generated SKILL.md (marker checked).
- **M33** — build never overwrites a SKILL.md without `generated-by: context-gate`: it reports a G001 error instead.
- **M34** — checkStale keeps every compiled file per entry and decides only by the ids the lock assigns to that entry.
- **M35** — ensureBuilt now returns {diagnostics, built}.
- **M36** — sync calls ensureBuilt before rendering, unless --no-prompt.
- **M37** — loadMarkdownRules skips .claude/rules/cursor/** and files carrying the `<!-- generated by context-gate from` marker, so sync no longer reads its own output back..
- **M38 (cli part)** — With classify.mode shadow and no explicit --profile/--tier, sync writes no skillOverrides.
- **M39** — New readSettingsForUpdate: {} when the file is missing, undefined when it does not parse.
- **M40** — With nested rules on, files are listed with `git ls-files -co --exclude-standard` (honours .gitignore, raw paths, no optional locks).
- **M42** — gitInfo runs `git status --porcelain=v1 -z -uall` with core.quotePath=false.
- **M43** — Every git call uses --no-optional-locks and GIT_OPTIONAL_LOCKS=0.
- **M44** — Module provider bundles are keyed by a manifest of every metafile input plus the esbuild version, so editing an imported helper rebuilds the bundle.
- **M45** — When the repo has node_modules, bundles are written to <root>/node_modules/.cache/context-gate/modules/ so npm imports resolve from the repo.
- **M46 / P3 (cli part)** — NodeHost.run puts the input in CONTEXT_GATE_INPUT only up to 64 KiB (INPUT_ENV_MAX).
- **M47** — The listExports cache key now includes the module file hash..
- **M49** — writeText writes through a symlinked target: the temp file goes next to the real file and is renamed there, so the link stays a link.
- **M50** — runProcess spawns the child as its own process group (POSIX) and kills the group on timeout.
- **M04 (cli part)** — New maskedScope(): scope.env values become *** in run --json, .trace/last.json (jsonOf) and gate.index.json (cmd-index)..
- **P2** — Providers.resolveAll resolves all providers in parallel under one shared deadline (PROVIDERS_DEADLINE_MS = 12 s).
- **R9 / L14** — All build outputs are written atomically (tmp + rename): .compiled, SKILL.md, prompt.lock.json, .types.
- **S10** — New ciTrustCheck: on GITHUB_EVENT_NAME=pull_request_target, --trust-repo is ignored with a warning unless CONTEXT_GATE_TRUST_PR_TARGET=1.
- **O2** — In text mode, run writes H013, G204 and G203 warnings to stderr, not only errors, so `claude -p` and CI see when the context is thinner.
- **O8 (cli part)** — runProcess runs argv[0] === 'node' as process.execPath (the whitelist is still checked on 'node'), so PATH-less or GUI launches still work.
- **bench baseline test (cli-misc 'bench: bench/repos.json…')** — Root cause: .compiled/ is gitignored (Р3), so a fresh checkout or worktree has no compiled TSX, and benchRepo rendered an empty system prompt (promptTokens 0).
- **commitCompiled flag (L16)** — removeGitignoreLines also drops equivalent forms (leading or trailing /).
- **L13** — Stage commands declare their bool flags (json, trace, markers, dry-scripts, dry-run).
- **L15** — init: a package or app named core or always gets its own pkg-/app- group instead of merging into the tier-wide seeded groups..
- **L17** — `report --since` with an unparseable value or a unitless number exits 2 with a usage message..
- **L19** — run exits 1 on any error diagnostic, including context errors (missing fixture, config) and auto-build errors..
- **L20** — health keys last-render.json by tier, profile and model..
- **L22** — syncWatchPaths covers every cursor-mdc dir and markdown-dir source..
- **L23** — setData with persist no longer mirrors the value into the cache store and removes a stale cache entry.
- **L24** — YAML: an empty or comment-only `-` item is null unless a deeper-indented block follows..
- **L25** — preserveJsxText decodes about 130 common HTML named entities (ge, le, rarr, …).
- **L26/L27** — watchLoop runs once more after a change made during a run (trailing run).
- **L28** — New stdinHasData() (FIFO or file only).
- **L29** — `example skills` copies into the configured prompt.dir..
- **L30** — walkFiles follows symlinks whose realpath stays inside the root, with loop protection..
- **L31 (cli part)** — The TOML and YAML parsers read keys as own properties only and set them with defineProperty: __proto__ becomes an ordinary key and constructor/toString tables parse..
- **L33 (cli part)** — shimAbs checks host.allowed('node') and emits G201 before running a bundled module provider..
- **M48 (partial: ctx['key'])** — transform.ts handles the ctx['gate'] element access before translating the bare ctx, so it is no longer rejected.

### Не виправлено

- **M48 (newline flattening when a conditional prop is lifted)** — Re-emitting the element twice under If/Else doubles its line count. The current `.replace(/\n/g,' ')` keeps the file's line numbers, but it flattens text, code fences and template literals. A correct fix has to either preserve the newlines (shifting every later line, which breaks diagnostics and source maps) or restructure the lift (for example, hoisting the branches). Not a safe small change. *Потрібно:* design
- **L18 (prompt.assertFail fallback)** — Dropping the fallback breaks test/observability.test.ts:170, which asserts it, and the schema/mod parity choice is a spec decision. *Потрібно:* human decision; then test/observability.test.ts and either schema+mod or assertFailOf
- **L21 (skillOverrides ownership kept in cache)** — Moving the ownership marker into settings.local.json adds a non-Claude key to Claude Code settings, which Claude Code may reject or warn about. Storing it in .claude/ needs a new file convention. *Потрібно:* design
- **M41 (cli part)** — Does not reproduce on the current code: ids from a custom cursor-mdc dir are full paths (docs/rules/api/style vs docs/rules/web/style); verified with `collect --kind rule`. Any change to the id format belongs in core mdc.ts. *Потрібно:* other package (core) if shorter ids are wanted
- **R9 rest (CRLF/BOM normalisation of source hashes, compiler version from package.json, inter-process .compiled lock)** — Changing the hash input or COMPILER invalidates every committed prompt.lock.json (examples included) and the tests that compare them. Atomic writes already cover the torn-read case. *Потрібно:* human decision
- **O8 rest (Windows python3/bash stubs, esbuild-wasm, macOS/Windows CI)** — Platform and CI work outside these files. *Потрібно:* other package / CI
- **M29 residual** — $ARGUMENTS is substituted as raw text before bash runs, so no single-line quoting is fully safe. Single quotes stop all expansion, but a `'` in the arguments still ends the quote (Ukrainian «п'ять» or English «don't» can make the line fail to parse). A quoted heredoc (multi-line `!` block) would be airtight, but whether Claude Code supports a multi-line `!` block is unverified (PROBE.md LIVE item). *Потрібно:* live probe of multi-line !`…` in Claude Code
- **bench/run.ts health without build** — bench/run.ts drives dist/cli.js `health`, which still sees no .compiled on a fresh checkout. Adding a `build` step would write .compiled and SKILL.md into the committed example repos. The tested CLI `bench` path is fixed. *Потрібно:* human decision (allow writes in bench repos or add an in-memory build flag to health)

## adapters

Файли: `packages/hooks-adapter/src/*.ts, packages/adapters/**/*.ts, probe/context-gate-probe/hooks/register.ts`

### Виправлено

- **M74 / R4 (main.ts:66/79, node.ts) session-state race** — Hook state read-modify-write now runs under an O_EXCL lock file (`<state>.lock`, 2 s wait with jittered retry, stale lock broken after 10 s) via new `updateState` in node.ts.
- **L84 (main.ts:79) state write failure swallows output** — The state write error is returned from updateState and logged with debug().
- **M75 (main.ts:168) isEntry through symlink** — New exported `isMainModule` realpaths both argv[1] and the module path, so the npm bin and other symlinks run..
- **L87 (main.ts:170) install/plan errors swallowed** — install and plan now run inside `command()`, which writes the error to stderr and returns exit 1.
- **M72 (handle.ts:323/325) @file mention not counted as read** — onPrompt now also pushes mentioned files into state.read, matching the mod's gatesMentioned..
- **M73 (handle.ts:413/414, common/session.ts promptHint) deny hint pins an undeclared profile** — The deny hint now uses new `flagForGroup(cfg, group)`: the group itself if it is a declared profile, else a declared profile that contains the group, else `[gate:off]`.
- **M71 (handle.ts:282) Always rules enabled by a later profile never delivered** — When a prompt changes the applied gate's profile or off state, onPrompt now packs any allowed Always rules not yet delivered (dedup through seen).
- **M03 (+ L-preload, R10 part) shadow parity: adapters preloaded in shadow** — Tier preload is now only for the applied gate, never when the gate is off, and never on SessionStart resume/fork.
- **M76 (shiftwork.ts:120/130) plan env loses ticket Skills +g/-g** — plan.env now carries CONTEXT_GATE_ADD / CONTEXT_GATE_REMOVE (only when non-empty).
- **L90 (shiftwork.ts:228) preload twice in a shift** — plan.env gets CONTEXT_GATE_PRELOAD=system when appendSystemPrompt carries preload bodies.
- **L89 (shiftwork.ts:225) plan skillOverrides never say 'on'** — plan.settings.skillOverrides now sets an explicit 'on' for every known skill the plan grants (on + preload), so a stale key from install time loses the key-by-key settings merge.
- **L79 (handle.ts:419/420) read-before-write default tiers include premium** — `readBeforeWriteActive` (now exported) requires `builtin: true`.
- **L80 (handle.ts:441) gate-failed lacks data.gate** — The read-before-write gate-failed entry now carries data.gate='read-before-write' and data.on='write', so core gateFailures and `report` count it.
- **L77 (handle.ts:274) compact always rechecks** — SessionStart(compact) now re-decides the profile only when classify.recheckOn contains compact, the same check as the mod's recheckOn..
- **L78 (handle.ts:308) machine UserPromptSubmit advances hysteresis / applies flags** — Prompts with source system, loop_wakeup, schedule_wakeup or poll_event are now a no-op: no turn advance, no `[gate:x]` or `/rule`, and the state is not written..
- **L75 (handle.ts:161) model switches not seen** — New PostModelSwitch handler: state.model is set from to_model, the gate is re-decided with advance:false and the decision is logged.
- **L81 (install.ts:32) subagents never get Always rules** — A SubagentStart hook is now installed by default.
- **L76 (handle.ts:268) forked session starts empty** — On SessionStart(fork) with no state yet, runHook finds the parent session id in the first 256 KB of transcript_path: the first `sessionId` that is not our own.
- **L82 (install.ts:62) install --profile typo** — install now validates every part of --profile against gate.json (new `unknownProfiles`).
- **L83 (install.ts:66) install/uninstall removes the user's hooks in a shared matcher** — Removal now works per hook, not per matcher.
- **L85 (main.ts:108) install/uninstall deletes the user's skillOverrides** — install now keeps a sidecar record of the keys it wrote: `<cache>/installs/<settings path>.json`.
- **M38 (main.ts:114) install hides skills in shadow** — Without --profile, --tier or --model, and with classify.mode other than auto (or no gate.json), install now writes no skillOverrides and prints why..
- **L86 (main.ts:126) settings backups inside the repo** — Backups now go to `<CONTEXT_GATE_CACHE_DIR or ~/.cache/context-gate>/backups/` (new `backupPath`).
- **O3 hooks adapter coexisting with the mod** — New `modPluginEnabled` reads enabledPlugins `context-gate@*` from local, then project, then user settings; the most specific scope wins.
- **M28 (pi/index.ts:46, opencode/index.ts:66) journal ignores log.file** — The default journal writer now appends only when gate.json has `log.file`.
- **M27 (opencode/index.ts:60) child sessions ignore the parent's [gate:x]** — A new opencode session now inherits the parent's manual override, committed GateState, model and current gate through `inheritSession`.
- **L11 (common/session.ts:500) editing a .mdc marks the rule delivered** — A .mdc now counts as delivered only on a full `tool:read` or a prompt mention, not on edit or write..
- **L12 (opencode/plan.ts:221) JSONC with comments or trailing commas disables MCP gating** — New `stripJsonc` is string-aware: it removes line and block comments, then trailing commas, in linear time.

### Не виправлено

- **L88 (shiftwork.ts:122) pluginDirSymlinks include in-worktree skills** — test/shiftwork.test.ts:97 asserts that `.claude/skills/tdd` is in the list, and SHIFTWORK.md's runner snippet relies on it. Changing the contract without the test owner and a doc decision would break both. The report's alternative fix is a doc change in the runner snippet: filter `!p.startsWith(root)`. *Потрібно:* human decision (code vs SHIFTWORK.md runner snippet) and an edit to test/shiftwork.test.ts
- **R10 (rest): adapter parity of repo-root detection, per-agent read-before-write, when.expr** — Root detection (CLAUDE_PROJECT_DIR/cwd vs ctx.location vs mod root), when.expr signals.data (M19) and a single core read-before-write implementation belong in core or the mod, not in adapter glue. The adapter-side parity items in my files are fixed: preload in shadow, read-before-write tiers and builtin, G502 flags, deny hint, @file as read, log.file, recheckOn, ADD/REMOVE env. *Потрібно:* core package (shared root/read-before-write helpers) and the mod package
- **O3 (partial): npx-cache install path / bare `node`** — install only warns when the script lives under `_npx`. It still writes `node <abs path>`, because process.execPath (an nvm/versioned path) would break after a Node upgrade. A stable path needs a packaging decision, for example `${CLAUDE_PLUGIN_ROOT}`. *Потрібно:* design/packaging decision
- **R4 (rest): per-event process cost, rule/skill cache by mtime, TTL for old state files** — These are performance and housekeeping, not correctness. Locking and merging fix the data loss. Caching and TTL would add more I/O surface than this pass should take on. *Потрібно:* follow-up task
- **probe/context-gate-probe/hooks/register.ts** — No confirmed finding or listed risk targets this file. Left unchanged. *Потрібно:* nothing

## tooling

Файли: `packages/jsx/src/*.ts, packages/lsp/src/*.ts, packages/editor-web/src/*.ts, editors/**`

### Виправлено

- **M81 (core.ts:204 dedent)** — dedentPieces now takes the strip amount only from pieces that start on their own line (authored JSX text/template blocks); a piece starting mid-line (imported code, YAML, nested lists, text after an expression) is dedented by that amount only when all its lines are indented at least as much, so data strings keep their nesting..
- **M80 (core.ts:103 JS methods)** — Proxy apply reports G160 (with a pipe-filter hint) for known JS value methods (join/map/slice/toUpperCase/includes/...) called on an Each item/index reference or on a ctx path of 3+ segments; provider calls such as git.log(3), fs.glob(), cursor.match() are unaffected.
- **M79 (components.ts:313 Mcp args / exprLiteral)** — mcpArg no longer JSON.stringifies objects (G160 via exprOf, since the language has no object literals).
- **M82 (core.ts:288 Run code refs)** — rawText reports G160 for ctx/Each reference children of <Run>, with a hint to read the context from stdin (CONTEXT_GATE_INPUT) or use <Call>.
- **M77 (compile.ts:25 multi-skill diagnostics)** — Each <Prompt> claims the diagnostics recorded since the previous Prompt (claimDiagnostics, kept in a WeakMap).
- **M78 (components.ts:175 Each trailing newline)** — New loopBody() keeps a body's authored trailing line break (string ending in \n, or a Fragment flagged by a hidden symbol) after inline content (text/expr) in build-time and runtime Each and in Repeat.
- **M83 (lsp/analyze.ts:109 CRLF offsets) + L98 JSX attribute entities/backslashes** — Replaced literalMap with literalValue(): an escape-aware scanner over the raw source that builds the value and a full value→file offset map.
- **M84 / S12 (lsp/runcli.ts:60, plugin.ts:158 Windows shell)** — New spawnPlan(): no shell on POSIX.
- **S4 (default `npx context-gate`)** — The default CLI is now `npx --no context-gate` (DEFAULT_CLI), so npx never installs a squatted package.
- **S12 VS Code** — In the extension manifest, contextGate.cliPath has scope `machine` and is listed in untrustedWorkspaces.restrictedConfigurations.
- **M70 (editor-web/page.ts:91 esm.sh) — partial** — CodeMirror modules are pinned to exact versions, with ?deps= pinning the shared @codemirror packages (CODEMIRROR_URLS); floating @6 is gone.
- **editor-web XSS / CSRF / DNS rebinding / path safety** — Already present and confirmed: binding to 127.0.0.1, the Host check (421), the Origin check and the per-run token.
- **L68 (page.ts:124 CRLF save)** — The client detects CRLF on load, edits LF text and writes CRLF back on save; dirty comparison uses the normalized text..
- **L69 (page.ts:141 save marks later keystrokes)** — save() captures the sent text before the PUT and sets saved = sent.
- **L70 (page.ts:146 unsequenced preview)** — The client ignores stale preview responses (sequence counter).
- **L71 + L73 (server.ts:101,185 section id matching)** — New sectionIds() uses a quote/brace-aware attribute pattern, so `>` inside when= is fine, and matches ids whole; it is used by resolvePromptFile and sectionId().
- **L72 (server.ts:173 model without readFile)** — The editor's buildModel gets repoFileReader(root), so provider schema files resolve and the false G170 is gone..
- **L74 (server.ts:245 PUT without etag)** — The client always sends etag (null when the file was absent).
- **L91 (components.ts:182 Each destructuring)** — The runtime Each body call is wrapped in try/catch; destructuring or spreading the item reports G160 with a hint instead of crashing the build..
- **L92 (HealthWarning parentheses)** — A threshold that is not a plain path or number is parenthesized (`ctx.percent > (data.limit ?? 70)`).
- **L93 (core.ts:100 dashed root key)** — IDENT is now strict (no dashes).
- **L94 (core.ts:125 numbers)** — New numberLiteral() prints exponent forms in plain decimal and reports G160 for NaN/Infinity.
- **L96 (core.ts:294 Run separators)** — Only leading/trailing whitespace-only parts are dropped; interior single-line separators are kept, and interior line breaks keep their newline only..
- **L97 (core.ts:338 intrinsic ExprRef attrs)** — An ExprRef attribute on an intrinsic element reports G160, because the renderer does not interpolate attributes..
- **L98 LSP family** — Fixed these LSP mismatches: (a) Each.of arrays/objects are not flattened (only Table.cells, Call.args/kwargs and Debug.exprs are lists).
- **L99 (analyze.ts:452 quick-variant)** — quickVariantCommand returns expand --only <id> --tiers quick.

### Не виправлено

- **M70 (full)** — CodeMirror cannot be vendored or bundled without npm install (forbidden here, and @codemirror/* is not in node_modules). Transitive deps that esm.sh resolves by range (crelt, @lezer/*, @codemirror/commands/search/lang-html) are still not pinned. Module code in the page realm can still patch fetch and use the token; neither SRI nor a server nonce helps against same-realm code. *Потрібно:* design decision: add @codemirror/* as devDependencies, bundle them with esbuild into packages/editor-web/dist, serve from the local server with script-src 'self', and make cdn:false the default
- **L95 (core.ts:235 build-time data strings parsed for {{ }})** — jsx gets only plain strings and cannot tell authored JSX text from imported data. A correct fix needs a marker from the CLI's preserveJsxText (cli-owned) or an escape syntax in core splitTemplate. *Потрібно:* design + other package (packages/cli/src/jsx-text.ts or core expr.ts escape such as \{{)
- **M81 residual** — Data strings are still dedented in one case: their indentation is ≥ the indentation of authored own-line text in the same container. Telling them apart reliably needs the same authored-text marker as L95. *Потрібно:* other package (cli jsx-text marker)
- **M82 residual** — `{`git log -n ${ctx.args.n}`}` inside a template literal stringifies the reference to a literal '{{ args.n }}' before <Run> sees it, so it cannot be told apart from Go-template braces. The editor now marks Run code as not interpolated, so the misleading 'valid expression' hint is gone, but this form still builds with no G160. *Потрібно:* design: G160 or a warning for any `{{` in Run code, which would conflict with docker/kubectl templates
- **LSP: missed G171 for unbound roots** — checkExpr reports nothing for an unknown root such as `it` outside every loop. Only the false G172 part of the file-global bindings bug is fixed. *Потрібно:* change in exprcheck.ts unknown-root policy (in my package but a behavior decision; left as is)
- **S12 build-on-request** — No code change needed: editor preview runs `context-gate run`, and the CLI builds TSX and runs scripts only for trusted repos (cmd-run ensureBuilt and the trusted gate). The VS Code preview and quick-variant now refuse untrusted workspaces. *Потрібно:* none

## Після рецензії

Рецензенти знайшли 45 проблем у фіксах (1 blocker, 17 major, 27 minor); виправлено: 44.

### Свідомо не закрито

- M29 (packages/cli/src/build.ts): not closed, only documented, because no safe fix exists with a one-line `!` command. Claude Code substitutes $ARGUMENTS raw, so a `'` in the args ends the quote and whatever follows runs as shell code. A real fix needs the args to reach the CLI outside shell text, for example a multi-line quoted heredoc, and engine support for that is unverified. The skillCommand comment, SPEC (the line after the live-line example) and SPEC-COVERAGE item 76 now call it an open prompt-injection residual for model-invoked skills when the line runs without the mod. No test asserts the vulnerable behaviour.
- M1 parity (cross-cutting, deferred): core decideGate, the hooks adapter and the CLI still gate Auto Attached rules by profile. Only the mod's display now matches the mod's delivery. Bringing them in line is a separate behaviour change in packages/core/src/decide.ts and packages/hooks-adapter.
- M13 TTL: user entries were not dropped at the next prompt.submit, because the order of command.run and prompt.submit is unverified. Instead the TTL for user entries went from 10 min to 60s, and non-composer origins are no longer queued at all.
- M44 / M02 / M13: fixed, but without dedicated regression tests (low risk, minor items).
- M12 latency: I chose the reviewer's 'cap the timeout' option (parallel captures, 15s each) rather than dropping pre-edit capture for commit/turn gates. Dropping it would turn every legacy violation into a commit block after edits; the existing M12 tests rely on the commit-gate baseline.

## Застосовано інтегратором

- Test updates requested by packages (all failing before): test/adapter-fixture.ts gets log:{file:true} (M28); test/build.test.ts live-line assertions now match skillCommand() (M29/M30); test/hooks-adapter.test.ts runs the SessionStart preload case with CONTEXT_GATE_MODE=auto (M03); test/shiftwork.test.ts expects CONTEXT_GATE_PRELOAD=system (L90); test/jsx.test.ts drops c.items.join from the Each case, and a new case in the G160 test asserts it is now G160 (M80), so coverage is kept; test/lsp-analyze.test.ts compiled G101 moved to line 4 (L98), and quick-variant expects --tiers quick (L99); test/lsp-vscode.test.ts expects cliArgv(undefined) = ['npx','--no','context-gate'] (S4); test/cli-misc.test.ts report.shadow now has the richer shadowAgreement shape (same counts: proposed 2, matched 1, differed 1, plus labeled 2, unlabeled 0, rate 0.5)
- H06 packages/core/src/render.ts Interp.run: any error other than Stop (ValueLimitError, StepLimitError, RangeError and so on) fails only that section with G155 and never rejects the render. A ValueLimitError shows its own message (e.g. 'Рядок довший за 67108864 символів') instead of the step-limit text
- H05 render.ts: new Interp.walk()/walkFrames() call chargeValue before every value walk: {{ }} output, table cells, @debug values, callFn and @call cache keys (stableJson), @mcp arg keys, and the @run stdin snapshot (non-root frames only; root host data is not charged). The @let and {{ }} trace previews use traceJson(), which prints '…' above 4096 cells
- M59 render.ts: Math.max(...spent) replaced by reduce. L45/linear trim: the fence and <pre> nodes use a linear trimNewlines() instead of /^\n+|\n+$/ (fenceFor already sized fences)
- packages/core/src/codes.ts: G107 explains linear-engine limits (backrefs, lookaround, modifiers, complex {n,m}); G155 explains the value size limits; G305 covers gates/brief/budgets tiers and default models with custom tiers; G001 mentions duplicate .mdc ids (warning); H002 hint mentions prompt.volatile: "context"
- types.ts and config.ts: GateCheckConfig.failClosed and prompt.volatile ('system'|'context') added to both type and schema, so the G302 'ignored' warnings for keys the mod honours are gone; schema/context-gate.schema.json regenerated. RenderHost.call/mcp req gain an advisory timeoutMs, and render passes timeoutMs to host.mcp
- M62 timeouts: packages/cli/src/host-node.ts call() honours req.timeoutMs (min with 10 s); cli context.ts scripts.* honours ProviderCallRequest.timeoutMs; hooks/layers/host.ts call(), cli providers and scripts honour timeoutMs via boundedTimeout()
- M46/P3 hooks/layers/host.ts: CONTEXT_GATE_INPUT is set only for inputs ≤ 64 KiB (utf8Length, no Buffer in the mod); stdin always carries the input
- M05 hooks/layers/host.ts: new exported configuredPromptDir(cfg) (absolute or .. → .claude/prompt), used by makeRenderHost when deps.promptDir is absent
- M11/H02 hooks/layers/cursor-rules.ts: loadProviderRules builds its host with promptDir and providerConfigs (lib module providers visible); .mdc and markdown-dir rules are read through readRepoFile (symlink containment)
- M41 cursor-rules.ts and packages/cli/src/context.ts loadRules: ruleIdFromPath(path, cursorRuleDirs(cfg).dirs); a duplicate id is skipped with a G001 warning, as in core loadRuleSources
- M60 packages/core/src/shims.ts parseLoose (bash @call results): a number only when it is finite and prints back exactly
- L53: cmd-expand.ts planExpand gains a tierNames param (tierVariantOf and parseMarkdownPrompt get the configured tiers); editor-web server.ts and lsp markdown.ts pass the configured tiers to parseMarkdownPrompt
- M04 packages/cli/src/cmd-run.ts: jsonOf masks scope and trace structurally with maskSecretsDeep(secretValues(scope)), and writeTrace masks the whole .trace/last.json (the mod already did this; gate.index.json was already masked by core-decide/cli)
- M51: hooks/layers/skill-gate.ts claude-tools match patterns and core decide.ts profiles[].when.branch now use expr.ts regexTest (linear engine, budgeted, invalid/unsupported → ignored with a reason)
- M23: packages/hooks-adapter/src/handle.ts and packages/adapters/common/session.ts use promptFlagAction() (behaviour unchanged). handle.ts passes nocase on Windows (L39) and records CONTEXT_GATE_TICKET as signals.ticketId (L64; new HookEnv key)
- M2/L59 packages/cli/src/cmd-report.ts: Report.shadow = core shadowAgreement (labeled/unlabeled/rate; the text says when nothing is labeled). Denies use core deniedItem (the mod's data.skill) and skip data.shadow denies
- S5/L33: new core shims.ts UNSAFE_EXECUTOR_ENV + executorEnv(); CLI host-node.ts run() filters executors[].env with it (PATH, NODE_OPTIONS, LD_*, DYLD_* … dropped); the mod's safeExecutorEnv reuses it
- hooks/layers/dsl.ts: prompt Markdown, SKILL.md bodies, scripts, tool modules, script argv and lazy file refs are read through readRepoFile (H02). writeDebugLog re-reads the file before every write, never overwrites an unreadable file and checks writableInsideRoot (M16). The mod loads only the compiled ids listed in prompt.lock.json (M32/S11 parity with CLI loadCompiled)
- M19: hooks/ctx.ts Io.env gains optional planProfile/ticketType/ticket; hooks/register.ts port maps them to literal $.env.get('CONTEXT_GATE_PROFILE'|'CONTEXT_GATE_TICKET_TYPE'|'CONTEXT_GATE_TICKET')
- L17 core pipeline.ts: sinceMs rejects a unitless number; the observe stage returns exit 2 with a usage message for an invalid --since
- New regression tests test/fix-integrator-crossfile.test.ts (6 cases: H06 message/section failure, H05 output charging, M60 bash numbers, L17, executorEnv, linear when.branch regex)
- Docs: SPEC.md (new live line and quoting note; value/regex limits, G155 for any section failure; @let section-wide and @fn limits; render clarifications covering run cache key, durations, the single budget, pending data, store, stdout numbers and CONTEXT_GATE_INPUT; non-enumerable data fields; prompt.volatile context; hysteresis/advance; group negation; prompt flags/G502/G316; shadow behaviour; write gates after the edit, onlyNew baseline, failClosed; Р2 trust hash, bare argv[0], unsafe env, G314, CI pull_request_target); ARCHITECTURE.md live line; SPEC-COVERAGE.md (#76, #93, #98, #144, #145, #171 plus a 'Review 2026-10-06: behaviour changes' section); HOOKS-ADAPTER.md (coexistence with the mod/--with-mod, events SubagentStart/PostModelSwitch, G502, deny hint, env ADD/REMOVE/PRELOAD/TICKET, read-before-write tiers, state lock/merge, install backups/ownership/shadow/G502); SHIFTWORK.md (env, skillOverrides 'on', symlink only outside the worktree); ADAPTERS.md (log.file, G502, preload only applied, .mdc delivery, opencode child sessions, JSONC); MOD-ADAPTER.md (shadow +g/-g, advance:false, cache FIFO bound, trust hash, resume/fork reset); EDITOR.md (S12 cliPath ignored from tsconfig, S4 default CLI, pinned CDN/--no-cdn, CRLF, cross-site, etag null)
- npm run build:all: dist/cli.js, dist/hooks-adapter.js and dist/jsx-types are rebuilt from the current sources

### Інтегратор пропустив

- core-expr L45 render fence via fenceText: already fixed. core-render's fenceFor already sizes the fence; only the quadratic newline trim was changed
- core-expr M56 mddsl @fn expansion limit and core-render M66 test/mddsl.test.ts: already done by core-render (G156 past 10,000 nodes); needs= is checked at render time only, so the mddsl fixture is unchanged
- core-render per-call result shape {results, errors} for RenderHost.call and the matching 'per-call errors' change in host-node/hooks host: optional. Render already retries a failed batch per call, so the hosts keep throwing for a batch with errors
- core-render/core-decide hooks/layers/dsl.ts and gateindex.ts masking: already done by hooks-skill (scopeForDisk + maskSecretsDeep) and core-decide/cli (varsOf ***, maskedScope)
- core-decide skill-gate M21/M22/M23/M2/L39: already done by hooks-skill (advance, modelAttrs, nocase in recompute; applyPromptFlag maps off/auto/new). The mod's literal comparisons are equivalent to promptFlagAction, so they were left as they are
- core-decide 'runtime writers resolve symlinks' (gates/host/host-node): already done by hooks-guard (readRepoFile/writableInsideRoot) and cli (safeJoin)
- hooks-guard skill-gate R8: already done by hooks-skill M24 (compaction recheck keeps counters and writes no brief)
- hooks-guard types/config failClosed: done here. G3xx path validation and argv[0] path checks were already in core (G314, commandAllowed L33)
- hooks-guard persistData bounded store key (M14): skipped. data:<repoKey> holds stored data that must not be evicted, and cachePut's FIFO eviction would drop it. A bounded design needs a decision
- hooks-guard M15 provider onError per section: skipped. The render's onError is one option for the whole render, not per provider; a per-provider skip/fail needs tracking of which sections reference which provider. This is a design change across render.ts, the mod and the CLI
- hooks-guard commands.ts /gate health surfacing of store failures: optional, not done
- hooks-skill L08 readOptions mode unset + effectiveMode: skipped. .claude-plugin/plugin.json userConfig mode has default 'shadow', so an 'unset' mode never reaches the mod. Without a manifest/engine change, an explicit 'shadow' would override every repo's classify.mode auto
- hooks-skill decide.ts/items.ts O1/M10 move into core (ungrouped MCP on, skill ns:name matching): skipped. It contradicts SPEC and the existing decide.test ('MCP outside the profile is off'); it needs a SPEC decision. The mod's refineGate keeps the behaviour
- hooks-skill/M03 CLI context.ts preload only when applied: tried and reverted. test/canonical.test.ts 'CLI run: the preload section from tiers[*].preload' asserts preload without classify config; the CLI run is also the runner's render path. Needs a SPEC decision
- adapters mod CONTEXT_GATE_ADD/REMOVE/PRELOAD in skill-gate.ts + register.ts: skipped as a new feature (mod-side shiftwork parity). SHIFTWORK.md now says only the adapters read these
- cli codes.ts dedicated codes for 'store key rejected'/'rule walk truncated': optional, not done
- cli hooks-adapter install M38: already done by the adapters package
- tooling hooks/layers/editor.ts --no-cdn: not needed. The editor server already honours CONTEXT_GATE_EDITOR_CDN=0 from the environment
- tooling jsx-text L95 branded text, expr.ts exponent literals L94: optional, not done

## Після інтеграції: паритет O1/M10

- **O1, M10 (ядро)** — правило «MCP без групи не фільтрується» і правило для plugin-skill `ns:name` перенесено з моду в core `decideGate`. Тепер hooks-adapter, CLI, pi і opencode вирішують так само, як мод; мод лише показує попередження. Тести: `test/decide.test.ts`, `test/fix-core-decide-decide.test.ts`.
