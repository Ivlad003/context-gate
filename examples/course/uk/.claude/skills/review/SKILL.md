---
name: review
description: "Ревю проєкту з вибраним фокусом; знахідки впорядковані, кожна має доказ. Приклад: /review --focus bugs"
argument-hint: "[--focus bugs|architecture|docs|security] [--paths <paths,…>] [--out <out>]"
generated-by: context-gate
source-hash: 17b2c6ad0d3d7989
---
!`if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then set -- node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"; else set -- npx --no-install context-gate; fi; "$@" run review --args '$ARGUMENTS' --ctx-from live`

<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/review.json. Якщо рядок вище не виконався (harness без підтримки !`…`), виконай: npx context-gate run review --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->
