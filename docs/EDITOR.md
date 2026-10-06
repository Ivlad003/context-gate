# Редактор DSL: tsserver-плагін, VS Code, браузерний редактор

Реалізація розділу SPEC «Редактор DSL та індекс автокомпліту» і live-preview з «Автономний інтерпретатор».
Усі три клієнти спираються на одне ядро аналізу (`packages/lsp/src`) і на CLI (`context-gate run`), тому
редактор нічого не знає сам: дані — з `gate.json`, `gate.index.json`, `.types/ctx.d.ts` і останнього trace.

## Що читається з репозиторію

| Файл | Навіщо |
| --- | --- |
| `.claude/gate.json` | профілі, tiers, групи, провайдери (`schema` → типи полів, `functions` → функції) |
| `.claude/gate.index.json` | профілі/tiers/секції/елементи, `vars`/`ctx` (значення-зразки), `data`, провайдери; усі поля необов'язкові |
| `.claude/prompt/.types/ctx.d.ts` | запасне джерело unions `ProfileName`/`TierName` і ключів провайдерів |
| `.claude/prompt/.trace/last.json` | значення для hover і REPL: `RunJson` (`core/runjson.ts`: `{ sections, text, trace, diagnostics, ms, scope, health?, meta }`) — останній `context-gate run` |
| `.claude/prompt/.compiled/*.json` | діагностики збірки (`G151`, `G160`, `G161`, `G164`, `G180` …) для файлів-джерел |

Файли перечитуються за mtime, тож `context-gate build` / `run` у фоні одразу видно в редакторі.

## 1. tsserver-плагін `@context-gate/lsp` (`packages/lsp`)

Працює в будь-якому редакторі з TypeScript language server. Аналізує лише `*.prompt.tsx`.

- **Діагностики** рядкових виразів рівня 1 (Р1) у пропсах `Section when`, `If/Assert test`, `Each of`, `Let/Set value`,
  `Repeat n`, `V expr`, `Table rows/cells`, `Call args/kwargs`, `Debug exprs`, `HealthWarning threshold`, `CursorRules match`,
  і в `{{ }}` будь-якого рядка всередині JSX (`{'{{ r.body }}'}`, `Fence title`, `Mcp args`):
  - `G101–G108`, `G154` — синтаксис (парсер ядра `parseExpr`);
  - `G170` — поле провайдера без `schema` (Р4), `G172` — поля немає в типі, `G171` — невідома змінна,
    `G157`/`G158` — невідомий провайдер / функція;
  - `G163` — `<Run>` без `cache` у `static`-секції (наживо, без збірки);
  - коди з `.compiled` (рекурсія `G151` тощо) — на рядку секції, з позначкою «остання збірка».
  Локальні імена (`as=`, `name=`, параметри функцій-дітей `Each`, `i` у `Repeat`, `row` у `Table`, `<Use name>`) відомі;
  тип елемента `Each` виводиться з `of` (`<Each of="cursor.always" as="r">` → `r.body`, `r.globs`).
  Коди tsserver: `G170` → `90170`, `H013` → `91013`; `source: "context-gate"`.
- **Completion** усередині виразів: корені (`gate git fs cursor session ctx budgets args data` + провайдери), поля,
  фільтри після `|`, вбудовані функції, значення профілів/tiers у `gate.profile == "…"`, `gate.tier in [...]`,
  аргументи skill з `<Prompt as="skill" args={{…}}>`.
- **Hover** — тип, опис і значення з `.trace/last.json`, рядки trace секції.
- **Рефакторинги** (група `context-gate`): «винести в Lazy» на `Include`/`Skill`/`Rule` (ставить `mode="lazy"`),
  «згенерувати quick-варіант» у секції — команда `context-gate expand --only <id>` через `applyCodeActionCommand`.
- **Outline** — секції файлу (`Section <id> (<scope>)`) на початку navigation tree.

Збірка: `npm run build:editors` (або `npm --prefix packages/lsp run build`) → `packages/lsp/dist/index.cjs`
(CommonJS, `typescript` — зовнішній, береться у tsserver).

Підключення без VS Code — у `tsconfig.json` проєкту з промптами:

```json
{ "compilerOptions": { "plugins": [{ "name": "@context-gate/lsp", "cliPath": "node /шлях/до/context-gate/dist/cli.js" }] } }
```

і пакет у `node_modules/@context-gate/lsp` (наприклад `npm i -D /шлях/до/context-gate/packages/lsp` після збірки).
Для Neovim/Helix/Zed це працює через їхній `typescript-language-server` / `vtsls` з `tsserver.pluginPaths`.

Чиста логіка — `analyze.ts` (TSX), `exprcheck.ts` (один вираз), `model.ts` (форма Ctx), `markdown.ts` (`.md`-форма);
вона ж доступна CLI: `validatePrompt(cp, { validateExpr })` у `packages/cli/src/build.ts` приймає `(src) => checkExpr(src, model)`.

## 2. VS Code (`editors/vscode`)

Тонкий клієнт: `contributes.typescriptServerPlugins` підключає плагін вище, плюс preview-панель.

```bash
npm run build:editors                 # dist/extension.cjs + node_modules/@context-gate/lsp усередині розширення
cd editors/vscode && npx @vscode/vsce package --no-dependencies   # .vsix (або F5 з цієї теки)
```

