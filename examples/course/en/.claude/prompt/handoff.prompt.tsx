// Skill: /handoff [file]. Replaces "stop and save a handoff to a file so we can continue later".
import { Prompt, Run, Fence, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="handoff"
    description="Stops the current work and writes a handoff file that a fresh session can continue from. Example: /handoff notes/handoff.md"
    args={{ file: arg.string({ positional: 0, default: 'HANDOFF.md', hint: '[file]' }) }}
  >
    <Run lang="bash" as="diff">git diff --stat HEAD</Run>
    Stop the current task now. Do not start anything new.
    Write <code>{'{{ args.file }}'}</code> so that another session, with no memory of this one and maybe in a different agent CLI, can continue. Use plain Markdown and full sentences, and do not refer to anything that exists only in this chat. Use these headings:
    <ol>
      <li>Goal: what we are trying to achieve, in two or three sentences.</li>
      <li>Done: what already works and how you checked it.</li>
      <li>Next: the very next step, with the command to run.</li>
      <li>Open questions: what you were unsure about.</li>
    </ol>
    <Fence lang="text" title="Changed since the last commit">{'{{ diff }}'}</Fence>
  </Prompt>
)
