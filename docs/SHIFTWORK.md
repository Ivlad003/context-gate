# Shiftwork integration contract

SPEC "Режими запуску" → "Інтеграція зі shiftwork" and plan step 7. The shiftwork runner reads the same
`.claude/gate.json` as the mod. For each `claude -p` shift it gets a skill set, a preload text and a profile from
the ticket's `**Type:**`, without a classifier. The mod in the TUI and the runner in the background then decide the
same way from one file. The runner and context-gate talk through `.claude/gate.log.jsonl`.

The contract is `packages/hooks-adapter/src/shiftwork.ts`. It is pure, with no Node and no I/O, and is also reachable
as a CLI: `node dist/hooks-adapter.js plan …`. This document says how the runner should consume it. Shiftwork itself is
unchanged.

## What shiftwork does today (0.3.0)

These are the facts the contract matches, from `shiftwork/packages/core/src/{index,planner,config}.js` and
`packages/cli/src/claude-backend.js`:

- `parseTicket` reads the ticket lines `Type`, `Model`, `Skills` (space-separated: `+group`, `-group`, `group`),
  `Budget`, `Verify` and `Frozen`.
- `planShift` picks the tier from `routing[Type].tier` or `defaultTier`. `resolveSkills` grants
  `tiers[tier].skills` (group names), applies the ticket's `Skills` adjustments, and maps groups to paths through
  `skillGroups` (group → source names) and `skillSources` (name → path). `preload` is the subset in
  `tiers[tier].preload`, and `restricted` is true when the tier or the ticket configures skills.
- The Claude backend symlinks `route.skills.paths` into `<tmp>/plugin/skills/<basename>` and passes
  `--plugin-dir <tmp>/plugin`. It appends the preloaded `SKILL.md` bodies, framed
  `<!-- Preloaded skill: <file> -->`, to the system prompt file passed with `--append-system-prompt-file`.
- Model refs look like `claude:claude-sonnet-4-6` (CLI backend prefix) or `anthropic/claude-haiku-4-5` (pi).

## The plan

```ts
import { planForTicket } from 'context-gate/packages/hooks-adapter/src/shiftwork.ts'

const plan = planForTicket(gateConfig, {
  ticketType: ticket.type ?? route.type,  // **Type:**
  model: route.ref,                        // shiftwork model ref, the prefix is stripped
  skills: ticket.skills,                   // **Skills:** adjustments, as +group / -group
  items,                                   // skills with provenance.path and body (the CLI loads them)
  branch,
})
```

Or, without importing TypeScript:

```bash
node <context-gate>/dist/hooks-adapter.js plan --root <worktree> --type ui --model claude:claude-haiku-4-5 --skills "+git"
```

This prints JSON with absolute symlink paths and no `gate` field:

| field | meaning | how the runner uses it |
| --- | --- | --- |
| `profile` | `profiles[x].when.ticketType` containing the Type. Several matches give the union `a+b`. With no match, the profile named like the Type. Else none (tier set only) | `env.CONTEXT_GATE_PROFILE` |
| `tier` | `models` glob over the model id (`tierForModel`) | for logs and escalation |
| `skills` | skill names that are `on` + `preload` | what the shift may use |
| `preload` | skill names whose body is inlined | — |
| `appendSystemPrompt` | preloaded bodies framed `<!-- Preloaded skill: <path> -->`, the same framing as `loadPreload` | append to the worker system prompt file (`--append-system-prompt-file`) |
| `pluginDirSymlinks` | skill directories of `skills` | symlink into `<tmp>/plugin/skills/` and pass `--plugin-dir` (as `route.skills.paths` today). Only skills outside the worktree need this |
| `settings.skillOverrides` | `nameOnly` → `name-only`, `off` → `off` | `claude -p --settings '<json>'`. This hides repo and user skills (`.claude/skills`, `~/.claude/skills`) that the plugin dir can't remove |
| `env` | `CONTEXT_GATE_PROFILE`, `CONTEXT_GATE_TICKET_TYPE`, `CONTEXT_GATE_MODEL` | the shift's env, so the hooks adapter or the mod in that shift decides the same |
| `mcpOff` | MCP tools outside the profile | informational. They are denied when the hooks adapter is installed in the worktree's `.claude/settings.local.json`, or passed in the same `--settings` JSON together with `hooks` from `install --print` |
| `log` | a `decision` entry (`trigger: when:ticketType`) | write with `decisionEvent(plan, { ts, turn: shift, ticket })` |

The ticket's `Skills:` adjustments become `/gate +x -y`-style group changes. Group names are the `gate.json` group
names. A legacy `gate.json` with `skillGroups` reads as unified `groups` (G310), so the shiftwork-style
`skillGroups`, `tiers[*].skills` and `tiers[*].preload` mean the same thing in both tools.

### Suggested runner change (Claude backend)

```js
// in startShift, when <worktree>/.claude/gate.json exists
const plan = JSON.parse(execFileSync('node', [hooksAdapter, 'plan', '--root', cwd, '--type', route.type, '--model', route.ref, '--skills', ticket.skills.join(' ')]))
for (const p of plan.pluginDirSymlinks) await symlink(p, join(pluginDir, 'skills', basename(p)))
fullSystemPrompt = [systemPrompt, preload.text, plan.appendSystemPrompt].filter(Boolean).join('\n\n')
args.push('--settings', JSON.stringify(plan.settings))
env = { ...env, ...plan.env }
```

When `gate.json` is absent, the runner keeps its own `shiftwork.json` routing unchanged.

## Events in `.claude/gate.log.jsonl`

One `DecisionLogEntry` per line (`core/types.ts`), written with `formatEvents()` (core `toJsonl`), the format the mod
and the hooks adapter already append. Every entry carries `data.adapter` (`"shiftwork"` for the runner's) and
`data.ticket` (`<feature>/<number>`). `turn` is the shift number.

| kind | written by | helper | data |
| --- | --- | --- | --- |
| `decision` | runner, at the start of a shift | `decisionEvent(plan, base)` | `ticketType`, `ticket` |
| `decision`, `trigger: "verify"` | runner, after a passing Verify | `verifyEvent(base, { passed: true, attempt })` | `gate: "verify"`, `passed`, `attempt` |
| `gate-failed`, `trigger: "verify"` | runner, after a failing Verify | `verifyEvent(base, { passed: false, attempt, exitCode, command })` | `gate: "verify"`, `passed: false`, `attempt`, `exitCode` |
| `gate-failed`, `trigger: "read-before-write"` | hooks adapter / mod | — | `id: file:<path>` |
| `escalation-suggested` | runner (or mod) | `escalationEvent(config, base, { verifyFailed, stallTurns })` | `from`, `to`, the counts |

`escalationEvent` returns `undefined` until a count reaches `escalation.after`. `to` is the next tier in
`escalation.order` (none at the top). The reason reads, for example,
`2 невдалі перевірки на quick — перейди на standard`.

The runner reads the log back like this:

- `escalationsSince(entries, shiftStartTs, ticket)` returns escalations the mod raised during the shift, in
  interactive or TUI use. Treat one like a soft-limit handoff, with `chooseHandoffTarget` toward `data.to`.
- `verifyFirstTry(entries)` returns, per ticket, whether the first `verify` event passed. `bench/run.ts` reports it
  as "Verify з 1-ї спроби".

Writing is plain append (`fs.appendFileSync(join(worktree, '.claude/gate.log.jsonl'), formatEvents(entries))`). The
log is local metadata, so add `.claude/gate.log.jsonl` to `.gitignore` in the target repo, or keep it outside the
worktree and set the path in the runner.
