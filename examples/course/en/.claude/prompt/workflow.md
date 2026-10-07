---
id: workflow
scope: profile
---
Work in small steps and run the tests before every commit.

@tier quick, standard
1. Read the files named in the task and the tests next to them.
2. Write a plan of 3–6 steps and show it before the first edit.
3. After each edit, run `npm test`; do not move on while it is red.
4. At the end, list the changed files and what you checked.
@end
@if gate.profile == "planning"
Planning mode: split the work into tickets that an agent can finish alone. Each ticket has a goal, the files to touch and a command that proves it is done.
@end
