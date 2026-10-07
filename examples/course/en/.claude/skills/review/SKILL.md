---
name: review
description: "Project review with a chosen focus; findings are ranked and every one has a proof. Example: /review --focus bugs"
argument-hint: "[--focus bugs|architecture|docs|security] [--paths <paths,…>] [--out <out>]"
generated-by: context-gate
source-hash: 823dbe0c6fc006c6
---
!`if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then set -- node "$CLAUDE_PLUGIN_ROOT/dist/cli.js"; else set -- npx --no-install context-gate; fi; "$@" run review --args '$ARGUMENTS' --ctx-from live`

<!-- context-gate: тіло цього skill рендериться в момент виклику з .claude/prompt/.compiled/review.json. Якщо рядок вище не виконався (harness без підтримки !`…`), виконай: npx context-gate run review --args "<аргументи>" — і використай його вивід як інструкцію. Файл згенеровано, не редагуй вручну. -->
