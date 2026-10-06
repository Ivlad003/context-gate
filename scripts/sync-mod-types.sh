#!/usr/bin/env bash
# Copy the mods API declarations (module 'claude-code') to hooks/.types/ for tsc.
# Source, first found:
#   1. $CLAUDE_CODE_DTS (explicit path)
#   2. .claude-plugin/types/claude-code/index.d.ts (the engine writes it when it
#      loads this folder via --plugin-dir / CLAUDE_CODE_PLUGIN_DIRS)
#   3. the newest plugin-authoring skill copy under ${TMPDIR:-/tmp}/claude-*/bundled-skills/
# hooks/.types/ is gitignored; regenerate after a Claude Code update.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/hooks/.types"
src="${CLAUDE_CODE_DTS:-}"
if [[ -z "$src" && -f "$root/.claude-plugin/types/claude-code/index.d.ts" ]]; then
  src="$root/.claude-plugin/types/claude-code/index.d.ts"
fi
if [[ -z "$src" ]]; then
  src="$(ls -t "${TMPDIR:-/tmp}"/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1 || true)"
fi
if [[ -z "$src" || ! -f "$src" ]]; then
  echo "sync-mod-types: no claude-code.d.ts found; run 'claude --plugin-dir $root' once or set CLAUDE_CODE_DTS" >&2
  exit 1
fi
mkdir -p "$out"
cp "$src" "$out/claude-code.d.ts"
echo "sync-mod-types: $(head -1 "$out/claude-code.d.ts") <- $src"
