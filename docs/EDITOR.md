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

Конфіг плагіна: `cliPath` (рядок або argv), `disabled`, `compiledDiagnostics` (типово `true`; VS Code-розширення
вимикає, бо публікує свіжі діагностики збірки саме). Для TSX рівня 2 плагін запускає трансформер збірки над відкритим
текстом і показує його G160 наживо.

Підключення без VS Code — у `.claude/prompt/tsconfig.json` (його пише `init`/`build`; рядок-позначку першим рядком
прибери, якщо редагуєш файл сам, інакше `build` його оновлює):

```json
{ "compilerOptions": { "plugins": [{ "name": "@context-gate/lsp", "cliPath": "node /шлях/до/context-gate/dist/cli.js" }] } }
```

і пакет у `node_modules/@context-gate/lsp` (наприклад `npm i -D /шлях/до/context-gate/packages/lsp` після збірки).
Для Neovim/Helix/Zed це працює через їхній `typescript-language-server` / `vtsls` з `tsserver.pluginPaths`.

Чиста логіка — `analyze.ts` (TSX), `exprcheck.ts` (один вираз), `model.ts` (форма Ctx), `markdown.ts` (`.md`-форма);
вона ж доступна CLI: `validatePrompt(cp, { validateExpr })` у `packages/cli/src/build.ts` приймає `(src) => checkExpr(src, model)`.

## 2. VS Code (`editors/vscode`)

Розширення самодостатнє: пакети context-gate не опубліковані в npm, тому в `.vsix` лежать CLI (`cli/dist/cli.js`
разом із `packages/{jsx,core}/src`, `dist/jsx-types`, `examples/skills`), `esbuild` (залежність розширення),
tsserver-плагін (`node_modules/@context-gate/lsp`) і схема `gate.json` (`schema/`).

### Встановлення

```bash
npm ci && npm --prefix editors/vscode ci     # один раз: залежності кореня і розширення (esbuild, vsce, test-electron)
npm run package:vscode                       # build.mjs + vsce package → editors/vscode/context-gate-vscode-0.1.0.vsix
code --install-extension editors/vscode/context-gate-vscode-0.1.0.vsix
```

`.vsix` (~5 МБ) не комітиться (`editors/vscode/*.vsix` у `.gitignore`); для розробки — F5 з `editors/vscode`.

### Що працює

