// Skill: /release [patch|minor|major] [--dry]. Replaces "let's publish a new version" typed again and again.
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
