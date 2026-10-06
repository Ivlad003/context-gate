import { test } from 'node:test'
import assert from 'node:assert/strict'
import { itemId, parseItemId, makeItem, normalizeItems, parseSkillListing, renderSkillListing, skillListingItems, groupMatches, expandGroups, groupsOf, mcpServerOf } from '../packages/core/src/items.ts'

test('ids', () => {
  assert.equal(itemId('skill', 'react'), 'skill:react')
  assert.deepEqual(parseItemId('skill:plugin:x'), { kind: 'skill', name: 'plugin:x' })
  assert.deepEqual(parseItemId('plugin:x'), { name: 'plugin:x' })
  assert.equal(mcpServerOf('mcp__github__list_prs'), 'github')
  assert.equal(mcpServerOf('Read'), undefined)
})

test('normalizeItems dedupes and computes cost', () => {
  const a = makeItem('skill', 'a', { description: 'abc' })
  assert.equal(a.cost.chars, 4)
  const items = normalizeItems([
    { ...a, cost: { chars: 0 } },
    { ...makeItem('skill', 'a', { body: 'x'.repeat(10), tags: ['t'] }), description: undefined },
    { ...makeItem('rule', 'r', { body: 'yy' }), id: '' },
  ])
  assert.equal(items.length, 2)
  assert.equal(items[0].body, 'x'.repeat(10), 'missing fields filled from duplicate')
  assert.equal(items[0].description, 'abc', 'first wins')
  assert.equal(items[0].cost.chars, 10)
  assert.deepEqual(items[0].tags, ['t'])
  assert.equal(items[1].id, 'rule:r')
})

const LISTING = `The following skills are available for use with the Skill tool:

- shiftwork:shiftwork: Drive Shiftwork, the ticket runner.
- react-components: Build React components
- tailwind: Tailwind styling
- claude-api: Reference for the Claude API.
TRIGGER — read BEFORE opening the target file.
SKIP only when another provider is used.
- tdd: Test-driven development.
- bare-skill

Trailing note line.`

test('parseSkillListing: bullets, colons in names, continuation, unknown lines', () => {
  const l = parseSkillListing(LISTING)
  const skills = skillListingItems(l)
  assert.deepEqual(skills.map((s) => s.name), ['shiftwork:shiftwork', 'react-components', 'tailwind', 'claude-api', 'tdd', 'bare-skill'])
  assert.equal(skills[3].description, 'Reference for the Claude API.\nTRIGGER — read BEFORE opening the target file.\nSKIP only when another provider is used.')
  assert.equal(skills[0].id, 'skill:shiftwork:shiftwork')
  // round trip with no decisions is identity
  assert.equal(renderSkillListing(l, {}), LISTING)
})

test('parseSkillListing: lenient forms', () => {
  assert.deepEqual(skillListingItems(parseSkillListing('* a: A\n• b: B\n1. c: C')).map((s) => s.name), ['a', 'b', 'c'])
  const plain = skillListingItems(parseSkillListing('Header text\nalpha: first\n  more of first\nbeta: second'))
  assert.deepEqual(plain.map((s) => [s.name, s.description]), [['alpha', 'first\n  more of first'], ['beta', 'second']])
  assert.deepEqual(skillListingItems(parseSkillListing('- `code-name`: d\n- **bold**: e')).map((s) => s.name), ['code-name', 'bold'])
})

test('renderSkillListing applies decisions', () => {
  const l = parseSkillListing(LISTING)
  const out = renderSkillListing(l, { 'skill:react-components': 'on', 'skill:tailwind': 'nameOnly', 'skill:claude-api': 'off', tdd: 'preload' })
  assert.match(out, /^- react-components: Build React components$/m)
  assert.match(out, /^- tailwind$/m)
  assert.doesNotMatch(out, /claude-api|TRIGGER/)
  assert.match(out, /^- tdd: Test-driven development\.$/m)
  assert.match(out, /^The following skills/)
  assert.match(out, /Trailing note line\.$/)
  const fromItems = renderSkillListing([makeItem('skill', 'x', { description: 'X' }), makeItem('skill', 'y', { description: 'Y' }), makeItem('tool', 'Read')], { 'skill:y': 'nameOnly' })
  assert.equal(fromItems, '- x: X\n- y')
})

test('groupMatches and expandGroups', () => {
  const items = [makeItem('skill', 'react-a'), makeItem('skill', 'react-native'), makeItem('tool', 'mcp__figma__get'), makeItem('agent', 'ui-reviewer'), makeItem('rule', 'react-x')]
  const rows: [string, number, boolean][] = [
    ['skill:react-*', 0, true],
    ['skill:react-*', 4, false],
    ['rule:react-*', 4, true],
    ['tool:mcp__figma__*', 2, true],
    ['react-*', 4, true],
    ['agent:ui-*', 3, true],
  ]
  for (const [pat, i, want] of rows) assert.equal(groupMatches(pat, items[i]), want, `${pat} ~ ${items[i].id}`)
  const cfg = { groups: { fe: ['skill:react-*', '!skill:react-native', 'tool:mcp__figma__*'], ag: ['agent:ui-reviewer'] } }
  assert.deepEqual([...expandGroups(cfg, ['fe', 'missing'], items)].sort(), ['skill:react-a', 'tool:mcp__figma__get'])
  assert.deepEqual([...expandGroups(cfg, ['fe', 'ag'], items)].length, 3)
  assert.deepEqual(groupsOf(cfg, items[1]), [])
  assert.deepEqual(groupsOf(cfg, items[3]), ['ag'])
})
