# PROBE: the mods API against what SPEC.md assumes

Stage 0 (SPEC Р6). I checked every event and `$` call the spec relies on against the declaration file of this build:
`plugin-authoring/types/claude-code.d.ts`, written by **Claude Code 2.1.288**. The installed CLI is **2.1.291**. Re-run
`scripts/sync-mod-types.sh` after `claude --plugin-dir .` has written `.claude-plugin/types/claude-code/index.d.ts`, then
diff it against this file before trusting the details below for a newer build.

Verdicts:

- **OK**: works as the spec assumes.
- **DIFFERS**: it exists, but the shape or semantics differ (the doc says how).
- **MISSING**: no API for it (the doc gives a fallback).
- **LIVE**: the types can't settle it. A live session has to check it (see the last section).

Quoted types are trimmed to their fields. The authoritative text is in the d.ts.

## Summary of contradictions with the spec

| # | Spec says | Reality | Consequence |
| --- | --- | --- | --- |
| 1 | `$.model.classify` gives `profile` + `confidence` | `classify(text, labels, { model? }) => Promise<string \| undefined>`, a label only | `minConfidence` can't come from `classify`. Use `$.model.complete` with a JSON answer (see below) |
| 2 | `$.ui.notice` shows a session notice on `hardContextPct` | `notice(tool_use_id, text)` is one line under an **open tool dialog** | Use `$.ui.toast` (transient), `$.ui.status` (pinned) or `$.session.append({ message: { type: 'system', content: [...] } })` (a transcript notice) |
| 3 | branch from `$.session.repo()` | `SessionRepo = { root, remote, internal, name }`, no branch | Read `<repo.root>/.git/HEAD` through `$.fs.read` (no trust needed); `$.process.run(['git','branch','--show-current'])` as a fallback |
| 4 | `$.plugin.root()` | `$.plugin.root: string`, a property (likewise `$.plugin.name`) | Trivial |
| 5 | `skill_listing`: check the format in `e.detail` | `skill_listing` has **no** `detail` in this build (only `plan_mode*` declare one) | Parse `e.text` (`items.ts parseSkillListing`) |
| 6 | `skill.prompt` carries the args | `SkillPromptInput = { skill, text }`, no args | Args come from `tool.call {tool:'Skill'}` (`e.args?: string`) or `command.run` (`e.args`) for a typed `/name args`. LIVE: whether `` !`…` `` has already run when `text` arrives |
| 7 | MCP fallback is `ENABLE_TOOL_SEARCH=auto` | `tool.describe` can answer `isDeferred: true` per tool | The env var isn't needed. Gated-off MCP tools get a one-line description, `isDeferred: true` and `{ deny }` at the call |
| 8 | `$.session.compact()` from `turn.complete` / `session.measure` | rejects "while a turn runs" | Defer it with `$.clock.after(0, …)` and catch the rejection |
| 9 | `$.env.get(name)` for the DSL env whitelist (`gate.json env[]`) | the name **must be a string literal** in the source (a computed name is refused) | A dynamic whitelist can't use `$.env.get`. Read `(await $.settings.read()).env` (the settings env block only), or spell out a fixed literal set |
| 10 | `classic.FileChanged` just fires for `.cursor/rules/**` | a classic FileChanged fires only for paths a SessionStart answer listed in `watchPaths` | Hook `classic.SessionStart` and add `watchPaths` to its result. LIVE: whether a directory or glob is accepted. Fallback: mtime polling with `$.fs.list` |
| 11 | `NotebookEdit` gets glob rules by `file_path` | the NotebookEdit input is `notebook_path` | The adapter must read `e.notebook_path` |

## Events

### session.start: OK

```ts
SessionStartInput  = { cwd: string; surface: RenderSurface | null; isInteractive: boolean }
SessionStartResult = { cwd: string }
```

It fires once per process for each loaded plugin, before the first prompt, and is awaited, so a `$.tool.register` or `$.command.register` made here is listed by turn one. It fires again on a fresh load (hot reload) and **never after `/clear`**. That matches the spec.

Extra: `classic.SessionStart` (the settings-hook event) fires with `source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork'` plus `model?`, and its result may carry `watchPaths?: string[]`. That makes it the hook for re-initialising after `/clear` and for registering FileChanged watches.

