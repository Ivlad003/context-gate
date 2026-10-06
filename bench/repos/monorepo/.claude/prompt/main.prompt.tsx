import { Prompt, Section, Each, If, V } from '@context-gate/jsx'

const packages = ['packages/ui', 'packages/server']

export default (
  <Prompt>
    <Section id="identity" scope="static">
      Ти інженер у монорепозиторії: {packages.join(', ')}. Відповідай українською.
    </Section>
    <Section id="rules" scope="profile" budget={2500}>
      <ul><Each of="cursor.always" as="r"><li><V expr="r.body" /></li></Each></ul>
      <If test="len(cursor.auto) > 0">Правила пакетів: {'{{ cursor.auto | map("id") | join(", ") }}'}.</If>
    </Section>
    <Section id="release" scope="profile" when='gate.profile == "release"'>
      Кожна зміна публічного пакета — з changeset; не піднімай версії вручну.
    </Section>
  </Prompt>
)
