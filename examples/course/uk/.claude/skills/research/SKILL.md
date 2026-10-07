---
name: research
description: "Досліджує тему за першоджерелами і порівнює варіанти в таблиці. Приклад: /research 'сховище для local-first застосунку' --options sqlite,indexeddb,files"
argument-hint: "<topic> [--options <options,…>] [--out <out>]"
generated-by: context-gate
source-hash: 1f40c6600df9f005
---
!`if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then set -- node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"; else set -- npx --no-install context-gate; fi; "$@" run research --args '$ARGUMENTS' --ctx-from live`

<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/research.json. Якщо рядок вище не виконався (harness без підтримки !`…`), виконай: npx context-gate run research --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->