| Що | Як |
| --- | --- |
| **Збірка при збереженні** | `.claude/prompt/<id>.prompt.tsx` → `build --json --only <файл>`; імпортовані файли (`shared/*.tsx`, `data/*.json`, `.md`, також поза `.claude/prompt`) → `--only` промптів, у чиїх `sources` у `prompt.lock.json` вони є; новий файл у `.claude/prompt` або `.claude/gate.json` → повна збірка. `.compiled/ .trace/ .types/`, `tsconfig.json`, `prompt.lock.json` не тригерять збірку. Збірки одного репозиторію йдуть чергою, запити під час збірки зливаються в одну наступну. |
| **Problems** | DiagnosticCollection `context-gate`: усі діагностики `build --json` (збірка, `validatePrompt`, перевірки виразів, G164 esbuild з рядком імпорту, G180 …) на файлі й рядку з `path`/`line`; без `path` — на збереженому файлі. Коди, які tsserver-плагін рахує наживо з точними діапазонами (`G10x`, `G154`, `G157`, `G163`, `G17x`), для `*.prompt.tsx` не дублюються. Плагіну передається `compiledDiagnostics: false`, щоб застарілі копії з `.compiled` не з'являлись поруч зі свіжими. |
| **Рядок стану** | `context-gate: ✓ built` / `⚠ N` (помилки + попередження) / `building…` / `✗ CLI`; клік — канал виводу **context-gate** з командою, stderr CLI і списком діагностик. |
| **Команди** | *context-gate: Build prompts* (повна збірка), *Build current file*, *Health* (`context-gate health` у журнал), *Show log*, *Preview section*, *згенерувати quick-варіант секції*. |
| **Підказки TSX** | `init` і кожен `build` пишуть `.claude/prompt/tsconfig.json` (`jsx: react-jsx`, `jsxImportSource: @context-gate/jsx`, `paths` → `.types/jsx/jsx/src/*.d.ts`) і `.types/jsx/` — копію декларацій `@context-gate/jsx` (з `dist/jsx-types` поруч із CLI), плюс `.types/ctx.d.ts`/`assets.d.ts`. tsserver резолвить компоненти, пропси, `arg.*`, типізований `ctx` без `node_modules`. Якщо файлів немає, розширення при активації (у довіреному workspace) запускає повну збірку і перезапускає TS server. |
| **tsserver-плагін** | `typescriptServerPlugins` з `enableForWorkspaceTypeScriptVersions: true` — працює і з TypeScript workspace. Діагностики/completion/hover у рядкових виразах, outline секцій; для TSX рівня 2 (`// @context-gate level2` або `prompt.transform: "level2"`) — той самий трансформер, що й у збірці: G160 наживо на рядку виразу, нативні `ctx.*` перевіряє сам TypeScript через `ctx.d.ts`. |
| **Markdown-секції** (`.claude/prompt/**/*.md`) | діагностики `analyzeMarkdown` (G0xx структури, G1xx виразів, G172 полів); completion директив після `@` (зі сніпетами `@if … @end`), коренів/полів/фільтрів у `{{ }}` і виразах директив, профілів/tiers у `gate.profile == "…"`, імен tiers після `@tier`; hover директив і виразів (тип, значення з trace); outline (секція → `@if/@each/@fn/@let`); підсвітка `@if/@each/@end/…` і `{{ }}` ін'єкцією TextMate у Markdown. |
| **Сніпети** | TSX: `cg-prompt`, `cg-skill` (skill-промпт з `args`), `Section`, `If`, `Each`, `Run`, `Include`, `Tier`; Markdown: `cg-section`, `@if`, `@each`, `@tier`, `@run`, `@include`, `{{`. |
| **`gate.json`** | `jsonValidation` для `**/.claude/gate.json` → вбудована схема: completion ключів, опис, помилки невідомих ключів і типів. Тривалості (`5m`) — `pattern`, а не `format: duration` (ISO 8601). |
| **`.mdc`** | діагностики `parseMdc` ядра (G010–G015) для будь-якого `*.mdc`, hover над frontmatter: тип правила (Always / Auto Attached / Agent Requested / Manual), globs, опис. |

### CLI

Порядок: налаштування `contextGate.cliPath` → `node_modules/.bin/context-gate` у корені репозиторію → вбудований
CLI. Вбудований запускається `process.execPath` хоста розширень (Electron VS Code) з `ELECTRON_RUN_AS_NODE=1`,
тож окремий Node не потрібен; `NODE_PATH` вказує на `typescript` з VS Code (`<appRoot>/extensions/node_modules`) —
його бере трансформер TSX рівня 2. `esbuild` CLI знаходить у `node_modules` розширення.

| Налаштування | Типово | Що |
| --- | --- | --- |
| `contextGate.cliPath` | `""` | команда CLI (`node /шлях/context-gate/dist/cli.js`); порожньо — порядок вище |
| `contextGate.buildOnSave` | `true` | збірка при збереженні |

У недовіреному workspace (`capabilities.untrustedWorkspaces: limited`) збірка і preview не запускаються: збірка
виконує код промптів. Підказки, схема і `.mdc` працюють.

**esbuild і платформи.** `esbuild` має нативний бінарник у пакеті під платформу (`@esbuild/linux-x64` тощо), а
`vsce package` кладе в `.vsix` лише той, що встановився на машині збірки. Тому `.vsix` з цього репозиторію працює
на тій самій платформі (тут linux-x64). Для інших — пакувати на цільовій платформі або покласти потрібний
`@esbuild/<платформа>` в `editors/vscode/node_modules` і `npx @vscode/vsce package --target <платформа>` (по `.vsix`
на ціль; `--target` лише позначає платформу в маркетплейсі, бінарник треба підкласти самому). Без робочого esbuild вбудований CLI дає G164 «esbuild не знайдено»; тоді `contextGate.cliPath`
на CLI з власним esbuild.

### Preview

- **context-gate: Preview section** (кнопка в заголовку редактора для файлів у `.claude/prompt/`): бере секцію під
  курсором і запускає `<cli> run --only <id> --json --dry-scripts` у корені репозиторію. Панель показує текст секції,
  токени, час, діагностики і таблицю trace; клік по рядку з `line` переходить до директиви.
