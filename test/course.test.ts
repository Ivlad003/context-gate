// The course examples (docs/COURSE.md, docs/COURSE.uk.md) must build and render, so the course never shows a prompt
// that the DSL rejects.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, cli, copyFixture } from './cli-helpers.ts'

const cases = [
  { lang: 'en', docs: /Documentation style:/, planning: /Planning mode:/, release: /Prepare a minor release\. The current version of course-demo is 1\.4\.2\./, state: /Version 1\.4\.2 on branch/, safety: /Things that are hard to undo:/, debug: /The symptom: «export does nothing»/ },
  { lang: 'uk', docs: /Стиль документації:/, planning: /Режим планування:/, release: /Підготуй minor-реліз\. Поточна версія course-demo: 1\.4\.2\./, state: /Версія 1\.4\.2 на гілці/, safety: /Те, що важко відкотити:/, debug: /Симптом: «export does nothing»/ },
]

for (const c of cases) {
  test(`course example ${c.lang}: builds without errors, sections follow profile and tier, skills parse args`, async () => {
    const root = copyFixture(join(REPO, 'examples', 'course', c.lang), `course-${c.lang}`)
    const b = await cli(root, ['build', '--json'])
    assert.equal(b.code, 0, b.out + b.err)
    const built = JSON.parse(b.out) as { compiled: string[]; diagnostics: { severity: string; code: string }[] }
    assert.deepEqual([...built.compiled].sort(), ['debug', 'handoff', 'release', 'research', 'review', 'status'])
    assert.deepEqual(built.diagnostics.filter((d) => d.severity === 'error'), [])

    const docs = await cli(root, ['run', '--no-markers', '--dry-scripts', '--tier', 'quick', '--profile', 'docs'])
    assert.match(docs.out, c.docs)
    assert.match(docs.out, /`README\.uk\.md`/)
    assert.doesNotMatch(docs.out, c.planning)

    const premium = await cli(root, ['run', '--no-markers', '--dry-scripts', '--tier', 'premium', '--profile', 'planning'])
    assert.match(premium.out, c.planning)
    assert.doesNotMatch(premium.out, c.docs)
    assert.doesNotMatch(premium.out, /npm test/) // the numbered steps are for quick and standard only

    const release = await cli(root, ['run', 'release', '--args', 'minor --dry', '--dry-scripts', '--no-markers'])
    assert.match(release.out, c.release)
    const bad = await cli(root, ['run', 'release', '--args', 'huge', '--dry-scripts', '--no-markers'])
    assert.match(bad.out, /patch\|minor\|major/)

    const review = await cli(root, ['run', 'review', '--args', '--focus architecture --paths src/api,src/db', '--no-markers'])
    assert.match(review.out, /`src\/api`/)
    assert.match(review.out, /`src\/db`/)
    assert.match(review.out, /docs\/reviews\/latest\.md/)

    // Lesson 12: live state for the session, a stable AGENTS.md render without it.
    const live = await cli(root, ['run', '--no-markers', '--dry-scripts', '--tier', 'standard'])
    assert.match(live.out, c.state)
    assert.match(live.out, c.safety)
    const agents = await cli(root, ['sync', '--agents-md', 'AGENTS.md', '--tier', 'standard', '--dry-scripts'])
    assert.equal(agents.code, 0, agents.err)
    const md = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    assert.match(md, c.safety)
    assert.doesNotMatch(md, c.state)
    assert.doesNotMatch(md, /unverified/)

    const debug = await cli(root, ['run', 'debug', '--args', "'export does nothing'", '--dry-scripts', '--no-markers'])
    assert.match(debug.out, c.debug)
  })
}
