# tsc: typecheck gate with a baseline

A `turn` gate that runs `tsc --noEmit` after every turn of the main agent and blocks only **new** type errors.
Legacy errors that already exist in the repo do not block anything.

```json
"gates": [
  { "name": "typecheck", "on": "turn", "run": ["tsc", "--noEmit", "--pretty", "false"],
    "pass": "exitCode == 0", "onlyNew": true, "baseline": ".claude/gate.baseline.json" }
]
```

Copy the `gates` entry from [`gate.json`](gate.json) into your `.claude/gate.json`.

## How `onlyNew` + `baseline` work

The mod runs the gate (`hooks/layers/gates.ts`, `runCommandGate`) on `turn.complete`:

1. `pass` is evaluated over `{ exitCode, stdout, stderr, result }`. When it holds, the gate passes and leaves nothing in the context.
2. When it fails and `onlyNew` is set, the gate takes the list of current violations:
   - `result.violations` / `errors` / `problems` / `issues` (or `result` itself) when stdout is a JSON array or object;
   - otherwise **each non-empty stdout line** is one violation. That is why `--pretty false` matters: one `tsc` error per line,
     `file(line,col): error TSxxxx: message`.
3. **First run** (no `<gate name>` key in the baseline file): the current violations are written to the baseline and the
   gate passes. Commit that file.
4. **Later runs**: violations not in the baseline are new. None new → pass. Any new → the gate fails, the model gets
   `Гейт typecheck не пройдено (exit 2)` plus the new lines (or `message` + `Нові порушення:` when `message` is set), and
   the failure is journaled as `gate-failed` (counts towards `escalation.after.verifyFailed`).

The baseline is a JSON object keyed by gate name, so several `onlyNew` gates can share one file. See the example
[`.claude/gate.baseline.json`](.claude/gate.baseline.json). Lines are compared as whole strings: if an old error moves to another
line, it counts as new. Fix it or refresh the baseline (delete the gate's key and let the next turn record it again).

## Notes

- Gates run commands only in a trusted repo (`/gate trust` or `context-gate trust grant`); in an untrusted repo the gate
  is skipped (passes silently). `tsc` must be on `PATH` (or use `["npx", "tsc", ...]` / `["node", "node_modules/typescript/bin/tsc", ...]`).
- `on: turn` gates run for the tiers in `tiers` (default: every tier except `premium`).
- The CLI does not run gates; they live in the mod. `npx context-gate health` checks that the gate.json validates.
