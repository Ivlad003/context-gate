// Pure logic of the VS Code preview panel (SPEC "Автономний інтерпретатор": live preview =
// `context-gate run --only <id> --json --dry-scripts`). No `vscode` import: tested with node:test.

import { type PreviewState, type RunView } from '../../../packages/lsp/src/runcli.ts'
export { buildRunArgs, cliArgv, invalidRunState, parseRunOutput, runCli, SAFE_ID, type PreviewState, type RunView } from '../../../packages/lsp/src/runcli.ts'

export interface PreviewOptions {
  tiers: string[]
  profiles: string[]
  ctxFrom: string[]
}

/** Section id at an offset: the enclosing `<Section id="…">` (TSX) or the `id:` frontmatter / file name (Markdown). */
export function sectionIdAt(text: string, offset: number, fileName: string): string | undefined {
  if (/\.md$/.test(fileName)) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    const id = fm && /^id:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fm[1]!)
    if (id) return id[1]
    return fileName.split(/[\\/]/).pop()!.replace(/\.md$/, '').replace(/\.(premium|standard|quick)$/, '')
  }
  const re = /<Section\b[^>]*?\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/g
  let best: string | undefined
  let first: string | undefined
  for (const m of text.matchAll(re)) {
    const id = m[1] ?? m[2] ?? m[3]!
    first ??= id
    if (m.index! <= offset) {
      const close = text.indexOf('</Section>', m.index!)
      const selfClose = /^[^>]*\/>/.test(text.slice(m.index!))
      if (selfClose ? false : close < 0 || close >= offset) best = id
    }
  }
  return best ?? first
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const opt = (values: string[], cur: string | undefined, emptyLabel: string): string =>
  [`<option value="">${escapeHtml(emptyLabel)}</option>`, ...values.map((v) => `<option value="${escapeHtml(v)}"${v === cur ? ' selected' : ''}>${escapeHtml(v)}</option>`)].join('')

/** The webview page. Messages to the extension: refresh {tier, profile, ctxFrom}, runScripts, reveal {line}. */
export function renderPreviewHtml(view: RunView | undefined, state: PreviewState, options: PreviewOptions, env: { nonce: string; cspSource: string; busy?: boolean; dryScripts?: boolean }): string {
  const sec = view?.sections.find((s) => s.id === state.section) ?? view?.sections[0]
  const tokens = sec?.tokens ?? (view ? Math.ceil(view.text.length / 4) : 0)
  // Every field of the CLI's JSON is escaped, numbers included: the JSON is data, not trusted markup.
  const e = (v: unknown): string => escapeHtml(String(v ?? ''))
  const diag = (view?.diagnostics ?? []).map((d) => `<li class="${e(d.severity)}"><b>${e(d.code)}</b> ${e(d.message)}${d.line ? ` <a href="#" data-line="${e(d.line)}">:${e(d.line)}</a>` : ''}</li>`).join('')
  const rows = (view?.trace ?? []).map((t) => `<tr${t.line ? ` data-line="${e(t.line)}" class="link"` : ''}><td>${e(t.section)}</td><td>${e(t.kind)}</td><td>${e(t.detail)}</td><td>${e(t.ms)}</td><td>${e(t.source)}</td></tr>`).join('')
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${env.cspSource} 'unsafe-inline'; script-src 'nonce-${env.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>context-gate: ${escapeHtml(state.section)}</title>
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 12px; }
header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-editor-background); }
select, input, button { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 6px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
button.warn { background: var(--vscode-inputValidation-warningBackground, #b58900); }
pre { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 90%; } td, th { border-bottom: 1px solid var(--vscode-panel-border); padding: 2px 6px; text-align: left; vertical-align: top; }
tr.link { cursor: pointer; } tr.link:hover { background: var(--vscode-list-hoverBackground); }
.error { color: var(--vscode-errorForeground); } .warning { color: var(--vscode-editorWarning-foreground); }
.meta { opacity: .8; }
</style></head><body>
<header>
  <b>${escapeHtml(state.section)}</b>
  <label>tier <select id="tier">${opt(options.tiers, state.tier, 'за моделлю')}</select></label>
  <label>profile <select id="profile">${opt(options.profiles, state.profile, 'авто')}</select></label>
  <label>ctx-from <input id="ctxFrom" list="ctxList" value="${escapeHtml(state.ctxFrom ?? '')}" placeholder="живий репозиторій"><datalist id="ctxList">${options.ctxFrom.map((c) => `<option value="${escapeHtml(c)}">`).join('')}</datalist></label>
  <button id="refresh">Оновити</button>
  <button id="run" class="warn" title="Одноразово без --dry-scripts, після підтвердження">виконати скрипти</button>
  <span class="meta">${env.busy ? 'рендер…' : view ? `${tokens} ток.${view.ms !== undefined ? ` · ${view.ms} мс` : ''}${sec && sec.included === false ? ` · не увійшла: ${escapeHtml(sec.reason ?? '')}` : ''}${env.dryScripts === false ? ' · скрипти виконано' : ' · dry-scripts'}` : ''}</span>
</header>
${view?.error ? `<pre class="error">${escapeHtml(view.error)}</pre>` : ''}
${diag ? `<ul>${diag}</ul>` : ''}
<h3>Промпт</h3>
<pre id="text">${escapeHtml(sec?.text ?? view?.text ?? '')}</pre>
<h3>Trace</h3>
<table><thead><tr><th>секція</th><th>вид</th><th>деталі</th><th>мс</th><th>джерело</th></tr></thead><tbody>${rows}</tbody></table>
<script nonce="${env.nonce}">
const vscode = acquireVsCodeApi();
const val = (id) => document.getElementById(id).value;
const state = () => ({ tier: val('tier'), profile: val('profile'), ctxFrom: val('ctxFrom') });
document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh', ...state() });
document.getElementById('run').onclick = () => vscode.postMessage({ type: 'runScripts', ...state() });
for (const id of ['tier', 'profile']) document.getElementById(id).onchange = () => vscode.postMessage({ type: 'refresh', ...state() });
document.getElementById('ctxFrom').onchange = () => vscode.postMessage({ type: 'refresh', ...state() });
document.body.addEventListener('click', (e) => { const el = e.target.closest('[data-line]'); if (el) { e.preventDefault(); vscode.postMessage({ type: 'reveal', line: Number(el.dataset.line) }); } });
</script>
</body></html>`
}

/** Preview options from gate.json (tiers, profiles) plus fixture files for `--ctx-from`. */
export function previewOptions(config: { tiers?: Record<string, unknown>; profiles?: Record<string, unknown> } | undefined, fixtures: string[] = []): PreviewOptions {
  return { tiers: Object.keys(config?.tiers ?? {}), profiles: Object.keys(config?.profiles ?? {}), ctxFrom: ['session:latest', ...fixtures] }
}
