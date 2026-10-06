// Builds the extension (dist/extension.cjs) and bundles the tsserver plugin into
// node_modules/@context-gate/lsp, where `typescriptServerPlugins` resolves it from.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = join(here, '..', '..')

await build({
  entryPoints: [join(here, 'src/extension.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node18',
  outfile: join(here, 'dist/extension.cjs'), external: ['vscode'],
})

const pluginDir = join(here, 'node_modules/@context-gate/lsp')
mkdirSync(pluginDir, { recursive: true })
await build({
  entryPoints: [join(repo, 'packages/lsp/src/index.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node18',
  outfile: join(pluginDir, 'index.cjs'), external: ['typescript'],
  footer: { js: 'module.exports = Object.assign(module.exports.default, module.exports);' },
})
writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: '@context-gate/lsp', version: '0.1.0', main: 'index.cjs' }, null, 2) + '\n')
console.log('built dist/extension.cjs and node_modules/@context-gate/lsp')
