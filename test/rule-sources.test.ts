// G-51 / G-04 / G-03 / G-16: rule sources (cursor-mdc dirs, markdown-dir, provider), the CLI wiring,
// `env.*` in the CLI scope and `init --commit-compiled`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cursorRuleDirs, frameRule, isFileRule, markdownRuleId, packInjections, parseMarkdownRule, providerRules, renderItemTemplate, ruleSourcesOf, ruleToItem } from '../packages/core/src/mdc.ts'
import { mergeDefaults } from '../packages/core/src/config.ts'
import type { Value } from '../packages/core/src/types.ts'
import { sandbox } from './cli-helpers.ts'

function write(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), text)
  }
}

test('ruleSourcesOf / cursorRuleDirs: rule kinds only; custom cursor dirs and per-source nested', () => {
  const cfg = mergeDefaults({
    itemSources: [
      { kind: 'claude-skills' }, { kind: 'cursor-mdc', dir: './rules/cursor/' }, { kind: 'markdown-dir', dir: 'docs/rules' },
      { kind: 'provider', name: 'arch', as: 'always' }, { kind: 'provider', name: 'prs', as: 'datum' },
    ],
    ruleSources: [{ kind: 'cursor-mdc', dir: '.cursor/rules', nested: true }],
  })
  assert.deepEqual(ruleSourcesOf(cfg).map((s) => `${s.kind}:${s.dir ?? s.name}`), ['cursor-mdc:./rules/cursor/', 'markdown-dir:docs/rules', 'provider:arch', 'cursor-mdc:.cursor/rules'])
  assert.deepEqual(cursorRuleDirs(cfg), { dirs: ['.cursor/rules', 'rules/cursor'], nested: true })
  assert.deepEqual(cursorRuleDirs(mergeDefaults({})), { dirs: ['.cursor/rules'], nested: false })
})

test('parseMarkdownRule: frontmatter mapping (paths → globs), unknown keys ignored, as: always', () => {
  const text = '---\ntitle: API\npaths:\n  - "src/api/**/*.ts"\n  - "!src/api/gen/**"\ntags: [a]\n---\n# API\n\nUse DTOs.'
  const { rule, diagnostics } = parseMarkdownRule(text, { path: 'docs/rules/api.md', id: markdownRuleId('docs/rules/api.md', 'docs/rules'), frontmatter: { paths: 'globs' } })
  assert.deepEqual(diagnostics, [])
  assert.equal(rule.id, 'api')
  assert.equal(rule.type, 'auto')
  assert.deepEqual(rule.globs, ['src/api/**/*.ts'])
  assert.deepEqual(rule.negGlobs, ['src/api/gen/**'])
  assert.equal(rule.source, 'markdown-dir')
  assert.equal(rule.body, '# API\n\nUse DTOs.')
  const plain = parseMarkdownRule('# Style\nBe brief.', { path: 'docs/rules/team/style.md', id: markdownRuleId('docs/rules/team/style.md', './docs/rules/') })
  assert.equal(plain.rule.id, 'team/style')
  assert.equal(plain.rule.type, 'manual')
  assert.equal(parseMarkdownRule('# Style', { path: 'x.md', id: 'x', as: 'always' }).rule.type, 'always')
  const item = ruleToItem(rule)
  assert.equal(item.provenance.source, 'markdown-dir')
  assert.match(frameRule(rule), /^Contents of docs\/rules\/api\.md \(rule api\):/)
})

test('providerRules: field/pick, template over item, ids, globs → auto, as: always, unverified data', () => {
  const value: Value = { deny: [{ from: 'domain', to: 'infra' }, { from: 'ui', to: 'db', globs: ['apps/web/**'] }], meta: { n: 2 } }
  const tpl = { kind: 'provider' as const, name: 'arch', field: 'deny', as: 'rule' as const, template: '{{ item.from }} не імпортує {{ item.to }}' }
  const r = providerRules(value, tpl)
  assert.deepEqual(r.diagnostics, [])
  assert.deepEqual(r.rules.map((x) => [x.id, x.type, x.body, x.globs]), [
    ['arch/0', 'always', 'domain не імпортує infra', []],
    ['arch/1', 'auto', 'ui не імпортує db', ['apps/web/**']],
  ])
  assert.equal(r.rules[0].source, 'provider:arch')
  assert.equal(isFileRule(r.rules[0]), false)
  assert.equal(providerRules(value, { ...tpl, as: 'always' }).rules[1].type, 'always')
  // An object map → one rule per entry, the key as id; plain strings as bodies.
  const map = providerRules({ rules: { naming: 'camelCase', size: { text: 'files < 300 lines' } } }, { kind: 'provider', name: 'team', pick: 'rules' })
  assert.deepEqual(map.rules.map((x) => [x.id, x.body]), [['team/naming', 'camelCase'], ['team/size', 'files < 300 lines']])
  assert.equal(providerRules({ unverified: true }, tpl).diagnostics[0].code, 'G203')
  assert.equal(providerRules({ other: 1 }, tpl).diagnostics[0].code, 'G313')
  assert.deepEqual(providerRules(null, tpl).rules, [])
  assert.equal(renderItemTemplate('{{ index }}: {{ item.a.b }}{{ nope( }}', { a: { b: 'x' } }, 3), '3: x')
  // Non-file rules frame without a path to read.
  assert.match(packInjections(r.rules, 10_000).text, /Contents of provider:arch \(rule arch\/0\):\ndomain не імпортує infra/)
})

