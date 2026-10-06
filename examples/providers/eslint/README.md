# eslint: lint results as context and as a commit gate

[`gate.json`](gate.json) declares two things:

- an `eslint` **cli provider**: `eslint -f json .`, cached for 10 minutes, `onError: unverified`, with a `schema` for the
  ESLint JSON formatter output (an array of `{ filePath, errorCount, warningCount, messages: [{ ruleId, severity, message, line, column }] }`).
  `context-gate build` turns the schema into the type of `ctx.eslint` in `.claude/prompt/.types/ctx.d.ts`;
- a `lint` **commit gate**: `eslint -f json {changedPaths}` before `git commit`, passing when no file has errors.

## Prompt section

[`lint.md`](lint.md) is a Markdown prompt section. Put it into `.claude/prompt/`. It renders only when the provider
returned data (`when: eslint != null`):

```text
ESLint: 3 файлів перевірено, з помилками — 2.
Найгірші файли (виправ, якщо торкаєшся їх):
- src/legacy.ts: 5 помил., перша — рядок 1 no-undef
- src/users.ts: 2 помил., перша — рядок 2 no-unused-vars
```

The same in TSX:

```tsx
<Section id="lint-state" scope="volatile" when="eslint != null">
  ESLint: файлів із помилками — {'{{ eslint | where("errorCount") | len }}'} з {'{{ eslint | len }}'}.
  <Each of='eslint | where("errorCount") | sort("-errorCount") | take(3)' as="f">
    <li><V expr="f.filePath" />: <V expr="f.errorCount" /></li>
  </Each>
</Section>
```

The DSL has no `sum` filter, so the section counts files with errors (`where("errorCount") | len`), not messages.

## Why `sh -c "eslint … || [ $? -eq 1 ]"`

ESLint exits with 1 when it finds lint errors, and a cli provider treats any non-zero exit as a failure (`onError`).
Exit 1 is exactly the case the section is for. The wrapper keeps exit 1 as success and still fails on exit 2
(a broken config or a crash). With a plain `["eslint", "-f", "json", "."]` the section disappears whenever there are errors.
The gate needs no wrapper: its `pass` expression looks at `result`, not at the exit code.

## Demo without ESLint installed

[`bin/eslint`](bin/eslint) is a fake that prints [`fixtures/eslint.json`](fixtures/eslint.json) and exits 1, like ESLint
does when it finds errors.

```bash
mkdir -p /tmp/eslint-demo/.claude/prompt
cp gate.json /tmp/eslint-demo/.claude/gate.json && cp lint.md /tmp/eslint-demo/.claude/prompt/
PATH="$PWD/bin:$PATH" node ../../../dist/cli.js run --root /tmp/eslint-demo --trust-repo --no-markers
```

`--trust-repo` lets the CLI start the provider. The binary (`sh` here) must be on the whitelist: the default list or
`allowBinaries` in `~/.claude/context-gate.json`.
