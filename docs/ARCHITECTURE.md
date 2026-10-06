# Архітектура context-gate: консолідація шару 3 (Р7)

Цей документ — та «наступна правка» зі SPEC Р7, але окремим файлом: `docs/SPEC.md` лишається текстом автора
без змін, а тут ті самі рішення зібрано в один розділ у порядку **синтаксис → AST → збірка → рантайм → skills →
імпорти → налагодження → межі**, потім шар 3а, потім доповнення до «Хто вже зробив». Р1–Р7 уже враховано: де
розділи SPEC вище за «Ревю дизайну» кажуть інакше, правильне те, що тут. Кожен пункт посилається на розділ SPEC і
на код, який його реалізує.

## 0. Карта

```
.claude/prompt/*.prompt.tsx ─┐                        ┌─ prompt.compose (mod, hooks/layers/dsl.ts)
.claude/prompt/*.md ─────────┼─ build ─▶ .compiled/<id>.json ─┼─ context-gate run / preview / LSP (packages/cli)
shared/*, *.json, *.md ──────┘  (Node, esbuild,           ├─ claude-code-hooks adapter (dist/hooks-adapter.js)
                                 10 с таймаут)             └─ static fallback: sync → prompt.generated.md
                                        │
                        packages/core/src/render.ts — один тотальний інтерпретатор для всіх
```

Шари 1 (cursor-rules) і 2 (skill-gate) — у SPEC без змін; шар 3 спирається на них через контекст рендера
(`cursor.*`, `gate.*`). Ядро `packages/core` не імпортує ні Node, ні Claude Code (AGENTS.md).

## 1. Шар 3 — промпт як TSX над спільною AST

### 1.1 Синтаксис

- **Дві форми, один AST.** TSX (`@context-gate/jsx`, `packages/jsx/src/components.ts`) для розробників; Markdown
  з `@`-директивами (`packages/core/src/mddsl.ts`) для решти. `@x` у тексті SPEC означає компонент `<X>`.
- **Вирази — рядки (Р1, рівень 1).** `when="ctx.percent > budgets.soft"`, `<Each of="cursor.always" as="r">`,
  `{'{{ r.body }}'}` або `<V expr="r.body" />`, тег `` e`…` ``. `ctx` у TSX — лише типізовані константи збірки.
  Рівень 2 (TS-трансформер, нативний синтаксис у `when/test/of/children`, `G160` поза підмножиною) — після bench;
  Proxy-магія для операторів заборонена як підхід.
- **Канонічний набір (Р5):** `Run`, `Call` через `Use`, `Store`, `Include mode=inline|ref|lazy`, а `Skill`/`Rule`/
  `Mcp` — спеціалізації `Include`. `Lazy`, `store=` на `Run`, провайдер `scripts`, `tiers[*].preload` — цукор,
  що компілюється в канонічні вузли; старі записи живуть до 1.0 з `G180`.
- **Пропси `Section`:** `id`, `scope` (`static`/`profile`/`volatile`), `when`, `budget`, `after`, `tier`.

### 1.2 AST

- Тип — `packages/core/src/types.ts` (`Node`, `SectionNode`, `CompiledPrompt`), серіалізується в JSON.
- Керування (`if`, `each`, `repeat`, `let`/`set`), дані (`run`, `call`, `use`, `include`, `store`), форматування
  (`el`, `fence`, `list`, `table`), налагодження (`debug`, `assert`, `log`, `trace`), варіанти (`tier`).
- Усе, що не залежить від `ctx`, — константа (`text`). У `run --trace` такі частини підписані `build-time`
  (`render.ts`: рядок `константи збірки: N символів`, `include text:… inline`, і кожен текстовий вузол під
  `@trace on`).
- `CompiledPrompt.sources[]` — `{ path, hash }` кожного імпорту; `prompt.lock.json` (комітиться, Р3) тримає хеші
  всіх джерел і версію компілятора.

### 1.3 Збірка

- `context-gate build` (`packages/cli/src/build.ts`): esbuild з jsx-фабрикою бібліотеки, виконання модуля в Node
  під таймаутом 10 с, `.compiled/<id>.json` з `source-hash`. `.compiled/` у `.gitignore` (Р3); `commitCompiled:
  true` — опція для репозиторіїв без Node у CI; `claude -p` без збірки бере CI-артефакт або кеш
  `~/.cache/context-gate/<repo>/`.
- Хто збирає: LSP і редактор на save, pre-commit, CI; mod — лише як запасний шлях (`session.start` за
  `source-hash`, `classic.FileChanged` для `.claude/prompt/**`, `gate.json`, `scripts/**`, перевірка mtime на
  `prompt.compose`, синхронно до 2 с, інакше попередній `.compiled` і `H013`).
- Довіра (Р2): збірка, як і будь-який `process.run`/`mcp.call` з конфігурації репозиторію, — лише після
  trust-on-first-use; `--trust-repo` у CI.
