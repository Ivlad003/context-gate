---
name: release
description: "Готує нову версію для npm: перевірки, нова версія, changelog, тег. Приклад: /release minor"
argument-hint: "[<patch|minor|major>] [--dry]"
disable-model-invocation: true
generated-by: context-gate
source-hash: f3db5e595e92b404
---
!`if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then set -- node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"; else set -- npx --no-install context-gate; fi; "$@" run release --args '$ARGUMENTS' --ctx-from live`

<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/release.json. Якщо рядок вище не виконався (harness без підтримки !`…`), виконай: npx context-gate run release --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->
