// Builds everything the extension ships:
//   dist/extension.cjs                     the extension (vscode external)
//   node_modules/@context-gate/lsp         the tsserver plugin, where `typescriptServerPlugins` resolves it from
//   cli/dist/cli.js                        the bundled CLI (default when no cliPath / workspace CLI), plus what it
//   cli/packages/{jsx,core}/src            reads at run time: jsx/core sources for `build`, the jsx declarations
//   cli/dist/jsx-types                     copied into user repos (`.types/jsx/`), example skills
//   schema/context-gate.schema.json        for `jsonValidation` of .claude/gate.json
// esbuild is a runtime dependency of the extension (node_modules/esbuild): the bundled CLI loads it for `build`.
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = join(here, '..', '..')

// CommonJS has no import.meta: shared modules (cli transform.ts) get a file URL of the bundle instead.
const cjsMeta = { define: { 'import.meta.url': '__cgUrl' }, banner: { js: "const __cgUrl = require('url').pathToFileURL(__filename).href;" } }

await build({
  entryPoints: [join(here, 'src/extension.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', ...cjsMeta,
  outfile: join(here, 'dist/extension.cjs'), external: ['vscode', 'typescript'],
})

const pluginDir = join(here, 'node_modules/@context-gate/lsp')
mkdirSync(pluginDir, { recursive: true })
await build({
  entryPoints: [join(repo, 'packages/lsp/src/index.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', ...cjsMeta,
  outfile: join(pluginDir, 'index.cjs'), external: ['typescript'],
  footer: { js: 'module.exports = Object.assign(module.exports.default, module.exports);' },
})
writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: '@context-gate/lsp', version: '0.1.0', main: 'index.cjs' }, null, 2) + '\n')

// Bundled CLI: same options as the root `npm run build`, laid out like the installed plugin so that
// defaultJsxSrc() / jsxTypesDir() / pluginRoot() find their files relative to cli/dist/cli.js.
const cli = join(here, 'cli')
rmSync(cli, { recursive: true, force: true })
await build({
  entryPoints: [join(repo, 'packages/cli/src/main.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: join(cli, 'dist/cli.js'), external: ['esbuild'],
  banner: { js: '#!/usr/bin/env node' },
})
writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: 'context-gate-bundled-cli', private: true, type: 'module' }, null, 2) + '\n')
for (const d of ['packages/jsx/src', 'packages/core/src', 'examples/skills']) cpSync(join(repo, d), join(cli, d), { recursive: true })
execFileSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', join(repo, 'packages/jsx/tsconfig.build.json'), '--outDir', join(cli, 'dist/jsx-types')], { stdio: 'inherit' })

mkdirSync(join(here, 'schema'), { recursive: true })
cpSync(join(repo, 'schema/context-gate.schema.json'), join(here, 'schema/context-gate.schema.json'))
cpSync(join(repo, 'LICENSE'), join(here, 'LICENSE'))
console.log('built dist/extension.cjs, node_modules/@context-gate/lsp, cli/, schema/')
