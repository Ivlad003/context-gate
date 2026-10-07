---
name: handoff
description: "Stops the current work and writes a handoff file that a fresh session can continue from. Example: /handoff notes/handoff.md"
argument-hint: "[<[file]>]"
generated-by: context-gate
source-hash: ac5e94451c9f8166
---
!`if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then set -- node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"; else set -- npx --no-install context-gate; fi; "$@" run handoff --args '$ARGUMENTS' --ctx-from live`

<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/handoff.json. Якщо рядок вище не виконався (harness без підтримки !`…`), виконай: npx context-gate run handoff --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->
