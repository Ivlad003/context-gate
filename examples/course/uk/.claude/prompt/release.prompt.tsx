// Skill: /release [patch|minor|major] [--dry]. Replaces "let's publish a new version" typed again and again.
import { Prompt, Run, If, Else, Fence, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="release"
    description="Готує нову версію для npm: перевірки, нова версія, changelog, тег. Приклад: /release minor"
    args={{
      bump: arg.enum(['patch', 'minor', 'major'], { positional: 0, default: 'patch' }),
      dry: arg.flag(),
    }}
    invoke={{ user: true, model: false }}
  >
    <Run lang="bash" as="dirty">git status --short</Run>
    <Run lang="bash" as="log">git log --oneline -15</Run>
    Підготуй {'{{ args.bump }}'}-реліз. Поточна версія {'{{ pkg.name }}'}: {'{{ pkg.version }}'}.
    <If test='dirty != ""'>
      Робоче дерево не чисте. Спершу закоміть або сховай ці зміни, а якщо не очевидно, що саме, спитай мене:
      <Fence lang="text">{'{{ dirty }}'}</Fence>
    </If>
    Кроки, саме в такому порядку:
    <ol>
      <li>Запусти всі перевірки проєкту (тести, typecheck, збірку). Якщо щось падає, зупинись і покажи мені помилку.</li>
      <li>Підніми версію командою <code>npm version {'{{ args.bump }}'} --no-git-tag-version</code> у кожному package.json і маніфесті плагіна, де вона є.</li>
      <li>Додай запис у changelog, написаний для користувачів, на основі цих комітів:</li>
    </ol>
    <Fence lang="text" title="Останні коміти">{'{{ log }}'}</Fence>
    <If test="args.dry">
      Це пробний запуск: покажи diff і текст changelog, але нічого не комітай, не тегуй і не пушай.
      <Else>Закоміть, постав тег `v` плюс нова версія, запуш обидва і дай мені точну команду `npm publish`. Сам не публікуй.</Else>
    </If>
  </Prompt>
)
