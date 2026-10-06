import { Prompt, If, V, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="greet"
    description="Привітання. Приклад: /greet Оля --style formal"
    args={{
      who: arg.string({ positional: 0, required: true, hint: '<імʼя>' }),
      style: arg.enum(['casual', 'formal'], { default: 'casual' }),
    }}
  >
    <If test='args.style == "formal"'>Добрий день, <V expr="args.who" />.</If>
    <If test='args.style == "casual"'>Привіт, <V expr="args.who" />!</If>
    Tier: <V expr="gate.tier" />.
  </Prompt>
)
