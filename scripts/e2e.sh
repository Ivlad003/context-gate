#!/usr/bin/env bash
# End-to-end check (SPEC "Тести": «claude --plugin-dir ./context-gate на еталонному репозиторії … де
# context-report-подібний хук на prompt.context підтверджує, що правила справді дійшли до моделі»).
#
# Copies examples/reference to a temp dir, runs one `claude -p` turn with context-gate and the probe plugin
# (probe/context-gate-probe), then reads <copy>/.claude/probe.json and checks that every Always rule of the
# reference repo is in what prompt.context returned (instruction files, or the cursorRules fallback block).
#
# Needs the claude CLI and credentials; makes one model call. Skips (exit 0) when claude is absent.
#   scripts/e2e.sh [--keep] [--repo <dir>]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/examples/reference"
keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) keep=1 ;;
    --repo) src="$(cd "$2" && pwd)"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

if ! command -v claude >/dev/null 2>&1; then echo "claude CLI not found: skipping e2e"; exit 0; fi
[[ -f "$root/dist/cli.js" ]] || { echo "dist/cli.js missing: run npm run build" >&2; exit 1; }
[[ -d "$src/.cursor/rules" ]] || { echo "no .cursor/rules in $src" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/context-gate-e2e.XXXXXX")"
[[ $keep -eq 1 ]] || trap 'rm -rf "$work"' EXIT
cp -r "$src/." "$work/"
rm -f "$work/.claude/probe.json"
# A unique code word in every Always rule of the copy: the answer can only contain it if the rule reached the model.
markers=""
for f in "$work"/.cursor/rules/*.mdc; do
  if grep -qE '^alwaysApply:[[:space:]]*true[[:space:]]*$' "$f"; then
    m="CG-E2E-$(basename "$f" .mdc | tr 'a-z' 'A-Z')-$RANDOM"
    printf '\nКодове слово цього правила: %s\n' "$m" >> "$f"
    markers+="$m "
  fi
done
( cd "$work" && git init -q && git add -A && git -c user.email=e2e@local -c user.name=e2e commit -qm init ) >/dev/null

echo "e2e: $work"
( cd "$work" && unset CONTEXT_GATE_PROBE_OUT && claude -p \
    --plugin-dir "$root" --plugin-dir "$root/probe/context-gate-probe" \
    "Прочитай apps/api/src/users.controller.ts і одним реченням скажи, що він робить. Потім перелічи всі кодові слова (CG-E2E-…) з правил проєкту, які ти бачиш у своєму контексті, не читаючи файлів .cursor/rules." ) > "$work/e2e.out" 2>&1 || {
  cat "$work/e2e.out"; echo "claude -p failed" >&2; exit 1; }

probe="$work/.claude/probe.json"
[[ -f "$probe" ]] || { cat "$work/e2e.out"; echo "no $probe: the probe plugin did not load" >&2; exit 1; }

missing_words=""
for m in $markers; do grep -qF "$m" "$work/e2e.out" || missing_words+="$m "; done

node - "$work" "$probe" "$missing_words" <<'JS'
const fs = require('fs'), path = require('path')
const [work, probeFile, missingWords] = process.argv.slice(2)
const rulesDir = path.join(work, '.cursor', 'rules')
const always = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.mdc'))
  .filter((f) => /^alwaysApply:\s*true\s*$/m.test(fs.readFileSync(path.join(rulesDir, f), 'utf8')))
  .map((f) => f.replace(/\.mdc$/, ''))
const report = JSON.parse(fs.readFileSync(probeFile, 'utf8'))
const samples = (report.points?.prompt_context_subagent?.samples ?? []).filter((s) => s.kind === 'prompt.context')
if (!samples.length) { console.error('prompt.context never fired'); process.exit(1) }
const files = samples.flatMap((s) => (s.resultInstructionFiles ?? []).map((f) => f.path))
const block = samples.some((s) => s.hasCursorRulesBlock)
const missing = always.filter((id) => !files.some((p) => p.endsWith(`${id}.mdc`)))
console.log(`Always rules: ${always.join(', ') || '—'}`)
console.log(`instruction files returned: ${files.join(', ') || '—'}; cursorRules block: ${block}`)
// The probe sees the result of the plugins below it only, so an empty list is not a failure by itself (plugin order);
// the code words in the answer are the proof that the rules reached the model.
if (missing.length && !block) console.log(`probe: not in the prompt.context result it saw (plugin order?): ${missing.join(', ')}`)
if (missingWords.trim()) { console.error(`the model did not see the Always rules: missing code words ${missingWords.trim()}`); process.exit(1) }
console.log('ok: every Always rule reached the model (code words in the answer)')
JS
