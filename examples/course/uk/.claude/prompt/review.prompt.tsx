// Skill: /review [--focus …]. Replaces "do a full and deep review of the whole project, find bugs".
import { Prompt, If, Each, Tier, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="review"
    description="Ревю проєкту з вибраним фокусом; знахідки впорядковані, кожна має доказ. Приклад: /review --focus bugs"
    args={{
      focus: arg.enum(['bugs', 'architecture', 'docs', 'security'], { default: 'bugs' }),
      paths: arg.list({ default: [] }),
      out: arg.string({ default: 'docs/reviews/latest.md' }),
    }}
  >
    Зроби ревю цього проєкту з фокусом на {'{{ args.focus }}'}.
    <If test="len(args.paths) > 0">
      Дивись лише на ці шляхи:
      <ul><Each of="args.paths" as="p"><li><code>{'{{ p }}'}</code></li></Each></ul>
    </If>
    Для кожної знахідки дай файл і рядок, що саме ламається, конкретні вхідні дані, які це показують, і пропозицію виправлення. Упорядкуй знахідки від найсерйознішої до найменшої. Дрібниці стилю пропускай, якщо фокус не docs.
    Записуй кожну знахідку в <code>{'{{ args.out }}'}</code> одразу, як тільки підтвердив її, а не наприкінці, щоб нічого не загубилося, якщо сесія зупиниться.
    <If test='args.focus == "architecture"'>Почни з короткої карти модулів і того, як дані ходять між ними, а потім оцінюй межі.</If>
    <Tier is="quick">Перевір кожну знахідку ще раз перед тим, як її показати, і викинь ті, які не можеш довести.</Tier>
  </Prompt>
)
