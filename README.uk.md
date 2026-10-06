# context-gate

**Runtime і DSL для контексту Claude Code.**

[English](README.md)

`context-gate` — один Claude Code mod-плагін (Claude Code ≥ 2.1.287), який керує тим, що потрапляє в контекст
моделі: правила Cursor `.mdc`, skills, MCP-інструменти, субагенти і сам системний промпт. Конфігурація лежить у
`.claude/` і комітиться, стан сесії живе в mod-і. Повний дизайн — [`docs/SPEC.md`](docs/SPEC.md); консолідована
карта шару 3 — [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Встановлення

```text
/plugin marketplace add <owner>/context-gate      # репозиторій на GitHub або локальний клон: /plugin marketplace add ./context-gate
/plugin install context-gate@context-gate
```

Marketplace лежить у цьому ж репозиторії (`.claude-plugin/marketplace.json`). Плагін постачається з уже зібраним
CLI (`dist/cli.js`), тож після встановлення нічого збирати не треба — потрібен лише `node` ≥ 22.18 у `PATH`.
Для компіляції TSX-промптів (`build`) потрібен ще `esbuild`: CLI бере його з `node_modules` репозиторію (`npm i -D esbuild`)
або з плагіна після `npm --prefix "${CLAUDE_PLUGIN_ROOT}" ci --omit=dev`; усе інше, зокрема `run` і skills-промпти, працює без нього.
Markdown-промпти збірки не потребують.

Той самий CLI опубліковано в npm як `context-gate` (TSX-компоненти — `@context-gate/jsx`):

```bash
npx context-gate init          # .claude/gate.json з профілями, вгаданими зі структури, classify: shadow
```

## Швидкий старт

```bash
cd your-repo
npx context-gate init                # .claude/gate.json і рядки .gitignore
claude                               # mod завантажується, рядок стану показує gate
```

У сесії:

```text
/gate                 стан: профіль, tier, скільки skills / MCP / правил увімкнено
/gate why             журнал рішень: хто обрав профіль і чому
/gate rules           кожне правило Cursor: тип, globs, чи доставлено
/gate frontend        профіль на сесію; /gate +docs додає групу, /gate auto повертає автоматику
/gate apply           вийти з shadow: gate починає фільтрувати
/gate health          метрики промпту H0xx з колонкою «що зробити»
```

Перший день — **shadow**: нічого не фільтрується, `/gate why` показує, що обрав би класифікатор. Через тиждень
`npx context-gate report` зводить журнал, і `/gate apply` вмикає gate.

## Три шари

| Шар | Що робить | Де |
| --- | --- | --- |
| 1. cursor-rules | `.cursor/rules/*.mdc` із семантикою Cursor: Always — після CLAUDE.md, Auto Attached — як контекст після результату Read/Edit/Write відповідного файлу, Agent Requested — як skills, Manual — через `@id` або `/rule <id>`. Дедуплікація по агентах, перевірка partial read, `strictWrite`. | `hooks/layers/cursor-rules.ts`, `packages/core/src/mdc.ts` |
| 2. skill-gate | Набір skills, MCP-інструментів і субагентів під задачу й модель: профілі з груп, tiers за моделлю, сигнали `when` (шляхи, гілка, тип тікета, вирази), класифікатор раз на задачу з гістерезисом, бюджети, ескалація. Вимкнене отримує однорядковий опис і `{ deny }` із «увімкни через `/gate +група`». | `hooks/layers/skill-gate.ts`, `packages/core/src/decide.ts` |
| 3. prompt DSL | Системний промпт як TSX (або Markdown з `@`-директивами), скомпільований у тотальну AST і відрендерений у `prompt.compose`: умови, цикли, скрипти (`Run`, `Call`), включення (`inline`/`ref`/`lazy`), tier-варіанти. Статична частина стабільна для prompt cache. | `packages/jsx`, `packages/core/src/render.ts`, `hooks/layers/dsl.ts` |

Мінімальний промпт, `.claude/prompt/main.prompt.tsx`:

```tsx
import { Prompt, Section, Each, Tier, Run, V } from '@context-gate/jsx'

export default (
  <Prompt>
    <Section id="identity" scope="static">Ти senior TypeScript-інженер у цьому репозиторії.</Section>
    <Section id="rules" scope="profile" budget={4000}>
      <Each of="cursor.always" as="r"><li><V expr="r.body" /></li></Each>
    </Section>
    <Section id="workflow" scope="profile">
      <Tier is={['quick', 'standard']}>План із 3–6 кроків, покажи його, тести після кожної правки.</Tier>
    </Section>
    <Section id="repo-state" scope="volatile">
      <Run lang="bash" cache="5m" as="log">git log --oneline -5</Run>
      Останні коміти: {'{{ log }}'}
    </Section>
  </Prompt>
)
```

```bash
npx context-gate build                      # → .claude/prompt/.compiled/main.json
npx context-gate run --trace --dry-scripts  # що отримає модель, з таблицею trace
```

## Довідник `.claude/gate.json`

JSON Schema — [`schema/context-gate.schema.json`](schema/context-gate.schema.json). Повний приклад —
[`examples/basic/.claude/gate.json`](examples/basic/.claude/gate.json); монорепо з 12 правилами, 20+ skills і
3 MCP — [`examples/reference/`](examples/reference/).

| Поле | Що означає |
| --- | --- |
| `groups` | група → globs із префіксом виду: `skill:react-*`, `tool:mcp__figma__*`, `agent:ui-reviewer`, `rule:api-*` (старі `skillGroups`/`mcpGroups` — `context-gate migrate`) |
| `tiers` | `premium` / `standard` / `quick` (будь-які назви): `groups`, `preload` (тіла skills інлайн для слабших моделей), `thresholds` |
| `models` | glob id моделі → tier або атрибути `{ match, tier?, contextWindow, costPer1k }` |
| `profiles` | ім'я → `groups` плюс `when`: `paths`, `branch`, `ticketType`, `expr` над провайдерами |
| `classify` | `mode: shadow \| auto`, `model`, `minConfidence`, `recheckOn`, `provider: builtin \| jev \| { kind: cli }` |
| `budgets`, `onExceed` | `softContextPct` / `hardContextPct` по tiers; дії `section`, `notice`, `compact` |
| `escalation` | `order` tiers і `after: { verifyFailed, stallTurns }` → `escalation-suggested` у журналі |
| `brief` | бриф задачі сильною моделлю, раз на задачу, для слабших tiers |
| `providers` | іменовані джерела даних для DSL: `cli` (JSON зі stdout), `file`, `mcp`, `module`; `schema`, `cache`, `onError`, `functions`; для `cli`: `okExitCodes`, `parseOnError` (`eslint -f json` виходить з 1) |
| `executors` | як `Run`/`Call` запускають мову (`python3`, `node`, `bash`, `deno`, …) |
| `itemSources` | джерела елементів: `cursor-mdc`, `markdown-dir`, `provider` (`field`, `as`, `template`), `prompt-dir` (додаткова тека секцій, `as: "section"`), `claude-skills`, `claude-tools` |
| `gates` | детерміновані перевірки: `on: write \| commit \| turn \| prompt`, `run` або `provider`, вираз `pass`, шаблон `message`, `onlyNew` + `baseline`, `tiers`; вбудований `read-before-write` |
| `cursorRules` | `enabled`, `nested`, `maxCharsPerInjection`, `strictWrite` |
| `prompt` | `dir`, `runCacheDefault`, `build: auto \| never`, `commitCompiled`, `persist` |
| `health` | пороги за кодами (`H001`: 12000, …) |
| `debug`, `debugLog`, `assertFail` | обчислення `@debug` і `.claude/gate.debug.log` (1 МБ); хибний `@assert` — `skip` або `fail` |
| `env` | змінні середовища, видимі DSL як `env.*`, у debug-виводі маскуються `***` |
| `allowBinaries` | звужує білий список бінарників користувача (`~/.claude/context-gate.json`), ніколи не розширює |
| `log` | `file: true` — ще й `.claude/gate.log.jsonl` (спільний зі shiftwork-runner) |

Адаптери провайдерів і гейтів для keylang, `tsc` і eslint — [`examples/providers/`](examples/providers/).

## Довідник CLI

`context-gate <команда> [прапорці]`; `context-gate <команда> --help` — довідка команди. Глобальні прапорці:
`--root <dir>`, `--trust-repo`, `--no-user-skills` (не читати `~/.claude/skills`, або `CONTEXT_GATE_NO_USER_SKILLS=1`;
`bench` робить так за замовчуванням). Коди виходу: 0 успіх, 1 помилка, 2 невірні аргументи.

| Команда | Що робить |
| --- | --- |
| **Промпти** | |
| `build` | зібрати `.claude/prompt/*.prompt.tsx` у `.compiled/*.json`, `prompt.lock.json` і SKILL.md |
| `run` | відрендерити промпт, секцію (`--only`) або skill (`run <skill> --args "…"`) тим самим ядром, що й `prompt.compose`; `--trace`, `--json`, `--dry-scripts`, `--ctx-from session:latest\|fixture.json`, `--diff`, `--watch`, `--debug` |
| `render` | рендер секцій або однієї: `render prompt://<id>` |
| `health` | метрики H0xx; `--json` для CI, `--strict` — код 1 при перевищенні |
| `fmt` | вирівняти `@`-директиви Markdown-промптів |
| `expand` | згенерувати quick/standard-варіанти канонічних секцій у `proposals/` |
| `explain <код>` | пояснення коду діагностики (`G0xx`…`G5xx`, `H0xx`, `D0xx`) |
| `index` | записати `.claude/gate.index.json` для редактора |
| **Репозиторій** | |
| `init` | створити `.claude/gate.json` зі структури репозиторію (`classify: shadow`) і рядки `.gitignore` |
| `migrate` | перевести `skillGroups`/`mcpGroups`/`ruleSources` у `groups`/`itemSources` |
| `sync` | fallback без mods: `.mdc` → `.claude/rules/cursor/` і skills, профіль → `skillOverrides`, DSL → `.claude/prompt.generated.md`; `--watch` |
| `example skills` | скопіювати приклади skills-промптів у `.claude/prompt/` |
| `trust` | довіра до репозиторію (Р2): процеси, cli/module-провайдери, `@run`/`@call` |
| `data` | сховище даних скриптів `data.*` |
| `schema infer <провайдер>` | чернетка JSON Schema провайдера з реального запуску |
| `tools` | інструменти моделі: `# gate-tool:` у `.claude/prompt/scripts` і над експортами `lib/*`, `module`-провайдерів і `use`-шляхів; `--call <name> --input '{…}'` виконує один, як mod |
| **Конвеєр (JSONL)** | |
| `pipe "<стадії>"` | увесь конвеєр одним рядком, граматика `/gate`: `collect \| decide --profile x \| tokens` |
| `collect`, `normalize`, `signals`, `decide`, `budget`, `deliver --dry-run`, `observe` | стадії конвеєра |
| `where`, `tokens`, `on`, `off`, `why`, `take`, `sort`, `preview` | фільтри й перегляди |
| **Журнал** | |
| `report` | звіт за журналом: `when` vs класифікатор vs вручну, deny по інструментах із пропозицією «додай групу X у профіль Y», недоставлені правила, ескалації, спроби й токени за tier на задачу, runner vs mod за тікетом, вартість рендера skills-промптів |
| `bench` | токени промпту й елементів до/після gate, `unverified`, по `bench/repos.json` |

## Хуки і виклики

Що показує `claude plugin validate --strict .` для mod-а (перегенерувати: `scripts/validate-calls.sh --markdown`;
CI падає, якщо з'являється виклик `$` поза [`scripts/expected-calls.txt`](scripts/expected-calls.txt)).

| Хук | Навіщо |
| --- | --- |
| `session.start` | прочитати `gate.json`, зареєструвати `/gate` і `/rule`, зібрати застарілі промпти, рядок стану |
| `classic.SessionStart` | `watchPaths` для `.cursor/rules`, `gate.json`, промптів; скид після `/clear`, перевірка після compact |
| `session.end` | скид стану на `/clear` |
| `session.compact` | інструкція зберегти активний профіль і правила |
| `classic.FileChanged` | скид кешу правил, перечитування конфігурації, інкрементальна збірка промптів |
| `command.run{command=gate}`, `command.run{command=rule}`, `command.run` | `/gate …`, `/rule <id>`, аргументи skill-ів із `/name args` |
| `prompt.context` | скид дедуплікації; Always-правила як instruction files після CLAUDE.md (або блок `cursorRules`) |
| `prompt.submit` | `@rule`, `@file` → Auto Attached, `[gate:x]`, сигнали, класифікатор першого промпту, бриф, гейти `prompt` |
| `prompt.attachment{type=skill_listing}` | переписати листинг skills під gate |
| `tool.call{tool=Read\|Edit\|Write\|NotebookEdit}` | glob-правила після результату, `strictWrite`, гейти `write`, read-before-write |
| `tool.call{tool=Bash}` | гейти `commit` на `git commit`; впалі тести/лінт рахуються для ескалації |
| `tool.call{tool=Skill}` | аргументи для `skill.prompt`; вимкнені skills |
| `tool.call{tool=/"^mcp__"/}` | `{ deny }` для MCP поза профілем; власні інструменти плагіна (ліниві включення, скрипти) |
| `tool.describe{tool=/"^mcp__"/}` | однорядковий опис і `isDeferred` для вимкнених MCP |
| `agent.offer` | приховати субагентів поза профілем |
| `skill.prompt` | відмова для вимкненого skill; рендер skill-промпту з аргументами |
| `turn.step` | модель і агент → перерахунок tier; usage prompt cache |
| `turn.complete` | гейти `turn`, лічильник застою, бюджети, ескалація, запис журналу |
| `session.measure` | відсоток контексту, бюджети, рядок стану |
| `prompt.compose` | секції DSL як `context-gate:<id>` (scope `session`) |
| `ui.render{component=AbovePrompt}`, `ui.render{component=Pane, requestId=?}` | смуга стану; pane `/gate why` і health |

| Виклик `$` | Навіщо |
| --- | --- |
| `$.fs.read`, `$.fs.list`, `$.fs.exists`, `$.fs.stat` | `gate.json`, `.mdc`, `.compiled`, skills, mtime |
| `$.fs.write` | `.claude/gate.log.jsonl`, `gate.debug.log`, baseline гейтів, `.trace/last.json`, `gate.index.json` |
| `$.session.root`, `.id`, `.model`, `.repo`, `.usage` | корінь, ключ журналу, tier, гілка, відсоток контексту |
| `$.session.append`, `$.session.compact` | повідомлення в транскрипті; `onExceed: compact` |
| `$.state.get`, `$.state.set` | атоми стану сесії (`context-gate.*`) |
| `$.store.get`, `$.store.set`, `$.store.delete` | довіра до репозиторію, кеш рендера, `data.*` |
| `$.tool.register`, `$.tool.list` | інструменти лінивих включень і скриптів; MCP-сервери сесії |
| `$.command.register` | `/gate`, `/rule` |
| `$.model.classify`, `$.model.complete` | класифікатор (з confidence) і бриф |
| `$.process.run`, `$.process.spawn` | `@run`, cli-провайдери, гейти, збірка промптів (лише довірені репозиторії); `/gate edit` |
| `$.mcp.call` | `@mcp` і `mcp`-провайдери (лише довірені репозиторії) |
| `$.settings.read`, `$.env.get` | білий список бінарників і блок `env` користувача; літерали `HOME`/`OS` |
| `$.clock.after` | відкласти `$.session.compact` за межі поточного ходу |
| `$.ui.*` | `ask` (довіра), `toast`, `status`, `log`, `open`/`close` pane, `invalidate`, `resolve` |

## Режими запуску

| Середовище | Що працює | Чим замінюється |
| --- | --- | --- |
| CLI, Desktop Code tab | усе | — |
| `claude -p` (shiftwork-runner, CI-агент) | хуки, `@run`, фільтрація; без `/gate` і pane | профіль з `userConfig` або `[gate:<profile>]` у промпті; `--trust-repo`; `--append-system-prompt` для preload |
| VS Code extension, cloud sessions | хуки без UI | те саме, що для `-p` |
| Claude Code < 2.1.287, `--bare`, `allowManagedModsOnly` | mod не завантажується | `npx context-gate sync` (нативні `.claude/rules/cursor/`, skills, `skillOverrides`, `prompt.generated.md`) або адаптер settings-хуків `dist/hooks-adapter.js` ([docs/HOOKS-ADAPTER.md](docs/HOOKS-ADAPTER.md)) |
| Cursor (той самий репозиторій) | — | `.cursor/rules` лишаються джерелом; `.claude/skills` Cursor читає сам |

Shiftwork-runner читає той самий `gate.json` і той самий журнал ([docs/SHIFTWORK.md](docs/SHIFTWORK.md)).

## Модель безпеки

- **Mod не ізольований** і працює з правами користувача, тож код із репозиторію запускається лише після
  trust-on-first-use (Р2): один запит на репозиторій (шлях + remote), що охоплює кожен `process.run` і `mcp.call`,
  ініційований конфігурацією репозиторію (збірка промптів, `@run`/`@call`, cli-провайдери, командні гейти,
  `@mcp`). До того — лише читання файлів і власні `module`-провайдери плагіна, а секції зі скриптами рендеряться як
  `unverified`. `/gate trust revoke` скасовує; `gate.json` з новими командами запитує знову; у `claude -p` і CI —
  `--trust-repo`.
- **Білий список бінарників** — лише в user-settings (`~/.claude/context-gate.json`); репозиторій може його тільки
  звузити (`allowBinaries`).
- **Жодної мережі** з DSL: `$.http` не викликається. Дані в скрипти йдуть через stdin як JSON.
- **Текст репозиторію — дані.** `.mdc` і DSL-файли ніколи не стають командою; результат провайдера — дані.
- **Класифікатор** отримує лише текст промпту і шляхи, без вмісту файлів.
- **Журнал** — лише метадані (без тексту промптів, вмісту файлів і виводу команд). Debug-вивід маскує значення
  змінних з білого списку `env`.
- **Організаційні правила першими:** кожен `deny` ставиться в `tool.call`, не в `tool.check`, тому `sec-default`
  і керовані `PreToolUse` ідуть раніше.

## Розробка

```bash
npm ci
npm test                 # unit-тести node:test (test/**/*.test.ts)
npx tsc -p tsconfig.json
npm run build            # dist/cli.js (комітиться: його запускає встановлений плагін)
npm run build:hooks-adapter
npm run typecheck:mod && npm run test:mod   # потрібен claude CLI
npm run validate:mod     # claude plugin validate --strict .
scripts/validate-calls.sh                   # виклики $ проти scripts/expected-calls.txt
scripts/e2e.sh           # один хід claude -p на examples/reference із probe/context-gate-probe
```

`dist/cli.js` і `dist/hooks-adapter.js` комітяться; CI перезбирає їх і падає на diff. Живий probe відкритих питань
mods API — [`probe/`](probe/README.md); статичні результати — [`docs/PROBE.md`](docs/PROBE.md). Bench —
[`bench/`](bench/README.md).

## Ліцензія

MIT
