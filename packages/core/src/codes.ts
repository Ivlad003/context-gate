// Diagnostic code table (SPEC: "Коди, explain, fmt, proposals" and every code named in the spec).
// `context-gate explain <code>` prints `explain(code)`.

import type { Code, Diagnostic } from './types.ts'

export interface CodeInfo {
  title: string
  explain: string
  hint?: string
  severity: Diagnostic['severity']
}

const PROVIDER_HINT = 'Ця логіка має жити в провайдері (`module`-провайдер або `Run`).'

export const CODES: Record<string, CodeInfo> = {
  // ── G0xx: structure (.mdc and prompt files) ──
  G001: { severity: 'error', title: 'Невірна структура промпту', explain: 'Промпт порушує структуру DSL: невідома директива, `<Section>` поза `<Prompt>` або вкладена, `<Else>` поза `<If>`, відсутній обов\'язковий проп, два файли з одним id, пошкоджений `.compiled/<id>.json`. Два `.mdc` правила з одним id — попередження: друге пропущено.', hint: 'Повідомлення називає елемент і місце; `context-gate build` показує всі.' },
  G002: { severity: 'error', title: 'Незакритий блок', explain: 'Блок `@if`/`@each`/`@run`/… не має `@end`. Його закрито в кінці файлу.', hint: 'Додай `@end`.' },
  G003: { severity: 'error', title: 'Зайвий @end або @else', explain: '`@end` без відкритого блоку, або `@else`/`@elif` без відповідного `@if`.' },
  G004: { severity: 'error', title: 'Невірний синтаксис директиви', explain: 'Директива Markdown-DSL має неправильну форму аргументів (наприклад `@each x in <вираз>`, `@call ns.fn() as x`).', hint: 'Повідомлення показує очікувану форму.' },
  G005: { severity: 'error', title: '@break/@continue поза циклом', explain: '`@break` і `@continue` дозволені лише всередині `@each` або `@repeat`. У тілі `@fn` — лише якщо кожен виклик функції стоїть у циклі; інакше сигнал ігнорується, решта секції рендериться.' },
  G006: { severity: 'warning', title: 'Невірний frontmatter промпту', explain: 'Frontmatter Markdown-промпту не закрито, має нерозпізнаний рядок або невірне значення (`scope`, `budget`).' },
  G010: { severity: 'warning', title: 'Незакритий frontmatter', explain: 'Файл починається з `---`, але закривального `---` немає. Весь файл вважається тілом правила (тип Manual).', hint: 'Додай рядок `---` після полів frontmatter.' },
  G011: { severity: 'info', title: 'Невідоме поле frontmatter', explain: 'У frontmatter `.mdc` є поле, яке Cursor не використовує (відомі: description, globs, alwaysApply). Поле ігнорується.' },
  G012: { severity: 'warning', title: 'Невірне значення alwaysApply', explain: '`alwaysApply` має бути `true` або `false`. Інше значення трактується як `false`.' },
  G013: { severity: 'warning', title: 'Порожній glob', explain: 'Список `globs` містить порожній елемент (зайва кома або порожній рядок). Його пропущено.' },
  G014: { severity: 'warning', title: 'Рядок frontmatter не розпізнано', explain: 'Рядок не має форми `ключ: значення` і не є елементом списку. Його пропущено.' },
  G015: { severity: 'warning', title: 'Правило без умов', explain: 'Є `globs`, але всі вони негативні (`!pattern`): правило ніколи не спрацює автоматично.', hint: 'Додай хоча б один позитивний glob.' },
  G016: { severity: 'warning', title: 'Підозрілий glob', explain: 'Glob у `globs` правила не компілюється (його пропущено) або містить лапки — часто це ознака неправильно записаного списку.', hint: 'Перевір синтаксис glob і формат списку `globs`.' },
  G020: { severity: 'warning', title: 'after: секцію не знайдено', explain: '`after=` посилається на секцію, якої немає в тому самому scope. Секцію лишено на місці.' },
  G021: { severity: 'warning', title: 'Цикл у after', explain: 'Ланцюжок `after=` утворює цикл. Секції лишено в порядку джерела.' },
  // ── G1xx: expressions and language limits ──
  G101: { severity: 'error', title: 'Синтаксична помилка виразу', explain: 'Вираз не парситься: неочікуваний символ, порожній вираз або конструкція поза граматикою.' },
  G102: { severity: 'error', title: 'Незакритий рядок', explain: 'Рядковий літерал у виразі не має закривальної лапки.' },
  G103: { severity: 'error', title: 'Невідома функція', explain: 'Виклик функції, якої немає серед вбудованих. Решта функцій — через провайдер `ns.fn(...)`.' },
  G104: { severity: 'error', title: 'Невідомий фільтр', explain: 'Фільтр після `|` не входить у перелік дозволених.' },
  G105: { severity: 'error', title: 'Невірна кількість аргументів', explain: 'Метод чи функція отримали не ту кількість аргументів.' },
  G106: { severity: 'warning', title: 'Ділення на нуль', explain: 'Ділення на нуль у виразі; результат `null`.' },
  G107: { severity: 'warning', title: 'Невірний регулярний вираз', explain: 'Регулярний вираз не компілюється, довший за 500 символів або використовує те, чого не підтримує лінійний рушій (зворотні посилання, lookaround, модифікатори); надто складні повтори `{n,m}` теж дають G107. Збіг вважається хибним.' },
  G108: { severity: 'error', title: 'Іменовані аргументи не підтримуються', explain: 'Функція або фільтр не приймає аргументів `k=v`.' },
  G120: { severity: 'warning', title: '@each по не-списку', explain: 'Значення для `@each`/`<Each of>` не є списком; блок пропущено.' },
  G151: { severity: 'error', title: 'Рекурсія функції', explain: 'Функція (`@fn` або власний компонент) викликає сама себе прямо чи через іншу функцію. DSL тотальна: рекурсія заборонена.', hint: PROVIDER_HINT },
  G152: { severity: 'error', title: 'Цикл без межі', explain: '`@each` «поки» без межі, або `@repeat` понад 1 000 ітерацій чи з межею, невідомою до запуску.', hint: 'Провайдер повертає готовий список. ' + PROVIDER_HINT },
  G153: { severity: 'error', title: 'Перевизначення константи', explain: 'Ім\'я, прив\'язане через `@let`, перевизначено пізніше в тій самій секції.', hint: '`@let` з новим іменем або провайдер. ' + PROVIDER_HINT },
  G154: { severity: 'error', title: 'Провайдер не на початку pipe', explain: 'Вираз із `@run` або викликом провайдера стоїть не на початку ланцюжка `|`. Фільтри — лише чисті функції.', hint: 'Перенеси виклик провайдера на початок. ' + PROVIDER_HINT },
  G155: { severity: 'error', title: 'Перевищено ліміт кроків', explain: 'Інтерпретатор виконав понад 10 000 кроків у секції, або значення/рядок перевищили ліміт розміру (2^20 комірок, 2^26 символів, глибина 256). Секцію пропущено; це вважається помилкою конфігурації.', hint: PROVIDER_HINT },
  G156: { severity: 'error', title: 'Завелика глибина вкладення', explain: 'Вкладення `@if` понад 3 рівні або `@each` понад 2, або розгортання викликів `@fn` дає понад 10 000 вузлів (функція, що двічі кличе функцію, що двічі кличе…).', hint: 'Розбий секцію на кілька.' },
  G157: { severity: 'error', title: 'Доступ до файлів, процесів чи мережі з виразу', explain: 'Вирази DSL не мають побічних ефектів і не читають файли.', hint: 'Використай `@run` або провайдер.' },
  G158: { severity: 'error', title: 'Функції немає в модулі', explain: '`Call` посилається на функцію, яку модуль із `Use` не експортує. Помилка валідації ще до рендера.', hint: 'Перевір ім\'я функції або `functions` провайдера.' },
  G159: { severity: 'error', title: 'Цикл включень', explain: '`@include` / `@section` утворюють цикл або глибину понад 3.', hint: 'Прибери взаємні включення.' },
  G160: { severity: 'error', title: 'Синтаксис поза підмножиною', explain: 'TS-трансформер (рівень 2) не може перетворити цей вираз у вузол AST: конструкція поза дозволеною підмножиною.', hint: 'Запиши вираз рядком (рівень 1) або винеси в провайдер.' },
  G161: { severity: 'error', title: 'Дубль секції', explain: '`Section` з тим самим `id` оголошено у двох файлах.', hint: 'Перейменуй одну з секцій.' },
  G162: { severity: 'error', title: 'Завеликий .compiled', explain: 'Зібраний `.compiled/<id>.json` більший за 2 МБ.', hint: 'Винеси дані в `Include mode="lazy"` або провайдер.' },
  G163: { severity: 'error', title: 'Run без cache у static', explain: '`@run` / `<Run>` без `cache` у секції `scope: static`. Static рендериться один раз і має бути стабільною.', hint: 'Додай `cache="5m"` або перенеси секцію у `volatile`.' },
  G164: { severity: 'error', title: 'Помилка збірки промпту', explain: 'esbuild не зміг зібрати `.prompt.tsx`, або модуль упав під час виконання на збірці.', hint: 'Повідомлення містить помилку esbuild або stderr модуля.' },
  G170: { severity: 'warning', title: 'Провайдер без схеми', explain: 'Доступ до поля результату провайдера, який не оголосив `schema`: тип `unknown`.', hint: 'Додай `schema` або згенеруй чернетку: `context-gate schema infer <provider>`.' },
  G171: { severity: 'warning', title: 'Невідома змінна', explain: 'Вираз посилається на ім\'я, якого немає ні серед коренів контексту, ні серед локальних прив\'язок.', hint: 'Корені контексту: gate, git, fs, cursor, session, ctx, budgets, args, data і провайдери з gate.json; локальні — з as=/name=.' },
  G172: { severity: 'warning', title: 'Невідоме поле', explain: 'Поле не існує у відомій формі значення (провайдер зі `schema`, корінь контексту), або функцію використано без виклику.', hint: 'Перевір назву поля або `schema` провайдера.' },
  G180: { severity: 'warning', title: 'Застарілий механізм', explain: 'Використано некононічний запис (`Lazy`, провайдер `scripts`, `store=` на `Run`, `tiers[*].preload` поза секцією `preload`). Він приймається до версії 1.0.', hint: 'Перейди на `Include mode=…`, `Use`+`Call`, `Store`.' },
  // ── G2xx: run / lazy / providers ──
  G201: { severity: 'warning', title: 'Бінарник поза білим списком', explain: 'Виконавець, shim або cli-провайдер запускає програму, якої немає в `allowBinaries` (за замовчуванням bash, sh, node, python3, python, deno, git; ~/.claude/context-gate.json). `allowBinaries` у gate.json репозиторію список лише звужує.', hint: 'Додай бінарник у allowBinaries користувацьких налаштувань.' },
  G202: { severity: 'warning', title: 'Немає виконавця для мови', explain: '`@run <мова>` або `<Run lang>` посилається на мову, якої немає в `executors` (вбудовані: bash, node, python, deno).', hint: 'Додай `executors.<мова>` у gate.json.' },
  G203: { severity: 'warning', title: 'Run або провайдер завершився з помилкою', explain: '`@run`, cli/file/module-провайдер не повернув даних. Далі діє `onError`: unverified — значення null; skip — секцію пропущено; fail — рендер завершується з помилкою.' },
  G204: { severity: 'warning', title: 'Репозиторій не довірений', explain: 'До підтвердження довіри (Р2) не запускаються процеси репозиторію: @run/@call рендеряться заглушками, cli/module-провайдери дають null.', hint: 'context-gate trust grant або --trust-repo.' },
  G205: { severity: 'info', title: 'MCP недоступний у CLI', explain: 'Провайдери kind=mcp і @mcp працюють лише всередині Claude Code (mod викликає $.mcp.call). У CLI значення unverified.' },
  G206: { severity: 'warning', title: 'Контекст --ctx-from не знайдено', explain: 'Знімок session:<id> відсутній у .claude/gate.log.jsonl (потрібен `log.file: true`) або fixture не є JSON-об\'єктом.' },
  G207: { severity: 'warning', title: 'Дані не готові', explain: 'Після кількох проходів рендера `needs=` досі чекає на дані без джерела (одруківка в імені, ім\'я з `@let`/`@set` замість `as=` у `@run`/`@call`/`@mcp`), або аргументи `@call` залежать від значення, якого так і не отримано; секцію відрендерено з null, статус unverified.', hint: 'Перевір імена в `needs=` — це `as=` блоків тієї самої секції.' },
  G208: { severity: 'info', title: 'Дані провайдера недоступні в адаптері', explain: 'Адаптер без моделі довіри (claude-code-hooks, pi, opencode) не запускає процеси репозиторію: `itemSources` kind=provider над cli/module/mcp-провайдером пропущено. Провайдери kind=file читаються. Повний набір — у mod і CLI.', hint: 'Використай file-провайдер (JSON, який пише CI) або mod.' },
  G210: { severity: 'warning', title: 'Файл для @include не знайдено', explain: 'Шлях @include/<Include path> не існує відносно кореня репозиторію.' },
  G211: { severity: 'warning', title: 'Секцію або елемент не знайдено', explain: '@section/@skill/@rule або --only посилається на id, якого немає.' },
  G220: { severity: 'error', title: 'Невірне ім\'я gate-tool', explain: 'Заголовок `# gate-tool:` має містити ім\'я з латиниці, цифр, _ або -.' },
  G221: { severity: 'error', title: 'Невірний input у gate-tool', explain: '`# input:` має бути JSON: скорочення `{ "path": "string" }` або повна JSON Schema.' },
  // ── G3xx: config (.claude/gate.json) ──
  G301: { severity: 'error', title: 'gate.json не є об\'єктом', explain: 'Файл конфігурації не є JSON-об\'єктом або не парситься. Шар skill-gate вимкнено до виправлення; сесія працює далі.', hint: 'Перевір JSON: `context-gate validate`.' },
  G302: { severity: 'warning', title: 'Невідомий ключ', explain: 'Ключ не входить у схему gate.json і ігнорується. Часто це одруківка.' },
  G303: { severity: 'error', title: 'Невірний тип значення', explain: 'Значення поля має інший тип, ніж вимагає схема. Шар skill-gate вимкнено, причина — у `/gate why`.' },
  G304: { severity: 'warning', title: 'Посилання на невідому групу', explain: 'Профіль або tier посилається на групу, якої немає в `groups` (чи `skillGroups`/`mcpGroups`). Посилання нічого не вмикає.' },
  G305: { severity: 'warning', title: 'Невідомий tier', explain: '`models`, `escalation.order`, `gates[].tiers`, `brief.tiers` чи `budgets.tiers` посилається на tier, якого немає в `tiers`; або власні tiers задано без `models`, і типова мапа моделей веде на неоголошені tiers.' },
  G306: { severity: 'error', title: 'Невірний регулярний вираз', explain: '`when.branch` має бути валідним регулярним виразом JavaScript.' },
  G307: { severity: 'error', title: 'Невірна тривалість', explain: 'Тривалість має форму `500ms`, `10s`, `5m`, `1h`, `1d` (можна поєднувати: `1h30m`).' },
  G308: { severity: 'error', title: 'Значення поза переліком', explain: 'Поле приймає лише значення з переліку, вказаного в повідомленні.' },
  G309: { severity: 'error', title: 'Значення поза діапазоном', explain: 'Число виходить за допустимі межі (наприклад `minConfidence` 0…1, відсотки 0…100).' },
  G310: { severity: 'warning', title: 'Застарілий формат конфігурації', explain: 'Поля `skillGroups`, `mcpGroups`, `ruleSources` і `skills`/`mcp`/`agents` у профілях чи tiers — старий формат. Вони конвертуються в єдині `groups` з kind-префіксами (`skill:…`, `tool:mcp__<server>__*`, `agent:…`) і `itemSources`.', hint: 'Запусти `context-gate migrate`, щоб переписати gate.json у новому форматі.' },
  G311: { severity: 'error', title: 'Відсутнє обов\'язкове поле', explain: 'Обов\'язкове поле об\'єкта відсутнє.' },
  G312: { severity: 'warning', title: 'softContextPct ≥ hardContextPct', explain: 'М\'який поріг бюджету не менший за жорсткий: попередження ніколи не встигне спрацювати.' },
  G313: { severity: 'warning', title: 'Невірне джерело елементів', explain: 'Запис `itemSources`/`ruleSources` неповний: `markdown-dir` потребує `dir`, `provider` — `name` провайдера, оголошеного в `providers`. Джерело пропущено.' },
  G314: { severity: 'error', title: 'Шлях поза репозиторієм', explain: 'Шлях у gate.json (`prompt.dir`, `itemSources[].dir`, `ruleSources[].dir`, `gates[].baseline`, `debugLog.path`, `providers.*.path`) абсолютний, містить `..`, NUL чи диск/UNC. Недовірений репозиторій міг би читати файли поза ним у промпт або перезаписувати файли користувача.', hint: 'Лише відносні шляхи всередині репозиторію.' },
  G315: { severity: 'warning', title: 'Невірний або оманливий glob', explain: 'Glob у `groups`, `preload` чи `when.paths` не компілюється, заперечення записане як `kind:!x` замість `!kind:x`, заперечення в `preload`, або `when.paths` має лише негативні globs (профіль ніколи не спрацює за шляхами).' },
  G316: { severity: 'warning', title: 'Профіль недоступний через /gate', explain: 'Назва профілю збігається з підкомандою чи стадією pipe, містить «+» (читається як об\'єднання профілів), пробіл, кому чи «]» — `/gate <name>` або `[gate:<name>]` його не вмикає.', hint: 'Перейменуй профіль.' },
  G317: { severity: 'warning', title: 'Новіша версія gate.json', explain: '`version` у gate.json новіша, ніж розуміє встановлений context-gate: нові ключі ігноруються.', hint: 'Онови context-gate.' },
  // ── G5xx: pipe / /gate command ──
  G501: { severity: 'error', title: 'Невідома стадія pipe', explain: 'Стадія конвеєра не входить у граматику.', hint: 'Відомі стадії: collect, normalize, decide, budget, render, deliver, observe, where, tokens, on, off, why, take, sort, preview.' },
  G502: { severity: 'error', title: 'Невідомий профіль або підкоманда', explain: 'Слово після `/gate` не є підкомандою і не збігається з жодним профілем з gate.json.', hint: '`/gate` без аргументів показує профілі; `/gate help` — підкоманди.' },
  G503: { severity: 'error', title: 'Порожня стадія pipe', explain: 'Між двома `|` немає стадії.' },
  G504: { severity: 'error', title: 'Невірний аргумент стадії', explain: 'Аргумент стадії має форму `key=value`, `--key value` або `--flag`.' },
  G505: { severity: 'error', title: 'Бракує аргументу', explain: 'Підкоманда потребує аргументу (наприклад `/gate render prompt://<id>`).' },
  G506: { severity: 'error', title: 'Змішані аргументи груп', explain: '`/gate +a -b` приймає лише групи з `+` або `-`.' },
  G507: { severity: 'error', title: 'Невідома дія trust', explain: 'Підтримується лише `/gate trust revoke`.' },
  G508: { severity: 'error', title: 'Невірний фільтр where', explain: 'Фільтр має форму `where key=value` (також `!=`, `~` для підрядка, `>`/`<` для чисел), умови через пробіл або `and`.' },
  // ── H0xx: prompt health ──
  H001: { severity: 'warning', title: 'Завеликий промпт', explain: 'Системний промпт разом понад 12 000 токенів.', hint: 'Бюджети на секції, `Include mode="lazy"`, Always-правила → Auto Attached.' },
  H002: { severity: 'warning', title: 'Мала стабільна частка', explain: 'Незмінний від минулого ходу префікс промпту менший за 70 %. Prompt cache — префіксний: перша змінена або переставлена секція скидає кеш усього, що після неї, разом з історією розмови. З реальним usage — частка cache_read у вхідних токенах.', hint: 'Змінні дані — у кінець (`scope: volatile`) або поза системний промпт (`prompt.volatile: "context"`); стабілізуй значення (cache=, округлення).' },
  H003: { severity: 'warning', title: 'Дрейф промпту', explain: 'Текст промпту поза `volatile` між ходами змінився більш ніж на 500 токенів (рахується змінений вміст секцій, а не різниця розмірів).' },
  H004: { severity: 'warning', title: 'Повільний рендер', explain: 'Рендер без скриптів триває понад 1 с.' },
  H005: { severity: 'warning', title: 'Повільний рендер зі скриптами', explain: 'Рендер разом із `@run` і провайдерами триває понад 2 с; секції зі скриптами пропускаються.', hint: 'Додай `cache` до `Run` або винеси в провайдер.' },
  H006: { severity: 'warning', title: 'Застарілі дані', explain: 'Секцію відрендерено з даних провайдера або `data.*`, що застаріли (`stale`) або взяті з резерву.' },
  H007: { severity: 'warning', title: 'Непідтверджена доставка', explain: 'Є елементи зі статусом `unverified` після apply-режиму.' },
  H008: { severity: 'warning', title: 'Урізання static', explain: 'Секцію `scope: static` обрізано за `budget`.' },
  H009: { severity: 'warning', title: 'Переповнення листингу skills', explain: 'Листинг skills перевищує нативний бюджет 1 % контексту.', hint: 'Звузь профіль або переведи частину skills у `nameOnly`.' },
  H010: { severity: 'warning', title: 'Часті deny', explain: 'Понад 3 deny одного інструмента за сесію.', hint: 'Додай групу інструмента в профіль.' },
  H011: { severity: 'warning', title: 'Гейт блокує надто часто', explain: 'Гейт блокує понад 30 % спроб.' },
  H012: { severity: 'warning', title: 'Дорогий системний промпт', explain: 'Системний промпт становить понад 40 % вхідних токенів.' },
  H013: { severity: 'warning', title: 'Застарілий .compiled', explain: '`.compiled/<id>.json` старіший за `.tsx` або його імпорти; використано попередню збірку.', hint: '`context-gate build`.' },
  // ── D0xx: debug ──
  D001: { severity: 'warning', title: 'Assert не пройшов', explain: 'Умова `@assert` хибна; за `assertFail` секцію пропущено або рендер упав.' },
}

