---
name: debug
description: "Знаходить причину симптому за логами і кодом, а потім виправляє її. Приклад: /debug 'кнопка експорту нічого не робить' --log logs/app.log"
argument-hint: "<symptom> [--log <log>]"
generated-by: context-gate
source-hash: 3fc75797aa8ca370
---
!`if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then set -- node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"; else set -- npx --no-install context-gate; fi; "$@" run debug --args '$ARGUMENTS' --ctx-from live`

<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/debug.json. Якщо рядок вище не виконався (harness без підтримки !`…`), виконай: npx context-gate run debug --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->