test('CLI loadRules: custom cursor-mdc dir and markdown-dir sources; provider rules join buildContext', async () => {
  const dir = sandbox()
  const root = join(dir, 'repo')
  write(root, {
    '.claude/gate.json': JSON.stringify({
      providers: { arch: { kind: 'file', path: 'arch.json' } },
      itemSources: [
        { kind: 'cursor-mdc', dir: 'rules/cursor' },
        { kind: 'markdown-dir', dir: 'docs/rules', frontmatter: { paths: 'globs' } },
        { kind: 'provider', name: 'arch', field: 'deny', as: 'always', template: '{{ item.from }} не імпортує {{ item.to }}' },
      ],
      env: ['CG_TEST_TOKEN'],
    }),
    'rules/cursor/ts.mdc': '---\nglobs: *.ts\n---\nTS rule',
    'docs/rules/api.md': '---\npaths: src/api/**\n---\nAPI rule',
    'docs/rules/README.md': '# not a rule',
    'arch.json': JSON.stringify({ deny: [{ from: 'domain', to: 'infra' }] }),
  })
  const { loadRepo, loadRules, buildContext, collectItems } = await import('../packages/cli/src/context.ts')
  const repo = loadRepo(root)
  const { rules } = loadRules(root, repo.config)
  assert.deepEqual(rules.map((r) => `${r.id}:${r.type}:${r.source ?? 'cursor-mdc'}`), ['ts:auto:cursor-mdc', 'api:auto:markdown-dir'])
  process.env.CG_TEST_TOKEN = 'tok-1234'
  process.env.CG_TEST_OTHER = 'hidden'
  try {
    const ctx = await buildContext({ root })
    assert.deepEqual(ctx.rules.map((r) => r.id), ['ts', 'api', 'arch/0'])
    assert.ok(collectItems(ctx.repo, ctx.rules).some((i) => i.id === 'rule:arch/0' && i.provenance.source === 'provider:arch'))
    assert.ok(ctx.gate.rules.on.includes('arch/0'))
    // G-03: only whitelisted env names reach the scope.
    assert.deepEqual(ctx.scope.env, { CG_TEST_TOKEN: 'tok-1234' })
    const cursor = ctx.scope.cursor as Record<string, { id: string }[]>
    assert.ok(cursor.always.some((r) => r.id === 'arch/0'))
  } finally {
    delete process.env.CG_TEST_TOKEN
    delete process.env.CG_TEST_OTHER
  }
})

test('init --commit-compiled: prompt.commitCompiled true, .compiled/ not gitignored (G-16)', async () => {
  const { initCommand, gitignoreLines } = await import('../packages/cli/src/cmd-init.ts')
  assert.ok(gitignoreLines({}).includes('.claude/prompt/.compiled/'))
  assert.ok(!gitignoreLines({ prompt: { commitCompiled: true } }).some((l) => l.includes('.compiled')))
  assert.deepEqual(gitignoreLines({ prompt: { dir: './prompts/' } }).slice(0, 2), ['prompts/.compiled/', 'prompts/.trace/'])
  const dir = sandbox()
  const plain = join(dir, 'a')
  mkdirSync(plain, { recursive: true })
  assert.equal(initCommand(plain, {}).code, 0)
  assert.match(readFileSync(join(plain, '.gitignore'), 'utf8'), /\.claude\/prompt\/\.compiled\//)
  const committed = join(dir, 'b')
  write(committed, { '.gitignore': 'node_modules/\n.claude/prompt/.compiled/\n' })
  const r = initCommand(committed, { commitCompiled: true })
  assert.equal(r.code, 0)
  assert.match(r.out, /commitCompiled: true/)
  const gi = readFileSync(join(committed, '.gitignore'), 'utf8')
  assert.doesNotMatch(gi, /\.compiled/)
  assert.match(gi, /node_modules\//)
  assert.equal(JSON.parse(readFileSync(join(committed, '.claude/gate.json'), 'utf8')).prompt.commitCompiled, true)
})