- Типи контексту (Р4): `.claude/prompt/.types/ctx.d.ts` з `gate.json`, `schema` провайдерів (інлайн, `.schema.json`,
  `.d.ts`); без схеми — `unknown` і `G170`-попередження.

### 1.4 Рантайм

- Один інтерпретатор — `packages/core/src/render.ts renderPrompt`: mod на `prompt.compose`, `context-gate run`,
  preview редактора, hooks-адаптер. Тому preview збігається з тим, що отримує модель, байт у байт.
- Два проходи на секцію: прохід даних збирає всі `run`/`call`/`mcp`/`include`/провайдерні виклики й виконує їх
  хвилею паралельно (`needs=` — раунди), потім рендер по готових значеннях. Порядок і результат залежать лише від
  даних, не від таймінгу.
- Бюджети: ліміт кроків на секцію (10 000, `G155`), усі `@run` на рендер — 2 с, `@run` кешується на 5 хв
  (`runCacheDefault`), `@call` — за хешем файлу модуля, ім'ям функції й аргументами (ключ `call:<module>:<fn>:<args>#<hash>`).
- `scope`: `static` → `profile` → `volatile`, `after` у межах scope. У mod-і всі секції — `scope: 'session'`
  `prompt.compose` (PROBE), DSL-scope лише впорядковує їх.
- Статуси секцій `ok` / `fail` / `unverified`; недовірений репозиторій → заглушки `[run: python, unverified]`;
  `onError: unverified | skip | fail`; застарілі `data.*` → `H006`.

### 1.5 Skills як промпти

- `<Prompt as="skill" name args invoke tiers>`: збірка пише `.claude/skills/<name>/SKILL.md` з рядком
  `` !`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" run <name> --args "$ARGUMENTS" --ctx-from live` ``; з mod-ом тіло
  рендериться в `skill.prompt` з аргументами з `tool.call {tool:'Skill'}` (PROBE: `skill.prompt` без args).
- Помилка аргументів → секція `usage` як текст для моделі (код 0). Fallback (Р6): попередньо відрендерене тіло з
  дефолтними аргументами, позначене `static`.
- `invoke`: `/name` для людини, інструмент для моделі; `tiers` обмежують, де skill діє.

### 1.6 Імпорти

- Промпт — звичайний TS-модуль: інші `.prompt.tsx` як компоненти, `.md` → текст, `.json`/`.yaml`/`.toml` → дані,
  бібліотеки й локальні хелпери — лише на збірці. На виході один `.compiled/<id>.json`; у рантаймі імпортів немає.
- Зміна будь-якого імпорту інвалідовує збірку (`H013`). Пакети промптів (`@acme/prompts`) можуть експортувати
  skills; збірка ставить у frontmatter позначку походження.
- Змішування збірки й рантайму (`lodash.sortBy(ctx.commits, …)`) — `G160`: перенести в `module`-провайдер або
  pipe-фільтр.

### 1.7 Налагодження

- `@debug`, `@assert`, `@log`, `@trace` ніколи не потрапляють у текст промпту (тест ядра: рендер з `@debug` і без
  дає однакові байти).
- `@debug` обчислюється лише при `debug: true` у `gate.json` або `--debug` у CLI; `@assert` — завжди, за
  `assertFail: skip | fail` секція пропускається або рендер падає (`D001`, видно в trace, журналі й `/gate health`).
- Куди йде: `run --trace` і панель редактора; у Claude Code — `/gate why | where kind=debug` і `$.ui.log` з
  `to: "debug"`; файл `.claude/gate.debug.log` (лише з `debug`, обрізається до 1 МБ з голови, у `.gitignore`).
- Значення обрізаються до 2 000 символів; секрети з `env` (білий список у `gate.json`) маскуються `***` у trace,
  діагностиках і debug-лозі (`render.ts maskSecrets`).

### 1.8 Межі мови

- AST тотальна: `@if` до 3 рівнів, `@each` по готових списках до 2, `@repeat n ≤ 1000` з межею, відомою до входу,
  `@fn` без рекурсії (`G151`), pipe-фільтри з білого списку, виклики провайдерів лише на початку ланцюжка.
- Повна мова — у провайдерах (`module`: TS у каталозі плагіна або `.claude/prompt/lib/*.ts`; `cli`; `file`; `mcp`)
  і на збірці. Повідомлення `G151–G155` мають одну підказку: «ця логіка має жити в провайдері».
- Безпека: виконавці лише з білого списку бінарників у user-settings (репозиторій тільки звужує), дані — через
  stdin, жодної мережі з DSL, текст `.mdc` і DSL ніколи не стає командою.

### 1.9 Prompt health (спільне для 1.4–1.8)

