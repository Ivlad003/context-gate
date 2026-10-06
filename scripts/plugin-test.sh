#!/usr/bin/env bash
# Run `claude plugin test` on the mod alone.
# `claude plugin test <dir>` runs every *.test.ts / *.test.tsx under <dir>
# (it skips node_modules/ and dot-directories, and ignores .gitignore), so at the
# repo root it would also load test/*.test.ts, the node:test suite, which cannot
# import "node:test" in the mod runtime. This stages just the plugin's runtime
# files into a temp folder and runs the mod tests there.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/context-gate-plugin-test.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/packages/core"
cp -r "$root/.claude-plugin" "$root/hooks" "$root/types" "$stage/"
rm -rf "$stage/.claude-plugin/types"
[[ -d "$root/packages/core/src" ]] && cp -r "$root/packages/core/src" "$stage/packages/core/src"
claude plugin test "$stage" "$@"
