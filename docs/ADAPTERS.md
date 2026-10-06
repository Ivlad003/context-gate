# Harness adapters: `pi` and `opencode`

**Status: experimental.** SPEC "Єдина модель", harness adapters table: `pi`, `opencode` — `before_agent_start` →
`systemPromptOptions.skills`; `permissions.skill` and `prompt({ skills })` in V2. SPEC-COVERAGE G-52.

Both adapters read the same `.claude/gate.json` and `.cursor/rules/*.mdc` as the mod, the hooks adapter and shiftwork.
They decide with the same core `decideGate` and journal to the same `.claude/gate.log.jsonl`. Each entry carries
`data.adapter: "pi"` or `"opencode"`.

## Layout

| file | role |
| --- | --- |
| `packages/adapters/common/session.ts` | Pure and harness-neutral. Holds the session state, the turn decision, shadow vs applied, the system-prompt parts (status, Always rules, tier preload), skill filtering, the MCP and skill deny texts, Auto Attached rules for a path, and `[gate:x]` and `@file` parsing. Imports only `packages/core/src`. |
| `packages/adapters/common/load.ts` | Node I/O: `gate.json`, root `.cursor/rules`, skill dirs, the git branch, and the journal append. |
| `packages/adapters/pi/{types,plan,index}.ts` | `types.ts` holds local pi API types. `plan.ts` is pure event mapping. `index.ts` is the extension entry (`export default (pi) => …`). |
| `packages/adapters/opencode/{types,plan,index}.ts` | `types.ts` holds local OpenCode V2 plugin types. `plan.ts` is pure hook mapping. `index.ts` exports the `{ id, setup }` plugin definition. |
| `test/adapter-pi.test.ts`, `test/adapter-opencode.test.ts` | Tests against fake harness objects, on a temp repo (`test/adapter-fixture.ts`). |

## What each adapter delivers

| gate feature | pi | opencode (V2) |
| --- | --- | --- |
| turn decision | `before_agent_start`, using `ctx.model` (`provider/id`, the provider is stripped) | `session` hook `prompt`; re-decided in `context` when `model.id` changes |
| `[gate:x]` / `[gate:off]` / `[gate:auto]` / `[gate:new]` | `input` → `{ action: "transform" }` strips it | `prompt` hook edits `prompt.text` |
| Always rules + status line | `systemPromptOptions.sections["context-gate"]` | `context` hook: `system.push(text)` |
| tier preload | inlined in the same section (`<!-- Preloaded skill: <path> -->`) | `prompt.skills.push({ id })` once per context. A preload the first prompt missed (model not known yet) is inlined in `system` until the next prompt attaches it |
| skills selection | `systemPromptOptions.skills` filtered: `off` removed, `nameOnly` kept (pi has no name-only mode) | `permission` hook `evaluate`: `action: "skill"` with a gated-off resource → `effect: "deny"` with the deny text. `skillPermissionRules(gate)` gives the same as `{ action: "skill", resource, effect: "deny" }` rules for `session.create({ permissions })` |
| MCP / tool deny | `tool_call` → `{ block: true, reason }` for `mcp__<server>__<tool>` outside the profile | `context` hook deletes those tools from `tools`; `evaluate` denies their action |
| Auto Attached (glob) rules | `tool_result` of `read` / `edit` / `write` → rule text appended to `content`, once per context | `tool` hook `execute.after` of `read` / `edit` / `write` → appended to `result.content` (string or parts) |
| `@file` mentions | `when.paths` signal; their Auto rules go in a hidden custom message (`display: false`) | `when.paths` signal; their Auto rules are appended to the prompt text |
| dedup reset | `session_compact`; `session_start` with `new` (full reset), `resume` or `fork` | `session` hook `compaction` (preload is re-attached too) |
| shadow (`classify.mode: "shadow"`, no profile) | decision journaled with `shadow: true`; nothing filtered or blocked; rules delivered | same |
| journal | `decision` (on change), `rule-delivered`, `deny` | same |

Deny texts point to `[gate:<group>]` at the start of the prompt instead of `/gate +<group>`, since there is no mod
command here. Env works as in the hooks adapter: `CONTEXT_GATE_PROFILE` (applied), `CONTEXT_GATE_MODE=auto|shadow`,
`CONTEXT_GATE_OFF=1`, `CONTEXT_GATE_TICKET_TYPE`, `CONTEXT_GATE_MODEL`. So the `env` of shiftwork's `planForTicket`
makes a pi or OpenCode shift decide like a `claude -p` shift.

