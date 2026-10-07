---
name: status
description: "Short status of the tickets: done, in progress, blocked, and what needs my decision. Example: /status checkout"
argument-hint: "[<[feature]>]"
generated-by: context-gate
source-hash: 2b757280c9202ed1
---
!`if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then set -- node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"; else set -- npx --no-install context-gate; fi; "$@" run status --args '$ARGUMENTS' --ctx-from live`

<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/status.json. Якщо рядок вище не виконався (harness без підтримки !`…`), виконай: npx context-gate run status --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->
