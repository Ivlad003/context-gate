#!/usr/bin/env bash
# Non-interactive part of the probe (docs/PROBE.md point 8): one `claude -p` turn with the probe loaded,
# so prompt.compose reports its traits under print mode. Writes <repo>/.claude/probe.print.json, leaving the
# interactive run's probe.json alone. Usage: probe/run-print.sh [test-repo]   (default: examples/basic)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
plugin="$here/context-gate-probe"
repo="${1:-$here/../examples/basic}"
if ! command -v claude >/dev/null 2>&1; then
  echo "run-print: claude CLI not found; skipping" >&2
  exit 0
fi
repo="$(cd "$repo" && pwd)"
mkdir -p "$repo/.claude"
cd "$repo"
CONTEXT_GATE_PROBE_OUT=probe.print.json claude -p --plugin-dir "$plugin" "say hi"
out="$repo/.claude/probe.print.json"
if [[ -f "$out" ]]; then
  echo "run-print: wrote $out"
else
  echo "run-print: no $out (the probe did not load, or fs.write was refused; rerun with --debug)" >&2
  exit 1
fi