## Install

- pi: `pi -e <context-gate>/packages/adapters/pi/index.ts`, or add the path to `pi.extensions` of a pi package. pi
  loads TS extensions itself. The files use `.ts` import specifiers.
- OpenCode V2: add `<context-gate>/packages/adapters/opencode/index.ts` to `plugins` in `opencode.json` (Bun runs TS).

## Verified vs assumed

**pi: verified against local types.** The types were checked against `@earendil-works/pi-coding-agent` 0.99.1, the
copy installed in `shiftwork/node_modules`, and mirrored in `pi/types.ts`:
- `before_agent_start` gets `systemPromptOptions: NormalizedBuildSystemPromptOptions`. Mutations are documented
  ("Later handlers observe mutations"). `skills: Skill[]` has `{ name, description, filePath, baseDir }`, and
  `sections: Record<string,string>` holds XML-wrapped sections. The result's `message` is a custom message.
  shiftwork's pi package filters `systemPromptOptions.skills` the same way.
- `tool_call` → `{ block, reason }`. `tool_result` → `{ content }` replaces the content. `read` / `edit` / `write`
  inputs have `path`, and `read` has `offset` / `limit`.
- `input` → `{ action: "continue" | "transform" | "handled" }`. `session_start.reason` and `session_compact` are
  checked too.
- MCP tool names `mcp__<server>__<tool>` come from pi's built-in MCP extension (`createMcpToolName`). Calls made from
  codemode scripts are `tool_call`s too, with a `parentToolCallId`.
- Not run inside a live pi yet. The tests drive fake `pi.on` handlers.

**OpenCode: assumed.** Neither `@opencode/plugin` nor its types are installed locally. The shapes in
`opencode/types.ts` come from two sources:
- The installed `opencode` 2.0.20 binary, whose bundled server JS was read without modifying anything. It shows these
  trigger sites:
  - `trigger("session","prompt",{sessionID,messageID,prompt:{text,files,agents,skills},…})`, where skills are `{ id, mention? }`
  - `trigger("permission","evaluate",{…,action,resources,effect})`, where hooks set `effect` / `message`
  - `trigger("tool","execute.after",{tool,…,input,status,result:{output,content,metadata}})`
  - the `context` hook, which built-in plugins use via `system.push(...)`, `delete tools[name]` and `model.id`
  - the skill tool's `assert({ action: "skill", resources: [skill.id] })`
  - the `read` / `write` input `{ path }`
- shiftwork's `research/opencode-plugins-report.md` (v2 docs): `Plugin.define({ id, setup })`,
  `ctx.<domain>.hook(name, cb)`, `ctx.location.directory`, and the skill discovery dirs.

Points to verify before calling it supported:
1. The external (promise) plugin API: whether `ctx.session.hook` / `ctx.tool.hook` / `ctx.permission.hook` exist under
   these names, and whether an async callback's in-place mutation is honoured as for the built-in Effect plugins. The
   export is a plain `{ id, setup }` object; wrap it in `Plugin.define` if that turns out to be required.
2. The element type of `system`: the built-ins push `rc.make(text)`, probably a branded string. The adapter pushes a
   plain string.
3. MCP tool naming and its permission `action`: `canonicalToolName` maps `<server>_<tool>` / `<server>.<tool>` for
   servers listed under `mcp` in `opencode.json` (root, `.opencode/`, `~/.config/opencode/`).
4. That skill ids equal the `SKILL.md` names the gate uses.
5. `ctx.permission.rules({ sessionID, permissions })` is not called. `skillPermissionRules` is exported for a runner
   that creates sessions.

## Gaps

- Not implemented here: read-before-write and `strictWrite` (hooks adapter only), nested `.cursor/rules` (`cursorRules.nested`), `/gate` commands, and the `classify` provider.
- pi has no name-only skill listing, so `nameOnly` skills stay fully listed.
- OpenCode: the first prompt of a session decides before any `context` hook has reported the model. It uses
  `CONTEXT_GATE_MODEL` or the default tier, so it journals a second `decision` once the model is known.
- Session state is in memory (one pi process; one map per OpenCode plugin instance) and is not persisted across
  restarts.
