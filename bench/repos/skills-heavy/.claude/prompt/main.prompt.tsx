import { Prompt, Section, Each, V } from '@context-gate/jsx'

export default (
  <Prompt>
    <Section id="identity" scope="static">Ти інженер платформи (web, api, mobile, data, ops). Відповідай українською.</Section>
    <Section id="rules" scope="profile" budget={1500}>
      <ul><Each of="cursor.always" as="r"><li><V expr="r.body" /></li></Each></ul>
      Активні skills: {'{{ gate.skills.on | join(", ") }}'}.
    </Section>
  </Prompt>
)
