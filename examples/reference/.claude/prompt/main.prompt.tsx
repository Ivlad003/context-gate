// Main system prompt of the reference monorepo (SPEC scenario 1–3, 7; TSX level 1: runtime expressions are strings).
import { Prompt, Section, Each, If, Else, Tier, Run, Include, Skill, Fence, V, Let, Examples, HealthWarning, ctx, e } from '@context-gate/jsx'
import { Identity, SafetyRules } from './shared/base.prompt.tsx'
import conventions from '../../CONVENTIONS.md'

// Build-time constants: computed once at build, land in the AST as text.
const apps = [
  { dir: 'apps/web', stack: 'React 19 + Tailwind + Storybook' },
  { dir: 'apps/api', stack: 'NestJS + Prisma + Postgres' },
]

export default (
  <Prompt>
    <Identity repo="acme-reference" stack="TypeScript, npm workspaces" />
    <SafetyRules />

    <Section id="layout" scope="static">
      Структура:
      <ul>
        {apps.map((a) => <li><code>{a.dir}</code> — {a.stack}</li>)}
      </ul>
    </Section>

    <Section id="project-rules" scope="profile" budget={4000}>
      Правила проєкту:
      <ul>
        <Each of="cursor.always" as="r">
          <li><V expr="r.body" /></li>
        </Each>
      </ul>
      <If test="len(cursor.auto) > 0">
        Правила для файлів підключаються, коли ти відкриваєш відповідний файл: {'{{ cursor.auto | map("id") | join(", ") }}'}.
        <Else>Правил для конкретних файлів немає.</Else>
      </If>
      Правила за запитом (підтягни, якщо задача про це):
      <ul>
        <Each of="cursor.agent" as="r">
          <li><V expr="r.id" /> — <V expr="r.description" /></li>
        </Each>
      </ul>
    </Section>

    <Section id="frontend" scope="profile" when={e`${ctx.gate.profile} == ${'frontend'}`}>
      Фронтенд: компоненти в <code>apps/web/src</code>, історії Storybook поряд (<code>*.stories.tsx</code>).
      Макети — через MCP figma, перевірка в браузері — через MCP playwright.
      <Tier is="quick">
        <Examples glob="apps/web/src/*.tsx" n={1} title="Зразок компонента з цього репозиторію:" />
      </Tier>
    </Section>

    <Section id="workflow" scope="profile">
      Працюй малими кроками: тест → правка → <code>{'{{ pkg.scripts.test }}'}</code> перед комітом.

      <Tier is={['quick', 'standard']}>
        <ol>
          <li>Прочитай файли, названі в задачі, і тести поряд з ними.</li>
          <li>Напиши план із 3–6 кроків і покажи його перед першою правкою.</li>
          <li>Після кожної правки запускай тести цього пакета; не переходь далі, поки не зелено.</li>
        </ol>
      </Tier>
    </Section>

    <Section id="lint-state" scope="volatile" when="eslint != null">
      ESLint: файлів із помилками — {'{{ eslint | where("errorCount") | len }}'} з {'{{ eslint | len }}'}.
      <ul>
        <Each of='eslint | where("errorCount") | sort("-errorCount") | take(3)' as="f">
          <li><V expr="f.filePath" />: <V expr="f.errorCount" /></li>
        </Each>
      </ul>
    </Section>

    <Section id="repo-state" scope="volatile" when={e`${ctx.gate.profile} != ${'docs'}`}>
      Гілка {ctx.git.branch}.
      <Run lang="bash" cache="5m" as="log">git log --oneline -5</Run>
      <Let name="recent" value="log.stdout" />
      <Fence lang="text" title="Останні коміти">{'{{ recent }}'}</Fence>
    </Section>

    <Section id="budget-warning" scope="volatile" when="ctx.percent > budgets.soft">
      Контекст заповнено на {'{{ ctx.percent }}'}%: відповідай стисло, не читай великих файлів повністю, запропонуй /compact.
    </Section>

    <Section id="references" scope="profile">
      <Include text={conventions} mode="inline" budget={1500} />
      <Skill name="tdd" mode="ref" />
      <Include path="docs/api.md" mode="lazy" description="Умовності REST API: ресурси, помилки, пагінація" />
      <HealthWarning />
    </Section>
  </Prompt>
)
