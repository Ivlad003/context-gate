// `npm run test:vscode`: the extension in a real VS Code (default /usr/bin/code, override VSCODE_EXECUTABLE)
// with an isolated profile — temp --user-data-dir and --extensions-dir, so nothing touches the user's VS Code.
// Workspace: a temp copy of examples/basic without the editor typings (tsconfig.json, .types/jsx/), i.e. a repo
// that only has the extension: the first build of the bundled CLI must write them. Assertions: test/suite.cjs.
import { runTests } from '@vscode/test-electron'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ext = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = join(ext, '..', '..')

// `--vsix <file>` (or CG_VSIX): run against the unpacked package instead of the source folder, i.e. exactly
// what `code --install-extension` installs (without esbuild/bin, with node_modules from `vsce package`).
const vsixArg = process.argv.indexOf('--vsix')
const vsix = vsixArg > 0 ? process.argv[vsixArg + 1] : process.env.CG_VSIX
if (!process.env.CG_SKIP_BUILD && !vsix) execFileSync(process.execPath, [join(ext, 'scripts/build.mjs')], { stdio: 'inherit' })

/** The Electron binary behind the `code` launcher script (the script itself detaches and exits at once). */
function electronOf(p) {
  const real = realpathSync(p)
  if (real.endsWith('/bin/code')) { const e = join(dirname(real), '..', 'code'); if (existsSync(e)) return e }
  return real
}

const tmp = mkdtempSync(join(tmpdir(), 'cg-vscode-'))
const ws = join(tmp, 'basic')
cpSync(join(repo, 'examples/basic'), ws, { recursive: true })
for (const p of ['.claude/prompt/tsconfig.json', '.claude/prompt/.types/jsx', '.claude/prompt/.compiled', '.claude/prompt/.trace']) rmSync(join(ws, p), { recursive: true, force: true })
const userData = join(tmp, 'user-data')
mkdirSync(join(userData, 'User'), { recursive: true })
writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'workbench.startupEditor': 'none',
  'workbench.enableExperiments': false,
  'chat.disableAIFeatures': true,
  'git.enabled': false,
  'typescript.tsserver.log': 'off',
  'typescript.disableAutomaticTypeAcquisition': true,
}, null, 2))
const report = join(tmp, 'report.json')
let devPath = ext
if (vsix) {
  execFileSync('unzip', ['-q', vsix, 'extension/*', '-d', join(tmp, 'vsix')])
  devPath = join(tmp, 'vsix', 'extension')
  console.log(`testing the packaged extension: ${vsix}`)
}

let code = 0
try {
  await runTests({
    vscodeExecutablePath: electronOf(process.env.VSCODE_EXECUTABLE ?? '/usr/bin/code'),
    extensionDevelopmentPath: devPath,
    extensionTestsPath: join(ext, 'test', 'suite.cjs'),
    extensionTestsEnv: { CG_WS: ws, CG_REPORT: report },
    launchArgs: [
      ws,
      '--user-data-dir', userData,
      '--extensions-dir', join(tmp, 'extensions'),
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates',
      '--disable-gpu', '--new-window',
    ],
  })
} catch (e) {
  console.error('VS Code tests failed:', e)
  code = 1
}
if (existsSync(report)) console.log(readFileSync(report, 'utf8'))
if (!process.env.CG_KEEP_TMP) rmSync(tmp, { recursive: true, force: true })
else console.log(`temp: ${tmp}`)
process.exit(code)
