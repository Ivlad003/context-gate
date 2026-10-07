// Skill: /research <topic> [--options a,b,c]. Replaces a long one-off "research papers, compare stacks" prompt.
import { Prompt, If, Each, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="research"
    description="Researches a topic from primary sources and compares options in a table. Example: /research 'storage for a local-first app' --options sqlite,indexeddb,files"
    args={{
      topic: arg.string({ positional: 0, required: true, hint: '<topic>' }),
      options: arg.list({ default: [] }),
      out: arg.string({ default: 'docs/research.md' }),
    }}
  >
    Research «{'{{ args.topic }}'}». Prefer primary sources: papers, official docs, the source code of well-known projects.
    <If test="len(args.options) > 0">
      Compare these options:
      <ul><Each of="args.options" as="o"><li>{'{{ o }}'}</li></Each></ul>
    </If>
    Write the result to <code>{'{{ args.out }}'}</code>: a short summary first, then a comparison table (strengths, limits, effort, risks), then a recommendation with the reasons. Explain each concept in plain words the first time it appears, and link every claim to its source.
  </Prompt>
)