- **context-gate: Preview section** (кнопка в заголовку редактора для файлів у `.claude/prompt/`): бере секцію під
  курсором і запускає `<cliPath> run --only <id> --json --dry-scripts` у корені репозиторію. Панель показує текст секції,
  токени, час, діагностики і таблицю trace; клік по рядку з `line` переходить до директиви.
- Перемикачі **tier / profile / ctx-from** угорі — ті самі прапорці CLI (`ctx-from`: `session:latest` або fixture з `fixtures/*.json`).
- **виконати скрипти** — один рендер без `--dry-scripts` після модального підтвердження.
- Перерендер при збереженні файлів `.claude/**` і `scripts/**` того самого репозиторію.
- Code action «згенерувати quick-варіант» відкриває термінал з `context-gate expand --only <id>`.
- Налаштування `contextGate.cliPath` (типово `npx context-gate`) передається і в tsserver-плагін (`configurePlugin`).

Логіка панелі — у `src/preview.ts` (без `vscode`, покрита тестами); `src/extension.ts` імпортує `vscode`
і перевіряється окремо: `npx tsc -p editors/vscode` (мінімальний шим типів у `src/vscode-shim.d.ts`).

## 3. Браузерний редактор (`packages/editor-web`)

`/gate edit <id>` запускає його через `$.process.spawn` (модель `keylang web`):

```bash
node packages/editor-web/src/main.ts <id> [--root .] [--port 0] [--cli "node dist/cli.js"] [--json]
# → context-gate edit: .claude/prompt/main.prompt.tsx
#   http://127.0.0.1:43127/?t=<токен>
```

`<id>` — id файлу (`main` → `main.prompt.tsx` / `main.md`) або id секції, оголошеної в одному з файлів.
З `--json` друкує один рядок `{"url","port","file"}` і завершується, коли батьківський процес закриває stdin.
Програмно: `startEditorServer({ root, id, port?, cli? }) → { url, port, token, file, close() }`.
CLI за замовчуванням — `CONTEXT_GATE_CLI` або `npx context-gate`.

Сторінка — CodeMirror 6 з `esm.sh` (TSX/Markdown, автокомпліт, lint, hover через API нижче); без мережі —
простий `<textarea>` з тим самим набором кнопок. Праворуч: preview секції, trace, REPL виразів.

| Endpoint | Що робить |
| --- | --- |
| `GET /?t=<token>` | сторінка (CSP з nonce; скрипти лише з `esm.sh`) |
| `GET /api/file?path=` | файл з `.claude/prompt/` + `etag` |
| `PUT /api/file?path=` `{text, etag}` | атомарний запис; `409` якщо файл змінився поза редактором |
| `POST /api/preview` `{section?, tier?, profile?, ctxFrom?, runScripts?, confirm?}` | `run --only <id> --json --dry-scripts`; `.md` без ctx-from рендериться ядром напряму (недовірений хост, без скриптів); `runScripts` вимагає `confirm: true` (інакше `428`) |
| `POST /api/eval` `{expr, scope?}` | REPL: `parseExpr` + `evalExpr` у scope з `.trace/last.json` (виклики провайдерів → `G157`) |
| `GET /api/index` | `gate.index.json` + корені Ctx з полями, фільтри, профілі, tiers |
| `POST /api/check` · `/api/complete` · `/api/hover` `{text, path?, offset?}` | діагностики / completion / hover тим самим аналізатором, що й tsserver-плагін (для TSX потрібен пакет `typescript`) |

**Безпека.** Лише `127.0.0.1`, випадковий порт; токен з URL обов'язковий для сторінки і кожного API-запиту
(заголовок `x-gate-token`, порівняння за сталий час); `Host` має бути `127.0.0.1:<port>`/`localhost:<port>`
(захист від DNS rebinding), чужий `Origin` відхиляється. Шляхи — лише всередині `.claude/prompt/`: абсолютні, `..`,
NUL і symlink назовні дають `403`; службові `.compiled/.trace/.types` і розширення поза `.tsx .ts .md .mdc .json .txt`
не записуються. Редактор не виконує код проєкту сам: preview іде через CLI з `--dry-scripts`, скрипти — лише за явним підтвердженням.

## Тести

`test/lsp-analyze.test.ts` (аналіз, completion, hover, рефакторинги, справжній LanguageService з плагіном),
`test/lsp-vscode.test.ts` (argv, парсинг `run --json`, HTML панелі, маніфест), `test/editor-web.test.ts`
(токен, Host/Origin, path traversal і symlink, PUT/etag, preview через CLI і ядро, REPL, index, check/complete/hover).

## Обмеження

- Формат `run --json` і `.trace/last.json` — `RunJson` з `core/runjson.ts`; клієнти читають його `parseRunJson`, інші форми (`{ result: … }`) — помилка.
- Тип `Each`-елемента виводиться для простих `of` (шлях, `take/sort/where/grep/unique`, `map("поле")`); складніші — `any`.
- Області видимості локальних імен — на весь файл, а не на піддерево.
- Коди `G171`/`G172` — у спільній таблиці `core/codes.ts`, тож `context-gate explain G171` їх знає.
- Позиції діагностик збірки з `.compiled` — з точністю до рядка секції.
- VS Code: preview оновлюється на збереження, не на кожне натискання; refactor-команда tsserver «quick-варіант» виконується, лише якщо клієнт передає `commands` у `applyCodeActionCommand`, — тому в розширенні є власний code action.
