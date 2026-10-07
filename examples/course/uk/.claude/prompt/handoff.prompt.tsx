// Skill: /handoff [file]. Replaces "stop and save a handoff to a file so we can continue later".
import { Prompt, Run, Fence, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="handoff"
    description="Зупиняє поточну роботу і пише handoff-файл, з якого нова сесія може продовжити. Приклад: /handoff notes/handoff.md"
    args={{ file: arg.string({ positional: 0, default: 'HANDOFF.md', hint: '[file]' }) }}
  >
    <Run lang="bash" as="diff">git diff --stat HEAD</Run>
    Зупини поточну задачу зараз. Нічого нового не починай.
    Напиши <code>{'{{ args.file }}'}</code> так, щоб інша сесія, яка нічого не пам'ятає про цю і, можливо, працює в іншому агентному CLI, могла продовжити. Пиши звичайним Markdown повними реченнями і не посилайся на те, що є лише в цьому чаті. Використай такі заголовки:
    <ol>
      <li>Мета: чого ми хочемо досягти, у двох-трьох реченнях.</li>
      <li>Зроблено: що вже працює і як ти це перевірив.</li>
      <li>Далі: найближчий крок разом із командою, яку треба запустити.</li>
      <li>Відкриті питання: у чому ти не був певен.</li>
    </ol>
    <Fence lang="text" title="Зміни після останнього коміту">{'{{ diff }}'}</Fence>
  </Prompt>
)
