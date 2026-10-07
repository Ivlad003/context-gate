# context-gate course: from repeated prompts to a prompt DSL

[Українська](COURSE.uk.md)

This course teaches context-gate step by step. It starts with a problem every Claude Code user knows: you type the
same instructions again and again, and the model still forgets half of them. It ends with a small repository in which
those instructions live in files, change with the model and the task, and are checked by tests.

You do not need to know TypeScript for the first seven lessons, because sections are plain Markdown. TSX shows up only
in lesson 8, where prompts become skills with arguments.

Every example in this course is a real file in [`examples/course/en/`](../examples/course/en/) (and the Ukrainian
version in [`examples/course/uk/`](../examples/course/uk/)). The test `test/course.test.ts` builds and renders them,
so what you read here is what the DSL really accepts.

## Contents

0. [Where the examples come from](#0-where-the-examples-come-from)
1. [Install and first run](#1-install-and-first-run)
2. [What makes a prompt good](#2-what-makes-a-prompt-good)
3. [Your first section](#3-your-first-section)
4. [Expressions, conditions and loops](#4-expressions-conditions-and-loops)
5. [Tiers: one prompt for strong and weak models](#5-tiers-one-prompt-for-strong-and-weak-models)
6. [Profiles and groups: only the skills the task needs](#6-profiles-and-groups-only-the-skills-the-task-needs)
7. [Scripts and data in the prompt](#7-scripts-and-data-in-the-prompt)
8. [Prompts as skills with arguments](#8-prompts-as-skills-with-arguments)
9. [Gates: rules the model cannot skip](#9-gates-rules-the-model-cannot-skip)
10. [Checking and debugging prompts](#10-checking-and-debugging-prompts)
11. [Prompt library: what you typed and what to use instead](#11-prompt-library-what-you-typed-and-what-to-use-instead)
12. [What your sessions reveal](#12-what-your-sessions-reveal)
13. [Cheat sheet](#13-cheat-sheet)

## 0. Where the examples come from

The prompts in this course come from the real history of one developer who works with Claude Code every day on
several open-source projects: about 180 prompts over a few weeks. Before they were used here, they were made
anonymous. Project names, people, links, e-mail addresses, file paths and anything that could point to an employer
were removed or replaced with neutral words. Typos were fixed, but the meaning of every prompt was kept.
Lesson 12 goes further and also looks at the system prompts, the full session transcripts with the model's
reasoning, and other agent CLIs.

When the history is sorted by intent, a pattern shows up quickly. Most prompts are not new ideas. They are the same
handful of requests, typed again with slightly different words:

| Intent | Share of prompts | Typical wording |
| --- | --- | --- |
| Publish a new version, commit, push | about 1 in 10 | "Let's publish a new version", "Commit and push", "Bump the version so I can publish" |
| How to make decisions with me | about 1 in 18 | "Answer every question you can answer yourself", "I agree with all your recommendations", "Collect all the questions that need my answer and give me options" |
| Status of the work | about 1 in 25 | "How is it going? What is the status of the tasks?", "What is happening with task 05?" |
| Planning and tickets | about 1 in 30 | "Use the skills and split the design into tasks" |
| Writing style of the docs | about 1 in 35 | "Make the docs human, with complete sentences, in English and Ukrainian" |
| Review, research, handoff | about 1 in 20 together | "Do a full and deep review and find bugs", "Research papers and compare stacks", "Stop and save a handoff to a file" |

Each repeated prompt costs you typing, and it costs the model something too. A short prompt such as "Let's publish a
new version" leaves the model to guess the steps: which checks to run, which files hold the version, whether to tag,
whether to publish. It guesses differently each time. The course turns each of these intents into a file that says
the full thing once.

## 1. Install and first run

Install the plugin inside Claude Code and the CLI in your project. The full explanation is in the
[README](../README.md#install); the short form is this:

```text
/plugin marketplace add Ivlad003/context-gate
/plugin install context-gate@context-gate
```

```bash
npm i -D context-gate
npx context-gate init
```

`init` writes `.claude/gate.json` with profiles guessed from your folders and turns on **shadow mode**. In shadow mode
nothing is filtered yet. The plugin only records what it would have done, and `/gate why` shows those records. This
lets you try context-gate on a real project without any risk.

Start `claude` and type `/gate`. You should see the active profile, the tier of the current model and how many skills,
MCP tools and rules are on.

**Prompts to try now:**

- `/gate` shows the current state of the gate.
- `/gate why` shows who chose the profile and why.
- `/gate rules` lists the Cursor rules and whether each one was delivered.

## 2. What makes a prompt good

A good prompt answers five questions, even when it is short. The model cannot read your mind, so whatever you leave
out, it fills in with a guess.

1. **Goal.** What should be true when the work is done?
2. **Context.** What does the model need to know that is not in the code?
3. **Constraints.** What must it not do?
4. **Output.** What should the answer look like?
5. **Done check.** How do you both know it worked?

Here are three prompts from the history and what they become when they answer those questions.

**Before:** "Let's publish a new version."

**After:** "Prepare a minor release. Run the tests, the typecheck and the build first, and stop if any of them fails.
Bump the version in every `package.json` and plugin manifest. Write a changelog entry for users from the commits
since the last tag. Commit, tag and push, then give me the exact `npm publish` command, but do not publish yourself."

**Before:** "Do a full and deep review of the whole project, find bugs."

**After:** "Review the project with the focus on bugs. For every finding, give the file and line, what goes wrong, a
concrete input that shows it, and a suggested fix. Rank findings from the most to the least severe, and leave out
style nitpicks."

**Before:** "Stop and save a handoff to a file so we can continue."

**After:** "Stop the current task. Write `HANDOFF.md` so that a new session with no memory of this one can continue.
Use four headings: goal, done, next step with the command to run, open questions."

The "after" versions are better, but nobody wants to type them every time. That is exactly what the rest of the course
is about: you write the long version once, in a file, and from then on a short command or no command at all is enough.

## 3. Your first section

A **section** is one piece of the system prompt, stored as a Markdown file in `.claude/prompt/`. The plugin renders
all sections and adds them to the system prompt of every session.

Take the decision-making prompts from the history: "Answer every question you can answer yourself", "Collect all the
questions that need my answer and give me options", "I agree with all your recommendations". They were typed about ten
times. As a section, they are written once:

```markdown
---
id: how-to-ask-me
scope: static
---
How to work with me on decisions:

- Answer every question you can answer yourself from the code, the docs or common sense, and say what you chose and why.
- Ask me only about decisions that really are mine: product scope, naming, money, anything hard to undo.
- When you ask, collect all open questions in one message. Number them, explain each one in plain words, and give two or three options with a short example of what each option means in practice. Put your recommendation first.
- If I answer "I agree with all your recommendations", take the recommended option for every question and continue without asking again.
```

The part between the `---` lines is the **frontmatter**. It describes the section:

| Field | What it means |
| --- | --- |
| `id` | The name of the section. By default it is the file name without `.md`. |
| `scope` | When the section can change. See below. |
| `when` | A condition. The section is included only when it is true (lesson 4). |
| `budget` | The maximum number of characters. Longer text is cut with a mark. |
| `tier` | The model tiers that get this section (lesson 5). |

**Scope** decides where the section goes in the prompt and how often it is rendered. This matters because Claude
caches the beginning of the prompt. As long as that beginning does not change, you pay less and the answer comes
faster.

- `static` sections never change during a session. They go first and stay in the cache. Use this scope for rules about
  you, your team and the project.
- `profile` sections change only when the profile or the tier changes (lessons 5 and 6). Use it for instructions that
  depend on the kind of task.
- `volatile` sections are rendered on every turn and go last. Use it for live data, such as the git status.

A second static section from the history is about tests. The prompt was "There should not be too many tests; I prefer
end-to-end tests that show the whole picture". As a section it becomes this:

```markdown
---
id: testing
scope: static
---
Testing in this project: prefer a few end-to-end tests that run the real app over many small unit tests. A good test shows that a user-visible flow works from start to finish. Add a unit test only for tricky pure logic, such as parsing or date math.
```

**Prompts to try now:** after you add the files, you do not type anything. Ask an ordinary question, for example "Add
an option to export the report as CSV", and watch the model ask its questions in one numbered list with options.

## 4. Expressions, conditions and loops

Plain text is enough for rules that never change. For anything else, the DSL has **expressions** and **directives**.

An expression is written inside `{{ }}`. It reads data from the context of the session: `gate.profile` is the active
profile, `gate.tier` is the tier of the model, `git.branch` is the current branch, `git.dirty` is true when there are
uncommitted changes, and `args.*` holds the arguments of a skill. Expressions can compare (`==`, `!=`, `<`, `>`), combine
(`&&`, `||`, `!`), do arithmetic (`+ - * / %`) and pass values through filters with `|`, for example
`{{ items | take(3) | join(", ") }}`.

A directive is a line that starts with `@`. The most common ones are:

| Directive | What it does |
| --- | --- |
| `@if cond` … `@elif cond` … `@else` … `@end` | Includes text only when the condition is true. |
| `@each x in list` … `@end` | Repeats the text for every item of a list. |
| `@let name = expr` | Gives a value a name that cannot change. |
| `@set name = expr` | Gives a value a name that can change later. |
| `@tier quick, standard` … `@end` | Includes text only for these model tiers (lesson 5). |
| `@run bash as=x` … `@end` | Runs a script and puts its output in `x` (lesson 7). |

The DSL is deliberately small. Loops always end, there is no recursion, and a rendering step limit protects the
session. Anything that needs real programming belongs in a script or a provider (lesson 7).

Here is the docs-style prompt from the history as a section. The original was "Review all the documentation, make it
more human and clear, so that sentences are not cut off and every thought is fully explained; update both the English
and the Ukrainian version". It was typed in different forms five times.

```markdown
---
id: writing-style
scope: profile
when: gate.profile == "docs"
budget: 2500
---
@let langs = ["README.md", "README.uk.md"]
Documentation style:

- Write plain, human language. Every sentence is complete and carries one whole thought; do not leave fragments or bare lists of nouns.
- Explain an idea first, then show an example of it.
- The English and the Ukrainian docs say the same thing. When you change one, change the other in the same commit:
@each f in langs
  - `{{ f }}`
@end
@tier quick
Before you finish, re-read each changed paragraph and check: is any sentence cut off, and does each term have a short explanation the first time it appears?
@end
```

Three things happen here. `when: gate.profile == "docs"` means the section appears only while you work on docs, so it
does not take space during a database migration. `@let` and `@each` build the list of files to keep in sync. `@tier
quick` adds a self-check only for small models, because a strong model does not need it.

To write a literal `@` at the start of a line, write `\@`. To write a literal `{{`, write `\{{`.

**Prompts to try now:**

- `[gate:docs] Update the install section of the README.` The `[gate:docs]` flag switches the profile for this task,
  so the writing-style section appears.
- `Rewrite the FAQ so a new user understands it.` If `docs/**` matches the files the model opens, the docs profile
  turns on by itself.

## 5. Tiers: one prompt for strong and weak models

Not every task needs the strongest model. One prompt in the history said it directly: "For git commands a smaller
model is enough". Another asked to pick free models for simple tasks, mid-range models for normal work and the best
model for hard work. context-gate calls these levels **tiers**.

A strong and a weak model need different prompts. A weak model works better with explicit steps, examples and a
checklist. A strong model works better without them, because the extra text is noise to it. The DSL lets one section
serve both.

First, map models to tiers in `.claude/gate.json`:

```json
"models": { "*opus*": "premium", "*sonnet*": "standard", "*haiku*": "quick" }
```

Then use `@tier` in a section:

```markdown
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
```

The premium model gets only the first sentence. The quick and standard models also get the four steps. Below premium,
context-gate also adds a short built-in "plan, edit, check" section on its own.

When a variant grows large, move it into its own file. `workflow.quick.md` next to `workflow.md` replaces the whole
section for the quick tier. The command `npx context-gate expand` can draft such variants for you with a strong model,
and you review and commit them.

You can see the difference without starting a session:

```bash
npx context-gate run --tier premium --no-markers
npx context-gate run --tier quick --no-markers
```

**Prompts to try now:**

- Switch the model with `/model` and run `/gate`. The tier in the status line changes with the model.
- With a small model selected, `Rename the helper and update its callers.` is enough: the model gets the numbered
  steps and the plan-edit-check section without you asking for them.

## 6. Profiles and groups: only the skills the task needs

Every skill, MCP tool and subagent you install adds its description to the context, even when the task has nothing to
do with it. Thirty skills can cost thousands of tokens on every turn. One prompt from the history asked for exactly this
fix: "A smarter model does not need all the skills, and a weaker one needs more; I want to choose which group of skills
each model gets".

context-gate solves it with **groups** and **profiles**:

- A **group** is a named list of items. Each item has a kind prefix: `skill:`, `tool:` (MCP tools), `agent:` or `rule:`.
  Globs are allowed.
- A **profile** is a set of groups for one kind of work, plus a `when` block that says when it turns on by itself.
- A **tier** can add groups too. For example, small models get the docs skills always.

```json
{
  "groups": {
    "core":     ["skill:tdd", "skill:diagnosing-bugs"],
    "planning": ["skill:grilling", "skill:to-issues", "skill:domain-modeling"],
    "docs":     ["skill:writing-*"],
    "release":  ["skill:release", "skill:handoff"]
  },
  "tiers": {
    "premium":  { "groups": ["core"] },
    "standard": { "groups": ["core", "release"] },
    "quick":    { "groups": ["core", "release", "docs"] }
  },
  "profiles": {
    "docs":     { "groups": ["docs"], "when": { "paths": ["docs/**", "**/*.md"] } },
    "planning": { "groups": ["planning"], "when": { "paths": [".scratch/**"] } },
    "release":  { "groups": ["release"], "when": { "branch": "^release/" } }
  },
  "classify": { "mode": "shadow", "minConfidence": 0.7 }
}
```

The profile is chosen in this order: a manual choice (`/gate planning` or `[gate:planning]` in the prompt) wins, then a
`when` signal (the files you touch, the branch), and only then the classifier, which reads the first prompt of a task
and suggests a profile with a confidence score. In shadow mode the suggestion is only recorded.

A skill that is off is not hidden in silence. The model sees a one-line description and, if it tries to use the skill,
a short answer that says how to turn it on, for example "enable with `/gate +planning`".

Notice what happened to "use the skills and split the design into tasks". The words "use the skills" are no longer
needed: when you open `.scratch/`, the planning profile turns on, and the planning skills are there. The section from
lesson 5 even has a planning paragraph, added with `@if gate.profile == "planning"`.

**Prompts to try now:**

- `/gate planning` fixes the planning profile for this session; `/gate auto` returns to automatic choice.
- `/gate +docs` adds one group without changing the profile.
- `[gate:planning] Split the checkout redesign into tickets that an agent can finish alone.`
- After a week in shadow mode, run `npx context-gate report` to see how often the classifier agreed with you, and then
  `/gate apply` to let the gate filter for real.

## 7. Scripts and data in the prompt

Some instructions depend on facts that change: the branch, uncommitted files, the version in `package.json`. You could
ask the model to look them up every time, but that costs a turn. context-gate can put the facts into the prompt.

`@run` runs a short script and stores its output in a variable. `cache=` keeps the result for a while, so the script
does not run on every turn.

````markdown
---
id: repo-state
scope: volatile
---
Branch `{{ git.branch }}`.
@if git.dirty
There are uncommitted changes. Do not lose them:
@run bash cache=1m as=st
git status --short | head -20
@end
```text
{{ st | truncate(1500) }}
```
@end
````

A **provider** is a named data source declared in `gate.json`. It can read a file, run a command that prints JSON, call
an MCP tool or load a module. This one reads three fields from `package.json`:

```json
"providers": {
  "pkg": { "kind": "file", "path": "package.json", "pick": ["name", "version", "scripts"],
           "schema": { "type": "object", "properties": { "name": { "type": "string" }, "version": { "type": "string" } } } }
}
```

After that, `{{ pkg.version }}` works in any section or skill. The `schema` is optional, but it gives you autocomplete
in the editor and removes the G170 warning.

**Trust comes first.** A repository you cloned could contain any script, so context-gate runs nothing from it until you
trust it once. Until then, `@run` blocks render as placeholders and the build warns with G203. In a session, the plugin
asks once per repository. On the command line, use `npx context-gate trust grant` once, and in CI or
`claude -p` use `--trust-repo`.

## 8. Prompts as skills with arguments

Sections are always there. Some prompts, though, are actions you start yourself: publish, hand off, review. For those,
a prompt can become a **skill**: a `/command` with typed arguments that is rendered at the moment you call it, with the
live state of the repository.

Skills are written in TSX, because arguments need types. You do not need React or any npm package for it: `init`
writes the type declarations, and `npx context-gate build` compiles the file. Inside, the same expressions work, as
strings: `'{{ args.bump }}'`.

### `/release`: "Let's publish a new version"

This was the most repeated prompt in the history. Here it is once, with all the steps:

```tsx
import { Prompt, Run, If, Else, Fence, arg } from '@context-gate/jsx'

export default (
  <Prompt
    as="skill"
    name="release"
    description="Prepares a new npm version: checks, version bump, changelog, tag. Example: /release minor"
    args={{
      bump: arg.enum(['patch', 'minor', 'major'], { positional: 0, default: 'patch' }),
      dry: arg.flag(),
    }}
    invoke={{ user: true, model: false }}
  >
    <Run lang="bash" as="dirty">git status --short</Run>
    <Run lang="bash" as="log">git log --oneline -15</Run>
    Prepare a {'{{ args.bump }}'} release. The current version of {'{{ pkg.name }}'} is {'{{ pkg.version }}'}.
    <If test='dirty != ""'>
      The working tree is not clean. Commit or stash these changes first, and ask me which one if it is not obvious:
      <Fence lang="text">{'{{ dirty }}'}</Fence>
    </If>
    Steps, in this order:
    <ol>
      <li>Run every check the project has (tests, typecheck, build). If one fails, stop and show me the error.</li>
      <li>Bump the version with <code>npm version {'{{ args.bump }}'} --no-git-tag-version</code> in every package.json and plugin manifest that holds it.</li>
      <li>Add a changelog entry written for users, based on these commits:</li>
    </ol>
    <Fence lang="text" title="Recent commits">{'{{ log }}'}</Fence>
    <If test="args.dry">
      This is a dry run: show the diff and the changelog text, but do not commit, tag or push.
      <Else>Commit, tag `v` plus the new version, push both, and give me the exact `npm publish` command. Do not publish yourself.</Else>
    </If>
  </Prompt>
)
```

`invoke={{ user: true, model: false }}` means only you can start it. The model will not decide to release on its own.
If you type a wrong argument, for example `/release huge`, the model does not get a stack trace. It gets a short usage
text and asks you again.

`npx context-gate run release --args "minor --dry"` shows exactly what the model will get:

```text
Prepare a minor release. The current version of course-demo is 1.4.2.
Steps, in this order:

1. Run every check the project has (tests, typecheck, build). If one fails, stop and show me the error.
2. Bump the version with `npm version minor --no-git-tag-version` in every package.json and plugin manifest that holds it.
3. Add a changelog entry written for users, based on these commits:
…
This is a dry run: show the diff and the changelog text, but do not commit, tag or push.
```

### `/handoff`: "Stop and save a handoff to a file"

```tsx
<Prompt as="skill" name="handoff"
        description="Stops the current work and writes a handoff file that a fresh session can continue from. Example: /handoff notes/handoff.md"
        args={{ file: arg.string({ positional: 0, default: 'HANDOFF.md', hint: '[file]' }) }}>
  <Run lang="bash" as="diff">git diff --stat HEAD</Run>
  Stop the current task now. Do not start anything new.
  Write <code>{'{{ args.file }}'}</code> so that another session, with no memory of this one, can continue. Use these headings:
  <ol>
    <li>Goal: what we are trying to achieve, in two or three sentences.</li>
    <li>Done: what already works and how you checked it.</li>
    <li>Next: the very next step, with the command to run.</li>
    <li>Open questions: what you were unsure about.</li>
  </ol>
  <Fence lang="text" title="Changed since the last commit">{'{{ diff }}'}</Fence>
</Prompt>
```

The next session starts with "Read `HANDOFF.md` and continue", and nothing is lost.

### `/status`: "How is it going? What is the status of the tasks?"

```tsx
<Prompt as="skill" name="status"
        description="Short status of the tickets: done, in progress, blocked, and what needs my decision. Example: /status checkout"
        args={{ feature: arg.string({ positional: 0, default: null, hint: '[feature]' }) }}
        invoke={{ user: true, model: 'skill' }}>
  <Run lang="bash" cache="1m" as="tickets">grep -H '^Status:' .scratch/*/issues/*.md 2&gt;/dev/null || echo "no tickets"</Run>
  Give me a short status report.
  <If test="args.feature">Only look at the feature «{'{{ args.feature }}'}».</If>
  <Fence lang="text" title="Ticket status lines">{'{{ tickets }}'}</Fence>
  Answer in four short parts: done, in progress, blocked (and why), needs my decision. For each decision, give the options and your recommendation in one sentence each.
</Prompt>
```

`invoke={{ model: 'skill' }}` lets the model use the skill by itself when you ask about the status in your own words.
Note `2&gt;` in TSX: inside JSX text, `>` has to be written as `&gt;`.

### `/review`: "Do a full and deep review, find bugs"

```tsx
<Prompt as="skill" name="review"
        description="Project review with a chosen focus; findings are ranked and every one has a proof. Example: /review --focus bugs"
        args={{
          focus: arg.enum(['bugs', 'architecture', 'docs', 'security'], { default: 'bugs' }),
          paths: arg.list({ default: [] }),
        }}>
  Review this project with the focus on {'{{ args.focus }}'}.
  <If test="len(args.paths) > 0">
    Look only at these paths:
    <ul><Each of="args.paths" as="p"><li><code>{'{{ p }}'}</code></li></Each></ul>
  </If>
  For every finding, give the file and line, what goes wrong, a concrete input that shows it, and a suggested fix. Rank findings from the most to the least severe. Leave out style nitpicks unless the focus is docs.
  <If test='args.focus == "architecture"'>Start with a short map of the modules and how data flows between them, then judge the boundaries.</If>
  <Tier is="quick">Check each finding once more before you report it, and drop the ones you cannot prove.</Tier>
</Prompt>
```

`/review --focus architecture --paths src/api,src/db` turns the list argument into two bullet points, and a small model
also gets the instruction to double-check.

### `/research`: "Research the papers and compare the options"

```tsx
<Prompt as="skill" name="research"
        description="Researches a topic from primary sources and compares options in a table. Example: /research 'storage for a local-first app' --options sqlite,indexeddb,files"
        args={{
          topic: arg.string({ positional: 0, required: true, hint: '<topic>' }),
          options: arg.list({ default: [] }),
          out: arg.string({ default: 'docs/research.md' }),
        }}>
  Research «{'{{ args.topic }}'}». Prefer primary sources: papers, official docs, the source code of well-known projects.
  <If test="len(args.options) > 0">
    Compare these options:
    <ul><Each of="args.options" as="o"><li>{'{{ o }}'}</li></Each></ul>
  </If>
  Write the result to <code>{'{{ args.out }}'}</code>: a short summary first, then a comparison table (strengths, limits, effort, risks), then a recommendation with the reasons. Explain each concept in plain words the first time it appears, and link every claim to its source.
</Prompt>
```

After `npx context-gate build`, each skill gets a `.claude/skills/<name>/SKILL.md`. With the plugin, the skill is
rendered inside the session. Without the plugin (a teammate, CI, another agent that reads `.claude/skills`), the
`SKILL.md` calls the locally installed CLI, so the skill still works.

**Argument types:** `arg.string`, `arg.number`, `arg.enum([...])`, `arg.flag()`, `arg.list()` (comma separated),
`arg.path` (must exist), `arg.json`. Options: `positional`, `required`, `default`, `hint`.

## 9. Gates: rules the model cannot skip

Some instructions are too important to leave to the model's attention. "Run the tests before you commit" is a good
example: the history has it in many forms, and still a commit sometimes went through with red tests. A **gate** is a
check that context-gate runs itself.

```json
"gates": [
  { "name": "tests", "on": "commit", "run": ["npm", "test"], "pass": "exitCode == 0",
    "message": "Tests fail, so the commit is blocked. Fix them first." }
]
```

When the model runs `git commit`, the plugin runs `npm test` first. If the result does not pass, the commit is
refused, and the model gets your message. Gates can also run on `write` (after a file edit), `turn` (after each answer)
and `prompt` (before your prompt reaches the model). The built-in `read-before-write` gate refuses an edit of a file
the model has not read, which helps small models most.

## 10. Checking and debugging prompts

You can see and test everything without starting a session. These commands are worth remembering:

| Command | What it shows |
| --- | --- |
| `npx context-gate build` | Compiles TSX prompts and reports errors with codes. |
| `npx context-gate run --no-markers` | The exact text the model gets. Add `--tier quick` or `--profile docs` to try other cases. |
| `npx context-gate run --trace` | The same text plus a table: which sections were included, why, and how many tokens each one costs. |
| `npx context-gate run <skill> --args "…"` | Renders a skill with arguments. |
| `npx context-gate health` | Prompt health: sections that are too long, stale builds, and what to do about them. |
| `npx context-gate explain G102` | Explains any diagnostic code in plain words. |
| `/gate why` (in a session) | The decision journal: who chose the profile, which rules were delivered, what was denied. |

Every diagnostic has a code. `G0xx` are structure errors (an unclosed `@if`), `G1xx` are expression errors (an unknown
function), `G2xx` are about scripts and providers (an untrusted repository), `G3xx` about `gate.json`, `G4xx` about
tier variants, and `H0xx` are health warnings. The parser never stops at the first error, so you see all of them at
once.

A good habit: when a prompt changes, render it for each tier and read the result as if you were the model. If a
sentence does not make sense without the rest of the file, fix it there.

## 11. Prompt library: what you typed and what to use instead

This table maps the most common prompts from the history to what replaces them. The left column is the anonymous
original, the right column is what you type after the course.

| You used to type | Now |
| --- | --- |
| "Let's publish a new version." / "Bump the version so I can publish." | `/release minor` (or `/release patch --dry` to look first) |
| "Commit everything and push." | "Commit and push." The `tests` gate runs the tests on commit for you. |
| "Answer every question you can answer yourself." | Nothing: the `how-to-ask-me` section says it on every turn. |
| "I agree with all your recommendations." | "Agree with all." The section tells the model what that means. |
| "Collect all the questions that need my decision and give me options." | Nothing, or "What do you need from me?" |
| "How is it going? What is the status of the tasks?" | `/status` or `/status checkout` |
| "What is happening with task 05?" | `/status` and then "Tell me more about 05." |
| "Stop and save a handoff to a file so we can continue." | `/handoff` |
| "Read the handoff and continue." | "Read `HANDOFF.md` and continue." |
| "Do a full and deep review of the whole project, find bugs." | `/review` or `/review --focus architecture --paths src/core` |
| "Research papers and compare stacks A, B, C." | `/research 'implementation language for the compiler' --options typescript,ocaml,zig` |
| "Use the skills and split the design into tasks." | `[gate:planning] Split the design into tickets.` |
| "Make the docs human, complete sentences, both languages." | `[gate:docs] Rewrite the getting-started guide.` |
| "For git commands a smaller model is enough." | Pick the model with `/model`; the tier and its prompt follow. |
| "There should not be too many tests, I prefer end-to-end." | Nothing: the `testing` section says it. |
| "It doesn't work, read the logs, debug it." | `/debug 'the export button does nothing'` |
| "Save all the findings to a file." | Nothing: `/review` writes each finding to `--out` as it goes. |
| "Which model is running? Where are the logs?" | "What's the status?" The `work-state` section has the answer. |
| The same rules typed again in another agent CLI | `npm run agents-md` renders the sections into `AGENTS.md`. |

More prompts that work well with the course setup:

- `[gate:docs] Explain the config file in the README for someone who has never seen it. Add one full example.`
- `[gate:planning] Interview me about the export feature until you can write tickets, then write them.`
- `/review --focus security --paths src/auth`
- `/research 'how other CLIs store user settings' --options xdg,dotfile,json-in-home --out docs/settings-research.md`
- `/release patch --dry` and then, after you look at the diff, `/release patch`.
- `/handoff notes/2026-10-07.md` before you close the laptop.
- `/status` at the start of the day, then "Take the first blocked ticket and tell me what it needs."
- `/gate why` when the model behaves as if a skill is missing.

## 12. What your sessions reveal

The first lessons used only the prompts that were typed. This lesson looks deeper, at three more sources from the same
developer, anonymized in the same way as in lesson 0:

- **The system prompts:** six project instruction files (`AGENTS.md`, `CLAUDE.md`), about twenty memory files and the
  prompt of a ticket runner, about 24k tokens in total.
- **The full session transcripts:** about 950 Claude Code sessions with subagents, including more than ten thousand
  blocks of the model's own reasoning.
- **Other agent CLIs:** about 200 prompts from four other agent command-line tools used on the same projects.

The biggest lesson is surprising. The model rarely misunderstood what was wanted. Most of the waste came from the model
**rediscovering the state of the repository at the start of every session**, and from rules that lived only in one
tool, one copy of a file or one person's head. Each pattern below comes with the section that fixes it, and every
section is in [`examples/course/en/`](../examples/course/en/).

### 12.1 The model rediscovers the same facts every session

In the first ten tool calls of a session, the spec was read in about 300 sessions and the project instructions in about
170. `git status` or `git log` ran at the start of most main sessions, the ticket folder was listed in about 140, and
the current version was looked up in about 40. On the user's side, about one prompt in six across the full transcripts
was a question about state: "What is the status?", "Which model is doing the review?", "Where are the logs?". One
session asked "What is the status?" seven times in a row.

A volatile section answers these before anyone asks:

````markdown
---
id: work-state
scope: volatile
when: gate.profile != "agents-md"
budget: 1800
---
@run bash cache=30s as=tickets
grep -H -m1 '^Status:' .scratch/*/issues/*.md 2>/dev/null | sed 's|^\.scratch/||; s|/issues/| |; s|\.md:Status:| →|'
@end
@run bash cache=30s as=handoff
ls -t HANDOFF.md .scratch/*/handoff*.md 2>/dev/null | head -1
@end
Version {{ pkg.version }} on branch `{{ git.branch }}`, {{ git.ahead }} commits not pushed, {{ git.behind }} commits behind the remote.
@if tickets
Tickets right now (answer "what's the status?" from this list, do not search again):
```text
{{ tickets | truncate(1200) }}
```
@end
@if handoff
The latest handoff is `{{ handoff }}`. Read it before you continue earlier work.
@end
````

The `when` line is explained in 12.8. The spec does not need to be pasted into the prompt to stop the re-reading. A
reference is enough, because the model then knows where the knowledge lives and opens it only when the task needs it:

```markdown
---
id: references
scope: static
---
Where the knowledge lives. Do not re-read these at the start of every task; open them when the task touches them:
@include docs/SPEC.md ref
@include package.json ref
```

`ref` renders one line per file. `inline` would paste the whole file, and `lazy` registers a tool that the model can
call to fetch it.

### 12.2 Reading too much, and ignoring the source you gave

Most interrupts happened while the model was reading widely: every document at once, the whole home directory, a
manual it did not need. In one case the user had named a text file with the answer, and the model rebuilt the same
information from another source instead. After an interrupt, the user usually sent the same prompt again or typed
"continue".

```markdown
---
id: exploration
scope: static
---
How to look around:

- If I name a file or paste text, use it first, and do not rebuild the same information from other sources.
- Stay inside the repository. Never list or search my home directory.
- Read at most five files before you tell me what you are looking for and why.
@tier quick
- Read at most three files, and ask me before you run anything that needs extra permissions.
@end
```

### 12.3 Short replies and one question at a time

Many replies were a single word or number: "yes", "2", "1. A", "continue". In the reasoning, the model sometimes had to
work out what such a reply referred to. In a tool with a weaker setup, the model asked one question per turn, so a
short spec discussion took a dozen turns of one-word answers. Two lines added to the `how-to-ask-me` section from lesson
3 fix both:

```markdown
- A short reply such as "2" or "B" answers the last list you gave me. If a short request can be read two ways, answer both readings briefly instead of guessing one.
@tier quick, standard
- Ask at most one round of questions per task, with every question in it.
@end
```

### 12.4 Things that are hard to undo

Three kinds of moments made the model hesitate in its reasoning, and the user interrupt. A password was pasted as part
of setup instructions, and the model planned to save it in a plain file. Another session was editing the same checkout,
so a broad `git add` would have committed someone else's half-finished work. A publish was about to happen, which the
model itself called irreversible, and only then did it find that there was no registry login.

```markdown
---
id: safety
scope: static
---
Things that are hard to undo:

- Never write passwords, tokens or keys into files. If a tool needs one, use the system keyring or ask me.
- Another session may be editing this checkout at the same time. Stage only the files you changed yourself, by name, never with `git add -A`.
- Pushing is fine after the checks pass. Publishing a package is mine: prepare everything and give me the exact command.
```

The rule about secrets is important enough to back with a gate, so it holds even when the model forgets it:

```json
{ "name": "no-secrets", "on": "write",
  "run": ["sh", "-c", "! git diff -U0 | grep -iE '(password|passwd|secret|token)[^a-z]*[:=]'"],
  "pass": "exitCode == 0",
  "message": "This looks like a password or token in a file. Remove it and use the system keyring." }
```

### 12.5 Results that live only in the chat

A deep review was interrupted twice: once while reading, once right after the findings were printed. Both times the
next prompt was "Save all the findings to a file". The fix is to make the file the default, and to write findings as
they are confirmed. The `/review` skill from lesson 8 gets one more argument and one more sentence:

```tsx
out: arg.string({ default: 'docs/reviews/latest.md' }),
…
Write each finding to <code>{'{{ args.out }}'}</code> as soon as you have confirmed it, not at the end, so that nothing is lost if the session stops.
```

Handoffs travelled between tools too: a handoff written in one agent CLI was continued in another. So `/handoff` now
asks for plain Markdown and full sentences, with no reference to anything that exists only in the chat.

### 12.6 The same request in three tools

The same bug was raised in three different agent CLIs, each time from scratch: "It doesn't work, figure out why",
"Re-read the logs and debug it", "Read the logs and run the tests". The follow-ups were "Still doesn't work" and "Fix
it". Every tool started without knowing where the logs were or in which order to work. A skill gives the request its
missing half:

```tsx
<Prompt as="skill" name="debug"
        description="Finds the cause of a symptom from the logs and the code, then fixes it. Example: /debug 'export button does nothing' --log logs/app.log"
        args={{
          symptom: arg.string({ positional: 0, required: true, hint: '<symptom>' }),
          log: arg.string({ default: 'logs/app.log' }),
        }}>
  <Run lang="bash" cache="10s" as="tail">tail -n 80 {'{{ args.log }}'} 2&gt;&amp;1 || echo "no log file"</Run>
  The symptom: «{'{{ args.symptom }}'}». Work in this order: reproduce it, find the cause in the code, fix the cause, and run the check again.
  <Fence lang="text" title="Last lines of the log">{'{{ tail }}'}</Fence>
  If you cannot reproduce it, say so and tell me what you need from me instead of guessing a fix. End with what you checked, what the cause was, and how I can verify the fix myself.
</Prompt>
```

Pasted content points the same way. The pastes in the history were status reports from another repository, earlier
review lists, terminal errors and a failing CI run. A provider can fetch the last one, so you never paste it again:

```json
"ci": { "kind": "cli", "command": ["gh", "run", "view", "--log-failed"], "cache": "5m", "onError": "skip" }
```

### 12.7 What the system prompts themselves show

The instruction files had five problems. Each one has a DSL answer you already know.

| Problem in the files | Example (anonymized) | Fix |
| --- | --- | --- |
| Two copies of the same file drift apart | Two checkouts of one project had 90% identical instructions that disagreed in four places; two memory files disagreed about a config format | One `static` section that both use; differences come from providers |
| Task-specific rules are always loaded | A 1k-token "bilingual docs" chapter loaded during a database migration | A `profile` section with `when: gate.profile == "docs"` (lesson 4) |
| Steps that only small models need | A six-step work cycle that a strong model follows anyway | `@tier quick, standard` (lesson 5) |
| Facts that go stale | "Migrations 001–018", "925 tests, about 5 minutes", "release tagged locally, not pushed" | `@run` and providers in a `volatile` section (lesson 7) |
| Checks written as prose | "Typecheck and tests must pass", "update both language versions", "never hard-code the time zone" | Gates (lesson 9) |

Two more habits are worth copying. First, give every topic one owner: when one file said "any dependency is fine" and a
memory said "keep dependencies minimal", the model had to pick. Second, keep the reason with the rule. A rule such as
"tokens are stored in plain text" without a reason invites the model to "fix" it.

### 12.8 One source for every agent CLI

The strongest finding came from comparing tools. The same rules were written again for each agent CLI, in different
words, and they drifted: where notes go, who commits, which language to answer in. One tool calls skills with `/name`,
another with `$name`, a third with `@name`. The user even asked once for the skills to be installed "so they are
available in all three CLIs".

With context-gate, the sections are the single source. Claude Code gets them live through the plugin. For a tool that
reads `AGENTS.md`, you render the same sections into that file. Live data would be stale in a file, so the volatile
sections carry `when: gate.profile != "agents-md"`, and you render with that profile:

```json
"profiles": { "agents-md": { "groups": [] } }
```

```json
"scripts": { "agents-md": "context-gate run --profile agents-md --tier standard --no-markers > AGENTS.md" }
```

Run `npm run agents-md` after you change a section, or from a pre-commit hook. Now one edit reaches every tool, and the
`how-to-ask-me`, `safety` and `testing` rules are the same everywhere.

**Prompts to try now:**

- "What's the status?" The answer comes from the `work-state` section, without a search.
- `/debug 'the export button does nothing'`
- `/review --focus bugs --out docs/reviews/2026-10-07.md`
- `/handoff`, then in another agent CLI: "Read `HANDOFF.md` and continue."
- `npm run agents-md`, then open `AGENTS.md` and compare it with `npx context-gate run --no-markers`.

## 13. Cheat sheet

**Section file** (`.claude/prompt/<id>.md`):

```markdown
---
id: my-section          # default: file name
scope: profile          # static | profile | volatile
when: gate.profile == "docs"
budget: 2000            # characters
tier: quick, standard   # optional
---
Text with {{ expressions }}.
@if cond
@elif cond
@else
@end
@each x in list
@end
@let name = expr
@set name = expr
@tier quick
@end
@run bash cache=5m as=out
echo hello
@end
@include docs/api.md ref        # inline | ref | lazy
@skill tdd ref
```

**Context:** `gate.profile`, `gate.tier`, `git.branch`, `git.dirty`, `git.changed`, `args.*` (skills), providers by
name (`pkg.version`), `cursor.always`, `cursor.auto` (Cursor rules), `env.*` (only variables listed in `gate.json`).

**Filters:** `take`, `sort`, `grep`, `map`, `join`, `truncate`, `fence`, `unique`, `where`, `len`, `round`, `ago`.
**Functions:** `len`, `min`, `max`, `abs`, `round`, `floor`, `ceil`.

**In a session:** `/gate`, `/gate why`, `/gate <profile>`, `/gate +<group>`, `/gate auto`, `/gate apply`,
`/gate health`, `/gate rules`, `[gate:<profile>]` in a prompt.

Where to go next: the full design is in [`SPEC.md`](SPEC.md) (in Ukrainian), the `gate.json` reference is in the
[README](../README.md#claudegatejson-reference), and a bigger example repository is
[`examples/reference/`](../examples/reference/).