- Перемикачі **tier / profile / ctx-from** угорі — ті самі прапорці CLI (`ctx-from`: `session:latest` або fixture з `fixtures/*.json`).
- **виконати скрипти** — один рендер без `--dry-scripts` після модального підтвердження.
- Перерендер при збереженні файлів `.claude/**` і `scripts/**` того самого репозиторію.
- Code action «згенерувати quick-варіант» відкриває термінал з `<cli> expand --only <id>`.

### Код і перевірки

Чиста логіка без `vscode`: `src/compiler-core.ts` (вибір CLI, що збирати, розбір `build --json`, діагностики за
файлами, текст рядка стану), `src/dsl-core.ts` (директиви, outline Markdown, `.mdc`), `src/preview.ts` — покриті
`test/lsp-vscode.test.ts`. Обгортки над API: `src/compiler.ts`, `src/providers.ts`, `src/extension.ts`;
`npx tsc -p editors/vscode` (типи `@types/vscode` з `editors/vscode/node_modules`).

**Справжній VS Code** — `npm run test:vscode` (`editors/vscode/test/run.mjs`, `@vscode/test-electron`):
`/usr/bin/code` (або `VSCODE_EXECUTABLE`; береться Electron за скриптом-запускачем), тимчасові `--user-data-dir` і
`--extensions-dir`, `--disable-extensions` (вбудовані розширення, зокрема TypeScript і JSON, лишаються), без
довіри до workspace. Профіль користувача не змінюється, розширення нікуди не встановлюється. Робоча тека — тимчасова
копія `examples/basic` без `tsconfig.json` і `.types/jsx/`, тобто репозиторій лише з розширенням. `test/suite.cjs`
перевіряє через API: перша збірка вбудованим CLI пише типи; у `main.prompt.tsx` немає помилок TS; `when="git.nope"` →
G172 плагіна; completion `when="git.|"` → `branch`; `<Sec` → `Section`; збереження з поганим імпортом → G164 у
Problems, виправлення → зникає і `.compiled/main.json` оновлено; Markdown: completion після `@` і в `{{ ctx.| }}`,
G172, hover, outline; `gate.json` з невідомим ключем і невірним типом → помилки схеми (оригінал — без помилок);
`.mdc` → G010/G011/G012 і hover; рівень 2 → G160; команди Build/Health. `--vsix <файл>` (або `CG_VSIX`) запускає
те саме проти розпакованого `.vsix`; `CG_KEEP_TMP=1` лишає тимчасову теку. Потрібен дисплей (`DISPLAY`) або `xvfb-run`.

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
`test/lsp-vscode.test.ts` (argv, парсинг `run --json`, HTML панелі, маніфест, вибір CLI, цілі збірки, `build --json`,
Markdown/`.mdc`-хелпери), `test/editor-types.test.ts` (`tsconfig.json` + `.types/jsx/` з `init`/`build`, перевірка
`examples/basic` TypeScript-ом без пакетів, живий G160 рівня 2), `npm run test:vscode` (справжній VS Code, вище), `test/editor-web.test.ts`
(токен, Host/Origin, path traversal і symlink, PUT/etag, preview через CLI і ядро, REPL, index, check/complete/hover).

## Обмеження

- Формат `run --json` і `.trace/last.json` — `RunJson` з `core/runjson.ts`; клієнти читають його `parseRunJson`, інші форми (`{ result: … }`) — помилка.
- Тип `Each`-елемента виводиться для простих `of` (шлях, `take/sort/where/grep/unique`, `map("поле")`); складніші — `any`.
- Області видимості локальних імен — на весь файл, а не на піддерево.
- Коди `G171`/`G172` — у спільній таблиці `core/codes.ts`, тож `context-gate explain G171` їх знає.
- Позиції діагностик збірки з `.compiled` — з точністю до рядка секції.
- VS Code: діагностики збірки — з точністю до рядка (CLI не дає колонок); Markdown-секції не мають власної збірки,
  їхні діагностики — живий аналіз; `.vsix` прив'язаний до платформи esbuild (див. вище).
- VS Code: preview оновлюється на збереження, не на кожне натискання; refactor-команда tsserver «quick-варіант» виконується, лише якщо клієнт передає `commands` у `applyCodeActionCommand`, — тому в розширенні є власний code action.
