// `/gate edit <id>`: the browser editor (packages/editor-web, SPEC "Редактор DSL — Клієнти") started with
// `$.process.spawn`. The editor prints one JSON line `{"url": …}`; the spawn loop keeps running in the
// background for the session (leaving it, or the module unloading, kills the child), one editor per id.

import { type Io, type Runtime, debug, join, now } from '../ctx.ts'

const START_MS = 15_000

interface Editor { id: string; url?: string; stop: () => void }

const editors = new WeakMap<Runtime, Map<string, Editor>>()

function running(rt: Runtime): Map<string, Editor> {
  let m = editors.get(rt)
  if (!m) { m = new Map(); editors.set(rt, m) }
  return m
}

/** argv of the editor: the bundled `dist/editor-web.js`, else the TypeScript source (Node type stripping). */
export async function editorArgv(io: Io, root: string, id: string): Promise<string[] | undefined> {
  const base = join(io.plugin.root, 'packages/editor-web')
  const tail = [id, '--root', root, '--json', '--no-stdin-watch']
  if (await io.fs.exists(`${base}/dist/editor-web.js`).catch(() => false)) return ['node', `${base}/dist/editor-web.js`, ...tail]
  if (await io.fs.exists(`${base}/src/main.ts`).catch(() => false)) return ['node', '--experimental-strip-types', '--no-warnings', `${base}/src/main.ts`, ...tail]
  return undefined
}

/** The `{"url": …}` line in the editor's stdout (leading log lines are skipped). */
export function parseEditorUrl(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const v = JSON.parse(t) as { url?: unknown }
      if (typeof v.url === 'string' && /^https?:\/\//.test(v.url)) return v.url
    } catch { /* not the JSON line yet */ }
  }
  return undefined
}

/** Starts (or reuses) the editor for `id` and resolves its URL, or an error text in Ukrainian. */
export async function openEditor(io: Io, rt: Runtime, id: string): Promise<{ url: string } | { error: string }> {
  const live = running(rt).get(id)
  if (live?.url) return { url: live.url }
  const spawn = io.process.spawn
  if (!spawn) return { error: 'Редактор недоступний: цей хост не має $.process.spawn' }
  const argv = await editorArgv(io, rt.root, id)
  if (!argv) return { error: `Редактор не знайдено в ${join(io.plugin.root, 'packages/editor-web')}` }
  let stream: ReturnType<typeof spawn>
  try {
    stream = spawn({ argv, cwd: rt.root })
  } catch (err) {
    return { error: `Не вдалося запустити редактор: ${String((err as Error)?.message ?? err)}` }
  }
  const ed: Editor = { id, stop: () => { void stream.return(undefined as never).catch(() => undefined) } }
  running(rt).set(id, ed)
  return new Promise((resolve) => {
    let done = false
    const finish = (r: { url: string } | { error: string }): void => {
      if (done) return
      done = true
      if ('error' in r) running(rt).delete(id)
      resolve(r)
    }
    const started = now()
    try {
      io.clock.after(START_MS, () => {
        // A clock that fires early (a test kit) is no timeout.
        if (done || now() - started < START_MS - 1000) return
        ed.stop()
        finish({ error: `Редактор не відповів за ${START_MS / 1000} с` })
      })
    } catch { /* no clock: rely on the stream */ }
    void (async () => {
      let out = ''
      let err = ''
      try {
        for await (const chunk of stream) {
          if (chunk.stream === 'stdout') {
            out += chunk.text
            const url = ed.url ?? parseEditorUrl(out)
            if (url && !ed.url) { ed.url = url; finish({ url }) }
            if (out.length > 64_000) out = out.slice(-8_000)
          } else {
            err = (err + chunk.text).slice(-2_000)
          }
        }
        const r = await stream.result.catch(() => undefined)
        finish({ error: `Редактор завершився (код ${r?.code ?? '?'})${err.trim() ? `: ${err.trim().split('\n').slice(-3).join(' ')}` : ''}` })
      } catch (e) {
        finish({ error: `Не вдалося запустити редактор: ${String((e as Error)?.message ?? e)}` })
      } finally {
        running(rt).delete(id)
        debug(io, `editor ${id} stopped`)
      }
    })()
  })
}

/** Ids of editors running in this session. */
export function editorsRunning(rt: Runtime): string[] {
  return [...running(rt).values()].filter((e) => e.url).map((e) => e.id)
}