### prompt.context: OK

```ts
PromptContextInput  = { blocks: readonly PromptContextBlock[]; instructionFiles?: readonly InstructionFile[] }
PromptContextResult = { blocks: readonly PromptContextBlock[]; instructionFiles?: readonly InstructionFile[] }
PromptContextBlock  = { name: string; text: string }   // core: claudeMd, userEmail, attachedProject, currentDate
InstructionFile     = { path: string /*abs*/; kind: 'managed'|'user'|'project'|'local'|'memory'; content: string; parent?: string }
```

- It fires once per conversation, and the answer is reused "until `$.ui.invalidate("prompt.context")` or a re-read (compaction, `/clear`)". The spec's choice to reset `seen` here holds.
- **After CLAUDE.md** works two ways. (a) Insert our own block right after `claudeMd` in `blocks`: `{ name: 'cursorRules', text }`, which renders under `# cursorRules`. (b) Append `InstructionFile`s (`kind: 'project'`, `path` the `.mdc` absolute path, `content` the framed body) to `instructionFiles`: "a changed list renders the text the next reader gets", so the engine frames them like CLAUDE.md. Choose (b) when `e.instructionFiles` is defined. Fall back to (a) when it is `undefined`, which happens when a hook above rewrote `claudeMd` and "a hook adds none of its own".
- The input has no `agentId`, so whether subagents get their own `prompt.context` is LIVE.

### prompt.submit: OK

```ts
PromptSubmitInput  = { text; attachments?; context?: readonly string[]; turnId?; wait: boolean; origin: PromptOrigin }
PromptSubmitResult = { text; context?; origin? } | { drop: string }
```

Attach context on the way down only: `next({ ...e, context: [...(e.context ?? []), mine] })`. Context added after `next` resolved is dropped and logged. To strip `[gate:frontend]`, rewrite with `next({ ...e, text })`. An `@file` mention can also be seen as `prompt.attachment {type:'file'}`. The spec's choice to parse `@` in `text` stays valid.

### tool.call (Read / Edit / Write / NotebookEdit): OK (context field name confirmed)

```ts
ToolCallInput = ToolCallEnvelope & { agentId?: string }   // envelope: { tool, tool_use_id, ...toolArgs }
Read:  { file_path; offset?; limit?; pages? }
Edit:  { file_path; old_string; new_string; replace_all? }
Write: { file_path; content }
NotebookEdit: { notebook_path; cell_id?; new_source; cell_type?; edit_mode? }   // ← not file_path
ToolCallResult = { deny: string }
              | { result; context?: readonly string[]; ref?; text?; isReadOnly? }
              | { isError: true; result; text?; ref?; context?; isReadOnly? }
```

