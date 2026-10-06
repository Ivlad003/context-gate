# context-gate-probe

A small, separate Claude Code mod plugin for **SPEC Р6 stage 0**. It answers the open questions in
[`docs/PROBE.md`](../docs/PROBE.md), section "Still LIVE: what a probe session must confirm", before
context-gate depends on any of them.

There is one observer hook per unverified API point. Each hook passes its event through unchanged and
never breaks the session: every hook is wrapped, and a failure falls back to the engine's own behaviour.
Each hook appends what it saw to one in-memory report. After every observation the probe rewrites the
whole report to `<session root>/.claude/probe.json` with `$.fs.write`, and also logs it to the debug log
(`$.ui.log(..., { to: 'debug' })`, which `--debug` shows).

The probe records metadata and lengths only. The one exception is the skill-listing text: it keeps the
first 20k characters, because that text becomes the fixture for `parseSkillListing`.

| Point (`points.<name>`) | PROBE.md # | Hooks | Recorded |
| --- | --- | --- | --- |
| `skill_listing` | 1 | `prompt.attachment {type:'skill_listing'}` | `text` (first 20k chars), `agentId`, origin, length, whether the result changed |
| `tool_describe_mcp` | 2 | `tool.describe {tool:/^mcp__/}` | tool name, `isDeferred`, description length (input and result) |
| `skill_prompt_bang` | 3 | `skill.prompt`, `tool.call {tool:'Skill'}`, `command.run` | skill name, whether `` !` `` is still in the text, whether the bundled fixture already expanded, text length; Skill args present/length; command name and whether it had args. Use `seq` for ordering |
| `state_after_clear` | 4 | `session.start`, `session.end`, `classic.SessionStart`, `prompt.submit` | the `$.state` marker each one sees before it writes its own, plus `reason` / `source` |
| `filechanged_watchdir` | 5 | `classic.SessionStart` (adds `watchPaths`), `classic.FileChanged` | the watch entries added: the `<root>/.cursor/rules` directory and the `<root>/.claude/probe-watch.txt` file; then each change's `file_path`, `event`, and whether it falls under the directory |
| `prompt_context_subagent` | 6 | `prompt.context`, `turn.step` | input side: `blockNames`, `instructionFilesDefined`, `instructionFilesCount`, `instructionFileKinds`, `inputKeys`, `agentLikeKeys`; result side (what `next(e)` returned, in the same sample): `resultBlockNames`, `resultInstructionFiles` (`{ path, kind }` each, the path repo-relative inside the session root and a basename outside it, never the content), `hasCursorRulesBlock`; per step `agentId`, model, `usage.cache_read_input_tokens` |
| `model_complete_cost` | 7 | `/probe classify` (a `command.run` registered in `session.start`) | ms, `usage`, answered or not |
| `prompt_compose_print` | 8 | `prompt.compose` | `traits` (look for `print` and `sdk-preset`), model, number of tools, number of sections |

The plugin also ships a skill, `probe-bang` (`skills/probe-bang/SKILL.md`). It contains
`` !`echo probe-bang-expanded` `` so that point 3 can be answered without guessing.

## Report shape

```json
{
  "claudeCode": "2.1.288",
  "startedAt": "2026-10-06T10:00:00.000Z",
  "out": "probe.json",
  "points": {
    "skill_listing": { "status": "observed", "samples": [{ "seq": 3, "at": "...", "kind": "prompt.attachment", "...": "..." }] },
    "tool_describe_mcp": { "status": "not-fired", "samples": [] },
    "state_after_clear": { "status": "observed", "samples": ["..."], "verdict": "works" }
  }
}
```

- `status` is `observed` once any hook for that point has fired.
- Each point keeps at most 60 samples. Repeated identical events (the same tool description, the same
  listing, the same compose traits) are recorded once.
- `verdict` is filled in automatically only where a single sample settles the question:
  - `tool_describe_mcp`: a deferred MCP tool was described.
  - `state_after_clear`: `classic.SessionStart {source:'clear'}` saw the marker that was written before
    `/clear`. If it did not, the verdict is `broken`.
  - `filechanged_watchdir`: a change under the watched directory fired (`works`), or only the watched
    file fired (`partial`).
  - `model_complete_cost`: the model answered.
  - `prompt_compose_print`: `print` appeared in `traits`.
  - Every other point needs a person to judge it.
- `/probe` with no arguments (or `/probe dump`) prints each point's status in the transcript.

## Running it

Use a throwaway test repo. `examples/basic` works: it has `.cursor/rules/*.mdc` and a `.claude/` folder.
`examples/reference` works too, if your checkout has it.
Run the steps in this order. Each step names the point it feeds.

```bash
cd examples/basic
mkdir -p .claude && touch .claude/probe-watch.txt
claude --plugin-dir ../../probe/context-gate-probe --debug
```

1. **Start.** Wait for the first prompt. Ask: `list your skills, verbatim as you see them`.
   This feeds point 1 (and points 4, 6 and 8 on the side).
2. **MCP via ToolSearch.** You need at least one MCP server connected. Ask: `use ToolSearch to find an
   MCP tool and call it once`. This feeds point 2: look for `isDeferred: true` samples.
3. **Skills.**
   - Type `/context-gate-probe:probe-bang foo bar`. This is the slash path: `command.run`, then
     `skill.prompt`.
   - Then ask: `run the probe-bang skill via the Skill tool with args "baz"`. This is the tool path:
     `tool.call:Skill`, then `skill.prompt`.
   - Compare the `seq` numbers and the `fixtureExpanded` / `hasBangPattern` values (point 3).
4. **File watches.** In another shell:
   - `touch .cursor/rules/project.mdc`
   - `echo "# probe" > .cursor/rules/probe-new.mdc` (then delete that file)
   - `touch .claude/probe-watch.txt`

   Then send any prompt, so the session gets a chance to deliver the events (point 5).
5. **Subagent.** Ask: `use a subagent (Task tool) to count the .mdc files under .cursor/rules`.
   This feeds point 6: look for `turn.step` samples with an `agentId`, and check whether `prompt.context`
   fired again.
6. **Model cost.** Type `/probe classify`. This feeds point 7. The reply also prints the ms and the usage.
7. **Clear.** Type `/clear`, then send any prompt, such as `hi`. This feeds point 4: look for
   `classic.SessionStart` with `source: "clear"` and the `markerBefore` it saw.
8. **Exit** (`/exit` or Ctrl-D). This records `session.end {reason}`.
9. **Print mode.** Run `probe/run-print.sh` (default repo `examples/basic`; pass another path as the first
   argument). It runs `claude -p --plugin-dir probe/context-gate-probe "say hi"` with
   `CONTEXT_GATE_PROBE_OUT=probe.print.json`, so the interactive report is not overwritten. It exits 0
   and skips if the `claude` CLI is not installed. This feeds point 8: is `print` in `traits`? For
   `sdk-preset`, run any Agent SDK client with the same plugin dir and look at the same point.

The reports land in `<test repo>/.claude/probe.json` (interactive) and
`<test repo>/.claude/probe.print.json` (`-p`). The debug log also holds one
`context-gate-probe: <point> {...}` line per observation (the listing text is left out there).
Delete both files, and `.claude/probe-watch.txt`, from the test repo when you are done.

## End-to-end use (scripts/e2e.sh)

`scripts/e2e.sh` loads the probe next to context-gate:
`claude -p --plugin-dir <repo> --plugin-dir probe/context-gate-probe` on a copy of `examples/reference`.
It then reads `.claude/probe.json`. To confirm that context-gate's Always rules reached the model, it
looks at the `prompt.context` samples in `points.prompt_context_subagent.samples`:
- `hasCursorRulesBlock: true`;
- `resultBlockNames` includes `cursorRules`;
- `resultInstructionFiles` lists the files by path and kind.

The load order of the two plugins is unknown. If context-gate sits beneath the probe, its blocks show up
on the result side. If it sits above, they show up on the input side (`blockNames`). That is why each
sample records both sides. Leave `CONTEXT_GATE_PROBE_OUT` unset there so the report lands in `probe.json`.

## Copying findings into docs/PROBE.md

For each point, add a row to a table in `docs/PROBE.md` under "Still LIVE":

| Point | Claude Code | Result | Evidence |
| --- | --- | --- | --- |
| `skill_listing` | 2.1.x | works / doesn't / partial | e.g. "fires per agent, agentId set for subagents; fixture saved to test/fixtures/skill-listing.txt" |

- Use `claudeCode` from the report as the version.
- Copy the `skill_listing` sample's `text` into a test fixture for `parseSkillListing`.
- Once a point is confirmed, move it out of the LIVE list into the verified part of PROBE.md.
- Any feature that depends on a point still `doesn't` or `partial` gets `requires: [probe:<name>]` in
  the spec or feature list (for example `requires: [probe:filechanged_watchdir]`). It keeps its fallback
  until a later probe run flips the point to `works`.

## Developing the probe

```bash
probe/sync-types.sh                                    # copy the claude-code API types to hooks/.types/
npx tsc -p probe/context-gate-probe/hooks/tsconfig.json
claude plugin validate --strict probe/context-gate-probe
claude plugin test probe/context-gate-probe
```

`sync-types.sh` works like `scripts/sync-mod-types.sh`. It takes the types the engine wrote under
`context-gate-probe/.claude-plugin/types/` after a `--plugin-dir` load, or the newest copy from the
plugin-authoring skill. Both generated folders are gitignored (`probe/.gitignore`). The root `npm test`
only globs `test/`, so nothing in this folder runs there.
