// Skill: /status [feature]. Replaces "how is it going? what is the status of the tasks?".
import { Prompt, Run, If, Fence, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="status"
    description="Короткий статус тікетів: готово, в роботі, заблоковано і що потребує мого рішення. Приклад: /status checkout"
    args={{ feature: arg.string({ positional: 0, default: null, hint: '[feature]' }) }}
    invoke={{ user: true, model: 'skill' }}
  >
    <Run lang="bash" cache="1m" as="tickets">grep -H '^Status:' .scratch/*/issues/*.md 2&gt;/dev/null || echo "тікетів немає"</Run>
    Дай мені короткий звіт про стан справ.
    <If test="args.feature">Дивись лише на фічу «{'{{ args.feature }}'}».</If>
    <Fence lang="text" title="Рядки статусу тікетів">{'{{ tickets }}'}</Fence>
    Відповідай чотирма короткими частинами: готово, в роботі, заблоковано (і чому), потребує мого рішення. Для кожного рішення дай варіанти і свою рекомендацію, кожне одним реченням.
  </Prompt>
)
