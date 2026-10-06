// Pure staleness helpers, importable from the mod adapter (no Node imports).

/**
 * Cheap check for `prompt.compose`: a compiled prompt is stale when it is missing or older than
 * its `.prompt.tsx` (or any import, if the caller passes the newest source mtime).
 */
export function isStaleByMtime(tsxMtimeMs: number, compiledMtimeMs: number | undefined): boolean {
  return compiledMtimeMs === undefined || !Number.isFinite(compiledMtimeMs) || tsxMtimeMs > compiledMtimeMs
}

/** Same check over several sources: the newest source decides. */
export function isStaleByMtimes(sourceMtimesMs: readonly number[], compiledMtimeMs: number | undefined): boolean {
  return isStaleByMtime(sourceMtimesMs.length ? Math.max(...sourceMtimesMs) : 0, compiledMtimeMs)
}
