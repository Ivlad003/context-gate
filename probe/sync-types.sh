#!/usr/bin/env bash
# Copy the mods API declarations (module 'claude-code') to context-gate-probe/hooks/.types/ for tsc.
# Mirrors scripts/sync-mod-types.sh. Source, first found:
#   1. $CLAUDE_CODE_DTS (explicit path)
#   2. context-gate-probe/.claude-plugin/types/claude-code/index.d.ts (written by the engine when it
#      loads the probe via --plugin-dir)
#   3. the newest plugin-authoring skill copy under ${TMPDIR:-/tmp}/claude-*/bundled-skills/
# Then: npx tsc -p probe/context-gate-probe/hooks/tsconfig.json
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
plugin="$here/context-gate-probe"
out="$plugin/hooks/.types"
src="${CLAUDE_CODE_DTS:-}"
if [[ -z "$src" && -f "$plugin/.claude-plugin/types/claude-code/index.d.ts" ]]; then
  src="$plugin/.claude-plugin/types/claude-code/index.d.ts"
fi
if [[ -z "$src" ]]; then
  src="$(ls -t "${TMPDIR:-/tmp}"/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1 || true)"
fi
if [[ -z "$src" || ! -f "$src" ]]; then
  echo "sync-types: no claude-code.d.ts found; run 'claude --plugin-dir $plugin' once or set CLAUDE_CODE_DTS" >&2
  exit 1
fi
mkdir -p "$out"
cp "$src" "$out/claude-code.d.ts"
echo "sync-types: $(head -1 "$out/claude-code.d.ts") <- $src"
