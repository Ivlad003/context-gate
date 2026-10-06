# Provider adapters

Examples for SPEC stage 7a: the first tools connected through `gate.json` alone (providers, item sources, gates),
with no code in context-gate. Each directory has a `gate.json` fragment. All keys of `gate.json` are optional, so each
fragment is also a valid `gate.json` (checked against `schema/context-gate.schema.json`). Merge the keys into your `.claude/gate.json`.

| dir | provider | item source | gate | demo |
| --- | --- | --- | --- | --- |
| [`keylang/`](keylang/) | `arch`: `keylang parse --json`, function `arch.code(id)`, schema | `provider` → Always rules from `arch.deny` | `architecture` on commit | fake `bin/keylang`, section `architecture.md` |
| [`tsc/`](tsc/) | — | — | `typecheck` on turn, `onlyNew` + `baseline` | example `.claude/gate.baseline.json` |
| [`eslint/`](eslint/) | `eslint`: ESLint JSON output, schema | — | `lint` on commit | fake `bin/eslint`, section `lint.md` |

Rules shared by all of them:

- cli providers and gates start processes only in a trusted repo (`context-gate trust grant`, `/gate trust`, or `--trust-repo` for one CLI run).
- The CLI and the mod's renderer start only whitelisted binaries: `allowBinaries` in `~/.claude/context-gate.json`
  (default `bash, sh, node, python3, python, deno, git`). A repo's `gate.json` can only narrow that list.
- A provider whose command fails (non-zero exit, bad JSON, binary not allowed) follows `onError`:
  `unverified` (render without the value, mark it), `skip`, or `fail`.
