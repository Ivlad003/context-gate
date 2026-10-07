// Skill: /status [feature]. Replaces "how is it going? what is the status of the tasks?".
import { Prompt, Run, If, Fence, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="status"
    description="Short status of the tickets: done, in progress, blocked, and what needs my decision. Example: /status checkout"
    args={{ feature: arg.string({ positional: 0, default: null, hint: '[feature]' }) }}
    invoke={{ user: true, model: 'skill' }}
  >
    <Run lang="bash" cache="1m" as="tickets">grep -H '^Status:' .scratch/*/issues/*.md 2&gt;/dev/null || echo "no tickets"</Run>
    Give me a short status report.
    <If test="args.feature">Only look at the feature «{'{{ args.feature }}'}».</If>
    <Fence lang="text" title="Ticket status lines">{'{{ tickets }}'}</Fence>
    Answer in four short parts: done, in progress, blocked (and why), needs my decision. For each decision, give the options and your recommendation in one sentence each.
  </Prompt>
)
