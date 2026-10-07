// Skill: /review [--focus …]. Replaces "do a full and deep review of the whole project, find bugs".
import { Prompt, If, Each, Tier, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="review"
    description="Project review with a chosen focus; findings are ranked and every one has a proof. Example: /review --focus bugs"
    args={{
      focus: arg.enum(['bugs', 'architecture', 'docs', 'security'], { default: 'bugs' }),
      paths: arg.list({ default: [] }),
      out: arg.string({ default: 'docs/reviews/latest.md' }),
    }}
  >
    Review this project with the focus on {'{{ args.focus }}'}.
    <If test="len(args.paths) > 0">
      Look only at these paths:
      <ul><Each of="args.paths" as="p"><li><code>{'{{ p }}'}</code></li></Each></ul>
    </If>
    For every finding, give the file and line, what goes wrong, a concrete input that shows it, and a suggested fix. Rank findings from the most to the least severe. Leave out style nitpicks unless the focus is docs.
    Write each finding to <code>{'{{ args.out }}'}</code> as soon as you have confirmed it, not at the end, so that nothing is lost if the session stops.
    <If test='args.focus == "architecture"'>Start with a short map of the modules and how data flows between them, then judge the boundaries.</If>
    <Tier is="quick">Check each finding once more before you report it, and drop the ones you cannot prove.</Tier>
  </Prompt>
)