export function codeInfo(code: string): CodeInfo | undefined {
  return CODES[code]
}

/** Human-readable explanation for `context-gate explain <code>`. */
export function explain(code: string): string {
  const c = code.trim().toUpperCase()
  const info = CODES[c]
  if (!info) {
    const family = /^G5/.test(c) ? 'G5xx — pipe і /gate' : /^G3/.test(c) ? 'G3xx — конфігурація' : /^G1/.test(c) ? 'G1xx — вирази' : /^G2/.test(c) ? 'G2xx — run/lazy/провайдери' : /^G4/.test(c) ? 'G4xx — tier-варіанти' : /^G0/.test(c) ? 'G0xx — структура' : /^H/.test(c) ? 'H0xx — health' : /^D/.test(c) ? 'D0xx — debug' : undefined
    return `Невідомий код ${c}.` + (family ? ` Родина: ${family}.` : '')
  }
  let out = `${c} — ${info.title} (${info.severity})\n\n${info.explain}`
  if (info.hint) out += `\n\nПідказка: ${info.hint}`
  return out
}

/** Build a Diagnostic with the table's default severity, title and hint. */
export function diag(code: Code, message?: string, extra: Partial<Diagnostic> = {}): Diagnostic {
  const info = CODES[code]
  const d: Diagnostic = {
    code,
    severity: info?.severity ?? 'error',
    message: message ?? info?.title ?? code,
  }
  if (info?.hint) d.hint = info.hint
  return { ...d, ...extra }
}
