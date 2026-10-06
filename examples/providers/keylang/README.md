# keylang: architecture rules as context, rules and a gate

The adapter from SPEC "Провайдери": context-gate knows nothing about keylang. [`gate.json`](gate.json) connects it
through config alone:

| key | what it does |
| --- | --- |
| `providers.arch` | cli provider `keylang parse --json`, cached 5 min, `onError: unverified`. `functions.code` makes `arch.code("<id>")` run `keylang explain <id> --json`. `schema` describes `{ deny: [{ from, to, reason? }], violations: [{ code, explain, file?, line? }], symbols }`, and `context-gate build` turns it into the type of `ctx.arch`. `exposes: ["symbols"]` puts the symbols into the editor index (`context-gate index`) |
| `itemSources[kind=provider]` | turns every `arch.deny` entry into an Always rule with the text `{{ item.from }} не імпортує {{ item.to }}`. Legacy `ruleSources` takes the same entry |
| `gates[name=architecture]` | before `git commit`: `keylang check --changed --json`, passes when `len(result.violations) == 0`, otherwise denies the commit with `KL001: …` from the first violation |

[`architecture.md`](architecture.md) is a Markdown prompt section that renders the deny list and one `arch.code(...)` call.

## Demo with the fake binary

[`bin/keylang`](bin/keylang) is a stand-in that prints fixed JSON (`parse`, `check`, `explain`). `KEYLANG_FAKE_VIOLATION=1`
makes `check` report one violation and exit 1.

```bash
mkdir -p /tmp/kl-demo/.claude/prompt
cp gate.json /tmp/kl-demo/.claude/gate.json && cp architecture.md /tmp/kl-demo/.claude/prompt/
# keylang is not on the default binary whitelist (bash, sh, node, python3, python, deno, git):
#   add it to "allowBinaries" in ~/.claude/context-gate.json
PATH="$PWD/bin:$PATH" node ../../../dist/cli.js run --root /tmp/kl-demo --trust-repo --no-markers
```

Output:

```text
Межі архітектури (з keylang):
- domain не імпортує infrastructure — домен не знає про БД і HTTP
- ui не імпортує domain/internal — UI працює лише через application-сервіси

Пояснення use case: application.purchase.buy: use case купівлі; …
```

Without trust (`--trust-repo` or `context-gate trust grant`) the provider does not run, the CLI warns with `G204`, and
the section is skipped (`when: arch != null`).

## Limitations

- The CLI and the mod do not collect `provider` item sources yet. `context-gate collect` shows `arch` only as a `datum`, so
  the deny rules do not reach the context as Always rules. Render them in a section, as `architecture.md` does.
- The CLI does not run gates. The `architecture` gate runs in the mod (`on: commit`, trusted repos only).
