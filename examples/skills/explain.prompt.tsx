// Skill: /explain <id> — signature of a function and the rules of its layer (provider `arch`).
import { Prompt, Let, If, Each, Fence, V, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="explain"
    description="Пояснює функцію за її id: сигнатура і правила її шару. Приклад: /explain application.purchase.buy"
    args={{ id: arg.string({ positional: 0, required: true, hint: '<id>' }) }}
  >
    <Let name="fn" value="arch.code(args.id)" />
    <If test="fn">
      <Fence lang="ts" title="{{ fn.path }}"><V expr="fn.signature" /></Fence>
      Шар {'{{ fn.layer }}'}; правила шару:
      <ul><Each of="arch.rules(fn.layer)" as="r"><li><V expr="r" /></li></Each></ul>
    </If>
    Поясни, що робить {'{{ args.id }}'}, і які межі шару вона не має порушувати.
  </Prompt>
)
