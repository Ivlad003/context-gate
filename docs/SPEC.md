# Специфікація: Claude Code mod «context-gate»

Oct 6, 2026 · @Vlad Kosmach Ai Account

## Мета і межі

`context-gate` — один Claude Code mod-плагін (вимагає Claude Code ≥ 2.1.287), який керує тим, що потрапляє в контекст моделі: правила Cursor `.mdc`, skills, MCP-інструменти, субагенти і сам системний промпт. Ціль — одна машина і один репозиторій: конфігурація лежить у `.claude/` і комітиться, стан сесії живе в mod-і.

Три результати, які плагін має дати:

1. Правила `.cursor/rules/*.mdc` працюють у Claude Code з семантикою Cursor (Always, Auto Attached, Agent Requested, Manual) без дублювання в CLAUDE.md.
2. Набір skills і MCP-інструментів обирається автоматично під задачу і модель, а не вручну в кожному промпті; видно, що увімкнено і чому.
3. Системний промпт описується TSX-компонентами, скомпільованими у тотальну AST, (умови, цикли, запуск скриптів, ліниве підвантаження) так, щоб стабільна частина кешувалась, а змінна займала мінімум токенів.

Поза межами: роутинг моделей і fallback між провайдерами (це робить shiftwork або окремий mod на `turn.step`), редагування самих skills, підтримка інших IDE. Mod споживає ту саму конфігурацію `gate.json`, що й shiftwork-runner, але не запускає тікети.

## Хто вже зробив схоже

