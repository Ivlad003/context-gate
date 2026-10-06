import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cli, copyFixture, jsonl } from './cli-helpers.ts'

function withSkills(root: string): void {
  for (const n of ['react-hooks', 'nestjs', 'tdd']) {
    mkdirSync(join(root, '.claude/skills', n), { recursive: true })
    writeFileSync(join(root, '.claude/skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: about ${n}\n---\n${'x'.repeat(40)}\n`)
  }
}

test('pipe JSONL chain: collect | decide --profile | tokens composes through stdin/stdout', async () => {
  const root = copyFixture()
  withSkills(root)
  const c = await cli(root, ['collect'])
  assert.equal(c.code, 0, c.err)
  const items = jsonl(c.out)
  const ids = items.map((i) => i.id)
  for (const id of ['rule:always', 'rule:react', 'rule:api', 'skill:react-hooks', 'skill:nestjs', 'skill:tdd', 'section:intro', 'section:workflow', 'tool:count_files', 'datum:pkg']) assert.ok(ids.includes(id), `collect has ${id}`)
  const d = await cli(root, ['decide', '--profile', 'backend', '--model', 'claude-haiku-4'], c.out)
  assert.equal(d.code, 0, d.err)
  const decided = jsonl(d.out)
  const dec = Object.fromEntries(decided.map((i) => [i.id, i.decision]))
  assert.equal(dec['skill:react-hooks'], 'off')
  assert.equal(dec['skill:nestjs'], 'on')
  assert.equal(dec['skill:tdd'], 'on')
  const t = await cli(root, ['tokens'], d.out)
  const sum = JSON.parse(t.out)
  assert.equal(sum.count, decided.length)
  assert.ok(sum.included.chars < sum.chars, 'off items do not count as included')
  assert.equal(sum.byDecision.off.count, decided.filter((i) => i.decision === 'off').length)
  // Same chain in-process with the /gate grammar.
  const p = await cli(root, ['pipe', 'collect | decide --profile backend --model claude-haiku-4 | tokens'])
  assert.deepEqual(JSON.parse(p.out), sum)
})

test('pipe stages: collect --kind/--id, where, observe --status never, render | preview, deliver --dry-run, budget', async () => {
  const root = copyFixture()
  const rules = await cli(root, ['collect', '--kind', 'rule'])
  assert.deepEqual(jsonl(rules.out).map((i) => i.name), ['always', 'api', 'react'])
  const auto = await cli(root, ['where', 'ruleType=auto'], rules.out)
  assert.deepEqual(jsonl(auto.out).map((i) => i.name), ['react'])
  // The journal delivered only `always` (and enabled react/api in decisions).
  const never = await cli(root, ['observe', '--status', 'never'], rules.out)
  assert.deepEqual(jsonl(never.out).map((i) => i.name), [])
  const delivered = jsonl((await cli(root, ['observe'], rules.out)).out)
  assert.equal((delivered.find((i) => i.name === 'always')!.observed as { delivered: number }).delivered, 1)
  const notDelivered = await cli(root, ['pipe', 'collect --kind rule | observe | where observed.delivered=0'])
  assert.deepEqual(jsonl(notDelivered.out).map((i) => i.name), ['api', 'react'])
  const sec = await cli(root, ['collect', '--kind', 'section', '--id', 'workflow'])
  const rendered = await cli(root, ['render', '--tier', 'quick'], sec.out)
  const r = jsonl(rendered.out)[0]!
  assert.equal(r.tier, 'quick')
  assert.match((r.rendered as { text: string }).text, /Зразок apps\/web\/src\/a\.js/)
  const preview = await cli(root, ['preview'], rendered.out)
  assert.match(preview.out, /^<!-- section:workflow -->\nПрацюй малими кроками\./)
  const decided = (await cli(root, ['decide', '--profile', 'frontend'], rules.out)).out
  const dl = jsonl((await cli(root, ['deliver', '--dry-run'], decided)).out)
  assert.equal(dl.find((x) => x.id === 'rule:always')!.event, 'prompt.context')
  assert.equal((await cli(root, ['deliver'], decided)).code, 2)
  const b = jsonl((await cli(root, ['budget', '--max-chars', '20'], decided)).out)
  assert.equal(b.find((x) => x.name === 'react')!.decision, 'nameOnly')
  // Unknown stage in a pipe → G501, exit 2.
  const bad = await cli(root, ['pipe', 'collect | frobnicate'])
  assert.equal(bad.code, 2)
  assert.match(bad.err, /G501/)
})