`packages/core/src/health.ts computeHealth` рахує один звіт для `/gate health` і `context-gate health`:
`H001` розмір, `H002` стабільна частка (з хешів секцій або з реального `usage.cache_read_input_tokens`), `H003`
дрейф, `H004`/`H005` час (з найдовшими `@run`/провайдерами й cache hit rate), `H006` вік даних, `H007` unverified,
`H008` урізання static, `H009` листинг skills і skills без опису, `H010` deny, `H011` гейт блокує > 30 % спроб
(лічильники `hooks/layers/gates.ts gateStats`, «все одно» після блоку — override), `H012` промпт > 40 % вхідних
токенів, `H013` застарілий `.compiled`, `D001` assert. Інформаційні рядки «Сесія»: компакції, токени кешу,
вартість, рішення gate.

## 2. Шар 3а — tier-адаптивні промпти

Без змін щодо SPEC, лише порядок механізмів від детермінованого до LLM:

1. Варіанти секцій: `@tier` / `<Tier is>` або файл `<id>.<tier>.md`, що перекриває канонічний.
2. Приклади з репозиторію (`fs.examples(glob, n)`), `tiers[*].preload` → `<Skill mode="inline">` у секції
   `preload`, контракт `plan-then-act` для tier нижче premium, гейти `gates[]` (вбудований `read-before-write`,
   командні й провайдерні на `write`/`commit`/`turn`/`prompt`, `onlyNew` + `baseline`).
3. Бриф задачі сильною моделлю: один `$.model.complete` на задачу, кеш у `$.state`.
4. `context-gate expand`: офлайн-генерація quick/standard-варіантів у `proposals/` з `source-hash`.

Ескалація: `escalation.after` → подія `escalation-suggested` у журналі й notice; модель mod не перемикає.
Скільки спроб і токенів коштував кожен tier на задачі — `context-gate report` («Спроби і токени за tier»,
`packages/core/src/report.ts tierCosts`).

## 3. Хто вже зробив: доповнення (Priompt, POML)

Два попередники, яких бракувало в таблиці SPEC «Хто вже зробив схоже» (Р7):

| Проєкт | Що робить | Перетин із нашими шарами | Чого бракує |
| --- | --- | --- | --- |
| [Priompt](https://github.com/anysphere/priompt) (Anysphere, автори Cursor) | JSX-бібліотека для промптів: компоненти з пріоритетами (`p`, `prel`), рендер під токен-бюджет — нижчі пріоритети відкидаються, поки промпт не влізе; `<scope>`, `<first>`, `<empty>`, ізоляція підпромптів | шар 3: JSX як мова промптів, `budget` і `ref`/`lazy` як спосіб влізти в контекст | Рендер — виконання JSX у рантаймі (повна мова, без гарантії завершення й статичного аналізу); немає збірки в дані, харнес-інтеграції, правил, skills, гейтів; бюджет — єдиний механізм вибору |
| [POML](https://github.com/microsoft/poml) (Microsoft) | Розмітка промптів (HTML-подібні теги `<role>`, `<task>`, `<example>`, `<document>`, `<table>`, `<img>`), шаблони з `{{ }}`, `for`/`if`, підключення даних із файлів, стилі виводу окремо від змісту, SDK і розширення VS Code з preview | шар 3: шаблонна мова з умовами й циклами, вбудовування даних, preview у редакторі; `fmt`/стилі ≈ наші детерміновані Markdown-примітиви | Це формат документа одного промпту: немає життєвого циклу сесії (scope, prompt cache, health), харнес-подій, дедуплікації правил, вибору skills/MCP під задачу й модель, довіри до виконання коду |

**Висновок.** Обидва — інструменти *верстки* промпту: як із компонентів і даних скласти текст. `context-gate`
відрізняють три речі, яких немає в жодного з них:

1. **Тотальна AST.** TSX і Markdown компілюються в дані, які виконує маленький інтерпретатор із лімітом кроків, —
   тому рантайм не може зависнути, вартість відома до запуску, а health і LSP аналізують промпт статично. Priompt
   виконує JSX як програму; POML інтерпретує шаблон без меж і без розділення «збірка / рантайм».
2. **Харнес-інтеграція через mods.** Промпт рендериться в `prompt.compose` з живим контекстом сесії (модель,
   tier, профіль, `ctx.percent`, правила, що вже доставлені), секції впорядковані під prompt cache, а ті самі
   рішення діють у `tool.call`, `skill.prompt`, `prompt.attachment`. Верстальник промпту цього контексту не бачить.
3. **Конвеєр `Item`.** Промпт — лише один вид елемента: правила `.mdc`, skills, MCP-інструменти, агенти й секції
   проходять один `collect → decide → render → deliver → observe` з журналом і поясненням (`/gate why`). Бюджет
   Priompt вирішує, що відкинути з тексту; gate вирішує, що взагалі потрапляє в контекст і чому.

Що варто запозичити: у Priompt — пріоритети як явну підказку для `budget` (секція з нижчим пріоритетом першою
переходить у `ref`); у POML — розділення змісту й стилю виводу для таблиць і прикладів.
