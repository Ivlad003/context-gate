#!/usr/bin/env bash
# End-to-end check (SPEC "Тести": «claude --plugin-dir ./context-gate на еталонному репозиторії … де
# context-report-подібний хук на prompt.context підтверджує, що правила справді дійшли до моделі»).
#
# Copies examples/reference to a temp dir and plants a unique code word in each delivery path:
#   - every Always rule (.cursor/rules/*.mdc with alwaysApply: true)  → prompt.context
#   - the Auto Attached rule $E2E_AUTO (api-conventions; its globs match $E2E_READ) → tool.call Read context
#   - the Manual rule $E2E_MANUAL (security-review), mentioned as @<id>            → prompt.submit context
#   - a Markdown DSL section .claude/prompt/cg-e2e.md                               → prompt.compose section
#   - the first static section of the first compiled prompt (.compiled/*.json)     → prompt.compose section
# examples/basic: E2E_READ=src/util.ts E2E_AUTO=typescript E2E_MANUAL=release scripts/e2e.sh --repo examples/basic
# Then runs ONE `claude -p` turn with context-gate and the probe plugin (probe/context-gate-probe), prompt
# prefixed with `[gate:frontend]`, and checks:
#   - every code word is in the answer (it can only be there if that path delivered it),
#   - the model never read .cursor/rules or .claude (stream-json tool uses),
#   - the `[gate:frontend]` prefix was stripped (the model reports what its message starts with) and the
#     journal (.claude/gate.log.jsonl, log.file on in the copy) records profile frontend,
#   - the probe's prompt.context sample (as before).
#
# Needs the claude CLI and credentials; makes one model call (model: $E2E_MODEL, default haiku).
# Skips (exit 0) when claude is absent.
#   scripts/e2e.sh [--keep] [--repo <dir>]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/examples/reference"
model="${E2E_MODEL:-haiku}"
read_file="${E2E_READ:-apps/api/src/users.controller.ts}"   # the file the model reads (created when missing)
auto_rule="${E2E_AUTO:-api-conventions}"                     # an Auto Attached rule whose globs match read_file
manual_rule="${E2E_MANUAL:-security-review}"                 # a Manual rule, mentioned as @<id>
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
rm -f "$work/.claude/probe.json" "$work/.claude/gate.log.jsonl"

word() { printf 'CG-E2E-%s-%s' "$1" "$RANDOM$RANDOM"; }
plant() { printf '\nКодове слово цього правила: %s\n' "$2" >> "$1"; }

