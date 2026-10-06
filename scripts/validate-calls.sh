#!/usr/bin/env bash
# Release check (SPEC "Валідація перед релізом"): `claude plugin validate --strict` must show only the
# expected `$` calls. Compares its `calls:` line with scripts/expected-calls.txt and fails on any call that is
# not listed. Skips (exit 0) when the claude CLI is absent.
#
#   scripts/validate-calls.sh                 check the plugin at the repo root
#   scripts/validate-calls.sh --exact         also fail when a listed exact call is no longer made
#   scripts/validate-calls.sh --markdown      print the hooks:/calls: tables for README.md and exit
#   scripts/validate-calls.sh --from <file>   read saved validate output instead of running claude
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
expected="$root/scripts/expected-calls.txt"
exact=0 markdown=0 from=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --exact) exact=1 ;;
    --markdown) markdown=1 ;;
    --from) from="$2"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ -n "$from" ]]; then
  out="$(cat "$from")"
else
  if ! command -v claude >/dev/null 2>&1; then
    echo "claude CLI not found: skipping the validate call-list check"
    exit 0
  fi
  out="$(cd "$root" && claude plugin validate --strict . 2>&1)" || { echo "$out"; echo "claude plugin validate --strict failed" >&2; exit 1; }
fi

# `❯ ./register.ts calls: $.a.b (via port), $.c.d, …` → one call per line, without the `(via …)` note.
calls="$(printf '%s\n' "$out" | sed -n 's/^.*register\.ts calls: //p' | tr ',' '\n' | sed -e 's/([^)]*)//g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^$' | sort -u || true)"
# Hooks: split at top-level ", " only (matchers like `{component=Pane, requestId=?}` hold commas); keep order, drop repeats.
hooks="$(printf '%s\n' "$out" | sed -n 's/^.*register\.ts hooks: //p' | awk '{
  depth = 0; cur = ""
  for (i = 1; i <= length($0); i++) {
    ch = substr($0, i, 1)
    if (ch == "{") depth++
    if (ch == "}") depth--
    if (ch == "," && depth == 0) { print cur; cur = ""; i++; continue }
    cur = cur ch
  }
  if (cur != "") print cur
}' | awk '!seen[$0]++' || true)"

if [[ -z "$calls" ]]; then
  echo "no 'calls:' line in the validate output" >&2
  exit 1
fi

if [[ $markdown -eq 1 ]]; then
  echo '| hook (event{matcher}) |'
  echo '| --- |'
  printf '%s\n' "$hooks" | sed 's/|/\\|/g; s/^/| `/; s/$/` |/'
  echo
  echo '| `$` call |'
  echo '| --- |'
  printf '%s\n' "$calls" | sed 's/^/| `/; s/$/` |/'
  exit 0
fi

patterns="$(grep -v '^[[:space:]]*#' "$expected" | sed -e 's/[[:space:]]*$//' | grep -v '^$')"
allowed() {
  local c="$1" p
  while IFS= read -r p; do
    if [[ "$p" == *'.*' ]]; then [[ "$c" == "${p%\*}"* ]] && return 0
    else [[ "$c" == "$p" ]] && return 0
    fi
  done <<< "$patterns"
  return 1
}

bad=0
while IFS= read -r c; do
  if ! allowed "$c"; then echo "unexpected call: $c (add it to scripts/expected-calls.txt only if it is intended)" >&2; bad=1; fi
done <<< "$calls"

missing=""
while IFS= read -r p; do
  [[ "$p" == *'.*' ]] && continue
  grep -qxF "$p" <<< "$calls" || missing+="$p "
done <<< "$patterns"
if [[ -n "$missing" ]]; then
  echo "listed but not called (ok unless --exact): $missing"
  [[ $exact -eq 1 ]] && bad=1
fi

n="$(printf '%s\n' "$calls" | wc -l | tr -d ' ')"
if [[ $bad -eq 0 ]]; then echo "ok: $n calls, all in scripts/expected-calls.txt"; fi
exit $bad
