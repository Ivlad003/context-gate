---
name: research
description: "Researches a topic from primary sources and compares options in a table. Example: /research 'storage for a local-first app' --options sqlite,indexeddb,files"
argument-hint: "<topic> [--options <options,…>] [--out <out>]"
generated-by: context-gate
source-hash: 868b50213a38bf90
---
!`if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then set -- node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"; else set -- npx --no-install context-gate; fi; "$@" run research --args '$ARGUMENTS' --ctx-from live`

<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/research.json. Якщо рядок вище не виконався (harness без підтримки !`…`), виконай: npx context-gate run research --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->