# Always rules: a code word in each.
always=""
for f in "$work"/.cursor/rules/*.mdc; do
  if grep -qE '^alwaysApply:[[:space:]]*true[[:space:]]*$' "$f"; then
    m="$(word "ALWAYS-$(basename "$f" .mdc | tr 'a-z' 'A-Z')")"; plant "$f" "$m"; always+="$m "
  fi
done
auto=""; manual=""; section=""; compiled=""
if [[ ! -f "$work/$read_file" ]]; then mkdir -p "$(dirname "$work/$read_file")"; printf 'export const answer = 42\n' > "$work/$read_file"; fi
if [[ -f "$work/.cursor/rules/$auto_rule.mdc" ]]; then auto="$(word AUTO)"; plant "$work/.cursor/rules/$auto_rule.mdc" "$auto"; fi
if [[ -f "$work/.cursor/rules/$manual_rule.mdc" ]]; then manual="$(word MANUAL)"; plant "$work/.cursor/rules/$manual_rule.mdc" "$manual"; fi
first_compiled="$(ls "$work"/.claude/prompt/.compiled/*.json 2>/dev/null | head -1 || true)"
if [[ -n "$first_compiled" ]]; then
  compiled="$(word COMPILED)"
  node -e 'const [f,w]=process.argv.slice(1),fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));const s=(c.sections||[]).find((x)=>x.scope==="static"&&!x.when);if(!s)process.exit(3);s.children=[...(s.children||[]),{t:"text",value:`\nКодове слово скомпільованої секції: ${w}\n`}];fs.writeFileSync(f,JSON.stringify(c))' "$first_compiled" "$compiled" || compiled=""
fi
if [[ -d "$work/.claude/prompt" ]]; then
  section="$(word SECTION)"
  printf -- '---\nid: cg-e2e\nscope: static\n---\nКодове слово секції системного промпту: %s\n' "$section" > "$work/.claude/prompt/cg-e2e.md"
fi
# The journal file, so the applied profile can be checked after the run.
if [[ -f "$work/.claude/gate.json" ]]; then
  node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.log={...(c.log||{}),file:true};fs.writeFileSync(f,JSON.stringify(c,null,2))' "$work/.claude/gate.json"
fi
( cd "$work" && git init -q && git add -A && git -c user.email=e2e@local -c user.name=e2e commit -qm init ) >/dev/null

prompt="[gate:frontend] @$manual_rule Прочитай $read_file інструментом Read і одним реченням скажи, що він робить. Не читай файлів у .cursor/ і .claude/.
Потім:
1) перелічи ВСІ кодові слова виду CG-E2E-… , які ти бачиш у своєму контексті (системний промпт, правила проєкту, результати інструментів, нотатки до мого повідомлення), кожне з нового рядка;
2) окремим рядком напиши PREFIX:YES, якщо моє повідомлення, як ти його отримав, починається з квадратної дужки «[», інакше PREFIX:NO."

echo "e2e: $work (model $model)"
( cd "$work" && unset CONTEXT_GATE_PROBE_OUT && claude -p --model "$model" --output-format stream-json --verbose \
    --plugin-dir "$root" --plugin-dir "$root/probe/context-gate-probe" "$prompt" ) > "$work/e2e.jsonl" 2> "$work/e2e.err" || {
  tail -20 "$work/e2e.err"; tail -5 "$work/e2e.jsonl"; echo "claude -p failed" >&2; exit 1; }

node - "$work" "$always" "$auto" "$manual" "$section" "$compiled" <<'JS'
const fs = require('fs'), path = require('path')
const [work, always, auto, manual, section, compiled] = process.argv.slice(2)
const lines = fs.readFileSync(path.join(work, 'e2e.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } })
const result = lines.filter((l) => l.type === 'result').pop()
const answer = result?.result ?? ''
fs.writeFileSync(path.join(work, 'e2e.out'), answer)
const toolUses = lines.filter((l) => l.type === 'assistant').flatMap((l) => l.message?.content ?? []).filter((b) => b.type === 'tool_use')
const touched = toolUses.map((b) => `${b.name}(${b.input?.file_path ?? b.input?.pattern ?? b.input?.command ?? ''})`)
let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
console.log(`tool uses: ${touched.join(', ') || '—'}`)
const peeked = toolUses.some((b) => /\.cursor\/|\.claude\//.test(JSON.stringify(b.input ?? {})))
check(!peeked, 'the model did not read .cursor/ or .claude/ (the code words came through context-gate)')
for (const m of always.split(' ').filter(Boolean)) check(answer.includes(m), `Always rule delivered (prompt.context): ${m}`)
if (auto) check(answer.includes(auto), `Auto Attached rule after Read (tool.call context): ${auto}`)
if (manual) check(answer.includes(manual), `@mention Manual rule (prompt.submit context): ${manual}`)
if (section) check(answer.includes(section), `Markdown DSL section (prompt.compose): ${section}`)
if (compiled) check(answer.includes(compiled), `compiled DSL section (prompt.compose): ${compiled}`)
check(/PREFIX:NO/.test(answer) && !/PREFIX:YES/.test(answer), '[gate:frontend] prefix stripped before the model')
const logFile = path.join(work, '.claude', 'gate.log.jsonl')
const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
check(log.some((e) => e.profile === 'frontend'), `journal records profile frontend (${log.length} entries)`)
const probeFile = path.join(work, '.claude', 'probe.json')
if (fs.existsSync(probeFile)) {
  const report = JSON.parse(fs.readFileSync(probeFile, 'utf8'))
  const samples = (report.points?.prompt_context_subagent?.samples ?? []).filter((s) => s.kind === 'prompt.context')
  const compose = (report.points?.prompt_compose_print?.samples ?? [])
  console.log(`probe: prompt.context fired ${samples.length}x; prompt.compose traits ${JSON.stringify([...new Set(compose.flatMap((s) => s.traits ?? []))])}`)
} else console.log('probe: no .claude/probe.json (the probe plugin did not load)')
console.log(`answer:\n${answer}`)
process.exit(failed ? 1 : 0)
JS
