// Skill: /release-notes <tag|sha> [--format md|slack|github] [--scope <scope>] [--dry]
// Rendered at invocation time with parsed args (SPEC «Промпти як skills»).
import { Prompt, Use, Let, Assert, Each, If, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="release-notes"
    description="Чернетка release notes з комітів від тегу. Приклади: /release-notes v1.4.0, /release-notes --since v1.4.0 --format slack"
    args={{
      since: arg.string({ positional: 0, required: true, hint: '<tag|sha>' }),
      format: arg.enum(['md', 'slack', 'github'], { default: 'md' }),
      scope: arg.string({ default: null }),
      dry: arg.flag(),
    }}
    invoke={{ user: true, model: 'tool' }}
    tiers={['standard', 'premium']}
  >
    <Use name="gitx" path="scripts/git-extra.js" />
    <Let name="commits" value="gitx.commitsSince(args.since, args.scope)" />
    <Assert test="len(commits) > 0" message="Немає комітів після {{ args.since }}" />
    Склади release notes у форматі {'{{ args.format }}'} з цих комітів:
    <ul>
      <Each of="commits" as="c">
        <li>{'{{ c.type }}({{ c.scope }}): {{ c.subject }}'}</li>
      </Each>
    </ul>
    <If test="args.dry">Лише покажи чернетку, нічого не записуй.</If>
  </Prompt>
)
