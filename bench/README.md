# bench

A harness for the MVP exit criterion (SPEC "MVP-зріз"): a TSX/DSL system prompt that is no bigger than the old
CLAUDE.md, with the same Verify result. It measures each repo in `repos.json` with the gate off and on.

```bash
npm run build                                      # dist/cli.js
node --experimental-strip-types bench/run.ts       # Markdown table
node --experimental-strip-types bench/run.ts --json
node --experimental-strip-types bench/run.ts --repos path/to/other-repos.json
```

## repos.json

```json
{ "repos": [ { "name": "basic", "dir": "examples/basic", "profile": "frontend", "model": "claude-sonnet-4-6" } ] }
```

`dir` is relative to the context-gate repo root. `profile`, `model` and `tier` choose the gate-on decision. When the
CLI flags differ, `commands` overrides the argv passed to `node dist/cli.js`:

| key | default argv | read from the output |
| --- | --- | --- |
| `health` | `health --json [--profile p] [--model m]` | `sections[].tokens` summed (system prompt per session), `metrics[name~unverified].value` |
| `tokensOff` | `pipe "collect \| tokens"` | `included.tokens` of the TokenSummary (every item on) |
| `tokensOn` | `pipe "collect \| decide --profile p --model m \| tokens"` | `included.tokens` after the gate |

## Columns

| column | meaning |
| --- | --- |
| системний промпт, ток. | rendered DSL sections, the tokens every session pays |
| елементи, gate off / on | skills, MCP tools, agents and rules that reach the context, without and with the gate |
| економія | off − on |
| unverified | sections rendered as `unverified` (untrusted repo, failed `@run`) |
| Verify з 1-ї спроби | from `<repo>/.claude/gate.log.jsonl`: tickets whose first `verify` event passed. The shiftwork runner writes these events with `verifyEvent()` from `packages/hooks-adapter/src/shiftwork.ts` (see `docs/SHIFTWORK.md`). `—` when the log has none |

The exit code is 2 when a command failed for some repo; the errors are listed under the table.
