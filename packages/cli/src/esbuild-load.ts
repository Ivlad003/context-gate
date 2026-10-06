// Lazy esbuild (G-61): the installed plugin ships only `dist/cli.js`, without `node_modules`, so a static
// `import 'esbuild'` would break every command, `run` and the SKILL.md render included. Only `build` and module
// providers need esbuild; they load it here from the CLI's own node_modules, else from the repository's.

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

type Esbuild = typeof import('esbuild')

let cached: Esbuild | undefined

/** esbuild from the CLI package, else from `<root>/node_modules`; throws an Error with a hint when absent. */
export async function loadEsbuild(root?: string): Promise<Esbuild> {
  if (cached) return cached
  try {
    cached = (await import('esbuild')) as Esbuild
    return cached
  } catch { /* not next to the CLI (installed plugin) */ }
  if (root) {
    try {
      const path = createRequire(join(root, 'package.json')).resolve('esbuild')
      const m = (await import(pathToFileURL(path).href)) as Partial<Esbuild> & { default?: Esbuild }
      cached = (typeof m.build === 'function' ? m : m.default) as Esbuild
      return cached
    } catch { /* not in the repo either */ }
  }
  throw new Error('esbuild не знайдено: збірка TSX потребує його. Встанови в репозиторії (npm i -D esbuild) або в плагіні (npm --prefix "${CLAUDE_PLUGIN_ROOT}" ci --omit=dev); `npx context-gate` має його в залежностях')
}