- **Context after the result: field `context: readonly string[]`** on the answered result. "What the model reads after the tool's result and the user never sees … One reminder, as a PostToolUse hook's is". The pattern: `const r = await next(e); if (r.deny !== undefined) return r; return { ...r, context: [...(r.context ?? []), framed] }`. Returning the object from `next` keeps `ref`, so core uses its own messages verbatim. Past 100,000 chars (200,000 together) the model gets head + path.
- **`e.agentId`: OK.** It is absent on the main loop and holds a subagent or teammate id otherwise. Engine forks (compaction, memory) carry ids that no list names.
- **Partial read:** `e.offset` / `e.limit` / `e.pages` on input. On the result (when `e.tool === 'Read'` and `!r.isError`), `r.result.type === 'text'` with `r.result.file.truncatedByTokenCap?: boolean`, plus `startLine`, `numLines`, `totalLines`. `r.result.type === 'file_unchanged'` (the engine's re-read dedup) means the body wasn't re-sent, so it doesn't count as a fresh delivery.
- Matcher: `{ tool: ['Read', 'Edit', 'Write', 'NotebookEdit'] }`. An array matches if any element does.
- `strictWrite` deny: answer `{ deny: text }` without calling `next`.

### tool.call (`mcp__*`): OK

Matcher `{ tool: /^mcp__/ }` (a RegExp is tested against the string). Answer `{ deny }` without `next`, and "the model receives the text as an error result". Our own registered tools are `mcp__context-gate__<name>` too, so exclude them from the gate.

### prompt.attachment {type: 'skill_listing'}: DIFFERS (no detail)

```ts
UndeclaredAttachmentInput = { type: string; text: string; origin: PromptAttachmentOrigin; agentId?: string; detail?: undefined }
PromptAttachmentResult    = { text: string | null }
```

- `skill_listing` isn't in `PromptAttachmentDetailOf`, so `e.detail` is always absent. Parse `e.text`, which is "an attachment rendered as several text blocks hands them joined by newlines". The `<system-reminder>` wrapper goes around the answer, never inside it.
- `{ text: null }` drops the attachment. "The answer holds per attachment for the process": after a gate change, call `$.ui.invalidate('prompt.attachment')`, and the cached answers drop at the next turn. That costs prompt cache, which is one more reason for hysteresis.
- `e.agentId` identifies a subagent's listing.
- The exact text format is LIVE. Capture one with a probe hook (see the end) and save it as a fixture for `parseSkillListing`.

### tool.describe: OK, including MCP

```ts
ToolDescribeInput  = { tool: string; description: string; isDeferred?: true; provider: Origin }  // MCP: provider.plugin === 'mcp:<server>'
ToolDescribeResult = { description: string; isDeferred?: boolean }
```

It fires once per tool, "when the engine first renders the tool's schema", and is cached for the session until `$.ui.invalidate('tool.describe')`. An MCP tool is deferred by default (it sits behind ToolSearch). Answering `isDeferred: true` keeps it there, and `false` pins it into the prompt. **A tool can't be removed from the tool list.** The strongest move available is one short description, `isDeferred: true` and a `{ deny }` at the call. Whether the event re-fires for a deferred tool when ToolSearch loads it is LIVE.

### agent.offer: OK

```ts
AgentOfferInput  = { agent: string; description: string; source: string; provider: Origin }
AgentOfferResult = { isOffered: boolean }
```

This hides the agent from both the listing and dispatch. It's model-facing only: a plugin's own `$.agent.spawn` still runs it.

### skill.prompt: DIFFERS (no args)

```ts
SkillPromptInput  = { skill: string; text: string }   // text: "as the skill computed it (its text blocks, joined)"
SkillPromptResult = { text: string }
```

It fires for `/name`, the Skill tool and a subagent preload. There's no args field. Take args from:

- `tool.call { tool: 'Skill' }`: input `{ skill: string; args?: string }`. Remember them per `skill` in a module map, then read them in the `skill.prompt` that follows.
- `command.run { command: '<skill name>' }`: `e.args` when the person types `/name args`. LIVE: whether skills raise `command.run`.
- Otherwise, the `$ARGUMENTS` substitution already present in `e.text`.

Whether `` !`…` `` has already executed by the time `text` arrives is LIVE. If it has, the CLI render runs anyway, and the mod should either ship a SKILL.md body without `!` (marker + `$ARGUMENTS`) when the mod is active, or accept the double render.

### prompt.compose: OK (new ids and reordering allowed)

```ts
PromptComposeInput   = { model; promptModel; surfaces; tools: readonly string[]; outputStyle; traits: readonly PromptComposeTrait[] }
PromptComposeResult  = { sections: readonly PromptComposeSection[] }
PromptComposeSection = { id: string; text: string; scope: 'shared' | 'session' }
PromptComposeTrait   = 'bare'|'lean'|'sdk-preset'|'teammate'|'analysis'|'print'|'skills'|'send-user-message'
```

- **New ids:** yes. "A plugin's own is `<plugin>:<name>`", which means `context-gate:<sectionId>`. Append, replace, reorder or drop are all allowed. A section added at the end of `next(e)` is `session`. **Constraint:** every `shared` section must come before every `session` one, and a list that breaks this "skips the hook". `shared` text may be cached across organisations, so **all our sections are `scope: 'session'`**, whatever the DSL `scope` says. The DSL `static/profile/volatile` only orders them inside the session side.
- **`claude -p`:** yes. The `print` trait marks it. `analysis` is a `/context` measurement render that sends nothing, so skip expensive work there. With `sdk-preset`, the per-person sections ride the first user message instead.
- `e.model` is the model the request is for. Use it for the tier as well.

### turn.step: OK (as an observer, it's a generator)

```ts
TurnStepInput  = { turnId; index; model: string; effort?; messageCount; agentId?: string }
TurnStepResult = { turnId; index; answer; toolUses; stopReason; usage: TurnUsage | null }   // TurnUsage = ModelUsage & { model }
```

It's a **streaming** event, and the only form that loads is `async function* ($, e, next) { return yield* next(e) }`. Read `e.model` and `e.agentId` before forwarding. `usage.cache_read_input_tokens` measures prompt-cache hits (health H002). Avoid `$.clock.sleep` here, because it eats the hook budget.

### session.measure / turn.complete: OK

```ts
SessionMeasureInput  = { context: SessionContextUsage; rateLimits; cost?; changed: UsageUnit[] }
SessionContextUsage  = { tokens?: number; window: number; percent?: number /*0..100*/; breakdown? }
TurnCompleteInput    = { answer; durationMs; isAborted; turnId; agentId?; usage?: TurnUsage; reason: 'answer'|'aborted'|'refusal'|'error'; refusal? }
TurnCompleteResult   = { text: string; usage? }
```

`session.measure` fires after each main-thread turn and when a rate-limit moves, so it's the right place to check budgets. `$.session.usage()` returns `{ startedAt, context, rateLimits, cost? }`, and `context.percent` is optional before the first response. `turn.complete` also fires for subagent runs (`agentId`).

### command.run: OK

```ts
CommandSpec      = { name; description; argumentHint?; immediate?: true }      // $.command.register
CommandRunInput  = { command: string; args: string; origin: PromptOrigin; presentation: { isFullscreen: boolean; columns: number } }
CommandRunResult = { text?: string; context?: readonly string[]; exitCode?: number; ref? }
```

**Args:** `e.args` is the raw string after the name (`""` when empty). Parse it with `gatecmd.ts parseGateCommand`. `context` is notes the model reads after the output (use it for `/rule <id>`). `exitCode` matters only when the command was the whole `-p` prompt. A `CommandOutput` render hook with `{ props: { command: 'gate' } }` can draw the `/gate why` table inline.

### ui.render {AbovePrompt, Pane}: OK

```ts
AbovePrompt props = { hasSurvey; isWorking; maxRows; bodyColumns; scroll: { offset; bodyRows }; view: { agentId? } }  // terminal + desktop only
Pane props        = { title; isFocused; bodyColumns; placement: 'dock' | 'inline'; scroll; view }              // every surface
```

Elements come from `$.ui.resolve(e)`. Calling `Text({ dimColor: true, children })` works in a `.ts` file, and JSX `h` needs `.tsx`. `$.state.get` / `read()` while drawing subscribes the instance. **A render hook must not `$.state.set`.** Match the pane with `{ component: 'Pane', requestId: 'gate-why' }`. Open it with `$.ui.open({ id, title })`, which returns `{ isPlaced, reason? }`. Unasked panes are placed only from 144 columns.

### classic.FileChanged: DIFFERS (needs watchPaths)

```ts
FileChangedHookInput = BaseHookInput & { hook_event_name: 'FileChanged'; file_path: string; event: 'change' | 'add' | 'unlink' }
ClassicResult.watchPaths?: string[]   // read from SessionStart only
```

The watch list is what the SessionStart answers carry. Hook `classic.SessionStart` with `async ($, e, next) => { const r = await next(e); return { ...r, watchPaths: [...(r.watchPaths ?? []), ...ours] } }`. Directory or glob support is LIVE, so list concrete absolute paths. Fallback: `$.fs.list('.cursor/rules')` `mtimeMs` compared on `prompt.context` and `prompt.compose`, which costs microseconds.

### session.end {reason: 'clear'}: OK

```ts
SessionEndInput = { reason: 'clear' | 'prompt_input_exit' | 'resume' | 'logout' | 'other' | …; sessionId; resume }
```

"`clear` is how a hook sees a `/clear` … the process goes on under a new session id, and no `session.start` fires for it." The whole chain shares one short bound (1.5 s by default, `next.budget`), so do only state resets here.

### session.compact: OK

```ts
SessionCompactInput  = { trigger: 'manual'|'auto'|'plugin'|'precompute'; agentId?; instructions?: string; messages }
SessionCompactResult = { messages; tokensBefore?; tokensAfter?; usage? } | { skip: string }
```

Append "keep the active profile and rules" with `next({ ...e, instructions })`. Skip `precompute`. Our own `$.session.compact({ instructions })` raises it with `trigger: 'plugin'`.

## `$` calls

| Call | Exact signature (d.ts) | Verdict |
| --- | --- | --- |
| `$.state.get/set` | `get(ref: { plugin, key, id? }) => Promise<{ value: T \| undefined; version }>`; `set(ref, value, { ifVersion? }) => Promise<{ isSet, version }>`. Helpers `atom`, `read`, `update`, `derive`, `memberOf` from `'claude-code'`. `plugin` and `key` **must be literals**. Values are JSON, and `undefined` is refused | OK. **After `/clear`: LIVE.** The doc says "held by the host for the session", while `/clear` keeps the process under a new session id. Don't depend on it: reset explicitly in `session.end {reason:'clear'}` and `classic.SessionStart {source:'clear'}` |
| `$.store` | `get(key) => Promise<unknown>`, `set(key, value)`, `delete`, `keys()`. JSON, 4 MiB total, survives sessions | OK (trust per repo, `seen` is not stored) |
| `$.fs.read` | `read(path, { as?: 'text'\|'bytes' }) => Promise<string \| { base64 }>`. Rejects when the file is missing or over 4 MiB. A relative path resolves from the **cwd**, not the root | OK. Wrap with `.catch(() => undefined)` for `RenderHost.readFile`. Join with `$.session.root()` explicitly |
| `$.fs.list` | `list(path?) => Promise<{ name; kind: 'file'\|'dir'\|'other'; size; mtimeMs; isLink }[]>` | OK, non-recursive (walk it yourself for `nested`) |
| `$.fs.exists` | `exists(path) => Promise<boolean>` | OK |
| `$.fs.stat` | `stat(path, { resolve? }) => Promise<{ kind; size; **mtimeMs**; isLink; realPath? }>`. Rejects `ENOENT` | OK. mtime is `mtimeMs` |
| `$.fs.write` | `write(path, text)`, creates directories | OK (`.claude/gate.log.jsonl`. Note: no append, so batch writes) |
| `$.session.root/cwd/model` | `() => Promise<string>` each | OK |
| `$.session.usage` | `(args?) => Promise<{ startedAt; context: { tokens?, window, percent?, breakdown? }; rateLimits; cost? }>` | OK |
| `$.session.repo` | `() => Promise<{ root; remote: string \| null; internal; name: string \| null } \| null>` | DIFFERS: no branch (see contradiction 3) |
| `$.session.compact` | `(input?: { instructions? }) => Promise<SessionCompactResult>`. Rejects while a turn runs | DIFFERS (contradiction 8) |
| `$.tool.register` | `register({ name; description; inputSchema? }) => Promise<{ tool }>`, listed as `mcp__context-gate__<name>`. Rejects before `session.start` binds. Serve it with `tool.call {tool:'mcp__context-gate__<name>'}` returning `{ result }` | OK |
| `$.tool.list` | `() => Promise<{ name; description; mcp: boolean }[]>` | OK (MCP server name = 2nd segment of `mcp__<server>__<tool>`) |
| `$.command.register` | `register({ name; description; argumentHint?; immediate? }) => Promise<{ command }>` | OK |
| `$.model.classify` | `classify(text, labels: readonly string[], { model? }) => Promise<string \| undefined>`. Rejects on a failed request | DIFFERS: **no confidence**. Use `$.model.complete({ model: cfg.classify.model ?? 'haiku', system, prompt, maxTokens: 64, timeoutMs: 8000 })`, ask for `{"profile":"…","confidence":0.0-1.0}` and parse `r.text` when `r.isAnswered`. `classify` is only a cheap fallback that maps to confidence = `minConfidence`, so it never auto-applies alone |
| `$.model.complete` | `complete({ model; prompt; system?; maxTokens?; effort?; timeoutMs? }, { signal? }) => Promise<{ isAnswered: true; text; usage } \| { isAnswered: false; reason: 'api-error'\|'empty-reply'\|'aborted'; usage; … }>` | OK (brief, classifier). It uses the session's own client and credentials, so no API key is needed. Cost and latency are LIVE |
| `$.process.run` | `run(argv, { cwd?, env?, stdin?, timeoutMs? }) => Promise<{ exitCode; stdout; stderr; isStdoutTruncated; isStderrTruncated }>`. Timeout defaults to 30 s (10 min max). **On timeout it rejects**, and also when the command can't start. Waits don't count against the 10 s hook budget | OK. Map a rejection to `exitCode: -1` with stderr = the message (G2xx) |
| `$.process.spawn` | `spawn({ argv, cwd?, env?, input? }) => HookStream<{ stream: 'stdout'\|'stderr'; text }, { code; signal }>` | OK (background build with a streamed log) |
| `$.mcp.call` | `call(server, tool, args?) => Promise<{ content: McpContentBlock[]; isError: boolean; structuredContent? }>`, positional, no permission prompt | **Exists.** It bypasses permission prompts, so it's gated by trust (Р2) |
| `$.ui.notice` | `notice(tool_use_id, text \| undefined) => void` | DIFFERS (contradiction 2) |
| `$.ui.toast` | `toast(text, { timeoutMs? }) => void` | OK |
| `$.ui.status` | `status(text \| undefined) => void`, one pinned line per plugin under the prompt | OK (a `-p`/desktop fallback for the band) |
| `$.ui.open` | `open({ id; title?; focus?; closeOnEscape?; holdToasts?; rows?; columns? }) => Promise<{ isPlaced: true } \| { isPlaced: false; reason }>`. Also `close({ id })` and `panes()` | OK |
| `$.ui.ask` | `ask(question, options?: string[] \| { options?, header?, multiSelect? }) => Promise<string>`. Takes 2–4 labels. Resolves to the chosen label, or free text typed under "Other". **Rejects when dismissed and in `-p`**. Implemented as an AskUserQuestion `tool.call` | OK. Compare against labels exactly. Treat a rejection as "not now" (don't store `denied`). In `-p`, trust comes from userConfig `trustBuild` / `--trust-repo` |
| `$.ui.log` | `log(text, { to?: 'transcript' \| 'debug' }) => void` | OK |
| `$.ui.invalidate` | `invalidate(event: 'ui.render' \| 'prompt.section' \| 'prompt.context' \| 'prompt.attachment' \| 'tool.describe' \| 'command.describe' \| 'config.describe')` | OK. Needed after a gate change |
| `$.env.get` | `get(name: string) => Promise<string \| undefined>`, **name must be a literal** | DIFFERS for a dynamic whitelist (contradiction 9). `$.env.get('OS')` as a literal is fine |
| `$.plugin.root` | `plugin: { name: string; root: string }` | DIFFERS: a property, not a function |
| `$.agent` | `spawn({ prompt, description?, subagentType?, model?, name?, cwd? })`, `list() => AgentInfo[]` (`{ id; description; type; … }`), `register(spec)` | OK (`list` maps `agentId` to its type for per-agent tiers) |
| `$.settings.read` | `read({ source? }?) => Promise<Settings>` | Extra: reads `~/.claude` settings, for the binary whitelist in Р2 |

Hook budget: `HookBudget.ms = 10_000` of the hook's own code. In-flight `next` and `$` calls don't count. `$.clock.sleep` does count. `next.signal` aborts when the dispatch is abandoned.

## Still LIVE: what a probe session must confirm

Run `claude --plugin-dir /path/to/context-gate --debug` with a probe build of `hooks/register.ts`, adding one hook per point that logs with `$.ui.log(..., { to: 'debug' })` and writes `.claude/probe.json` through `$.fs.write`:

1. `prompt.attachment {type:'skill_listing'}`: capture `e.text` verbatim, which becomes the fixture for `parseSkillListing`, and check that the `{ text }` rewrite changes what the model reads (ask the model to list its skills).
2. `tool.describe` for `mcp__*`: does it fire for deferred tools, and does `isDeferred: true` plus a short description hold?
3. `skill.prompt`: has `` !`…` `` already run when `e.text` arrives? Does `tool.call {tool:'Skill'}` precede it with `args`? Does `/name args` raise `command.run`?
4. `$.state` after `/clear`: does a value written before `/clear` survive? Does `classic.SessionStart {source:'clear'}` fire for a mod?
5. `classic.FileChanged`: does a `watchPaths` directory entry work, or only files?
6. `prompt.context` in subagents, and `e.instructionFiles` when another plugin rewrote `claudeMd`.
7. `$.model.complete({ model: 'haiku' })`: latency and cost per classification, from `usage`.
8. `prompt.compose` under `-p` (`traits` includes `print`) and under the `sdk-preset`.

## LIVE results (2026-10-06, Claude Code 2.1.291, `claude -p`)

Non-interactive runs only: `scripts/e2e.sh` on temp copies of `examples/reference` and `examples/basic` (model
`haiku`, context-gate plus the probe plugin, one turn each) and `probe/run-print.sh` on a temp copy of
`examples/basic` (default model, probe only). `scripts/e2e.sh` plants a random code word in each delivery path and
passes only when the model quotes it without having read `.cursor/` or `.claude/` (checked on the stream-json tool
uses).

### context-gate delivery: works

| Path | Hook | Result |
| --- | --- | --- |
| Always rules (`alwaysApply: true`) | `prompt.context` (`instructionFiles`) | works, both repos (2 rules in reference, 1 in basic); journal `rule-delivered via prompt.context` |
| Auto Attached rule after `Read` of a matching file | `tool.call` `context` | works (`api-conventions` for `apps/api/src/*.ts`; `typescript` with a slash-less `*.ts` glob); journal `via tool.call` with the path |
| Manual rule by `@<id>` in the prompt | `prompt.submit` `context` | works (`@security-review`, `@release`); journal `via @mention` |
| Markdown DSL section (`.claude/prompt/*.md`) | `prompt.compose` | works without trust (Markdown needs no build) |
| Compiled DSL section (`.compiled/*.json`) | `prompt.compose` | works without trust (the committed compiled JSON is read; no build runs under `-p` without trust) |
| `[gate:frontend]` prefix | `prompt.submit` rewrite | stripped: the model reports its message does not start with `[`; the journal records `trigger: manual`, `profile: frontend`, and the following `snapshot` carries `profile: frontend` |

Under `-p` the trust question rejects (`$.ui.ask`), so trust stays `unknown`: no TSX build, `cli` providers render
`unverified` (health `H007`), and a `.prompt.tsx` without a compiled JSON shows `H013`. That matches Р2.

### Open points from the list above

1. `skill_listing`: **format confirmed** (`- <name>: <description>` lines under one header, ~9–20k chars with user
   and plugin skills). Whether the rewrite reaches the model was not asked in these runs.
2. `tool.describe` for `mcp__*`: **works**. It fires for deferred MCP tools (input `isDeferred: true`) and for our own
   registered tools (`mcp__context-gate__get_api`, a lazy include), and `isDeferred: true` holds in the result.
3. `skill.prompt` and `` !`…` ``: not exercised (needs `/name args` or a Skill call; interactive step 3).
4. `$.state` after `/clear`: not testable under `-p`. Seen instead: **`classic.SessionStart {source: 'startup'}` fires
   before `session.start`** (probe seq 1 and 3), so `classicSessionStart` must not rely on `session.start` having run.
   It calls `ensureSession` first, which covers it.
5. `classic.FileChanged` with a directory in `watchPaths`: **works, recursively**. The mod lists `<root>/.claude/prompt`
   as a directory; a FileChanged arrived for `<root>/.claude/prompt/.trace/last.json` (two levels down, written by the
   mod's own `prompt.compose`), which no file entry named. The mod's own writes under a watched directory therefore
   come back as FileChanged: `dsl.ts classifyChange` ignores `.trace/`, `.compiled/` only marks the cache dirty, and
   `gate.index.json` / `gate.log.jsonl` are not under a watched directory.
6. `prompt.context`: under `-p` the input has `blocks` `claudeMd, userEmail, currentDate` and **`instructionFiles`
   defined** (an empty array without project CLAUDE.md files), so the instruction-file path is taken. It fired once per
   run; subagents were not exercised.
7. `$.model.complete` cost: not exercised (`/probe classify` is interactive).
8. `prompt.compose` under `-p`: **fires**, with `traits` `print, skills` (haiku) and `lean, print, skills` (the
   default Opus model). No `sdk-preset`. The mod skips only `bare` (and serves the last sections for `analysis`), so
   `lean` renders normally.
