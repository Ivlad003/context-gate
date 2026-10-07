// Skill: /debug '<symptom>' [--log file]. Replaces "it doesn't work, read the logs, debug it", typed in several agent CLIs.
import { Prompt, Run, Fence, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="debug"
    description="Знаходить причину симптому за логами і кодом, а потім виправляє її. Приклад: /debug 'кнопка експорту нічого не робить' --log logs/app.log"
    args={{
      symptom: arg.string({ positional: 0, required: true, hint: '<symptom>' }),
      log: arg.string({ default: 'logs/app.log' }),
    }}
  >
    <Run lang="bash" cache="10s" as="tail">tail -n 80 {'{{ args.log }}'} 2&gt;&amp;1 || echo "лог-файлу немає"</Run>
    Симптом: «{'{{ args.symptom }}'}». Працюй у такому порядку: відтвори його, знайди причину в коді, виправ причину і запусти перевірку ще раз.
    <Fence lang="text" title="Останні рядки логу">{'{{ tail }}'}</Fence>
    Якщо не вдається відтворити, так і скажи і поясни, що тобі від мене потрібно, замість того щоб вгадувати виправлення. Наприкінці напиши, що ти перевірив, у чому була причина і як я можу сам перевірити виправлення.
  </Prompt>
)
