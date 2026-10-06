// Skill: /pr-review --pr 123 [--focus security|perf|style]
import { Prompt, Mcp, If, Else, Each, Tier, Fence, V, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="pr-review"
    description="Рев'ю PR з GitHub: diff і чеклист під поточний профіль. Приклад: /pr-review --pr 123 --focus security"
    args={{
      pr: arg.number({ required: true, hint: '<number>' }),
      focus: arg.enum(['security', 'perf', 'style'], { default: 'style' }),
    }}
    invoke={{ user: true, model: false }}
  >
    <Mcp server="github" tool="get_pr" args={{ number: '{{ args.pr }}', include_diff: true }} as="pr" />
    Переглянь PR #{'{{ args.pr }}'} «<V expr="pr.title" />» з фокусом на {'{{ args.focus }}'}.
    <Fence lang="diff" title="{{ pr.head }} → {{ pr.base }}"><V expr="pr.diff | truncate(8000)" /></Fence>
    Чекліст:
    <ul>
      <If test='args.focus == "security"'>
        <li>Вхідні дані валідуються; немає секретів у коді й логах.</li>
        <Else><li>Імена, структура і тести відповідають умовностям проєкту.</li></Else>
      </If>
      <If test='gate.profile == "frontend"'><li>Доступність: ролі, фокус, контраст.</li></If>
      <Each of="pr.files | take(20)" as="f"><li>Перевір {'{{ f.path }}'} (+{'{{ f.additions }}'}/−{'{{ f.deletions }}'}).</li></Each>
    </ul>
    <Tier is="quick">Відповідай списком знахідок: файл, рядок, проблема, пропозиція.</Tier>
  </Prompt>
)
