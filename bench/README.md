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

`repos.json` is the single list of bench repos. `node dist/cli.js bench` (no dirs) reads it too, with each repo's
`profile` / `model` / `tier` unless the flags override them. The same `dir` may appear twice with a different profile or model.

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

## Repos

Besides `examples/basic` and `examples/reference`, `repos.json` lists the small synthetic repos in `bench/repos/`. Each one
has a `.claude/gate.json`, a few `.cursor/rules/*.mdc` rules, `.claude/skills/*/SKILL.md` skills and a small prompt:

| repo | what it models | prompt | bench profile / model |
| --- | --- | --- | --- |
| `web-spa` | frontend-only React SPA | TSX | `ui` / sonnet |
| `api-service` | Fastify + Postgres API, `workflow.quick.md` tier variant | Markdown | `api` / haiku |
| `py-data` | Python data pipelines and notebooks | Markdown | `etl` / sonnet |
| `monorepo` | pnpm workspaces with nested `packages/*/.cursor/rules` | TSX | `ui` / opus |
| `docs-site` | documentation site | Markdown | `writing` / haiku |
| `rules-only` | Rust crate with `.cursor/rules` only, no prompt DSL, no skills | — | none |
| `skills-heavy` | 30 skills in 6 groups; a profile turns on one group | TSX | `web` / sonnet |

The repos are fixtures: no dependencies, nothing to install. Build their TSX prompts first. `.compiled/` is gitignored,
and a repo without it reports 0 prompt tokens:

```bash
for d in examples/reference bench/repos/*/; do node dist/cli.js build --root "$d"; done
```

Skills in `~/.claude/skills` count towards every repo's items (`listSkills` reads the user dir too). For numbers that
do not depend on the machine, run with an empty home: `HOME=$(mktemp -d) node --experimental-strip-types bench/run.ts`.

## Columns

| column | meaning |
| --- | --- |
| системний промпт, ток. | rendered DSL sections, the tokens every session pays |
| елементи, gate off / on | skills, MCP tools, agents and rules that reach the context, without and with the gate |
| економія | off − on |
| unverified | sections rendered as `unverified` (untrusted repo, failed `@run`) |
| Verify з 1-ї спроби | from `<repo>/.claude/gate.log.jsonl`: tickets whose first `verify` event passed. The shiftwork runner writes these events with `verifyEvent()` from `packages/hooks-adapter/src/shiftwork.ts` (see `docs/SHIFTWORK.md`). `—` when the log has none |

The exit code is 2 when a command failed for some repo; the errors are listed under the table.
