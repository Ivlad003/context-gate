// The single HTML page of the browser editor. CodeMirror 6 comes from esm.sh at exact versions; if it cannot
// load (offline, or `cdn: false`), the page falls back to a plain <textarea> with the same save / preview / REPL panel.

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * CodeMirror modules, pinned: exact versions, and `deps` pins the shared @codemirror packages every module
 * imports (one instance of state/view). A floating `@6` would run whatever release esm.sh resolves next in the
 * page that holds the API token (M70). Bump the versions together.
 */
const CM_DEPS = 'deps=@codemirror/state@6.7.6,@codemirror/view@6.43.13,@codemirror/language@6.12.4,@codemirror/autocomplete@6.20.3,@codemirror/lint@6.9.7'
export const CODEMIRROR_URLS = [
  'codemirror@6.0.2', '@codemirror/view@6.43.13', '@codemirror/state@6.7.6', '@codemirror/autocomplete@6.20.3',
  '@codemirror/lint@6.9.7', '@codemirror/lang-javascript@6.2.5', '@codemirror/lang-markdown@6.5.2',
].map((m) => `https://esm.sh/${m}?${CM_DEPS}`)

export function editorPage(p: { token: string; file: string; id: string; section: string; nonce: string; cdn?: boolean }): string {
  const boot = JSON.stringify({ token: p.token, file: p.file, id: p.id, section: p.section, cm: p.cdn === false ? [] : CODEMIRROR_URLS }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>context-gate · ${esc(p.id)}</title>
<style>
:root { --bg:#fbfaf8; --fg:#1f2328; --muted:#6b7280; --line:#e5e3df; --panel:#f3f1ed; --accent:#2f6feb; --warn:#b45309; --err:#c2410c; }
@media (prefers-color-scheme: dark) { :root { --bg:#16181c; --fg:#e6e6e6; --muted:#9aa0a6; --line:#2c2f36; --panel:#1d2026; --accent:#6ea8fe; --warn:#f0b35a; --err:#ff8a65; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 system-ui, sans-serif; background:var(--bg); color:var(--fg); height:100vh; display:flex; flex-direction:column; }
header { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:8px 12px; border-bottom:1px solid var(--line); }
header b { font-family: ui-monospace, monospace; }
main { flex:1; display:grid; grid-template-columns: minmax(0,1.2fr) minmax(0,1fr); min-height:0; }
@media (max-width: 800px) { main { grid-template-columns: 1fr; grid-template-rows: 60vh auto; } }
#editor { min-height:0; overflow:auto; border-right:1px solid var(--line); }
#editor .cm-editor { height:100%; } #editor textarea { width:100%; height:100%; border:0; padding:12px; font:13px/1.5 ui-monospace, monospace; background:var(--bg); color:var(--fg); resize:none; }
aside { overflow:auto; padding:8px 12px; background:var(--panel); }
select, input, button { font:inherit; padding:3px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
button { cursor:pointer; } button.primary { background:var(--accent); color:#fff; border-color:var(--accent); } button.warn { border-color:var(--warn); color:var(--warn); }
pre { white-space:pre-wrap; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px; font:12.5px/1.5 ui-monospace, monospace; }
table { border-collapse:collapse; width:100%; font-size:12.5px; } td, th { border-bottom:1px solid var(--line); padding:2px 6px; text-align:left; vertical-align:top; }
tr[data-line] { cursor:pointer; } tr[data-line]:hover { background:var(--bg); }
.muted { color:var(--muted); } .error { color:var(--err); } .warning { color:var(--warn); }
h3 { margin:12px 0 4px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
#repl { display:flex; gap:6px; } #repl input { flex:1; font-family:ui-monospace, monospace; }
</style></head><body>
<header>
  <b id="fname">${esc(p.file)}</b><span id="dirty" class="muted"></span>
  <label>секція <input id="section" size="14" value="${esc(p.section)}"></label>
  <label>tier <select id="tier"><option value="">за моделлю</option></select></label>
  <label>profile <select id="profile"><option value="">авто</option></select></label>
  <label>ctx-from <input id="ctxFrom" size="14" placeholder="живий репозиторій" list="ctxList"><datalist id="ctxList"><option value="session:latest"></datalist></label>
  <button id="save" class="primary" title="Ctrl+S">Зберегти</button>
  <button id="refresh">Preview</button>
  <button id="run" class="warn">виконати скрипти</button>
  <span id="status" class="muted"></span>
</header>
<main>
  <div id="editor"></div>
  <aside>
    <ul id="diags"></ul>
    <h3>Промпт <span id="meta" class="muted"></span></h3>
    <pre id="text" class="muted">Збережи файл або натисни Preview.</pre>
    <h3>REPL</h3>
    <form id="repl"><input id="expr" placeholder='gate.tier == "quick"' autocomplete="off"><button>=</button></form>
    <pre id="replOut" class="muted">Вираз обчислюється тим самим інтерпретатором у контексті останнього trace.</pre>
    <h3>Trace</h3>
    <table><thead><tr><th>секція</th><th>вид</th><th>деталі</th><th>мс</th><th>джерело</th></tr></thead><tbody id="trace"></tbody></table>
  </aside>
</main>
<script nonce="${p.nonce}" type="module">
const BOOT = ${boot};
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-gate-token': BOOT.token, ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let etag = null, saved = '', getText = () => '', setDiagnostics = () => {}, gotoLine = () => {};
const status = (s, cls = 'muted') => { $('status').textContent = s; $('status').className = cls; };
const markDirty = () => { $('dirty').textContent = getText() !== saved ? ' ●' : ''; };
addEventListener('beforeunload', (e) => { if (getText() !== saved) e.preventDefault(); });

const file = await api('/api/file?path=' + encodeURIComponent(BOOT.file)).catch((e) => ({ text: '', etag: null, error: e.message }));
// The editor works on LF text; a CRLF file is written back with CRLF (no whole-file diff on Windows).
const eol = /\\r\\n/.test(file.text) ? '\\r\\n' : '\\n';
saved = file.text.replace(/\\r\\n/g, '\\n'); etag = file.etag ?? null;
if (file.error) status(file.error, 'error');
const idx = await api('/api/index').catch(() => ({ roots: {}, tiers: [], profiles: [] }));
for (const t of idx.tiers || []) $('tier').append(new Option(t, t));
for (const pr of idx.profiles || []) $('profile').append(new Option(pr, pr));

async function check() {
  try { const r = await api('/api/check', { method: 'POST', body: JSON.stringify({ path: BOOT.file, text: getText() }) }); showDiags(r.diagnostics || []); return r.diagnostics || []; } catch { return []; }
}
function lineOf(off) { return getText().slice(0, off).split('\\n').length; }
function showDiags(ds) {
  $('diags').innerHTML = ds.map((d) => '<li class="' + escH(d.severity) + '"><a href="#" data-off="' + escH(d.start) + '">:' + lineOf(d.start) + '</a> <b>' + escH(d.code) + '</b> ' + escH(d.message) + '</li>').join('');
  setDiagnostics(ds);
}
$('diags').addEventListener('click', (e) => { const a = e.target.closest('[data-off]'); if (a) { e.preventDefault(); gotoLine(lineOf(Number(a.dataset.off))); } });

// ── editor: CodeMirror 6 from esm.sh (pinned), textarea fallback ──
try {
  if (!BOOT.cm.length) throw new Error('завантаження з esm.sh вимкнено');
  const [cm, view, state, auto, lint, jsLang, mdLang] = await Promise.all(BOOT.cm.map((u) => import(u)));
  const isMd = /\\.md$/.test(BOOT.file);
  const completion = async (ctx) => {
    const r = await api('/api/complete', { method: 'POST', body: JSON.stringify({ path: BOOT.file, text: ctx.state.doc.toString(), offset: ctx.pos }) }).catch(() => null);
    if (!r || !r.options || !r.options.length) return null;
    return { from: r.from, to: r.to, options: r.options.map((o) => ({ label: o.name, apply: o.insert || o.name, type: o.kind === 'filter' ? 'function' : o.kind, detail: o.detail })) };
  };
  let lintDiags = [];
  const linter = lint.linter(async (v) => { lintDiags = await check(); return lintDiags.map((d) => ({ from: d.start, to: Math.min(v.state.doc.length, d.start + d.length), severity: d.severity === 'info' ? 'info' : d.severity, message: d.code + ': ' + d.message + (d.hint ? ' — ' + d.hint : '') })); }, { delay: 400 });
  const hover = view.hoverTooltip(async (v, pos) => {
    const r = await api('/api/hover', { method: 'POST', body: JSON.stringify({ path: BOOT.file, text: v.state.doc.toString(), offset: pos }) }).catch(() => null);
    if (!r || !r.hover) return null;
    return { pos: r.hover.start, end: r.hover.end, above: true, create: () => { const d = document.createElement('div'); d.style.cssText = 'padding:4px 8px;max-width:480px;white-space:pre-wrap;font:12px ui-monospace,monospace'; d.textContent = r.markdown.replace(/\`/g, ''); return { dom: d }; } };
  });
  const ed = new cm.EditorView({
    doc: saved,
    parent: $('editor'),
    extensions: [
      cm.basicSetup,
      isMd ? mdLang.markdown() : jsLang.javascript({ jsx: true, typescript: true }),
      auto.autocompletion({ override: [completion], activateOnTyping: true }),
      linter, lint.lintGutter(), hover,
      view.keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { save(); return true; } }]),
      cm.EditorView.updateListener.of((u) => { if (u.docChanged) markDirty(); }),
    ],
  });
  getText = () => ed.state.doc.toString();
  gotoLine = (n) => { const l = ed.state.doc.line(Math.max(1, Math.min(n, ed.state.doc.lines))); ed.dispatch({ selection: { anchor: l.from }, scrollIntoView: true }); ed.focus(); };
} catch (e) {
  const ta = document.createElement('textarea');
  ta.value = saved; ta.spellcheck = false;
  $('editor').append(ta);
  getText = () => ta.value;
  ta.addEventListener('input', () => { markDirty(); clearTimeout(ta._t); ta._t = setTimeout(check, 500); });
  ta.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); save(); } });
  gotoLine = (n) => { const lines = ta.value.split('\\n'); const off = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0); ta.focus(); ta.setSelectionRange(off, off); };
  status('CodeMirror недоступний (' + e.message + '), простий редактор', 'warning');
  check();
}

async function save() {
  // Keystrokes typed while the PUT runs stay unsaved (dirty).
  const sent = getText();
  try {
    // etag null = "no file when loaded": the server refuses to overwrite one created since.
    const r = await api('/api/file?path=' + encodeURIComponent(BOOT.file), { method: 'PUT', body: JSON.stringify({ text: eol === '\\n' ? sent : sent.replace(/\\n/g, eol), etag }) });
    etag = r.etag; saved = sent; markDirty(); status('збережено');
    preview(false);
  } catch (e) { status(e.message, 'error'); }
}

let previewSeq = 0;
async function preview(runScripts) {
  if (runScripts && !confirm('Виконати скрипти секції «' + $('section').value + '»? Run/Call/Mcp запустяться з правами користувача.')) return;
  // Only the latest request paints: a slower earlier one (another tier) must not overwrite it.
  const seq = ++previewSeq;
  status(runScripts ? 'виконую скрипти…' : 'рендер…');
  try {
    const r = await api('/api/preview', { method: 'POST', body: JSON.stringify({ path: BOOT.file, section: $('section').value, tier: $('tier').value, profile: $('profile').value, ctxFrom: $('ctxFrom').value, runScripts, confirm: runScripts }) });
    if (seq !== previewSeq) return;
    const sec = (r.sections || []).find((s) => s.id === $('section').value) || (r.sections || [])[0];
    $('text').textContent = r.error ? r.error : (sec && sec.text != null ? sec.text : r.text || '');
    $('text').className = r.error ? 'error' : '';
    $('meta').textContent = sec ? '· ' + (sec.tokens ?? Math.ceil((sec.text || '').length / 4)) + ' ток.' + (sec.included === false ? ' · не увійшла: ' + (sec.reason || '') : '') + (r.ms != null ? ' · ' + r.ms + ' мс' : '') + ' · ' + r.via + (runScripts ? '' : ' · dry-scripts') : '';
    $('trace').innerHTML = (r.trace || []).map((t) => '<tr' + (t.line ? ' data-line="' + escH(t.line) + '"' : '') + '><td>' + escH(t.section) + '</td><td>' + escH(t.kind) + '</td><td>' + escH(t.detail) + '</td><td>' + escH(t.ms) + '</td><td>' + escH(t.source) + '</td></tr>').join('');
    if ((r.diagnostics || []).length) $('text').textContent += '\\n\\n' + r.diagnostics.map((d) => d.code + ': ' + d.message).join('\\n');
    status('');
  } catch (e) { if (seq === previewSeq) status(e.message, 'error'); }
}
$('trace').addEventListener('click', (e) => { const tr = e.target.closest('[data-line]'); if (tr) gotoLine(Number(tr.dataset.line)); });
$('save').onclick = save;
$('refresh').onclick = () => preview(false);
$('run').onclick = () => preview(true);
for (const id of ['tier', 'profile']) $(id).onchange = () => preview(false);
$('repl').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/eval', { method: 'POST', body: JSON.stringify({ expr: $('expr').value }) });
    $('replOut').className = r.ok ? '' : 'error';
    $('replOut').textContent = (r.ok ? JSON.stringify(r.value, null, 2) : '') + (r.diagnostics.length ? '\\n' + r.diagnostics.map((d) => d.code + ': ' + d.message).join('\\n') : '') + (r.hasTrace ? '' : '\\n(немає .trace/last.json — контекст порожній)');
  } catch (err) { $('replOut').textContent = err.message; }
};
preview(false);
</script>
</body></html>`
}
