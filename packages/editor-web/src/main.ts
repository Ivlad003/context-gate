// Entry of the browser editor: `node packages/editor-web/src/main.ts <id> [--root .] [--port 0] [--cli "npx context-gate"]`.
// `/gate edit <id>` spawns it with `$.process.spawn` and shows the printed URL. Prints one JSON line
// `{"url": …}` with --json (for the mod), else a human line. Stops on SIGINT/SIGTERM or stdin close.

import { pathToFileURL } from 'node:url'
import { startEditorServer } from './server.ts'

export interface MainArgs { id?: string; root: string; port: number; cli?: string; json: boolean; help: boolean }

export function parseMainArgs(argv: string[]): MainArgs {
  const out: MainArgs = { root: process.cwd(), port: 0, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${a}: потрібне значення`); return v }
    if (a === '--root') out.root = next()
    else if (a === '--port') out.port = Number(next())
    else if (a === '--cli') out.cli = next()
    else if (a === '--json') out.json = true
    else if (a === '-h' || a === '--help') out.help = true
    else if (!a.startsWith('-') && !out.id) out.id = a
    else throw new Error(`Невідомий аргумент ${a}`)
  }
  return out
}

const USAGE = 'Використання: context-gate-edit <id> [--root <шлях>] [--port <n>] [--cli "<команда>"] [--json]'

export async function main(argv: string[]): Promise<number> {
  let args: MainArgs
  try { args = parseMainArgs(argv) } catch (e) { process.stderr.write(`${(e as Error).message}\n${USAGE}\n`); return 2 }
  if (args.help || !args.id) { process.stdout.write(USAGE + '\n'); return args.help ? 0 : 2 }
  const srv = await startEditorServer({ root: args.root, id: args.id, port: args.port, ...(args.cli ? { cli: args.cli } : {}) })
  process.stdout.write(args.json ? JSON.stringify({ url: srv.url, port: srv.port, file: srv.file }) + '\n' : `context-gate edit: ${srv.file}\n${srv.url}\n`)
  await new Promise<void>((done) => {
    const stop = (): void => { void srv.close().then(done) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    // Spawned by the mod (--json): exit when the parent closes our stdin.
    if (args.json && !process.stdin.isTTY) { process.stdin.resume(); process.stdin.once('end', stop) }
  })
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`${(e as Error).stack ?? e}\n`); process.exit(1) })
}