Повного аналога немає, але кожен із трьох шарів має прямого попередника, і два з них варто вивчити перед кодом: `jev-pilot` (вибір skill під промпт через класифікатор) і `jev-rules` (вибір правил під промпт). Каталог [mods.aidojo.si](https://mods.aidojo.si/) станом на 4 жовтня 2026 налічує 1 753 mods; нижче — ті, що перетинаються із задачею.

| Проєкт | Що робить | Перетин із нашими шарами | Чого бракує |
| --- | --- | --- | --- |
| [jev-pilot](https://mods.aidojo.si/) (Akramovic1, 8★) | Jev-класифікатор на кожен промпт: reasoning effort, модель субагента, чи ділити роботу, і «один skill, який потрібен промпту». Хукає `prompt.attachment {type=skill_listing}`, `skill.prompt`, `agent.spawn`, `turn.step`; бекенди OpenRouter / TypeSafe / Vercel / вбудований класифікатор | skill-gate: класифікація задачі, вибір skill, переписування skill-листингу | Один skill на промпт, а не профіль; немає груп/tiers, MCP-фільтрації, бюджетів, `/gate why`; роутинг моделей змішано з вибором skills |
| [jev-rules](https://mods.aidojo.si/) (EliaAlberti, 64★) | «Jev picks which of your rules apply to each prompt, so Claude only sees the ones that matter»; pane з правилами, `/rules` | cursor-rules (Agent Requested), skill-gate (вибір за змістом промпту) | Читає власні правила, не `.mdc`; немає globs/alwaysApply/`@rule`; вибір на кожному промпті без гістерезису |
| [nfoenki/claude-cursor-rules](https://github.com/nfoenki/claude-cursor-rules) (1★) | Глобальний settings-hook на Python: always на SessionStart, globs на першому Read/Edit, Manual через `@rule-name` | cursor-rules повністю | Не mod (окремий процес на подію), лише macOS/Linux, немає `@file`-згадок, ліміт `additionalContext` 10 000 символів |
| [roof-mod / roof-probe](https://mods.aidojo.si/) (kagamiurayama, 20★) | Переписує вбудовані reminders і секції через `prompt.compose`, `prompt.section`, `prompt.attachment`; probe логує всі секції системного промпту | prompt DSL: доводить, що секції системного промпту можна перезбирати з mod-а | Статичні заміни, без шаблонів, умов, скриптів |
| [context-report](https://mods.aidojo.si/) (darkroomengineering, 47★) | Друкує, які instruction-файли двигун завантажив (tier, шлях, @-імпорти, розмір) на `prompt.context` | моніторинг: готовий патерн для `/gate why` і для перевірки, що `.mdc` справді потрапили в контекст | Лише спостереження |
| [memory-lens](https://mods.aidojo.si/) (orchestkit, 286★) | На кожен промпт підбирає кілька релевантних нотаток: один рядок людині, один context-запис моделі, без мережі | skill-gate: мінімальна інжекція «по одному запису», локальний матчинг без класифікатора | Пам'ять, а не skills/rules |
| [context-guard](https://mods.aidojo.si/) (melodic-software, 21★) | Зони контексту (smart / acceptable / dumb) із `zones.json`, повідомляє моделі про перехід, blocking-режим, рядок стану | бюджети `onExceed`, рядок стану | Не керує тим, що завантажується |
| [spike-describe](https://mods.aidojo.si/) (ucsandman/Agnostic-AI) | Перевіряє, чи доходить до моделі переписаний `tool.describe`, чи ховає `agent.offer` тип субагента | skill-gate: саме ті два відкриті питання, які треба підтвердити | Spike, не продукт |
| [claude-skills-doctor](https://pypi.org/project/claude-skills-doctor/) і [0xDarkMatter/claude-mods](https://github.com/0xDarkMatter/claude-mods) | Діагностика бюджету skill-листингу (1 % контекстного вікна, `SLASH_COMMAND_TOOL_CHAR_BUDGET`, `skillOverrides`) | показують, що без gate модель мовчки втрачає описи skills | CLI-діагностика, не runtime |
| [rulesync](https://github.com/dyoshikawa/rulesync), [ruler](https://github.com/intellectronica/ruler), [vibe-rules](https://github.com/FutureExcited/vibe-rules) | Транспіляція правил між інструментами | fallback-шар cursor-rules | Без runtime-семантики `.mdc` |

**Що вже є нативно і що mod не має дублювати.** Claude Code сам тримає листинг skills у бюджеті 1 % контекстного вікна і при переповненні скидає описи найменш уживаних ([docs skills](https://code.claude.com/docs/en/skills)); `skillOverrides` у settings вимикає skill або лишає тільки назву; `disable-model-invocation` і `paths` у frontmatter обмежують автозапуск; `ENABLE_TOOL_SEARCH=auto` відкладає завантаження схем MCP-інструментів до першого пошуку ([features-overview](https://code.claude.com/docs/en/features-overview)); `/context` і `/doctor` показують розмір листингу. Mod надбудовує над цим динаміку: той самий механізм, але залежно від задачі й моделі, з поясненням.

**Чим `context-gate` відрізняється від найближчих.** Профілі з груп і tiers замість «одного skill на промпт»; класифікація раз на задачу з гістерезисом, а не на кожен хід; одне джерело правди для `.mdc`, skills і MCP; DSL системного промпту замість статичних замін; і `/gate why` як обов'язкова частина, бо без пояснення автоматичний відбір не можна налагодити. Технічна знахідка з jev-pilot, яку беремо напряму: листинг skills приходить як `prompt.attachment {type: "skill_listing"}`, тобто фільтрувати його можна одним хуком із `{ text }`, без правки settings.

## Архітектура

Один плагін, один хуковий модуль `hooks/register.ts`, три шари як підмодулі під `hooks/`, і спільне ядро без залежностей від Claude Code — так само, як `agents-md` тримає частини поряд із `register.ts`, а `shiftwork-core` не залежить від pi.

&#91;embedded content: архітектура context-gate · 4 групи подій, 3 шари, 1 ядро\]

Події входять зверху, кожен шар відповідає за свою частину контексту, ядро тримає конфігурацію, чисту логіку рішень і стан.

**Карта подій mods API, які використовує плагін** (усі з [reference](https://code.claude.com/docs/en/plugins/mods/reference)):

| Подія | Хто хукає | Що робить |
| --- | --- | --- |
| `session.start` | ядро | читає `gate.json`, реєструє `/gate` і `/rule`, вмикає рядок стану |
| `prompt.context` | cursor-rules, DSL | скидає дедуплікацію (перерахунок після compaction і `/clear`), додає Always-правила як `blocks` |
| `prompt.submit` | cursor-rules, skill-gate | `@rule`, Auto Attached для `@file`; сигнали задачі для профілю; перший промпт → класифікація |
| `tool.call` (Read, Edit, Write, NotebookEdit) | cursor-rules | glob-правила як контекст після результату, per-agent dedup, перевірка partial read |
| `tool.call` (`mcp__*`) | skill-gate | `{ deny }` для інструментів поза профілем, із підказкою «увімкни через /gate +name» |
| `prompt.attachment {type: skill_listing}` | skill-gate | переписує листинг skills під профіль |
| `tool.describe`, `agent.offer` | skill-gate | коротший опис або приховування субагента |
| `skill.prompt` | skill-gate | заміна тіла вимкненого skill короткою відмовою; preload для слабких tiers |
| `prompt.compose` | DSL | рендер секцій із `.claude/prompt/*.md`, сортування за `scope` |
| `turn.step` (спостерігач) | skill-gate | фіксує `e.model`, перераховує tier при зміні моделі чи субагента |
| `session.measure`, `turn.complete` | skill-gate | відсоток контексту й бюджети `onExceed`, оновлення рядка стану |
| `command.run {gate, rule}` | ядро | ручне керування і `/gate why` |
| `ui.render {AbovePrompt, Pane}` | ядро | рядок стану, pane журналу рішень |

Порядок у ланцюжку mods важливий: `sec-default` на Team/Enterprise іде першим, керовані `PreToolUse` — до будь-якого `tool.call`, а `PreToolUse` із settings-файлів — після останнього `next`. Тому `{ deny }` для MCP ставимо в `tool.call`, а не в `tool.check`, щоб не перебивати організаційні правила.

## Конфігурація `.claude/gate.json`

Один файл у репозиторії описує групи skills, рівні моделей, профілі задач і бюджети; його ж читає shiftwork-runner. Модель даних узята зі `shiftwork.json` (`skillGroups → tiers → models`) і доповнена профілями задач і правилами для MCP.

```json
{
  "$schema": "https://…/context-gate.schema.json",
  "skillGroups": {
    "core":     ["tdd", "diagnosing-bugs"],
    "frontend": ["react-*", "tailwind", "storybook"],
    "backend":  ["nestjs", "prisma", "api-design"],
    "git":      ["git-conventions", "resolving-merge-conflicts"],
    "docs":     ["writing-for-agents"]
  },
  "mcpGroups": {
    "frontend": ["figma", "playwright"],
    "backend":  ["postgres"],
    "always":   ["github"]
  },
  "tiers": {
    "premium":  { "skills": ["core"] },
    "standard": { "skills": ["core", "git"] },
    "quick":    { "skills": ["core", "git", "docs"], "preload": ["project-conventions"] }
  },
  "models": { "claude-opus-*": "premium", "claude-sonnet-*": "standard", "claude-haiku-*": "quick" },
  "profiles": {
    "frontend": { "skills": ["frontend"], "mcp": ["frontend", "always"], "agents": ["ui-reviewer"],
                  "when": { "paths": ["apps/web/**", "**/*.tsx"], "branch": "^feat/ui" } },
    "backend":  { "skills": ["backend"], "mcp": ["backend", "always"],
                  "when": { "paths": ["apps/api/**", "**/*.service.ts"] } },
    "git":      { "skills": ["git"], "mcp": ["always"], "agents": [] },
    "docs":     { "skills": ["docs"], "mcp": [] }
  },
  "classify": { "mode": "shadow", "model": "haiku", "minConfidence": 0.7, "recheckOn": ["/gate new", "compact"] },
  "budgets": {
    "default": { "softContextPct": 70, "hardContextPct": 85 },
    "tiers":   { "quick": { "softContextPct": 55, "hardContextPct": 70 } }
  },
  "onExceed": {
    "softContextPct": { "do": "section", "section": "budget-warning" },
    "hardContextPct": { "do": "notice", "text": "Контекст {pct}%: запусти /compact або /handoff" }
  },
  "escalation": { "order": ["quick", "standard", "premium"], "after": { "verifyFailed": 2, "stallTurns": 6 } },
  "brief": { "enabled": true, "model": "opus", "maxChars": 2000, "tiers": ["quick", "standard"] },
  "providers": { "git": { "kind": "module", "builtin": true }, "fs": { "kind": "module", "builtin": true } },
  "ruleSources": [ { "kind": "cursor-mdc", "dir": ".cursor/rules" } ],
  "gates": [
    { "name": "read-before-write", "on": "write", "builtin": true, "tiers": ["quick", "standard"] },
    { "name": "tests", "on": "commit", "run": ["pnpm", "test"], "pass": "exitCode == 0" }
  ],
  "cursorRules": { "enabled": true, "nested": true, "maxCharsPerInjection": 30000 },
  "prompt": { "dir": ".claude/prompt", "runCacheDefault": "5m" }
}
```

**Семантика полів**

| Поле | Значення | Примітка |
| --- | --- | --- |
| `skillGroups`, `mcpGroups` | ім'я групи → glob по іменах skills (`react-*`) або MCP-серверів | імена беруться з `$.tool.list()` і з листингу skills, тож нічого не треба дублювати |
| `tiers` | базовий набір груп для рівня моделі; `preload` — skills, тіло яких вбудовується одразу | ідея shiftwork: слабка модель сама skill не підтягне |
| `models` | glob на ім'я моделі → tier | модель читається з `$.session.model()` і з `e.model` на `turn.step` |
| `profiles` | набір груп під задачу; `when` — детерміновані сигнали (шляхи, гілка) | `when` перевіряється до класифікатора; збіг кількох профілів → об'єднання |
| `classify` | `shadow` лише логує, `auto` застосовує; `recheckOn` — коли перекласифікувати | починати завжди з `shadow` |
| `budgets` / `onExceed` | пороги по контексту і дія: увімкнути DSL-секцію, показати notice, викликати `$.session.compact` | формат «що → дія», як `onExceed` у shiftwork |
| `cursorRules` | `nested` вмикає пошук `*/.cursor/rules` у підпапках; ліміт символів на одну інжекцію | nested у самому Cursor працює ненадійно, тому опція |

**Пріоритет при обчисленні набору** (від найсильнішого): ручна команда `/gate +x -y` на цю сесію → збіг `profiles[*].when` → результат класифікатора (якщо `auto` і впевненість ≥ `minConfidence`) → `tiers[models[model]]` → `standard` з попередженням у журналі. Файл валідований JSON Schema на `session.start`; помилка схеми не ламає сесію, а вимикає шар і пише причину в `/gate why`.

## Шар 1 — cursor-rules

Шар відтворює чотири типи правил Cursor так, як їх описує [документація Cursor](https://cursor.com/docs/rules), і використовує для доставки ті самі механізми, якими Claude Code доставляє nested CLAUDE.md і AGENTS.md (README вбудованого mod [agents-md](https://github.com/anthropics/claude-code/blob/main/mods/agents-md/README.md)).

| Тип Cursor | Умова у frontmatter | Подія mod | Доставка |
| --- | --- | --- | --- |
| Always | `alwaysApply: true` | `prompt.context` | блок серед instruction-файлів проєкту, після CLAUDE.md |
| Auto Attached | `globs` є, `alwaysApply: false` | `tool.call` Read/Edit/Write/NotebookEdit; `prompt.submit` для `@file` | контекст після результату інструмента, фрейм `Contents of <path> (Cursor rule <id>):` |
| Agent Requested | лише `description` | транспіляція в `.claude/skills/cursor-<id>/SKILL.md` | нативний skill; Cursor 2.4 сам мігрує такі правила у skills і читає `.claude/skills/` |
| Manual | без `description` і `globs` | `prompt.submit` (`@id`) і `/rule <id>` | текст правила як `context` промпту |

**Парсер `.mdc`.** Власний лінійний парсер frontmatter без YAML-бібліотеки: `globs: *.ts` — невалідний YAML, але стандартний запис у Cursor. Приймає рядок через кому (кома всередині `{a,b}` не роздільник), inline-масив `["a", "b"]` і YAML-список; `!pattern` — негація; BOM і CRLF нормалізуються. Файл без frontmatter — Manual. `@file`-посилання в тілі правила розгортаються в один рядок «див. файл …», а не вбудовуються.

**Glob-матчинг.** Без залежностей (у модулі немає bare import, крім `claude-code`): `**`, `*`, `?`, `{a,b}`, `[…]`, негація. Шляхи нормалізуються до POSIX відносно `$.session.root()`; на Windows (визначається з `$.env.get('OS')` або з форми `$.session.cwd()`) порівняння нечутливе до регістру. Якщо потрібна повна сумісність із picomatch — бандл у `hooks/vendor/picomatch.js` через esbuild `--platform=neutral`.

**Дедуплікація.** Множина `seen` у `$.state`, ключ `<agentId або main>:<ruleId>`; субагент, що не є fork, отримує правило на власному першому збігу (так робить agents-md). Скидання — на `prompt.context`, бо саме він перераховується після compaction і `/clear`; `session.start` після `/clear` не спрацьовує, а `session.compact` фіксується до стискання.

**Edge cases, які закриває реалізація**

1. Read самого `.mdc` з `offset`/`limit` або обрізаний по token cap не вважається доставкою правила (PR #96364 для agents-md).
2. Правило в контексті після результату приходить після запису файлу; для `Write` нового файлу з незастосованим правилом опція `strictWrite` повертає `{ deny }` з текстом правила і проханням повторити запис.
3. `@`-згадка файлу не проходить через `tool.call` (issue #98796), тому Auto Attached для `@file` обробляється в `prompt.submit`.
4. Вкладені `.cursor/rules` у підпапках: опція `nested`; glob отримує префікс директорії (`packages/api/src/**`). Cursor сам підтримує це ненадійно, тому за замовчуванням вимкнено.
5. Ліміт `maxCharsPerInjection`: правила понад ліміт замінюються рядком «також діє: \<path>, прочитай за потреби».
6. Кеш правил у замиканні модуля, інвалідація через `classic.FileChanged` для `.cursor/rules/**` і при зміні `$.session.root()`.
7. Одночасно активний mod і згенеровані `.claude/rules/cursor/*.md` дублюють контекст: mod вимикається, якщо бачить цю директорію, і пише про це в `/gate why`.

## Шар 2 — skill-gate

Skill-gate — це стадії signals → decide → budget єдиного конвеєра (див. «Єдина модель»); skills, MCP і субагенти для нього — елементи різного kind. Він обчислює один об'єкт `Gate = { profile, tier, skills: {on, nameOnly, off, preload}, mcp: {on, off}, agents: {on, off}, reason[] }` і застосовує його в чотирьох точках. Усе рішення — чиста функція `decideGate(config, signals, state)` без побічних ефектів; хуки лише збирають сигнали і застосовують результат.

**Сигнали, від дешевих до дорогих**

1. Ручна команда `/gate <profile>`, `/gate +group -group`, `/gate off` — діє до кінця сесії або до `/gate auto`.
2. `profiles[*].when`: шляхи з `@`-згадок у промпті, останні файли з `tool.call`, гілка з `$.session.repo()`; перший збіг фіксує профіль.
3. Модель: `$.session.model()` на старті, `e.model` на `turn.step`; `e.agentId` → субагент отримує tier своєї моделі.
4. Класифікатор `$.model.classify` (вбудований, без API-ключа) на першому промпті задачі і при `recheckOn`. Запитання типізовані: `profile: choice(frontend|backend|git|docs|mixed)`, `confidence`. Режим `shadow` лише пише рішення в журнал; `auto` застосовує при `confidence ≥ minConfidence`.

**Гістерезис.** Профіль змінюється лише з сигналу 1, із нового збігу `when` на іншому профілі два ходи поспіль, або після `/gate new` чи compaction. Між змінами набір стабільний, тож описи інструментів і листинг skills у системному промпті не стрибають і prompt cache зберігається.

**Застосування**

| Що | Подія | Механіка | Статус |
| --- | --- | --- | --- |
| Листинг skills | `prompt.attachment {type: "skill_listing"}` | повернути `{ text }` лише з `on`; для `nameOnly` — назва без опису | підтверджено в jev-pilot; формат тексту звірити з `e.detail` |
| Тіло skill | `skill.prompt` | `off` → `{ text: "Skill <name> вимкнено профілем <p>. Увімкни: /gate +<group>" }`; `preload` → вбудувати тіло в DSL-секцію `preload` на `prompt.compose` | задокументовано |
| MCP-інструменти | `tool.describe` + `tool.call {tool: /^mcp__/}` | опис → один рядок «вимкнено профілем»; виклик → `{ deny }` з тим самим текстом | `tool.describe` для MCP перевірити (spike-describe) |
| Субагенти | `agent.offer` | `{ isOffered: false }` для типів поза профілем | задокументовано |
| Preload для слабких tiers | `prompt.compose` | DSL-секція `preload` зі `scope: profile` | через шар 3 |

Повністю прибрати MCP-схему з промпту mod не може, якщо `tool.describe` не доходить до моделі; тоді fallback — `ENABLE_TOOL_SEARCH=auto` (схеми відкладено нативно) плюс `{ deny }`. Це все одно економить контекст: описи стають короткими, а повні схеми не завантажуються до пошуку.

**Бюджети.** На `session.measure` і `turn.complete` читається `$.session.usage().context.percent`. Пороги з `budgets` по tier; `onExceed` виконує дію один раз на перетин: увімкнути DSL-секцію (`budget-warning`), показати `$.ui.notice`, або викликати `$.session.compact()` з інструкцією зберегти список активних правил і профіль. Після compaction профіль і `seen` перераховуються з `prompt.context`.

**Журнал рішень.** Кожен виклик `decideGate` пише запис `{ turn, trigger, profile, tier, enabled, disabled, reason }` у кільцевий буфер (`$.state`, 200 записів) і, за опцією, у `.claude/gate.log.jsonl`. Це джерело для `/gate why`, pane і для режиму `shadow`, де видно, чи класифікатор узагалі вгадує.

## Шар 3 — промпт як TSX над спільною AST

Системний промпт описується TSX-компонентами у `.claude/prompt/*.prompt.tsx`. TSX не виконується в рантаймі: при збереженні (watch, LSP або `context-gate build`) компонент компілюється у дерево секцій — AST, у якій `If`, `Each`, `Run`, `Call`, `Include` лишаються вузлами, а не обчисленими значеннями. У сесії mod читає `.claude/prompt/.compiled/*.json` і виконує AST тотальним інтерпретатором з лімітом кроків у `prompt.compose`. Так автор отримує TypeScript із типами й автокомплітом, а рантайм — завершення, статичний аналіз і health-метрики.

**Чому саме так, а не TSX у рантаймі.** У hooks-модулі mod-а немає Node і динамічного імпорту файлів репозиторію, а JSX-runtime там налаштований під `ui.render`; повна мова в рантаймі зняла б гарантії з розділу «Межі мови». Компіляція на save переносить довільні обчислення на етап збірки (один раз, під таймаутом) — рівно туди, де за правилами живе «повна мова», — а в AST потрапляють вузли і дані.

**Компоненти** — з пакета `@context-gate/jsx`, типізовані, без залежностей від React:

```tsx
import { Prompt, Section, If, Each, Let, Set, Repeat, Run, Call, Use, Include, Skill, Rule, Mcp, Lazy, Tier, Debug, Assert } from '@context-gate/jsx'

export default (
  <Prompt>
    <Section id="identity" scope="static">
      Ти senior TypeScript-інженер у проєкті {ctx.repo.name}.
    </Section>

    <Section id="project-rules" scope="profile" budget={4000}
             when={ctx.gate.profile.in(['frontend', 'backend'])}>
      <Each of={ctx.cursor.always}>{r => <li>{r.body}</li>}</Each>
      <If test={ctx.arch.available}>
        Межі архітектури:
        <Each of={ctx.arch.deny}>{d => <li>{d.from} не імпортує {d.to}</li>}</Each>
      </If>
    </Section>

    <Section id="workflow" scope="profile">
      Зміни малими кроками, тести перед комітом.
      <Tier is={['quick', 'standard']}>
        <ol>
          <li>Прочитай файли з задачі і тести поряд.</li>
          <li>Покажи план із 3–6 кроків до першої правки.</li>
          <li>Після кожної правки: <code>pnpm test -- {'<шлях>'}</code>.</li>
        </ol>
      </Tier>
      <Tier is="quick">
        <Each of={ctx.fs.examples('src/**/*.service.ts', 1)}>{ex => <Fence lang="ts" title={ex.path}>{ex.body}</Fence>}</Each>
      </Tier>
    </Section>

    <Section id="repo-state" scope="volatile" when={ctx.gate.profile !== 'docs'}>
      Гілка {ctx.git.branch}.
      <Run lang="bash" cache="5m" as="log">git log --oneline -5</Run>
      <pre>{ctx.log}</pre>
    </Section>

    <Section id="references" scope="profile">
      <Lazy name="api-conventions" path="docs/api.md">Умовності REST API</Lazy>
      <Include path="CONVENTIONS.md" mode="ref" />
      <Skill name="tdd" mode={ctx.gate.tier === 'quick' ? 'inline' : 'ref'} />
      <Mcp server="github" tool="list_prs" args={{ state: 'open' }} as="prs" />
      <If test={ctx.ctx.percent > ctx.budgets.soft}>Контекст {ctx.ctx.percent}% — відповідай стисло.</If>
      <Debug>{['prs', ctx.prs?.length]}</Debug>
    </Section>
  </Prompt>
)
```

`ctx` — типізований об'єкт контексту рендера (`Ctx`), згенерований з `gate.json`, провайдерів і `gate.index.json`: `ctx.arch.deny` має тип з JSON-схеми провайдера, `ctx.gate.profile` — union із профілів, неіснуюче поле — помилка компіляції. Вирази в пропсах і фігурних дужках не обчислюються під час збірки, а транслюються у вузли AST (`when`, `test`, `of`) з тим самим інтерпретатором виразів і білим списком pipe-фільтрів; довільний TS у них (замикання з побічними ефектами, виклики поза `ctx`) — помилка компіляції `G160` з підказкою винести у провайдер.

**Пропси `Section`**

| Проп | Тип | Призначення |
| --- | --- | --- |
| `id` | string | ім'я секції; збіг з `id` секції Claude Code означає заміну її тексту |
| `scope` | `'static' \| 'profile' \| 'volatile'` | порядок у промпті й політика кешу |
| `when` | `Expr<boolean>` | секція присутня, лише якщо істинно |
| `budget` | number | максимум символів; надлишок обрізається з позначкою |
| `after` | string | id секції, після якої вставити (у межах `scope`) |
| `tier` | `Tier \| Tier[]` | скорочення для `<Tier>` навколо всієї секції |

**Компоненти і їхні AST-вузли**

| Компонент | Вузол | Семантика |
| --- | --- | --- |
| `If` / `Else` | `if` | умова; вкладення до 3 |
| `Each of children={fn}` | `each` | по готових списках; вкладення до 2 |
| `Let` / `Set` | `let` / `set` | константа / змінна в межах секції; `Store` — у `data.*` |
| `Repeat n` | `repeat` | межа відома до запуску, ≤ 1 000; `Break`, `Continue` |
| `Run lang cache as store needs` | `run` | код для `executors`; результат — дані |
| `Use`, `Call` | `use` / `call` | модуль скриптової мови і виклик його функції |
| `Include`, `Section ref`, `Skill`, `Rule`, `Mcp`, `Lazy` | `include` / `ref` / `lazy` | включення в режимах `inline` / `ref` / `lazy` |
| `Tier is` | `tier` | варіант для рівнів моделі |
| `Fence`, `List`, `Table` | форматування | детерміновані Markdown-примітиви на виході |
| `Debug`, `Assert`, `Log`, `Trace` | `debug` | поза промптом, у trace і журнал |

Звичайні HTML-подібні теги (`<ol>`, `<li>`, `<pre>`, `<code>`) рендеряться в Markdown; текст між тегами — як є, без JSX-пробільних сюрпризів: компілятор нормалізує відступи за правилами Markdown, а не JSX.

**Власні компоненти.** Функція `(props) => JSX` — це `@fn`: компілюється інлайном у місці виклику, без рекурсії (`G151`) і без побічних ефектів. Компонент, якому потрібні обчислення (парсинг файлу, мережа), — це провайдер `module`: він експортує функцію над даними, а в TSX викликається як `ctx.myProvider.fn(...)`. Бібліотека `@context-gate/jsx` сама містить готові: `<CursorRules match={path} />`, `<Examples glob n />`, `<HealthWarning />`.

**Збірка.** `context-gate build` (і watch у LSP) запускає esbuild із `jsxFactory` бібліотеки, виконує модуль у Node під таймаутом 10 с, серіалізує дерево в `.claude/prompt/.compiled/<id>.json` з `source-hash`. Рантайм, `context-gate run`, preview редактора й health читають лише цей JSON. Застарілий `.compiled` відносно `.tsx` → `H013` і попередження в рядку стану. Markdown-форма (`@if`, `@each`, …), яка використовується в прикладах нижче як скорочення, — другий парсер у ту саму AST; її можна додати пізніше для не-розробників, а поки `@x` в тексті специфікації означає компонент `<X>`.

**Економія контексту і кеш.** `static`-секції рендеряться один раз на сесію і порівнюються за хешем; `profile` — при зміні `Gate`; `volatile` — щоходу, останніми. `Run` без `cache` у `static` — помилка збірки. `budget` обрізає текст, `/gate health` показує токени кожної секції.

**Безпека.** Етап збірки виконує TS з правами користувача — тому `build` запускається явно (save у редакторі, `watch`, CI), файли `.prompt.tsx` з репозиторію проходять рев'ю як код, імпорти обмежені `@context-gate/jsx` і локальними компонентами, а у `claude -p` збірка не відбувається — читається тільки `.compiled`. `Run`/`Call` у рантаймі — як у «Виконавці скриптів»: білий список бінарників, дані лише через stdin.

### Збірка через mod: коли і як компілюється TSX

Mod не виконує TSX сам, але може запустити збірку як процес: `$.process.run` є в mods API, його час не рахується в 10-секундний бюджет хука, а таймаут за замовчуванням 30 с. CLI збірки лежить у самому плагіні (`$.plugin.root()` + `dist/cli.js`), тому залежить лише від наявності `node` у `PATH`.

**Життєвий цикл**

| Момент | Що робить mod | Вартість |
| --- | --- | --- |
| `session.start` | перевіряє `.compiled/*.json` проти `.prompt.tsx` за `source-hash`; застаріле або відсутнє → `node dist/cli.js build` один раз для всіх файлів | esbuild + виконання модулів, типово 0,2–0,8 с один раз на сесію |
| `classic.FileChanged` для `.claude/prompt/**/*.tsx`, `gate.json`, `scripts/**` | інкрементальна збірка лише зміненого файлу у фоні; результат підхоплюється наступним `prompt.compose` | десятки мс |
| `prompt.compose` | лише `$.fs.stat` на `.tsx` і `.compiled` (mtime); розбіжність → синхронна збірка цього файлу, якщо вклалась у 2 с, інакше — попередній `.compiled` і `H013` | без збірки — мікросекунди |
| `prompt.context` (після compaction, `/clear`) | те саме, що `prompt.compose` | — |
| `command.run /gate build` | примусова повна збірка з виводом помилок у pane | — |

**Де ще збирається, щоб mod майже ніколи не збирав сам.** LSP/редактор збирає на save (`watch`), pre-commit hook — перед комітом, CI — перед запуском `claude -p`. Тому у звичайний день `session.start` знаходить актуальний `.compiled` і нічого не запускає. `.compiled/` комітиться: це дає відтворюваний промпт у CI та в `claude -p`, де збірка не виконується взагалі, і дозволяє рев'юїти diff AST поруч із diff TSX.

**Помилки збірки.** Помилка TypeScript або `G1xx` з компілятора → mod лишає попередній `.compiled`, пише `H013`/`G*` у журнал і рядок стану (`prompt ⚠ build`), показує перші три повідомлення в `$.ui.notice`; промпт не ламається і не стає порожнім. Відсутній `node` → те саме, з підказкою; відсутній `.compiled` і неможлива збірка → секції TSX пропускаються, решта джерел (правила, skills) працює.

**Довіра і межі.** Збірка виконує TS із репозиторію з правами користувача, тому при першій збірці в новому репозиторії mod один раз запитує через `$.ui.ask` («Зібрати промпти з .claude/prompt цього репозиторію?») і запам'ятовує відповідь у `$.store` за шляхом репозиторію; `trustBuild: always` у user-settings вимикає запит. У `claude plugin validate` збірка видима як `process.run` і `plugin.root` — єдині канали. На Team/Enterprise із `allowManagedModsOnly` плагін і так не завантажиться, а зі своїм managed-складом збірку можна винести в pre-commit і вимкнути в mod-і (`build: never`).

**Чому не компілювати в `prompt.compose` щоразу.** Збірка на кожен промпт додавала б 200–800 мс латентності та непотрібні запуски Node; перевірка mtime коштує мікросекунди і дає ту саму гарантію актуальності. Єдиний випадок синхронної збірки в `prompt.compose` — редагування `.tsx` поза редактором і без `FileChanged` (наприклад, `git checkout` гілки): тоді перший промпт після перемикання платить ці сотні мілісекунд один раз.

### Промпти як skills: аргументи і рендер у момент виклику

Будь-який TSX-промпт може оголосити себе skill-ом: тоді він з'являється в Claude Code (і в Cursor, Codex, pi, які читають `.claude/skills/`) як `/name`, приймає аргументи, а рендериться не на збірці, а в момент виклику — з розпарсеними аргументами і живим контекстом сесії.

**Оголошення**

```tsx
export default (
  <Prompt as="skill" name="release-notes"
          description="Чернетка release notes з комітів від тегу. Приклади: /release-notes v1.4.0, /release-notes --since v1.4.0 --format slack"
          args={{
            since:  arg.string({ positional: 0, required: true, hint: '<tag|sha>' }),
            format: arg.enum(['md', 'slack', 'github'], { default: 'md' }),
            scope:  arg.string({ default: null }),
            dry:    arg.flag(),
          }}
          invoke={{ user: true, model: 'tool' }}   // /release-notes для людини, інструмент для моделі
          tiers={['standard', 'premium']}>
    <Use name="gitx" path="scripts/git-extra.js" />
    <Let name="commits" value={ctx.gitx.commitsSince(ctx.args.since, ctx.args.scope)} />
    <Assert test={ctx.commits.length > 0} message="Немає комітів після {ctx.args.since}" />
    Склади release notes у форматі {ctx.args.format} з цих комітів:
    <Each of={ctx.commits}>{c => <li>{c.type}({c.scope}): {c.subject}</li>}</Each>
    <If test={ctx.args.dry}>Лише покажи чернетку, нічого не записуй.</If>
  </Prompt>
)
```

**Що генерує збірка.** Для кожного `as="skill"` — `.claude/skills/<name>/SKILL.md` з frontmatter (`name`, `description`, `argument-hint` з схеми, `disable-model-invocation` за `invoke.model`) і `.compiled/<name>.json`. Тіло SKILL.md — не статичний текст, а один рядок виклику рендера, щоб skill працював і без mod-а:

```markdown
---
name: release-notes
description: Чернетка release notes з комітів від тегу…
argument-hint: <tag|sha> [--format md|slack|github] [--scope <s>] [--dry]
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" run release-notes --args "$ARGUMENTS" --ctx-from live`
```

Запис `` !`…` `` у skill — нативне виконання команди перед відправкою тексту моделі; `$ARGUMENTS` — нативна підстановка аргументів. Тому в `claude -p`, Cursor чи pi виклик `/release-notes v1.4.0` рендерить промпт через CLI з живим контекстом і без mods API. (Підтримку `` !`…` `` у SKILL.md для конкретної версії Claude Code та інших harness-ів треба підтвердити; fallback — попередньо відрендерене тіло з дефолтними аргументами і позначкою, що воно статичне.)

**З mod-ом — те саме, але в процесі.** Хук `skill.prompt` спрацьовує, коли Claude Code розгортає текст skill-а; mod бачить ім'я, впізнає свій skill, парсить аргументи, рендерить AST з `ctx.args` і контекстом сесії (`gate.profile`, `tier`, `ctx.percent`) і повертає `{ text }`. Рядок із `` !`…` `` при цьому не виконується — mod підміняє тіло цілком. Поля події зі значенням аргументів звірити в `.d.ts`; якщо їх немає, аргументи беруться з `$ARGUMENTS` у тексті події.

**Парсинг аргументів.** Один парсер у ядрі, той самий для `/name`, CLI і `$ARGUMENTS`: позиційні за `positional`, іменовані `--key value`, прапорці `--dry`, `--key=value`, лапки, `--` для сирого хвоста (`arg.rest()`). Типи: `string`, `number`, `enum`, `flag`, `path` (перевіряється існування відносно кореня), `list` (через кому), `json`. Помилка парсингу не йде моделі як сирий stack: рендериться стандартна секція `usage` — «Невірні аргументи: `format` має бути md|slack|github. Використання: /release-notes \<tag|sha> \[--format …\]» — і skill повертає її як свій текст, щоб модель перепитала людину або виправила виклик сама.

**Виклик моделлю.** `invoke.model: 'tool'` реєструє skill ще й інструментом через `$.tool.register` з JSON-схемою, згенерованою з тієї самої `args` — модель викликає `release_notes({ since: 'v1.4.0', format: 'github' })` структуровано, без парсингу рядка; результат інструмента — відрендерений промпт. `invoke.model: 'skill'` лишає нативну автоактивацію за `description`; `invoke.model: false` — лише `/name` для людини (`disable-model-invocation: true`).

**Як елемент конвеєра.** Такий skill — `Item kind=skill` з `provenance: prompt-tsx`, тож він підпорядкований групам, профілям, `tiers` і бюджету листингу, як будь-який інший; `/gate why` показує, скільки разів його викликали, з якими аргументами і скільки коштував рендер (`H*`). Аргументи, контекст і результат рендера пишуться в журнал як подія `skill-render`, тож `context-gate run release-notes --ctx-from session:latest` відтворює виклик пізніше один в один.

**Приклад для спроби.** `release-notes` вище, плюс два короткі: `pr-review --pr 123 --focus security` (через `<Mcp server="github" tool="get_pr" />` тягне diff і рендерить чеклист під профіль) і `explain <id>` (через провайдер `arch` вставляє сигнатуру функції й правила її шару). Усі три живуть в `examples/skills/` плагіна і ставляться командою `context-gate example skills`.

### Імпорти: інші TSX-файли, JSON, Markdown, бібліотеки — і один промпт на виході

Промпт — звичайний TS-модуль, тому він імпортує інші файли так само, як код, а збірка (esbuild) складає все дерево імпортів в один `.compiled/<id>.json`. У рантаймі mod читає один файл; жодних імпортів у момент рендера не відбувається.

```tsx
import { Prompt, Section, Each, If } from '@context-gate/jsx'
import { Identity, SafetyRules } from './shared/base.prompt.tsx'       // інші промпти як компоненти
import { CodeStyle } from './shared/style.prompt.tsx'
import conventions from '../../CONVENTIONS.md'                          // Markdown → текст (data)
import glossary from './data/glossary.json'                             // JSON → об'єкт (data)
import pkg from '../../package.json' with { type: 'json' }
import { groupBy } from 'lodash-es'                                      // бібліотека: лише на етапі збірки
import { semver } from './lib/semver.ts'                                 // локальний TS-хелпер: теж на збірці

const byType = groupBy(glossary.terms, 'type')                         // обчислено на збірці → у AST як дані

export default (
  <Prompt>
    <Identity repo={ctx.repo} />
    <SafetyRules level="strict" />
    <Section id="style" scope="static" budget={2500}>
      <CodeStyle />
      <Include text={conventions} mode="inline" />
    </Section>
    <Section id="glossary" scope="static">
      <Each of={Object.entries(byType)}>{([type, terms]) => <li>{type}: {terms.map(t => t.name).join(', ')}</li>}</Each>
    </Section>
    <Section id="scripts" scope="profile" when={ctx.gate.profile === 'backend'}>
      Команди проєкту: {Object.keys(pkg.scripts).join(', ')}; поточна версія {semver.bump(pkg.version, 'patch')}
    </Section>
  </Prompt>
)
```

**Що з чим відбувається на збірці**

| Імпорт | Як обробляється | Куди потрапляє |
| --- | --- | --- |
| `.prompt.tsx` | компоненти інлайняться в дерево; `Section` з того самого `id` з двох файлів → `G161` | вузли AST |
| `.tsx`/`.ts` без промптів | звичайний TS-хелпер: виконується на збірці, результат — значення | дані або інлайн у вузли |
| `.json`, `.yaml`, `.toml` | парсяться на збірці | дані (`JSON`), з `source-hash` файлу |
| `.md`, `.txt` | текст; frontmatter відокремлюється у `.meta` | дані; `<Include text>` робить вузол `include` |
| бібліотеки з `node_modules` | тільки на збірці; у `.compiled` їх немає | обчислені значення |
| `ctx.*` | ніколи не обчислюється на збірці | вузол-вираз, обчислюється в рантаймі |

Два різні світи позначаються просто: усе, що не залежить від `ctx`, обчислюється на збірці й лягає в AST як константа (у `--trace` воно підписане `build-time`); усе, що торкається `ctx`, стає виразом і живе в рантаймі. Змішування (`lodash.sortBy(ctx.commits, …)`) — `G160` з підказкою: або перенести обчислення у `module`-провайдер, або використати pipe-фільтр (`ctx.commits | sort('date')`).

**Один промпт на виході.** `.compiled/<id>.json` містить повне дерево з усіма інлайнами, вбудованими даними і `sources: [{ path, hash }]` для кожного імпорту. Зміна будь-якого з них інвалідовує збірку (`H013`), а `git diff` на `.compiled` показує, що саме змінилось у підсумковому промпті, навіть якщо правка була у спільному `base.prompt.tsx`. Розмір `.compiled` обмежений 2 МБ — більше означає, що дані треба винести в `<Lazy>` або провайдер, і збірка каже про це (`G162`).

**Спільні бібліотеки промптів.** Тека `.claude/prompt/shared/` або npm-пакет (`@acme/prompts`) з компонентами `Identity`, `SafetyRules`, `CodeStyle`, `ReleaseNotes` — так промпти версіонуються і перевикористовуються між репозиторіями, як UI-кіт. Пакет може експортувати і skills (`as="skill"`): `context-gate build` збирає їх у `.claude/skills/` цього репозиторію з позначкою походження в frontmatter.

**Markdown-промпти з інших інструментів.** `import rules from '../../.cursor/rules/react.mdc'` дає текст і frontmatter (`globs`, `alwaysApply`) як дані — зручно, коли одне правило треба вбудувати в конкретну секцію замість загального конвеєра `itemSources`. `AGENTS.md`, `CLAUDE.md`, `SKILL.md` імпортуються так само.

### Межі мови: тотальна DSL, повна потужність у провайдерах

AST, яку виконує рантайм, навмисно не Тьюрінг-повна: кожна програма на ній завершується, а її вартість і склад відомі до запуску. TSX-джерело — повна мова, але вона працює лише на етапі збірки; все, що потребує довільних обчислень у рантаймі, живе в `module`-провайдерах і `Run`, де є таймаути, явні права і результат у вигляді даних. Межа проходить не між «можна і не можна», а між «коли і де».

**Що гарантує тотальність і чому це важливо**

| Властивість | Що дає |
| --- | --- |
| Завершення | хук укладається в 10 с; інакше Claude Code мовчки пропускає його, і промпт іде без секцій |
| Статичний аналіз | валідатор наперед знає секції, провайдери, вартість у токенах і чи стабільна `static`-секція для prompt cache |
| Рев'ю як списку | файл у репозиторії читається до кінця, як у keylang: «a list, not a programming language» |
| Детермінований preview і тести | результат залежить від даних, не від обчислення; тести таблицею кейсів |
| Composability | стадії pipe — чисті функції над JSON з відомою вартістю |

**Що дозволено в DSL**

- `@if … @else … @end`, вкладення до 3 рівнів.
- `@each x in <список> … @end` лише по готових списках (з контексту, провайдера або результату pipe); вкладення до 2 рівнів.
- Pipe-фільтри з білого списку: `take`, `sort`, `grep`, `map`, `join`, `truncate`, `fence`, `unique`, `where`, `len`.
- Локальні функції `@fn name(a, b) … @end` — підстановка без самовиклику і без взаємної рекурсії; тіло — той самий DSL.
- `@let name = <вираз>` — незмінна прив'язка в межах секції.
- Виклики провайдерів лише на початку ланцюжка виразу.

**Що заборонено, з кодом помилки**

| Заборона | Код | Куди винести |
| --- | --- | --- |
| Рекурсія `@fn`, прямa чи через іншу функцію | `G151` | `module`-провайдер |
| `@each` «поки» без межі, або @repeat понад 1 000 ітерацій чи з межею, невідомою до запуску | `G152` | провайдер повертає готовий список |
| Константа, яку перевизначають після `@let` | `G153` | `@let` з новим іменем або провайдер |
| Вираз із `@run` або провайдером не на початку pipe | `G154` | перенести на початок |
| Перевищення ліміту кроків інтерпретатора (10 000 на секцію) | `G155` | `module`-провайдер |
| Глибина вкладення понад ліміт | `G156` | розбити секцію |
| Доступ до файлів, процесів, мережі з виразу | `G157` | `@run` або провайдер |

Ліміт кроків — запобіжник, а не частина семантики: валідатор вважає перевищення помилкою конфігурації, а не умовою часу виконання. Повідомлення для `G151–G155` містить одну підказку: «ця логіка має жити в провайдері».

**Повна мова там, де їй місце.** `module`-провайдер — TypeScript-файл у каталозі плагіна або `.claude/prompt/lib/*.ts`, що експортує чисті функції над даними. Він має все: цикли, рекурсію, бібліотеки, доступ до `$.fs`/`$.process`/`$.http` через параметр — під таймаутом 10 с, з явним переліком викликів у `claude plugin validate` і з результатом, який у DSL потрапляє як дані. Тому відповідь на «а якщо треба більше» завжди одна: додати функцію в провайдер і викликати її одним рядком у секції.

### Змінні, арифметика і простий цикл

Це ті «95 % зручності», які не порушують тотальність: змінні живуть у межах секції, арифметика — над числами і рядками, цикл має відому до запуску верхню межу, і все це рахує той самий ліміт кроків.

**Змінні.** `@let` — константа, `@set` — змінна, яку можна перепризначати; обидві видимі лише в секції (і в `@fn`, якщо передані аргументом). Між секціями дані ходять лише через `store=` / `data.*`, щоб секції лишалися незалежними й кешованими окремо.

```markdown
@let limit = gate.tier == "quick" ? 3 : 6
@set shown = 0
@set total = 0

@each r in cursor.auto | sort("cost.chars")
  @if shown < limit
- {{ r.id }} ({{ r.cost.chars / 1000 | round(1) }}k)
    @set shown = shown + 1
    @set total = total + r.cost.chars
  @end
@end

Показано {{ shown }} з {{ len(cursor.auto) }}, разом {{ total / 1000 | round(1) }}k символів.
```

**Арифметика і вирази.** `+ - * / %`, `min`, `max`, `abs`, `round(n)`, `floor`, `ceil`, порівняння, `&&`, `||`, `!`, тернарний `? :`, конкатенація рядків `+`, `len`, `in`; ділення на нуль дає `null`, не помилку, і позначку в журналі. Тип результату — число, рядок, булеве, список або `null`; об'єктів і функцій як значень немає.

**Простий цикл.** `@repeat n … @end` з лічильником `i` (від 0) і `n`, відомим на момент рендера: число, `len(список)` або вираз із них, не більше 1 000. `@break` виходить із циклу, `@continue` пропускає ітерацію; обидва працюють і в `@each`.

```markdown
@set attempts = data.verify-log.failures | len
@repeat min(attempts, 3)
- спроба {{ i + 1 }}: {{ data.verify-log.failures.at(i).reason }}
@end
@if attempts > 3
…ще {{ attempts - 3 }} спроб у журналі.
@end
```

**Що саме гарантує завершення.** Межа `@repeat` обчислюється до входу в цикл і не змінюється всередині; `@each` ітерує готовий список; `@set` не може створити список більшої довжини, ніж дозволяє ліміт кроків; рекурсії немає. Отже число кроків відоме наперед, і валідатор рахує його статично для констант, а для даних — у рантаймі з лімітом 10 000 (`G155`). Усе, що хочеться записати як `while`, записується як `@repeat` із верхньою межею і `@break`, або йде у `module`-провайдер.

**Стан між сесіями.** Змінна, яку треба зберегти, записується так само, як результат скрипта: `@set counter = (data.counter ?? 0) + 1` і `@store counter` наприкінці секції — наступний рендер прочитає `data.counter`. Так рахуються, наприклад, кількість запусків секції, останній використаний профіль, або лічильник невдалих Verify для ескалації.

### Виконавці скриптів: JS, bash, Python та інші

Готові скрипти репозиторію використовуються у двох ролях: під час рендера промпту (виконавець запускає їх, результат стає даними секції) і як інструменти самої моделі (той самий скрипт зареєстрований через `$.tool.register`, і модель викликає його для парсингу чи генерації). Обидві ролі описуються одним файлом скрипта і одним рядком у конфігурації; мова скрипта не має значення для плагіна.

**Виконавці** (`executors`) — як запускати код тієї чи іншої мови:

```json
"executors": {
  "bash":   { "command": ["bash", "-euo", "pipefail", "-c", "{code}"], "timeout": "10s" },
  "node":   { "command": ["node", "--input-type=module", "-e", "{code}"], "timeout": "10s" },
  "python": { "command": ["python3", "-c", "{code}"], "timeout": "20s", "env": { "PYTHONDONTWRITEBYTECODE": "1" } },
  "deno":   { "command": ["deno", "run", "--no-prompt", "--allow-read=.", "-"], "stdin": "{code}", "timeout": "10s" }
}
```

Виконавець — лише шаблон команди для `$.process.run`; додати Ruby, PHP чи `uv run` означає додати рядок. Код передається через аргумент або stdin, вхідні дані — через stdin як JSON (`{ ctx, args }`), результат читається зі stdout: валідний JSON стає структурою, інакше — рядком. Ненульовий код виходу → `onError` (`unverified` | `skip` | `fail`), stderr — у журнал, ніколи в промпт.

**Вбудований код у секції.** `@run` отримує мову першим аргументом; `bash` — значення за замовчуванням, тож наявні секції не змінюються:

```markdown
@run python cache=10m
import json, sys, subprocess
ctx = json.load(sys.stdin)
out = subprocess.run(["git", "diff", "--stat", "HEAD~1"], capture_output=True, text=True).stdout
print(json.dumps({"files": [l.split("|")[0].strip() for l in out.splitlines()[:-1]]}))
@end

Змінені файли: {{ run.files | join(", ") }}

@run node
const { ctx } = JSON.parse(await new Response(process.stdin).text());
console.log(JSON.stringify({ tier: ctx.gate.tier, n: ctx.cursor.always.length }));
@end
```

Результат останнього `@run` доступний як `run`, іменований — через `@run python as=diff`.

**Скрипти як провайдер.** Тека `.claude/prompt/scripts/` стає провайдером `scripts`: кожен файл — функція з назвою файлу, мова визначається за розширенням або shebang, виклик — `{{ scripts.changed_files() }}`, `@each t in scripts.open_todos("src")`. Аргументи йдуть у stdin разом із контекстом. Кеш — за хешем файлу і аргументів. Це ті самі скрипти, які людина запускає руками, тож їх тестують звичайними засобами мови.

**Скрипти як інструменти моделі.** Файл із frontmatter-коментарем стає інструментом:

```python
#!/usr/bin/env python3
# gate-tool: parse_openapi
# description: Повертає список ендпоінтів з openapi.yaml: метод, шлях, operationId
# input: { "path": "string" }
# tiers: quick, standard
```

На `session.start` плагін реєструє `parse_openapi` через `$.tool.register` з описом і схемою з коментаря; виклик моделі йде через той самий виконавець і повертає stdout як результат інструмента. Так модель отримує детерміновані парсери і генератори замість того, щоб відтворювати їх кодом у кожній сесії — для quick-tier це часто важливіше за будь-яку інструкцію в промпті. Поле `tiers` обмежує, яким рівням інструмент показується; `kind: tool` робить його елементом `Item` і підпорядковує групам і профілям, як MCP-інструменти.

**Межі.** Скрипти працюють із правами користувача, тому: виконавці і тека скриптів вмикаються явно в `gate.json`; у `claude -p` — лише з `userConfig.allowScripts`; команди з білого списку бінарників; жодної інтерполяції тексту промпту чи результатів провайдерів у код (дані йдуть тільки через stdin); сумарний бюджет усіх `@run` на один рендер — 2 с, довші блоки обов'язково з `cache`; `claude plugin validate` показує `process.run` як єдиний канал. У preview редактора скрипти виконуються лише з явної кнопки; за замовчуванням показується кешований результат або заглушка `[run: python, 0.4 s, 212 B]`.

### Дані скриптів у промпті

Рендер завжди йде у два проходи: спочатку збираються дані (провайдери, `@run`, `scripts.*`), потім секції рендеряться з уже готовими значеннями. Тому жоден скрипт не бачить напіввідрендереного тексту, а секція ніколи не чекає скрипта посеред підстановки.

**Іменовані результати.** `@run python as=diff` кладе результат у `diff`; `@let todos = scripts.open_todos("src")` — у `todos`; обидва доступні в цій секції через `{{ diff.files }}`, `@each t in todos`. Без `as` результат — у `run`.

**Збереження між рендерами і сесіями.** `store=<ключ>` записує результат у `$.store` (спільний для сесій на машині) і дублює у `.claude/prompt/data/<ключ>.json`, якщо `persist: true` у `gate.json`:

```markdown
@run python as=api store=api-endpoints cache=1h
import json, sys; print(json.dumps(parse_openapi("openapi.yaml")))
@end
```

У будь-якій іншій секції, іншій сесії чи в CI ці дані читаються як `{{ data.api-endpoints.count }}` без повторного запуску. `data.*` має `fetchedAt` і `stale` (вік понад `cache`), тож секція може написати «дані від {{ data.api-endpoints.fetchedAt | ago }}». Скрипт може й сам оновити сховище: `context-gate data set api-endpoints < result.json` — тоді рендер бере готове, а запуск іде з cron, pre-commit чи CI.

**Порядок і залежності.** Дані збираються паралельно, крім явних залежностей (`@run … needs=diff`), з єдиним бюджетом на рендер; що не встигло — `unverified`, секція рендериться з попереднім збереженим значенням, якщо воно є, і це видно в journal і health.

### Виклик функцій зі скриптових мов

Крім цілих скриптів, DSL викликає окремі функції з файлів на JS, Python, bash чи іншій мові з `executors` — як звичайні функції виразу. Результат або друкується в промпт через `{{ }}`, або йде у змінну через `@let`/`@set`, або в сховище через `store`.

**Прив'язка модуля.** `@use` у frontmatter або на початку секції оголошує модуль і простір імен:

```markdown
---
id: release-notes
use:
  util: scripts/util.py
  gitx: scripts/git-extra.js
  sh:   scripts/helpers.sh
---
Версія: {{ util.next_version(pkg.version, "minor") }}

@let commits = gitx.commitsSince(data.last-release.tag) | where("type", "feat")
@set n = len(commits)

@each c in commits | take(10)
- {{ c.scope }}: {{ c.subject }}
@end

@call util.summarize(commits, tier=gate.tier) as summary cache=1h
{{ summary.text }}

Шлях збірки: {{ sh.build_dir() }}
```

**Як це працює.** Для кожної мови виконавець має shim — коротку обгортку, яка імпортує модуль, викликає функцію за іменем з JSON-аргументами зі stdin і друкує JSON-результат:

| Мова | Shim | Аргументи → результат |
| --- | --- | --- |
| JS/TS (`node`, `deno`) | `import(file)` → `mod[fn](...args)`; `await`, якщо Promise | JSON ↔ JSON |
| Python | `importlib` → `getattr(mod, fn)(*args, **kwargs)` | JSON ↔ JSON; `dataclass`/`Pydantic` → `__dict__` |
| bash | `source file; fn "$@"` | аргументи як рядки; stdout — JSON або текст |
| інша мова | шаблон `callTemplate` у `executors` | за контрактом JSON у stdin, JSON у stdout |

Два виклики в одній секції до того самого модуля виконуються одним процесом (батч `[ {fn, args}, … ]` → `[результати]`), тож десять функцій Python не означають десять інтерпретаторів. Результат кешується за хешем файлу, імені функції і аргументів; `cache=` на `@call` або в `@use` перекриває загальний.

**Три форми**

| Форма | Коли | Що з результатом |
| --- | --- | --- |
| `{{ util.fn(a, b) }}` | коротке значення в тексті | рядок або число друкується; список — через pipe (`join`), об'єкт — через поле |
| `@let x = util.fn(...)` / `@set x = …` | значення потрібне далі в секції | будь-який JSON у змінну |
| `@call util.fn(...) as x [cache=…] [store=…]` | довгий виклик, кілька аргументів, іменовані параметри, потрібен `store` | у змінну і, за `store`, у `data.*` |

Виклик функції — це провайдер на початку ланцюжка (правило `G154`), тому `{{ util.fn() | take(3) }}` дозволено, а `{{ list | util.fn }}` — ні: функції зовнішніх мов не є pipe-фільтрами, щоб вартість кожного запуску була видимою.

**Типи і помилки.** Аргументи — значення DSL (число, рядок, булеве, список, `null`) і об'єкти з контексту (`pkg`, `data.*`, елементи `@each`); функції й секції передавати не можна. Виняток у функції → `onError` модуля (`unverified` | `skip` | `fail`), текст помилки — у журнал і `/gate health`, у промпт — ніколи. Функція, якої немає в модулі, — помилка валідації `G158` ще до рендера: валідатор один раз на сесію питає у shim-а список експортів, і редактор бере з нього автокомпліт та сигнатури.

**Функції як інструменти моделі.** Той самий файл може оголосити експорт інструментом коментарем `# gate-tool: next_version` (як у «Виконавці скриптів»), тоді функція доступна і DSL під час рендера, і моделі під час роботи — з одного визначення.

### Включення: файли, секції, skills, MCP — inline, посилання або ліниво

Усе, що можна покласти в промпт, має три режими доставки, і директиви відрізняються лише джерелом. Режим вибирається явно, бо від нього залежить вартість у токенах:

| Режим | Що потрапляє в промпт | Коли |
| --- | --- | --- |
| `inline` | повний текст | коротке і потрібне завжди |
| `ref` | один рядок: назва, опис, шлях | модель прочитає сама через Read, якщо треба |
| `lazy` | один рядок-опис плюс зареєстрований інструмент `get_<name>` | довге, потрібне зрідка; працює і в `claude -p` |

**Директиви**

| Директива | Джерело | Приклад |
| --- | --- | --- |
| `@include <шлях> [mode] [budget=]` | файл репозиторію | `@include docs/api.md ref` · `@include CONVENTIONS.md inline budget=1500` |
| `@section <id> [mode]` | інша секція DSL, відрендерена з тим самим контекстом | `@section safety-rules inline` · `@section glossary ref` |
| `@skill <name> [mode]` | skill з листингу (`Item kind=skill`) | `@skill tdd inline` (для quick-tier) · `@skill deploy ref` |
| `@rule <id> [mode]` | правило з будь-якого `itemSource` | `@rule api-conventions lazy` |
| `@mcp <server>.<tool>(args) [as x]` | виклик MCP-інструмента під час рендера через `$.mcp.call` | `@mcp github.list_prs(state="open") as prs` |
| `@lazy name path` | те саме, що `@include … lazy` з власним описом | залишено для сумісності |

`@include` і `@section` не можуть утворити цикл (`G159`), глибина вкладення — 3. `@section` рендерить ціль один раз на рендер і повторно використовує результат; секція, включена як `ref`, у підсумковий промпт окремо не потрапляє, якщо тільки її `scope` не вимагає цього сам. `@skill name inline` робить те саме, що `tiers[*].preload`, але локально для секції, тому в `premium` зазвичай пишуть `@skill name ref` або нічого — листинг і так містить опис. `@mcp` — це провайдер (виклик на початку ланцюжка, кеш, `onError`), результат — дані, а не текст, тож далі він іде через `@each`, pipe або `{{ }}`.

Посилання на промпт ззовні: кожна секція має URI `prompt://<id>`, який приймають `@section`, `/gate render prompt://workflow` і `context-gate render workflow`; `@lazy`-інструменти і `ref`-рядки використовують його ж, тож у журналі видно, яку секцію модель запросила і скільки разів.

### Автономний інтерпретатор: рендер поза Claude Code

`context-gate run` рендерить промпт або одну секцію без сесії Claude Code — у терміналі, у редакторі, у CI — тим самим кодом ядра, що й хук `prompt.compose`, тому результат збігається байт у байт.

```bash
context-gate run                                   # весь промпт, контекст із поточного репозиторію
context-gate run workflow --tier quick --profile backend
context-gate run --ctx-from session:latest        # контекст із останньої реальної сесії (журнал)
context-gate run --ctx-from fixtures/pr-review.json --trace
context-gate run --watch                           # перерендер при зміні .claude/prompt/**, gate.json, scripts/
context-gate run --dry-scripts                     # @run і функції з кешу, нічого не запускати
```

**Контекст** береться з трьох джерел на вибір: живий репозиторій (git, файли, провайдери запускаються), знімок реальної сесії з журналу (`session:<id>`, значення `ctx.percent`, модель, профіль — як були), або fixture-JSON, який можна комітити для тестів секцій. `--diff session:latest` показує, чим рендер зараз відрізняється від того, що модель реально отримала.

**Вивід.** За замовчуванням — відрендерений промпт у Markdown з маркерами меж секцій. `--trace` додає поруч таблицю: для кожної секції — чи увійшла і чому (`when`, `@tier`, бюджет), гілки `@if`, значення `@let`/`@set` на виході, кожен `@run`/`@call`/`@mcp` з часом, джерелом (кеш чи запуск) і розміром, токени секції, попередження `G*`/`H*`. `--json` віддає те саме структурою для редактора і CI; `--only <id>` рендерить одну секцію з повним контекстом.

**У редакторі** це і є live-preview: LSP викликає `context-gate run --only <секція> --json --dry-scripts` на кожну зміну, панель поруч показує промпт і trace, кнопка «виконати скрипти» знімає `--dry-scripts` одноразово, а перемикачі tier/profile/ctx-from угорі панелі — ті самі прапорці. Hover на `{{ вираз }}` показує значення з останнього trace, клік по рядку trace переходить до директиви. Так людина бачить ту саму картину, що й модель, до того, як відправити промпт, і без витрати токенів.

### Налагодження: `@debug`, `@assert`, `@log` — поза промптом

Директиви налагодження пишуть у trace і журнал, ніколи в текст промпту: рендерер видаляє їх до збирання секцій, тому жоден `@debug` не може потрапити до моделі навіть помилково. Перевіряє це тест ядра: рендер будь-якої секції з `@debug` і без нього дає однаковий байтовий результат.

| Директива | Що робить | Куди йде |
| --- | --- | --- |
| `@debug <вираз>[, <вираз>…]` | друкує значення з іменем секції, рядком і номером ходу | trace (`run --trace`), панель редактора, `.claude/gate.debug.log` при `debug: true` |
| `@debug "повідомлення" {{ x }}` | те саме з текстом | там само |
| `@assert <умова> [, "повідомлення"]` | умова хибна → запис `D001` і, за `assertFail`, секція пропускається (`skip`) або рендер падає (`fail`) | trace, журнал, `/gate health` |
| \`@log level=info | warn | error "текст"\` |
| \`@trace on | off\` | вмикає детальний trace для частини секції: кожна підстановка і гілка |

```markdown
@let commits = gitx.commitsSince(data.last-release.tag)
@debug "commits", len(commits), gate.tier
@assert len(commits) < 500, "підозріло багато комітів — перевір тег"

@each c in commits | take(10)
  @debug c.hash, c.type
- {{ c.subject }}
@end
```

**Де видно.** У `context-gate run --trace` і в панелі редактора — рядком під директивою: `[debug release-notes:3] commits=42 tier=quick`. У Claude Code — у pane `/gate why` з фільтром `| where kind=debug`, і в `$.ui.log` з `to: "debug"`, тобто у debug-лозі сесії (`claude --debug`), не у транскрипті. Файл `.claude/gate.debug.log` пишеться лише при `debug: true` у `gate.json` або `--debug` у CLI, обрізається до 1 МБ і в `.gitignore` за замовчуванням.

**Обмеження.** `@debug` обчислює вираз тим самим інтерпретатором і рахується в ліміт кроків, тож нескінченний `@debug` неможливий. Значення обрізаються до 2 000 символів на запис; об'єкти серіалізуються як JSON. Секретні змінні з `env` (білий список у `gate.json`) у debug-виводі маскуються. Коли `debug: false`, директиви лишаються в файлі, але не обчислюються — `@assert` при цьому виконується завжди, бо це перевірка, а не лог.

### Prompt health: метрики промпту

`/gate health` і `context-gate health` показують один і той самий звіт; частина метрик — у рядку стану, пороги — у `gate.json` (`health`), перевищення — коди `H0xx` у журналі.

| Метрика | Що означає | Поріг за замовчуванням |
| --- | --- | --- |
| Розмір промпту | символи і токени по секціях і разом; окремо `static` / `profile` / `volatile` | `H001` разом > 12 000 токенів |
| Частка стабільної частини | скільки відсотків промпту не змінилось від минулого ходу (prompt cache) | `H002` < 70 % |
| Дрейф | diff промпту між ходами в токенах; хто змінився (секція, скрипт, профіль) | `H003` > 500 токенів поза `volatile` |
| Час рендера | загалом і по стадіях; найдовші `@run` і провайдери; cache hit rate | `H004` > 1 с без скриптів, `H005` > 2 с разом |
| Вік даних | для кожного `data.*` і провайдера: `fetchedAt`, чи `stale`, чи взято з резерву | `H006` секція відрендерена зі застарілих даних |
| Unverified | кількість елементів, доставку яких не підтверджено | `H007` > 0 після apply-режиму |
| Урізання | секції, обрізані за `budget`; skills, що втратили опис у листингу | `H008` будь-яке урізання `static` |
| Листинг skills | розмір проти нативного бюджету 1 % контексту; скільки skills без опису | `H009` переповнення |
| Контекст сесії | `ctx.percent`, компакції за сесію, токени кешу з `result.usage` на `turn.step` | з `budgets` |
| Рішення gate | профіль, confidence класифікатора, ручні перевизначення, deny по інструментах за сесію | `H010` > 3 deny одного інструмента |
| Гейти | скільки разів спрацювали, середній час, false positives за ручними «все одно» | `H011` гейт блокує > 30 % спроб |
| Вартість | оцінка $ за сесію за токенами і моделлю; частка на системний промпт | `H012` промпт > 40 % вхідних токенів |

Рядок стану показує три з них: `ctx 38% · prompt 8.1k (static 76%) · ◌ 0`. Pane `/gate health` — повну таблицю з колонкою «що зробити» (приклад: «`cursor-always` 9.8k → додати `budget` або перевести 3 правила в Auto Attached»). `context-gate health --json` віддає ті самі числа для CI; `bench` використовує цей звіт як формат результатів. Усі метрики рахуються з даних, які плагін і так має (`$.session.usage`, тайминги стадій, журнал), тому health не додає жодного виклику моделі.

## Шар 3а — tier-адаптивні промпти

Слабка модель отримує інший промпт, а не довший: явні кроки замість цілі, приклади замість правил, чекліст виходу, тіло skill замість опису і менше варіантів вибору. Сильній моделі ті самі додатки шкодять як шум. Промптом можна звузити розрив на добре визначених задачах (boilerplate, git, docs, рефакторинг за шаблоном); на задачах із міркуванням (нетривіальний дебаг, архітектура) межа — ескалація моделі, а не ще детальніший промпт.

**Три механізми, від детермінованого до LLM**

| Механізм | Коли працює | LLM | Де в плагіні |
| --- | --- | --- | --- |
| Tier-варіанти секцій | завжди | ні | DSL: `@tier` або файли `<id>.<tier>.md`; вибір за `gate.tier` |
| Приклади з репозиторію, preload, контракти виходу, гейти | завжди | ні | DSL `@each … examples(...)`, `tiers[*].preload`, секції `plan-then-act`, `tool.call`-гейти |
| Бриф задачі сильною моделлю | перший промпт задачі в quick/standard | так, 1 виклик на задачу | `$.model.complete` у `prompt.submit`, кеш у `$.state` |
| Збірка варіантів офлайн | один раз на зміну канонічної секції | так, на етапі збірки | `npx context-gate expand`, результат у репозиторії |

**Варіанти секцій у DSL.** Канонічна секція пишеться один раз; варіант для tier задається або директивою всередині, або окремим файлом, який перекриває канонічний повністю:

````markdown
---
id: workflow
scope: profile
---
Працюй за процесом проєкту: зміни малими кроками, тести перед комітом.

@tier quick, standard
1. Прочитай файли, названі в задачі, і тести поряд з ними.
2. Напиши план із 3–6 кроків і покажи його перед першою правкою.
3. Після кожної правки запусти `pnpm test -- <шлях>`; не переходь далі, поки не зелено.
4. У кінці перелічи змінені файли і що саме перевірив.
@end

@tier quick
@each ex in fs.examples("src/**/*.service.ts", 1)
Зразок стилю сервісу з цього репозиторію ({{ ex.path }}):
```ts
{{ ex.body }}
```
@end
@end
````

`examples(glob, n)` — функція вбудованого провайдера fs: бере `n` найменших файлів за glob (детерміновано, за розміром і шляхом), обрізає за `budget`. `@tier` без аргументу означає «усі, крім premium». Файл `workflow.quick.md` поряд із `workflow.md` має пріоритет над директивами.

**Контракти виходу і гейти.** Для tier нижче `premium` вмикається секція `plan-then-act` (план → правка → перевірка) і гейти з `gates[]` (див. «Провайдери»): вбудований `read-before-write` (`Write`/`Edit` без попереднього `Read` цільового файлу → `{ deny }`) і будь-які командні гейти на `commit` чи `turn`, наприклад тести або typecheck. Кожен гейт має поле `tiers`, тому в `premium` вони типово не діють.

**Бриф задачі.** Якщо `tier` не `premium` і це перший промпт задачі (або `/gate new`), `prompt.submit` викликає `$.model.complete` на моделі з `brief.model` (за замовчуванням `opus`) із запитом: мета, обмеження, релевантні файли, кроки, критерії прийняття, відомі пастки — у форматі Markdown до `brief.maxChars` (2 000). Результат додається як `context` промпту і кешується в `$.state` за хешем тексту задачі; наступні промпти його не повторюють. Вартість — один дорогий виклик замість десятків; у `claude -p` бриф вмикається прапорцем `brief: true` у `userConfig`. Це паттерн «plan on strong, execute on cheap» з jev-router і shiftwork.

**`npx context-gate expand`.** Команда збірки читає канонічні секції без варіантів, просить сильну модель згенерувати `quick`- і `standard`-варіанти за інструкцією (кроки, приклади, чекліст, без зміни суті), кладе їх у `.claude/prompt/<id>.<tier>.md` і показує diff. Варіанти комітяться, тож у сесії LLM не викликається, промпт детермінований і кешується. Повторний `expand` перегенеровує лише ті секції, канонічний текст яких змінився (хеш у frontmatter `source-hash`).

**Ескалація.** У `gate.json` поруч із `tiers`:

```json
"escalation": { "order": ["quick", "standard", "premium"], "after": { "verifyFailed": 2, "stallTurns": 6 } }
```

Mod сам модель не перемикає (це поза межами, див. «Мета і межі»), але фіксує подію `escalation-suggested` у журналі, показує notice «2 невдалі перевірки на quick — перейди на standard: /model sonnet» і віддає ту саму подію shiftwork-runner через `.claude/gate.log.jsonl`, де runner уже робить handoff. У `/gate why` видно, скільки спроб і токенів коштував кожен tier на задачі — це і є метрика, за якою видно, чи промпт справді закриває розрив, чи час міняти модель.

**Очікування.** На механічних задачах quick-tier із брифом, прикладами і гейтами має проходити Verify з першої-другої спроби; якщо ні — задача не для quick. Жоден із механізмів не робить Haiku рівним Opus на міркуванні; вони роблять Haiku надійним там, де задача вже добре описана.

## Провайдери: будь-який інструмент як джерело контексту і гейт

Плагін не знає про keylang, tsc, eslint чи shiftwork. Він знає чотири абстракції — джерело правил, провайдер контексту, гейт, сигнал профілю — а конкретні інструменти підключаються декларативно в `gate.json`. keylang нижче — лише один приклад адаптера; те саме описує `tsc --noEmit`, власний скрипт чи MCP-інструмент.

**Провайдер контексту.** Іменований простір у контексті рендера (`{{ <name>.<поле> }}`, `<name>.<функція>(…)`), заповнений результатом зовнішнього інструмента. Чотири види:

| `kind` | Як отримує дані | Приклад |
| --- | --- | --- |
| `cli` | запускає команду через `$.process.run`, читає JSON зі stdout | `keylang parse --json`, `eslint -f json`, власний `node scripts/ctx.js` |
| `file` | читає JSON або Markdown із файлу | `.keylang/index.json`, `package.json`, `docs/decisions.md` |
| `mcp` | викликає інструмент MCP-сервера через `$.mcp.call` | `mcp__github__list_prs` |
| `module` | JS-функція з каталогу плагіна (відносний import дозволений) | вбудовані `git`, `fs`, `cursor` |

```json
"providers": {
  "git":     { "kind": "module", "builtin": true },
  "fs":      { "kind": "module", "builtin": true, "functions": ["examples"] },
  "arch":    { "kind": "cli", "command": ["keylang", "parse", "--json"], "cache": "5m",
               "functions": { "code": ["keylang", "explain", "{id}", "--json"] },
               "onError": "unverified" },
  "pkg":     { "kind": "file", "path": "package.json", "pick": ["name", "scripts"] },
  "prs":     { "kind": "mcp", "tool": "mcp__github__list_prs", "args": { "state": "open" }, "cache": "10m" }
}
```

У DSL після цього доступні `{{ arch.deny }}`, `arch.code("application.purchase.buy")`, `{{ pkg.scripts.test }}`, `fs.examples("src/**/*.service.ts", 1)`. Жодне ім'я, крім `git`, `fs`, `cursor`, `gate`, `ctx`, `session`, не зарезервоване. Результат провайдера — дані; текст із нього ніколи не виконується. `onError` визначає, що робити, коли команда впала: `unverified` (позначити в журналі й рендерити секцію без цих значень), `skip` (пропустити секцію), `fail` (помилка валідації).

**Джерела правил.** Шар cursor-rules — перший адаптер загального інтерфейсу `RuleSource → Rule[] { id, kind, globs?, description?, body }`:

```json
"ruleSources": [
  { "kind": "cursor-mdc", "dir": ".cursor/rules", "nested": false },
  { "kind": "markdown-dir", "dir": "docs/rules", "frontmatter": { "paths": "globs" } },
  { "kind": "provider", "name": "arch", "field": "deny", "as": "always",
    "template": "{{ item.from }} не імпортує {{ item.to }}" }
]
```

Третій запис перетворює заборони з keylang на Always-правила без окремого коду; так само підключаються правила з Confluence через MCP або з `AGENTS.md`. Доставка, дедуплікація і статуси однакові для всіх джерел.

**Гейти.** Детерміновані перевірки в `tool.call` і на `turn.complete`, кожна — команда або провайдер плюс умова проходження:

```json
"gates": [
  { "name": "read-before-write", "on": "write", "builtin": true, "tiers": ["quick", "standard"] },
  { "name": "tests", "on": "commit", "run": ["pnpm", "test", "--", "{changedPaths}"],
    "pass": "exitCode == 0", "message": "Тести впали, виправ перед комітом" },
  { "name": "typecheck", "on": "turn", "run": ["tsc", "--noEmit", "--pretty", "false"],
    "pass": "exitCode == 0", "onlyNew": true, "baseline": ".claude/gate.baseline.json" },
  { "name": "architecture", "on": "commit", "provider": "arch",
    "run": ["keylang", "check", "--changed", "--json"], "pass": "len(result.violations) == 0",
    "message": "{{ result.violations[0].code }}: {{ result.violations[0].explain }}" }
]
```

`on`: `write` (перед Write/Edit), `commit` (Bash із `git commit`), `turn` (після ходу), `prompt`. `onlyNew` + `baseline` блокують лише нове порушення відносно збереженого знімка — патерн `check --changed` з keylang, але для будь-якої команди. Непройдений гейт повертає `{ deny }` із `message`, пройдений не лишає сліду в контексті.

**Сигнали профілю.** `profiles[*].when` приймає не лише `paths` і `branch`, а й вирази над провайдерами: `"when": { "expr": "pkg.scripts.storybook != null && git.branch ~ '^feat/ui'" }`. Класифікатор теж провайдер: `"classify": { "provider": "builtin" | "jev" | { "kind": "cli", ... } }` із єдиним контрактом «профіль + confidence».

**Статуси ok / fail / unverified.** Кожен елемент контексту у `/gate why` має статус: `ok` — доставку підтверджено подією, `fail` — відхилено лімітом чи помилкою, `unverified` — плагін не може знати, чи модель це побачила (`tool.describe` для MCP, `agent.offer`, провайдер з `onError: unverified`). Unverified не рахується як ok і показується в рядку стану як `◌ N`.

**Коди, `explain`, `fmt`, proposals.** Валідатор `gate.json` і DSL повертає коди (`G0xx` структура, `G1xx` вирази, `G2xx` `@run`/`@lazy`/провайдери, `G3xx` конфігурація, `G4xx` tier-варіанти); поганий рядок дає код, парсинг триває; `npx context-gate explain G102`. `context-gate fmt` вирівнює файли промптів і відмовляється форматувати вкладення, якому не довіряє, щоб рендер і GitHub-перегляд збігалися. Усе згенероване (`expand`, бриф) йде в `.claude/prompt/proposals/` з `generated-by`, `generated-at`, `source-hash` у frontmatter.

**Інші жорсткі прив'язки, які прибрано тим самим принципом**

| Було в спеці | Стало |
| --- | --- |
| `pnpm test`, `git commit` у гейтах | `gates[].run` і `gates[].on`, будь-яка команда |
| `brief.model: opus`, класифікатор Haiku | `brief.model` і `classify.provider` у конфігурації; бриф може писати й зовнішній CLI (`kind: cli`) |
| shiftwork як єдиний runner | контракт для будь-якого runner-а: той самий `gate.json` плюс журнал `.claude/gate.log.jsonl` з подіями `decision`, `escalation-suggested`, `gate-failed` |
| `.cursor/rules` як єдине джерело правил | `ruleSources` з адаптерами `cursor-mdc`, `markdown-dir`, `provider` |
| `examples()` по glob | функція вбудованого провайдера `fs`; будь-який провайдер може оголосити свої функції |
| `.keylang/index.json` в індексі автокомпліту | індекс бере символи з будь-якого провайдера, що оголосив `exposes: ["symbols"]` |

**Bench.** `bench/` на 5–8 репозиторіях: токени системного промпту на сесію, частка Verify з першої спроби по tier, кількість `unverified` — до і після увімкнення gate.

## Єдина модель: елементи, джерела, pipeline, harness-адаптери

Skills, MCP-інструменти, субагенти, правила Cursor, секції DSL і дані провайдерів — це один тип даних, `Item`, який проходить через один і той самий конвеєр. Claude Code, його mods API і settings-hooks — лише один harness-адаптер на кінці конвеєра. Усе, що раніше було окремим шаром зі своєю логікою, стає конфігурацією джерела або стадії.

**Item** — нормалізований запис із будь-якого джерела:

```json
{ "kind": "skill" | "tool" | "agent" | "rule" | "section" | "datum",
  "id": "skill:react-components", "name": "react-components",
  "description": "…", "body": "…(ліниво)", "tags": ["frontend"],
  "attach": { "when": "always" | "paths" | "manual" | "on-demand", "globs": [] },
  "cost": { "chars": 1840 }, "provenance": { "source": "cursor-mdc", "path": ".cursor/rules/react.mdc" },
  "status": "ok" | "fail" | "unverified" }
```

**Джерела** (`itemSources`) замість окремих `ruleSources`, листингу skills і `$.tool.list()`:

```json
"itemSources": [
  { "kind": "claude-skills" },                       
  { "kind": "claude-tools", "match": "^mcp__" },      
  { "kind": "claude-agents" },
  { "kind": "cursor-mdc", "dir": ".cursor/rules" },
  { "kind": "markdown-dir", "dir": "docs/rules", "as": "rule" },
  { "kind": "prompt-dir", "dir": ".claude/prompt", "as": "section" },
  { "kind": "provider", "name": "arch", "pick": "deny", "as": "rule",
    "template": "{{ item.from }} не імпортує {{ item.to }}" },
  { "kind": "provider", "name": "prs", "as": "datum" }
]
```

Кожне джерело — адаптер з одним методом `collect(): Item[]`; `claude-skills`, `claude-tools`, `claude-agents` і `cursor-mdc` вбудовані, решта — провайдери. Додати нове джерело (правила з Notion, skills із власного реєстру) означає додати провайдер і рядок у конфіг, не код.

**Групи** одні для всіх видів, із kind-префіксом замість `skillGroups` / `mcpGroups`:

```json
"groups": {
  "frontend": ["skill:react-*", "skill:tailwind", "tool:mcp__figma__*", "agent:ui-reviewer", "rule:react-*"],
  "backend":  ["skill:nestjs", "tool:mcp__postgres__*", "rule:api-*"],
  "always":   ["tool:mcp__github__*", "rule:security-*"]
}
```

Профілі й tiers посилаються лише на групи; слова «skills», «mcp», «agents» у конфігу зникають. Старий формат (`skillGroups`, `mcpGroups`, `ruleSources`) читається з попередженням `G310` і конвертується командою `context-gate migrate`.

**Pipeline.** Рішення — послідовність чистих стадій над масивом `Item[]`, кожна приймає JSON і повертає JSON:

```
collect → normalize → signals → decide → budget → render → deliver → observe
```

| Стадія | Вхід → вихід | Що робить |
| --- | --- | --- |
| `collect` | джерела → `Item[]` | усі адаптери з `itemSources` |
| `normalize` | `Item[]` → `Item[]` | дедуплікація за `id`, обчислення `cost`, нормалізація globs |
| `signals` | сесія → `Signals` | шляхи, гілка, модель, `@`-згадки, ручні команди, провайдерні `when` |
| `decide` | `Item[] + Signals + config` → `Decision` | профіль, tier, `on/nameOnly/off/preload` на кожен item, `reason[]` |
| `budget` | `Decision` → `Decision` | обрізання за `budget`, перенесення довгих у `on-demand` |
| `render` | `Decision` → `Rendered` | секції системного промпту, листинг, контекстні блоки, тексти deny |
| `deliver` | `Rendered` → події harness | тільки ця стадія знає про `prompt.compose`, `tool.call`, `additionalContext` |
| `observe` | усе → журнал | статуси `ok/fail/unverified`, токени, причини |

Стадії — експорт `packages/core` без залежності від Claude Code; у mod-і вони викликаються з хуків, у CLI — як команди, у тестах — таблицею кейсів.

**Composable pipe-команда.** Ті самі стадії доступні як CLI з JSONL між ними, тож їх можна комбінувати між собою і з `jq`, `grep`, `fzf`:

```bash
# що увімкнеться для frontend на haiku, скільки це коштує
context-gate collect | context-gate decide --profile frontend --model haiku | context-gate tokens

# знайти правила, які ніколи не спрацьовують за журналом тижня
context-gate collect --kind rule | context-gate observe --since 7d --status never | jq -r .id

# відрендерити одну секцію для quick і подивитись
context-gate collect --kind section --id workflow | context-gate render --tier quick | context-gate preview

# сторонній фільтр у середині конвеєра
context-gate collect | jq 'select(.cost.chars < 2000)' | context-gate decide | context-gate deliver --dry-run
```

Всередині Claude Code та сама граматика через `/gate`: `/gate collect kind=skill | where group=frontend | off` або `/gate why | where status=unverified`. Парсер команди один для CLI і для `/gate`; невідома стадія — помилка `G5xx` з підказкою.

**Pipe у DSL-виразах.** Той самий знак `|` усередині `{{ }}` і `@each`, з білим списком фільтрів: `{{ git.log(10) | grep("fix") | take(3) | join("\n") }}`, `@each f in fs.glob("src/**/*.ts") | sort("size") | take(2)`, `{{ arch.deny | map("{{ item.from }} → {{ item.to }}") | join("; ") | truncate(400) }}`. Фільтри — чисті функції ядра (`take`, `sort`, `grep`, `map`, `join`, `truncate`, `fence`, `unique`, `where`), без доступу до файлів чи процесів; провайдери — лише на початку ланцюжка.

**Harness-адаптери.** Стадія `deliver` має адаптери, як у shiftwork є бекенди:

| Адаптер | Як доставляє | Стан |
| --- | --- | --- |
| `claude-code-mod` | `prompt.compose`, `prompt.context`, `prompt.attachment`, `tool.call`, `tool.describe`, `agent.offer`, `skill.prompt` | основний |
| `claude-code-hooks` | `SessionStart`/`UserPromptSubmit`/`PreToolUse` з `additionalContext`, `skillOverrides` | fallback, без mods |
| `static` | транспіляція у `.claude/rules`, `.claude/skills`, `CLAUDE.md`-імпорт | CI, старі версії |
| `pi`, `opencode` | `before_agent_start` → `systemPromptOptions.skills`; `permissions.skill` і `prompt({ skills })` у V2 | через shiftwork, пізніше |

Ядро не імпортує жоден адаптер; адаптер імпортує ядро. Це та сама межа, що й між `shiftwork-core` і його пакетами.

**Що ще стало абстрактним**

| Було | Стало |
| --- | --- |
| «skills», «MCP», «агенти» як окремі поля профілю | `Item.kind` і kind-префікси в групах |
| Листинг skills, `$.tool.list()`, `.cursor/rules` як три окремі механізми | три адаптери `itemSources` з одним `collect()` |
| Модель → tier за іменем моделі | `models` приймає glob і атрибути (`contextWindow`, `costPer1k`), tier виводиться з порогів, якщо імені немає в мапі |
| `.claude/prompt` як єдина тека секцій | `prompt-dir` — джерело виду `section`; секції можуть приходити і з провайдера |
| Журнал `.claude/gate.log.jsonl` для shiftwork | стадія `observe` з форматом JSONL — контракт для будь-якого споживача |
| Індекс автокомпліту з переліком полів | індекс = `collect` + `normalize`, серіалізований; редактор не має власної схеми |
| Classify, бриф, expand як окремі функції | провайдери з контрактами `classify`, `brief`, `expand`; будь-який — вбудований, CLI чи MCP |

Єдине, що лишається жорстким навмисно: формат `Item`, назви стадій і граматика pipe. Це контракт, на якому тримається composability.

## Інтерфейс користувача

Усе керування — одна команда `/gate` з підкомандами, один рядок над промптом і одна pane; нічого не відкривається само, крім рядка стану.

| Команда | Дія |
| --- | --- |
| `/gate` | поточний стан: профіль, tier, увімкнені skills/MCP/агенти, звідки взято рішення |
| `/gate <profile>` | зафіксувати профіль до `/gate auto` |
| `/gate +<group>` / `-<group>` | додати або прибрати групу на цю сесію |
| `/gate off` / `/gate auto` | вимкнути фільтрацію (усе як без mod) / повернути автоматику |
| `/gate new` | перекласифікувати задачу з наступного промпту |
| `/gate why` | останні рішення з причинами: сигнал, профіль, що увімкнено/вимкнено, токени на секцію промпту |
| `/gate shadow` / `/gate apply` | перемкнути режим класифікатора |
| `/rule <id>` | застосувати Manual-правило Cursor (те саме, що `@id` у промпті) |
| `/gate rules` | які `.mdc` уже доставлено в цій розмові і яким агентам |

**Рядок стану** (`ui.render {component: AbovePrompt}`, один рядок, оновлюється на `turn.complete` і `session.measure`):

`gate frontend · tier standard · skills 5/23 · mcp 2/6 · rules 3 · ctx 38%`

При `shadow` профіль показується в дужках: `gate (frontend?) …` — видно, що класифікатор пропонує, але не застосовує. При перетині `softContextPct` відсоток підсвічується; при `hardContextPct` з'являється `$.ui.notice`.

**Pane журналу** (`/gate why` відкриває, `/gate why off` закриває): таблиця останніх 50 рішень — хід, тригер (`manual`, `when:paths`, `classify 0.84`, `model-change`, `compact`), профіль, зміни набору, причина одним рядком. Нижче — секції системного промпту з довжиною і `scope`, щоб видно було, що саме займає контекст. Кнопки в pane: «Застосувати запропонований профіль» у режимі shadow і «Скинути до auto».

**Команди у `claude -p`** недоступні, тож ті самі дії читаються з `userConfig` плагіна (`profile`, `mode`) і з прапорців у промпті (`[gate:frontend]` на початку тексту) — цей рядок вирізається з промпту в `prompt.submit`.

## Редактор DSL та індекс автокомпліту

Редактор має бути маленьким, тому він нічого не знає сам: усі підказки йдуть з одного індексу й одного LSP-сервера, які плагіну потрібні і без редактора. Три тонкі клієнти діляться цим ядром так само, як у keylang одна аналітика обслуговує CLI, LSP, MCP і UI.

**Індекс `.claude/gate.index.json`.** Mod перезаписує його на `session.start`, після `/gate`, при `classic.FileChanged` для `gate.json` і `.claude/prompt/**`:

| Що | Звідки |
| --- | --- |
| Інструменти (вбудовані, MCP, `@lazy`) | `$.tool.list()` |
| Skills і їхні описи, MCP-сервери | листинг skills (`prompt.attachment`), `$.mcp` |
| Профілі, групи, tiers | `gate.json` |
| Секції DSL: `id`, `scope`, `when`, довжина останнього рендера | парсер DSL |
| Змінні контексту рендера з типами і поточними значеннями | останній `prompt.compose` |
| Символи коду: id, сигнатури, файли | `.keylang/index.json` або будь-який провайдер з exposes: symbols |
| Правила Cursor: id, тип, globs | парсер `.mdc` |

Значення в індексі — знімок останнього рендера цієї сесії; редактор показує їх як підказки, а не як істину.

**LSP.** Основа — звичайний TypeScript language server: типи `Ctx`, пропсів компонентів і провайдерів генеруються у `.claude/prompt/.types/ctx.d.ts` з `gate.json` та індексу, тому completion, hover і діагностики для TSX працюють у будь-якому редакторі без власного сервера. Невеликий плагін до tsserver (`packages/lsp`) додає те, чого TypeScript не знає: коди `G*` з компілятора AST (вирази поза білим списком, рекурсія, `Run` без `cache` у `static`), hover зі значенням виразу з останнього trace, code actions «згенерувати quick-варіант» і «винести в `Lazy`», document symbols — список секцій.

**Клієнти**

| Клієнт | Що вміє | Коли |
| --- | --- | --- |
| VS Code (`editors/vscode`, тонкий клієнт LSP) | повне редагування, діагностики, preview-панель | основний для редагування |
| Браузерний редактор (`/gate edit <id>` → `$.process.spawn` локального сервера з CodeMirror 6, за моделлю `keylang web`) | те саме без VS Code, працює з будь-якого терміналу | швидкі правки під час сесії |
| Pane у Claude Code | перегляд секції, її рендер, токени, кнопки «відкрити в редакторі» і «перерендерити» | не редагує: елементи `Input`/`Markdown` у mods не є редактором |

**Live-preview замість «code eval».** Поруч із текстом рендериться секція з поточним контекстом сесії: обчислені `{{ }}`, результати `@run` з кешу (dry-run, без запуску — для запуску окрема кнопка з підтвердженням), які гілки `@if` спрацювали, довжина в токенах, порядок секції в підсумковому промпті. Окреме поле REPL обчислює один вираз у тому ж інтерпретаторі. Preview використовує той самий рендер, що й `prompt.compose`, тому розбіжностей між тим, що бачить людина, і тим, що бачить модель, немає.

**Межі.** Редактор не виконує код проєкту і не викликає LLM сам; усе, що потребує моделі (`expand`, бриф), іде через CLI-команди у proposals. Індекс не містить вмісту файлів проєкту, лише імена, сигнатури і шляхи.

## Сценарії використання і вирішення проблем

Кожен сценарій — реальна ситуація, що робить людина, що робить плагін, і чим це закінчується. Перші чотири — щоденна робота, решта — коли щось пішло не так.

**1. Перший запуск у проєкті з Cursor-правилами.** Ситуація: монорепо з `.cursor/rules/` (12 правил), 30 skills, 5 MCP. Дія: `/plugin install context-gate@acme`, `npx context-gate init` → створює `gate.json` з профілями, вгаданими з структури (`apps/web` → frontend, `apps/api` → backend), і вмикає `classify.mode: shadow`. Результат: рядок стану `gate (frontend?) · tier standard · skills 30/30 · mcp 5/5 · rules 12`; нічого ще не фільтрується, але `/gate why` уже показує, що запропонував би класифікатор. Через тиждень `/gate apply`.

**2. Правка React-компонента.** Промпт: «зроби кнопку в `apps/web/src/Button.tsx` доступною». Плагін: `when.paths` збігається з `apps/web/**` → профіль frontend без класифікатора; Always-правила вже в контексті; на `Read Button.tsx` підключається `react-components.mdc` (globs `**/*.tsx`) як контекст після результату; листинг skills скорочено до 5 frontend-skills; MCP `figma` і `playwright` видимі, `postgres` — рядок «вимкнено профілем». Результат: модель бачить правило про компоненти саме тоді, коли відкриває файл, і не тягне в контекст описи 25 зайвих skills.

**3. Та сама задача на дешевій моделі.** `/model haiku` посеред сесії. Плагін: `turn.step` бачить нову модель → tier quick → перерахунок: skills quick-tier плюс `preload` тіла `project-conventions`; у промпт входить `@tier quick`-варіант секції `workflow` (план → правка → тест) і один зразок компонента через `examples()`; гейт `readBeforeWrite` увімкнений. Перший промпт нової задачі додатково отримує бриф від Opus (один виклик, кеш). Результат: Haiku працює за явним чеклістом; якщо Verify падає двічі — notice «перейди на sonnet», подія в журнал для shiftwork.

**4. Ручне правило і ручна група.** «@security-review перевір цей ендпоінт» → Manual-правило `security-review.mdc` підключається з промпту; `/gate +docs` на цю сесію додає docs-skills без зміни профілю. `/gate` показує, звідки кожен елемент: `manual`, `when:paths`, `tier`.

**5. Проблема: правило не спрацювало.** Симптом: модель ігнорує `api-conventions.mdc`. Діагностика: `/gate rules` → правило є, тип Auto Attached, globs `src/api/**/*.ts`, доставлено: ні. `/gate why` → останні `tool.call` на `apps/api/src/users.controller.ts`; glob не збігається, бо шлях у монорепо має префікс `apps/api/`. Виправлення: `globs: apps/api/src/**/*.ts` або `nested: true` і правило в `apps/api/.cursor/rules/`. Та сама перевірка для `@file`-згадок: якщо файл був згаданий через `@`, правило йде з `prompt.submit`, і журнал це показує окремим тригером.

**6. Проблема: класифікатор обрав не той профіль.** Симптом: задача про міграцію БД, профіль frontend, бо промпт згадував «форму». У shadow це лише запис `classify frontend 0.62 < 0.7 → tier default`; в apply — профіль застосовано. Дія: `/gate backend` на сесію; у `gate.json` додати `when.paths: ["prisma/**", "**/migrations/**"]`, щоб детермінований сигнал ішов раніше класифікатора; підняти `minConfidence`. Журнал зберігає такі промахи, і `npx context-gate report` зводить їх за тиждень: скільки разів `when` виграв, скільки класифікатор, скільки ручних перевизначень.

**7. Проблема: контекст усе одно забивається.** Симптом: `ctx 78%` на третьому промпті. `/gate why` → секції промпту з довжиною: `keylang-rules` 3 100 символів, `cursor-always` 9 800, skills preload 6 200. Дії: `budget` на секцію (`cursor-always: 4000` → надлишок замінюється рядком «також діють: …, прочитай за потреби»), винести довгі правила в `@lazy`, перевести два Always-правила в Auto Attached. На 85 % спрацьовує `onExceed` → `$.session.compact()` з інструкцією зберегти профіль і список активних правил; після compaction `prompt.context` відновлює Always-блоки.

**8. Проблема: MCP-інструмент вимкнено, а він потрібен.** Модель викликає `mcp__postgres__query` у frontend-профілі → `{ deny: "postgres вимкнено профілем frontend. Користувач може увімкнути: /gate +backend" }`. Модель переказує це користувачу; `/gate +backend` → наступний виклик проходить. Якщо такі deny повторюються для одного профілю, `report` пропонує додати групу в профіль.

**9. Проблема: після оновлення Claude Code mod мовчить.** `/plugin` не показує `1 mod active`; у debug-лозі `context-gate: tool.call hook skipped: threw TypeError` — змінилась форма події. Дії: `claude plugin validate ./context-gate` показує, які події та виклики не збігаються з новими типами; `claude plugin test` падає на конкретному хуку; до виправлення — `npx context-gate sync`, і правила працюють через нативні `.claude/rules/cursor/*.md`, профіль — через `skillOverrides`. Mod сам вимикає шар cursor-rules, побачивши згенеровану директорію, тож дублювання немає.

**10. Проблема: згенерований quick-варіант секції гірший за канонічний.** `expand` поклав `workflow.quick.md` у `proposals/`; у рев'ю видно, що він додав неіснуючу команду тестів. Дія: правка в редакторі з автокомплітом (команди підказуються з `package.json` в індексі), live-preview показує рендер для tier quick, мерж у `.claude/prompt/`. `source-hash` у frontmatter гарантує, що наступний `expand` не перезапише ручну правку, поки канонічний файл не змінився.

**11. Проблема: shiftwork-runner і TUI приймають різні рішення.** Runner на тікеті `Type: git` вантажить git-skills, а в TUI той самий тікет отримує backend-профіль. Причина: у `gate.json` немає мапи `types → profiles`. Дія: додати `profiles.git.when.ticketType: ["git"]`; runner і mod читають один файл, `report` порівнює рішення обох за `ticketId` у журналі.

**12. Проблема: не зрозуміло, чи плагін узагалі допомагає.** `npx context-gate bench --before --after` на еталонних репозиторіях: токени системного промпту на сесію, частка Verify з першої спроби по tier, кількість `unverified`. Якщо різниці немає — вимкнути шар і не носити складність.

## Режими запуску

Mod працює повністю в CLI і в Code-вкладці Claude Desktop; у `claude -p`, VS Code-розширенні та хмарних сесіях хуки виконуються, але інтерфейс не малюється. Для середовищ без mods той самий репозиторій дає транспільований fallback.

| Середовище | Що працює | Чим замінюється |
| --- | --- | --- |
| CLI, Desktop Code tab | усе | — |
| `claude -p` (shiftwork-runner, CI-агент) | хуки, `@run`, фільтрація; без `/gate` і pane | профіль з `userConfig` або `[gate:<profile>]` у промпті; `--append-system-prompt` для preload |
| VS Code extension, cloud sessions | хуки без UI | те саме, що для `-p` |
| Claude Code < 2.1.287, `--bare`, `allowManagedModsOnly` | mod не завантажується | `npx context-gate sync`: `.mdc` → `.claude/rules/cursor/*.md` і `.claude/skills/cursor-*`, профілі → `skillOverrides` у `settings.local.json`, DSL → один рендер у `.claude/prompt.generated.md`, підключений через `@`-імпорт у CLAUDE.md |
| Cursor (той самий репозиторій) | — | `.cursor/rules` лишаються джерелом; skills із `.claude/skills` Cursor читає сам |

**Інтеграція зі shiftwork.** Runner читає той самий `gate.json`: `tiers`/`models` → набір skills для `claude -p` через тимчасовий `--plugin-dir` зі symlink-ами, `preload` → `--append-system-prompt`, а тип тікета (`**Type:**`) мапиться на `profiles` напряму, без класифікатора. Mod у TUI і runner у фоні тоді приймають однакові рішення з одного файлу.

**Транспілятор** — окремий Node-скрипт у тому ж пакеті (`packages/cli`), без залежності від mods API, із watch-режимом через `fs.watch` і запуском із `SessionStart` settings-hook (`reloadSkills: true`). Згенеровані файли або в `.gitignore`, або комітяться для CI; mod вимикає свій шар cursor-rules, коли бачить `.claude/rules/cursor/`.

## Тестування, валідація, безпека, продуктивність

**Тести.** Три рівні: чисті функції (`parseMdc`, `compileGlobs`, `decideGate`, DSL-рендер) — звичайні unit-тести таблицею кейсів без `$`; хуки — `claude plugin test` з фейками `fs.list`/`fs.read`/`session.*`, по тесту на кожну подію з карти; наскрізна перевірка — `claude --plugin-dir ./context-gate` на еталонному репозиторії з `.cursor/rules`, 20+ skills і 3 MCP, де `context-report`-подібний хук на `prompt.context` підтверджує, що правила справді дійшли до моделі.

**Валідація перед релізом.** `claude plugin validate --strict` має показувати лише очікуваний набір викликів: `fs.read`, `fs.list`, `fs.exists`, `fs.stat`, `session.root/cwd/model/usage/repo`, `state`, `store`, `tool.register`, `command.register`, `model.classify`, `process.run` (тільки з увімкненим `@run`), `ui.*`. Будь-що поза списком — регресія. Ім'я плагіна не може починатися з `claude-`/`anthropic-`: валідатор відхиляє такі імена як зарезервовані, тому `context-gate`.

**Безпека.** Mod не ізольований і працює з правами користувача. Межі: `@run` лише з білого списку бінарників; жодної мережі (`$.http` не викликається); `.mdc` і DSL-файли з репозиторію — дані, їхній текст ніколи не стає командою; `$.model.classify` отримує лише текст промпту і шляхи, без вмісту файлів; журнал не пише вміст промптів, лише метадані. На Team/Enterprise `sec-default` стоїть першим у ланцюжку, тож mod не може обійти організаційні `deny`-правила — і не намагається: усі свої `deny` він ставить у `tool.call`, не в `tool.check`.

**Продуктивність.** Бюджет хука — 10 с власного часу, час у `$.process.run` і `next` не рахується. Правила й DSL парсяться один раз і кешуються в замиканні модуля; `tool.call` робить лише glob-матч по кешу (мікросекунди). Класифікатор — максимум один виклик на задачу. `@run` кешується за замовчуванням на 5 хвилин. Ціль: без `@run` жоден хук не перевищує 5 мс; усі `@run` разом на один `prompt.compose` — до 2 с, інакше секція пропускається з попередженням.

## Ревю дизайну і прийняті рішення

Дизайн цілісний: одна модель `Item`, чистий конвеєр, harness-адаптери, повна мова на збірці і тотальна AST у рантаймі. Спека при цьому виросла у платформу з сімома підсистемами, і одна проблема лежить на рівні компілятора. Нижче — сім знахідок, і для кожної рішення, яке відтепер вважається частиною специфікації; розділи вище читаються з урахуванням цих рішень, до наступної консолідації тексту.

**Р1. Вирази в пропсах: JS-оператори не перехоплюються.** `when={ctx.ctx.percent > ctx.budgets.soft}` обчислюється на збірці в `false` і мовчки лягає в AST константою; Proxy перехоплює поля і методи, але не `>`, `===`, `&&`, `? :`; те саме з умовами всередині колбеків `Each`. *Рішення:* два рівні, обидва з одним парсером виразів ядра. Рівень 1 (MVP): вирази — рядки в пропсах: `when="ctx.percent > budgets.soft"`, `<Each of="cursor.always" as="r">`, `{'{{ r.body }}'}` або компонент `<V expr="r.body" />`; `ctx` у TSX — лише для типізованих констант збірки, а не для рантайм-виразів; LSP-плагін перевіряє рядки проти `ctx.d.ts` (completion, помилки `G1xx`). Рівень 2 (після bench): TS-трансформер на ts-morph, який переписує вирази в позиціях `when/test/of/children` у AST-вузли і дозволяє нативний синтаксис; компілятор відмовляє всьому, що не входить у підмножину (`G160`). Будь-яка спроба Proxy-магії для операторів заборонена як підхід. *Наслідок:* приклади у шарі 3 читати як рівень 2; рівень 1 — те саме з рядками.

**Р2. Довіра покриває лише збірку, а код запускають і `executors`, `cli`-провайдери, гейти, `@mcp`.** Клон чужого репозиторію з `gate.json` виконував би чужі команди з правами користувача. *Рішення:* єдиний trust-on-first-use на репозиторій (ключ — шлях + remote), що охоплює будь-який `process.run` і `mcp.call`, ініційований конфігурацією з репозиторію; до підтвердження — тільки `module`-провайдери плагіна і читання файлів, секції з `Run`/`Call` рендеряться як `unverified` із заглушкою. Білий список бінарників — лише в user-settings (`~/.claude/context-gate.json`), репозиторій може його тільки звужувати. У `claude -p` і CI довіра задається явно прапорцем `--trust-repo`. Рішення фіксується в `$.store`, скасовується `/gate trust revoke`, зміна `gate.json` з новими командами запитує знову.

**Р3. `.compiled` у git дає конфлікти злиття і дрейф.** *Рішення:* `.compiled/` у `.gitignore`; відтворюваність — через `prompt.lock.json` з хешами всіх джерел і версією компілятора (комітиться); збірка на `session.start`, у LSP і в CI; `claude -p` без збірки отримує промпт лише з CI-артефакту або попередньо зібраного кешу `~/.cache/context-gate/<repo>/`. Коміт `.compiled` допускається як опція `commitCompiled: true` для репозиторіїв без Node у CI.

**Р4. Типи провайдерів без джерела.** `ctx.arch.deny` не може бути типізований, якщо `cli`-провайдер не оголосив форму результату. *Рішення:* поле `schema` у провайдері — JSON Schema інлайном, шлях до `.schema.json` або до `.d.ts`; без схеми тип `unknown`, і доступ до полів у виразах дає попередження `G170`, а не помилку. `context-gate schema infer <provider>` генерує чернетку схеми з реального запуску в `proposals/`. Вбудовані провайдери (`git`, `fs`, `cursor`, `gate`, `session`) мають схеми в пакеті.

**Р5. Дублювання механізмів.** Три способи виконати код, два зберегти, два для лінивого включення, два для preload. *Рішення:* канонічний набір — `Run` (інлайн-код), `Call` (функція модуля через `Use`), `Store` (збереження), `Include` з `mode`, `Skill`/`Rule`/`Mcp` як спеціалізації `Include`. Провайдер `scripts` — цукор, який компілюється в `Use`+`Call`; `Lazy` — у `Include mode="lazy"`; `tiers[*].preload` — у `<Skill mode="inline" />` в автоматично згенерованій секції `preload`; `store=` на `Run` — у `Store`. У AST лишаються лише канонічні вузли; старі записи приймаються до версії 1.0 з попередженням `G180`.

**Р6. Неперевірені точки mods API.** `tool.describe` для MCP, `skill.prompt` з аргументами, `prompt.attachment {type: skill_listing}`, `prompt.compose` з новими `id`, `` !`…` `` у SKILL.md, `e.agentId` на `tool.call`, `$.state` після `/clear`. *Рішення:* етап 0 — окремий плагін-spike `context-gate-probe` з одним хуком на кожну точку, який пише результат у `probe.json`; матриця «працює / не працює / частково» потрапляє в спеку, і кожна функція, що залежить від точки, отримує `requires: [probe:<name>]`. Поки точка не підтверджена, відповідна функція в коді — за прапорцем і в `shadow`. Для `` !`…` `` — додатковий fallback: SKILL.md з попередньо відрендереним тілом і позначкою `static`.

**Р7. Застарілі оцінки і структура.** Оцінки «3–4 тижні» писалися для Markdown-DSL без компілятора, виконавців, LSP і skills; підрозділи шару 3 розкидані; у попередниках відсутні Priompt (JSX-промпти з пріоритетами й токен-бюджетами, Anysphere) і POML (Microsoft, розмітка промптів із даними). *Рішення:* план нижче замінюється на MVP-зріз і три наступні інкременти; наступна правка документа — консолідація: шар 3 як один розділ із підрозділами в порядку «синтаксис → AST → збірка → рантайм → skills → імпорти → налагодження → межі», 3а після нього, Priompt і POML — у таблицю «Хто вже зробив» з висновком, що відрізняє `context-gate`: тотальна AST, harness-інтеграція через mods і конвеєр `Item`, а не лише верстка промпту.

**MVP-зріз (перший реліз, \~4 тижні однієї людини)**

| Включено | Не включено (наступні інкременти) |
| --- | --- |
| Ядро: `Item`, стадії `collect → decide → render → deliver → observe`, журнал | `budget`-стадія як окрема, pipe-CLI повний |
| Адаптер `claude-code-mod`; `static` як fallback | `claude-code-hooks`, `pi`, `opencode` |
| Джерела: `cursor-mdc`, `claude-skills`, `claude-tools` | `markdown-dir`, `provider`-джерела |
| `decide` у shadow, `/gate`, `/gate why`, рядок стану | класифікатор у apply, бюджети `onExceed`, `agent.offer` |
| TSX рівень 1: `Section`, `If`, `Each`, `Include`, `Run`, `Tier`, рядкові вирази; збірка на `session.start` і в CLI | `Use`/`Call`, виконавці інших мов, імпорти бібліотек, skills-as-prompts, `Repeat`, `Store` |
| `context-gate run --trace`, health з 5 метрик (розмір, стабільна частка, час рендера, unverified, урізання) | повний health, bench |
| Provider `cli` з `schema`, `git`, `fs` | `mcp`-провайдер, гейти з `run` |

Критерій виходу MVP: на одному реальному репозиторії тиждень роботи в shadow показує, що запропоновані рішення gate збігаються з ручними ≥ 80 %, а системний промпт із TSX не більший за попередній CLAUDE.md при тому ж результаті Verify.

**Інкременти після MVP:** (1) apply-режим, бюджети, гейти з `run`, `claude-code-hooks`; (2) `Call`, виконавці, `Store`, skills-as-prompts з аргументами, імпорти; (3) TSX рівень 2 (трансформер), LSP-плагін, редактор з preview, bench, `pi`/`opencode`.

**Класифікація.** AST з інтерпретатором — маленька тотальна мова (зовнішня DSL, серіалізована в JSON); `@context-gate/jsx` — вбудована DSL у TypeScript, її пропси — синтаксис цієї AST; mod + CLI + конвеєр — фреймворк (інверсія контролю: він викликає промпти, провайдери і гейти за своїми подіями); `gate.json` — конфігурація; провайдери, виконавці й адаптери — плагінна система фреймворку. Формула для README: «runtime і DSL для контексту Claude Code».

## План реалізації і відкриті питання

Порядок етапів іде від того, що дає найбільше за найменший ризик API: спочатку spike на непідтверджені точки, потім шар із найчистішою семантикою (cursor-rules), потім gate у shadow-режимі, і лише тоді DSL, який на них спирається.

1. **Spike (1 день).** `claude --plugin-dir` з порожнім mod, щоб Claude Code згенерував `.claude-plugin/types/claude-code/index.d.ts`; звірити п'ять точок нижче. Запозичити перевірку в `spike-describe` і `probe2/probe3` з Agnostic-AI.
2. **Ядро + cursor-rules.** `parseMdc`, `compileGlobs`, dedup у `$.state`, `prompt.context` + `tool.call` + `prompt.submit`, `/rule`, тести. Готовність: усі чотири типи правил на еталонному репозиторії з `/gate rules`.
3. **Транспілятор** `npx context-gate sync` і watch; CI-варіант без mod.
4. **skill-gate у shadow.** `gate.json`, `decideGate`, ручні `/gate`, рядок стану, журнал, `/gate why`; класифікатор лише логує. Тиждень на одній машині, щоб побачити точність.
5. **skill-gate apply.** Фільтрація листингу, `skill.prompt`, MCP `deny`, `agent.offer`, бюджети `onExceed`.
6. **prompt DSL.** Парсер директив, інтерпретатор виразів, `@run` з кешем, `@lazy`, `prompt.compose`, перевірка prompt cache через `result.usage` на `turn.step`.
7. **Інтеграція зі shiftwork**: спільний `gate.json`, `--plugin-dir` + `--append-system-prompt` у runner.
8. **Публікація**: marketplace у тому ж репозиторії, `claude plugin validate --strict`, README з таблицею `hooks:`/`calls:`.

Етап 6а, після DSL: tier-адаптивні промпти — `@tier`, файли-варіанти, `examples()`, гейти `readBeforeWrite` / `testBeforeCommit`, бриф через `$.model.complete`, команда `expand`, подія `escalation-suggested` у журналі. Критерій готовності: на еталонному репозиторії quick-tier проходить Verify механічних тікетів не гірше за standard без цих механізмів.

Етап 7а, паралельно зі shiftwork: індекс `gate.index.json` і LSP (`packages/lsp`), тонкий VS Code-клієнт, браузерний редактор з live-preview; провайдери (`cli`, `file`, `mcp`, `module`), `ruleSources` і декларативні `gates[]` — з keylang, tsc і eslint як першими адаптерами в `examples/`. Критерій готовності: автокомпліт пропонує лише імена, які реально існують у сесії, preview збігається з `prompt.compose` байт у байт, а підключення нового інструмента не потребує коду в плагіні.

**Що перевірити в `.d.ts` і на практиці перед кодом**

- [ ] Форма результату `tool.call`: як саме додається контекст після результату інструмента (README agents-md описує механізм, назва поля — у типах).
- [ ] Форма `prompt.context`: структура `blocks` і `e.instructionFiles`; чи можна вставити блок після CLAUDE.md проєкту.
- [ ] `prompt.attachment {type: "skill_listing"}`: формат `e.detail`, чи переписаний `{ text }` справді змінює, що бачить модель (jev-pilot це хукає, тож так).
- [ ] `tool.describe` для `mcp__*`: чи доходить скорочений опис до моделі, чи схема MCP усе одно йде повністю; чи зникає інструмент при `agent.offer`-подібному вимкненні.
- [ ] `e.agentId` на `tool.call` для per-agent дедуплікації.
- [ ] `prompt.compose`: чи приймає нові `id` і перепорядкування, чи лише заміну наявних секцій; чи викликається в `claude -p`.
- [ ] `$.state` після `/clear`: зберігається чи ні (визначає, чи потрібен додатковий скид у `session.end {reason: clear}`).
- [ ] Вбудований `$.model.classify`: вартість, латентність, чи доступний без TypeSafe-ключа у вашому плані.

**Ризики.** Mods API «can change between releases» — усі точки з карти подій покриваються тестами, а plugin pin-иться на мінімальну версію. Нативна підтримка `.mdc` (issue #98167) або нативний skill-router можуть з'явитися у Claude Code; архітектура з трьох незалежних шарів дозволяє вимкнути будь-який із них без переписування решти.

**Джерела**: [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference), [React to events](https://code.claude.com/docs/en/plugins/mods/events), [agents-md README](https://github.com/anthropics/claude-code/blob/main/mods/agents-md/README.md), [Skills](https://code.claude.com/docs/en/skills), [Memory](https://code.claude.com/docs/en/memory), [Hooks](https://code.claude.com/docs/en/hooks), [Cursor Rules](https://cursor.com/docs/rules), [Cursor Skills](https://cursor.com/docs/skills), [Awesome Claude Code Mods](https://mods.aidojo.si/), [shiftwork RESEARCH.md](https://github.com/Ivlad003/shiftwork/blob/main/RESEARCH.md), issues [#98167](https://github.com/anthropics/claude-code/issues/98167), [#98796](https://github.com/anthropics/claude-code/issues/98796), PR [#96364](https://github.com/anthropics/claude-code/pull/96364).
