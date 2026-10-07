---
name: handoff
description: "Зупиняє поточну роботу і пише handoff-файл, з якого нова сесія може продовжити. Приклад: /handoff notes/handoff.md"
argument-hint: "[<[file]>]"
generated-by: context-gate
source-hash: 1902ada917ae4d88
---
!`if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then set -- node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"; else set -- npx --no-install context-gate; fi; "$@" run handoff --args '$ARGUMENTS' --ctx-from live`

<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/handoff.json. Якщо рядок вище не виконався (harness без підтримки !`…`), виконай: npx context-gate run handoff --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->
