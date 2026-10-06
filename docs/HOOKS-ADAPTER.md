# claude-code-hooks: the fallback adapter without mods

`packages/hooks-adapter/` is the `claude-code-hooks` harness adapter from SPEC "Єдина модель". It runs where the mod
does not load (Claude Code < 2.1.287, `--bare`, `allowManagedModsOnly`) and in runners that prefer plain settings
hooks (`claude -p`, CI). It is one Node script, `dist/hooks-adapter.js`, called as a settings **command hook**. It
uses the same core as the mod (`decideGate`, `parseMdc`, `packInjections`, `denyText`), so both make the same
decisions from the same `.claude/gate.json`.

```bash
npm run build:hooks-adapter                                  # → dist/hooks-adapter.js
node dist/hooks-adapter.js install --profile frontend --tier standard
node dist/hooks-adapter.js install --print                   # show the merged settings, write nothing
node dist/hooks-adapter.js install --uninstall
```

Don't run it next to the mod in the same session: both would deliver the same rules.

## Files

| file | role |
| --- | --- |
| `src/handle.ts` | pure: hook event + repo data + session state → hook JSON, new state, journal entries |
| `src/node.ts` | loads `gate.json`, the rules of every source (core `loadRuleSources`, see «Rule sources»), `.claude/skills/*/SKILL.md` (project, then `~/.claude/skills`), the branch from `.git/HEAD`; state and journal I/O |
| `src/install.ts` | pure: hooks block, `skillOverrides` from a gate, idempotent merge into settings |
| `src/shiftwork.ts` | pure: shiftwork contract (see `docs/SHIFTWORK.md`) |
| `src/main.ts` | entry: hook mode (stdin), `install`, `plan` |

## Rule sources

`loadRules` (`src/node.ts`) uses core `loadRuleSources` (`packages/core/src/mdc.ts`), so the adapter sees the same
rules as the mod: `.cursor/rules` and every `cursor-mdc` `dir`, nested `*/.cursor/rules` (`cursorRules.nested` or a
source's `nested: true`), `markdown-dir` sources, and `provider` sources over `file` providers (core
`staticProviderValue`). A `provider` source over a `cli`, `module` or `mcp` provider is skipped with `G208`: a
settings hook has no trust store, so it never starts repo processes. When `.claude/rules/cursor/` exists (the
`sync` output, delivered natively by Claude Code), nothing is loaded (edge case 7).

## Events

The stdin and stdout shapes follow `ClassicHookInputs` / `ClassicResultFields` in the Claude Code 2.1.288 d.ts.

