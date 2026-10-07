// Main system prompt of the example repo (TSX level 1: runtime expressions are strings).
import { Prompt, Section, Each, If, Else, Tier, Run, Include, Skill, Lazy, Fence, V, Let, Examples, HealthWarning, ctx, e } from '@context-gate/jsx'
import { Identity, SafetyRules } from './shared/base.prompt.tsx'
import conventions from '../../CONVENTIONS.md'
import glossary from './data/glossary.json' with { type: 'json' }

// Build-time computation: grouped once at build, lands in the AST as constants.
const types = [...new Set(glossary.terms.map((t) => t.type))]

export default (
  <Prompt>
    <Identity repo="context-gate-example" />
    <SafetyRules level="strict" />

    <Section id="glossary" scope="static">
      Терміни проєкту:
      <ul>
        <Each of={types}>{(type: string) => <li><b>{type}</b>: {glossary.terms.filter((t) => t.type === type).map((t) => `${t.name} — ${t.text}`).join('; ')}</li>}</Each>
      </ul>
    </Section>

    <Section id="project-rules" scope="profile" budget={4000} when='gate.profile in ["frontend", "backend"]'>
      Правила проєкту:
      <ul>
        <Each of="cursor.always" as="r">
          <li><V expr="r.body" /></li>
        </Each>
      </ul>
      <If test="len(cursor.auto) > 0">
        Також діють правила для файлів: {'{{ cursor.auto | map("id") | join(", ") }}'}.
        <Else>Правил для конкретних файлів немає.</Else>
      </If>
    </Section>

    <Section id="workflow" scope="profile">
      Працюй за процесом проєкту: зміни малими кроками, тести перед комітом.

      <Tier is={['quick', 'standard']}>
        <ol>
          <li>Прочитай файли, названі в задачі, і тести поряд з ними.</li>
          <li>Напиши план із 3–6 кроків і покажи його перед першою правкою.</li>
          <li>Після кожної правки: <code>pnpm test -- {'<шлях>'}</code>; не переходь далі, поки не зелено.</li>
        </ol>
      </Tier>
      <Tier is="quick">
        <Examples glob="src/**/*.service.ts" n={1} title="Зразок стилю сервісу з цього репозиторію:" />
      </Tier>
    </Section>

    <Section id="repo-state" scope="volatile" when={e`${ctx.gate.profile} != ${'docs'}`}>
      Гілка {ctx.git.branch}.
      <Run lang="bash" cache="5m" as="log">git log --oneline -5</Run>
      <Let name="recent" value="log" />
      <Fence lang="text" title="Останні коміти">{'{{ recent }}'}</Fence>
    </Section>

    <Section id="references" scope="profile">
      <Include text={conventions} mode="inline" budget={1500} />
      <Include path="CONVENTIONS.md" mode="ref" />
      <Skill name="tdd" mode="ref" />
      <Lazy name="api-conventions" path="docs/api.md">Умовності REST API: ресурси, помилки, пагінація</Lazy>
      <HealthWarning />
    </Section>
  </Prompt>
)
