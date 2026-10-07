// Skill: /research <topic> [--options a,b,c]. Replaces a long one-off "research papers, compare stacks" prompt.
import { Prompt, If, Each, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="research"
    description="Досліджує тему за першоджерелами і порівнює варіанти в таблиці. Приклад: /research 'сховище для local-first застосунку' --options sqlite,indexeddb,files"
    args={{
      topic: arg.string({ positional: 0, required: true, hint: '<topic>' }),
      options: arg.list({ default: [] }),
      out: arg.string({ default: 'docs/research.md' }),
    }}
  >
    Досліди тему «{'{{ args.topic }}'}». Надавай перевагу першоджерелам: статтям, офіційній документації, коду відомих проєктів.
    <If test="len(args.options) > 0">
      Порівняй ці варіанти:
      <ul><Each of="args.options" as="o"><li>{'{{ o }}'}</li></Each></ul>
    </If>
    Запиши результат у <code>{'{{ args.out }}'}</code>: спершу короткий підсумок, потім таблицю порівняння (сильні сторони, обмеження, зусилля, ризики), потім рекомендацію з причинами. Поясни кожне поняття простими словами там, де воно з'являється вперше, і дай джерело для кожного твердження.
  </Prompt>
)