| Event (matcher) | Reads | Answers |
| --- | --- | --- |
| `SessionStart` | `source`, `model` | `additionalContext`: Always rules (framed `Contents of <path> (Cursor rule <id>):`), the preloaded skill bodies of the tier (`tiers[*].preload`), and a status line when the gate applies |
| `UserPromptSubmit` | `prompt` | `additionalContext`: Manual rules from `@id` and `/rule <id…>`, Auto Attached rules of `@file` mentions (issue #98796); handles `[gate:<profile>]`, `[gate:off]`, `[gate:auto]`, `[gate:new]` |
| `PostToolUse` (`Read\|Edit\|Write\|NotebookEdit`) | `tool_input.file_path` / `notebook_path` | `additionalContext`: Auto Attached rules for the path, once per session and agent |
| `PreToolUse` (`mcp__.*\|Edit\|Write\|NotebookEdit`) | `tool_name`, `tool_input` | `permissionDecision: "deny"` with `permissionDecisionReason` for MCP tools outside the profile, for read-before-write, and for `strictWrite` |

Output examples:

```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Contents of .cursor/rules/react.mdc (Cursor rule react):\n…"}}
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"postgres вимкнено профілем frontend. Користувач може увімкнути: [gate:backend] у промпті або /gate +backend з mod. Або напиши [gate:off] у промпті."}}
```

Claude Code may reject an unknown slash command before `UserPromptSubmit` fires. When `/rule <id>` is refused, write
`@<id>` instead, or put `/rule <id>` on a later line of the prompt.

A hook never breaks the session. Bad stdin, a broken `gate.json` or any exception means exit 0 with no output. Set
`CONTEXT_GATE_DEBUG=1` to see the reason on stderr.

### The 10,000-character limit

Claude Code saves a hook's `additionalContext` above 10,000 characters to a file and shows the model only a preview.
Every answer is packed with `packInjections` under that limit (and under `cursorRules.maxCharsPerInjection`). Rules
that don't fit become one line each: `також діє: <path>, прочитай за потреби`.

## When the gate applies

Rule delivery always works. MCP `deny` and gating rules by profile apply only when one of these holds:

- `CONTEXT_GATE_PROFILE=<profile>` is set (like `/gate <profile>`; shiftwork sets it from the ticket),
- the prompt carries `[gate:<profile>]` (kept for the rest of the session),
- `classify.mode` is `auto` in `gate.json`, or `CONTEXT_GATE_MODE=auto`.

Otherwise the adapter is in shadow mode. It writes the `deny` it would have made to the journal with
`data.shadow: true` and lets the call through. `CONTEXT_GATE_OFF=1` or `[gate:off]` turns filtering off.

The profile comes from `decideGate` with the same priority as the mod: manual → `profiles[*].when` (paths from
`@file` mentions and recent file tools, the branch, `CONTEXT_GATE_TICKET_TYPE`) → tier of the model → `standard`.
Hysteresis runs on `UserPromptSubmit` only. `PreToolUse` and `PostToolUse` read the committed profile without
advancing a turn. There is no classifier in this adapter: a settings hook has no `$.model`.

The model comes from the `SessionStart` input, else `CONTEXT_GATE_MODEL`, else `ANTHROPIC_MODEL`.

### read-before-write

This builtin gate is active when `gates[]` has `{ "name": "read-before-write", "on": "write", "builtin": true }` and
the model's tier is in its `tiers` (no `tiers` means every tier). An `Edit`, `NotebookEdit` or `Write` of an existing
file that this session hasn't read is denied. Writing a new file is allowed. A denial is logged as `gate-failed`.
Every evaluation of the gate is also a `gate-attempt` entry (`outcome: "pass" | "block"`, core
`journal.ts gateAttemptEntry`), which `context-gate health` and `report` turn into `H011`.

### Command gates

Command gates (`gates[]` with `run`) are not run by this adapter: a settings hook has no trust-on-first-use (Р2) and
must not start commands from repo config. The mod and any future runner decide with core
`commandGateDecision({ trusted, whitelist, scriptsAllowed }, argv)`: an untrusted repo, disabled scripts, or a binary
outside the whitelist (`commandAllowed(argv, whitelist)`, user `allowBinaries` narrowed by the repo) skips the gate
instead of blocking.

### strictWrite

With `cursorRules.strictWrite: true`, a `Write` of a new file whose Auto Attached rule hasn't been delivered is
denied once. The rule text goes in the reason, and the model is asked to write again (SPEC layer 1, edge case 2).

## Session state

The state lives in `~/.cache/context-gate/hooks/<session_id>.json`, or `$CONTEXT_GATE_CACHE_DIR/hooks/` when that is
set. It holds:

- `seen`: dedup keys `<agent_id|main>:<ruleId>`. They reset on `SessionStart` with `source` `clear` or `compact`,
  because the context is re-read then.
- `read`: paths for read-before-write. They reset on `clear`.
- `paths`: recent paths, used as `when.paths` signals.
- `gate`: the `GateState` of `decideGate` (profile, hysteresis).
- the prompt-level manual override, the model, and the last logged decision.

Reading a `.mdc` file in full counts as delivering that rule. A partial read (`offset`, `limit`, `pages`) does not.

## Journal

When `gate.json` has `"log": { "file": true }`, entries are appended to `.claude/gate.log.jsonl`: `decision` (on
`SessionStart` and when the profile, tier or off flag changes), `rule-delivered` (`data.rules`), `deny`
(`data.tool`, `data.shadow`), `gate-failed` and `gate-attempt` (read-before-write). They carry metadata only, never prompt or rule
text. `data.adapter` is `"claude-code-hooks"`.

## install

`install` merges into `.claude/settings.local.json` and first backs the file up to
`settings.local.json.bak-<timestamp>`.

- **`hooks`**: the four entries above. The command is `node <abs path>/dist/hooks-adapter.js` with timeout 10 s. A
  re-install replaces earlier entries whose command contains `hooks-adapter.js`. Other hooks stay.
- **`skillOverrides`**: `decideGate` runs for `--profile` and `--tier` (or `--model`) over the repo's and user's
  skills. A `nameOnly` skill becomes `"name-only"`. An `off` skill becomes `"user-invocable-only"`, so `/name` still
  works, or `"off"` with `--hard`. Skills that are on get no key. Keys for skills we don't know are kept. This is the
  static half of the gate: the listing can't change during a session in this mode, so the profile set at install
  time sticks until the next `install`.

`--no-skill-overrides` writes the hooks only. `--print` writes nothing.

The `skillOverrides` values (`on`, `name-only`, `user-invocable-only`, `off`) were checked against the settings
schema in Claude Code 2.1.291.

## Limits compared with the mod

| Mod | Hooks adapter |
| --- | --- |
| skill listing rewritten per turn (`prompt.attachment`) | `skillOverrides` fixed at install time |
| `tool.describe` shortens MCP descriptions, `isDeferred` | only the `deny` at call time |
| `agent.offer` hides subagents | not possible |
| `/gate`, `/rule` commands, pane, status line | `[gate:x]` and `/rule x` in the prompt text, env vars |
| classifier (`$.model`) | none: `when` signals, env, manual |
| DSL sections via `prompt.compose` | not delivered. Use `context-gate sync` (`.claude/prompt.generated.md`) |
