# Reference monorepo

The end-to-end fixture from SPEC "Тестування": a monorepo with `.cursor/rules`, 20+ skills and 3 MCP servers. The e2e
check runs the real mod against it, and the scenarios in SPEC "Сценарії використання" can be replayed on it with the CLI.
None of the app code is meant to build or run. It only gives the rules and profiles real paths to match.

## Layout

| path | what |
| --- | --- |
| `apps/web/src/*.tsx` | React app: `Button.tsx` (a `<div onClick>` to make accessible, scenario 2), `App.tsx`, `UserList.tsx` |
| `apps/api/src/users.{controller,service}.ts` | NestJS service; `apps/api/prisma/schema.prisma`, `apps/api/migrations/*/migration.sql` |
| `package.json` | private root with npm `workspaces: ["apps/*"]`; read by the `pkg` file provider |
| `.cursor/rules/*.mdc` | 12 rules of all four types (below) |
| `.claude/skills/*/SKILL.md` | 25 one-paragraph skills, matched by the `groups` in gate.json |
| `.claude/agents/*.md` | `ui-reviewer` (frontend), `db-reviewer` (backend) |
| `.mcp.json` | 3 MCP servers: `figma`, `playwright`, `postgres`. Placeholder `npx -y @example/*` commands; nothing starts them |
| `.claude/gate.json` | unified `groups`/`itemSources` format: profiles frontend/backend/git/docs, tiers, classify shadow, budgets, escalation, providers, gates |
| `.claude/prompt/main.prompt.tsx` | TSX system prompt (`shared/base.prompt.tsx` holds Identity and SafetyRules) |
| `.claude/prompt/backend-workflow.md` | Markdown-form section (`@if gate.tier == "quick"` … `@end`), on in the backend profile only |
| `docs/api.md`, `CONVENTIONS.md` | targets of `<Include mode="lazy">` and `<Include mode="inline">` |

Rules:

| type | rules |
| --- | --- |
| Always (`alwaysApply: true`) | `project`, `communication` |
| Auto Attached (`globs`) | `react-components` (`**/*.tsx`), `tailwind` (`apps/web/**/*.tsx, apps/web/**/*.css`), `api-conventions` (`apps/api/src/**/*.ts`), `prisma` (`**/*.prisma`), `migrations` (`**/migrations/**/*.sql`), `testing` (`**/*.test.ts, **/*.test.tsx`) |
| Agent Requested (`description` only) | `api-design`, `performance` |
| Manual (neither) | `security-review`, `release` |

Profiles (`when` is checked before the classifier):

| profile | groups | `when` |
| --- | --- | --- |
| frontend | react-*, tailwind, storybook, a11y, playwright-e2e, `mcp__figma__*`, `mcp__playwright__*`, ui-reviewer | `paths: apps/web/**`, `branch: ^feat/ui` |
| backend | nestjs, prisma, api-design, postgres-queries, security-audit, docker, ci-pipelines, `mcp__postgres__*`, db-reviewer | `paths: apps/api/**, prisma/**, **/migrations/**` |
| git | git-conventions, resolving-merge-conflicts, release-notes, changelog | `ticketType: git` (scenario 11) |
| docs | writing-for-agents, docs-style, adr | `paths: docs/**`, `ticketType: docs` |

Tiers add `core` (tdd, diagnosing-bugs, project-conventions) everywhere, `git` on standard and quick, `docs` on quick,
and preload `project-conventions` on quick.

`.claude/prompt/.compiled/` and `.trace/` are gitignored, as in `examples/basic`. `prompt.lock.json` and `.types/` are
committed. Run `build` after cloning.

## CLI checks (from the context-gate repo root)

```bash
npm run build
node dist/cli.js build  --root examples/reference
node dist/cli.js run    --root examples/reference --trace --dry-scripts
node dist/cli.js health --root examples/reference
node dist/cli.js pipe   --root examples/reference "collect | tokens"
node dist/cli.js pipe   --root examples/reference "collect | decide --profile frontend | tokens"
```

All of them exit 0. The untrusted repo gives two expected warnings: `G203` (`<Run>` in `repo-state` was not run) and
`G204` (the `eslint` cli provider was not started), plus `H007 Unverified = 1` in health.

## Scenarios you can replay

| SPEC scenario | how |
| --- | --- |
| 1. First run with Cursor rules | `pipe "collect \| tokens"`: 12 rules, 25 skills, 2 agents, 11 sections. In the mod the status line shows `rules 12` and `classify: shadow` only logs. The 3 MCP servers show up only inside Claude Code: the CLI cannot list MCP tools |
| 2. Editing a React component | `pipe "collect \| decide --paths apps/web/src/Button.tsx \| where kind=skill \| on"` → frontend profile by `when.paths`. In the mod, `Read apps/web/src/Button.tsx` attaches `react-components.mdc` and `tailwind.mdc` |
| 3. The same task on a cheap model | `run --profile frontend --model claude-haiku-4-5 --dry-scripts`: tier quick, `workflow` checklist, one `<Examples>` component sample, `project-conventions` preloaded |
| 4. Manual rule and group | `@security-review` in a prompt (Manual rule), `/gate +docs` in the mod |
| 5. A rule that does not fire | `api-conventions.mdc` uses `apps/api/src/**/*.ts`, the fixed glob. Change it to `src/api/**/*.ts` and `run --only project-rules` / `/gate rules` show it never matches `apps/api/src/users.controller.ts` |
| 6. Classifier picks the wrong profile | `decide --paths apps/api/migrations/x.sql` → backend through `when.paths: **/migrations/**`, before the classifier |
| 7. Context fills up | the `budget-warning` section (`onExceed.softContextPct`) and `budget={4000}` on `project-rules`; `--ctx-from fixture.json` with `{"ctx":{"percent":80}}` renders it |
| 11. Runner and TUI disagree | `profiles.git.when.ticketType: ["git"]`; shiftwork passes the ticket type |
| 12. Is the gate worth it | `node dist/cli.js bench` and `bench/run.ts`: `reference` and `reference-backend-haiku` rows in `bench/repos.json` |

## End-to-end check

`scripts/e2e.sh` copies this directory to a temp dir, runs
`claude -p --plugin-dir <context-gate root> --plugin-dir probe/context-gate-probe` in it, and then reads `.claude/probe.json`
(written by the probe plugin's `prompt.context` hook) to check that the Always rules and the matching Auto Attached rules
reached the model. The `.mcp.json` servers are placeholders. The check does not need them to start.
