// Skill: /debug '<symptom>' [--log file]. Replaces "it doesn't work, read the logs, debug it", typed in several agent CLIs.
import { Prompt, Run, Fence, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="debug"
    description="Finds the cause of a symptom from the logs and the code, then fixes it. Example: /debug 'export button does nothing' --log logs/app.log"
    args={{
      symptom: arg.string({ positional: 0, required: true, hint: '<symptom>' }),
      log: arg.string({ default: 'logs/app.log' }),
    }}
  >
    <Run lang="bash" cache="10s" as="tail">tail -n 80 {'{{ args.log }}'} 2&gt;&amp;1 || echo "no log file"</Run>
    The symptom: «{'{{ args.symptom }}'}». Work in this order: reproduce it, find the cause in the code, fix the cause, and run the check again.
    <Fence lang="text" title="Last lines of the log">{'{{ tail }}'}</Fence>
    If you cannot reproduce it, say so and tell me what you need from me instead of guessing a fix. End with what you checked, what the cause was, and how I can verify the fix myself.
  </Prompt>
)
