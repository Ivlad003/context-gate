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

test('hooks-adapter and pi/opencode loadRules: every rule source through core loadRuleSources, as the mod', async () => {
  const { loadRules: hooksLoad } = await import('../packages/hooks-adapter/src/node.ts')
  const { loadRules: adapterLoad, loadGateData } = await import('../packages/adapters/common/load.ts')
  const dir = sandbox()
  const root = join(dir, 'repo')
  const gate = {
    providers: { arch: { kind: 'file', path: 'arch.json' }, lint: { kind: 'cli', command: ['eslint'] } },
    itemSources: [
      { kind: 'cursor-mdc', dir: 'rules/cursor' },
      { kind: 'cursor-mdc', dir: '.cursor/rules', nested: true },
      { kind: 'markdown-dir', dir: 'docs/rules', frontmatter: { paths: 'globs' } },
      { kind: 'provider', name: 'arch', field: 'deny', template: '{{ item.from }} не імпортує {{ item.to }}' },
      { kind: 'provider', name: 'lint', field: 'rules' },
    ],
  }
  write(root, {
    '.claude/gate.json': JSON.stringify(gate),
    '.cursor/rules/base.mdc': '---\nalwaysApply: true\n---\nBase.',
    'rules/cursor/custom.mdc': '---\nglobs: src/**\n---\nCustom.',
    'packages/api/.cursor/rules/api.mdc': '---\nglobs: "**/*.ts"\n---\nApi.',
    'node_modules/x/.cursor/rules/skip.mdc': '---\nalwaysApply: true\n---\nSkip.',
    'docs/rules/style.md': '---\npaths: ["src/**"]\n---\nStyle.',
    'docs/rules/README.md': '# not a rule',
    'arch.json': JSON.stringify({ deny: [{ from: 'ui', to: 'db' }] }),
  })
  const want = ['arch/0', 'base', 'custom', 'packages/api/api', 'style']
  for (const [name, load] of [['hooks-adapter', hooksLoad], ['pi/opencode', adapterLoad]] as const) {
    const r = load(root, mergeDefaults(gate as never))
    assert.deepEqual(r.rules.map((x) => x.id).sort(), want, name)
    assert.deepEqual(r.rules.find((x) => x.id === 'packages/api/api')!.globs, ['packages/api/**/*.ts'], name)
    assert.equal(r.rules.find((x) => x.id === 'arch/0')!.body, 'ui не імпортує db')
    assert.equal(r.rules.find((x) => x.id === 'style')!.source, 'markdown-dir')
    // A cli provider needs trust: skipped with G208, no process started.
    assert.ok(r.diagnostics.some((d) => d.code === 'G208' && d.message.includes('lint')), name)
  }
  assert.deepEqual(loadGateData(root).rules.map((x) => x.id).sort(), want)
  // The CLI loads the same file-based rules (provider rules join in buildContext).
  const { loadRules: cliLoad } = await import('../packages/cli/src/context.ts')
  assert.deepEqual(cliLoad(root, mergeDefaults(gate as never)).rules.map((x) => x.id).sort(), want.filter((x) => x !== 'arch/0'))
  assert.deepEqual(hooksLoad(root, mergeDefaults({ ...gate, cursorRules: { enabled: false } } as never)).rules, [])
})

test('collect / report: provider rule sources load when trusted; otherwise an unverified placeholder item', async () => {
  const { cli, jsonl } = await import('./cli-helpers.ts')
  const dir = sandbox()
  const root = join(dir, 'repo')
  write(root, {
    '.claude/gate.json': JSON.stringify({
      providers: { arch: { kind: 'cli', command: ['node', 'arch.mjs'] }, team: { kind: 'file', path: 'team.json' } },
      itemSources: [
        { kind: 'provider', name: 'arch', field: 'deny', template: '{{ item.from }} не імпортує {{ item.to }}' },
        { kind: 'provider', name: 'team', field: 'rules' },
      ],
    }),
    'arch.mjs': 'console.log(JSON.stringify({ deny: [{ from: "ui", to: "db" }] }))',
    'team.json': JSON.stringify({ rules: [{ id: 'naming', text: 'camelCase' }] }),
    '.cursor/rules/base.mdc': '---\nalwaysApply: true\n---\nBase.',
  })
  const ids = (out: string) => jsonl(out).filter((i) => i.kind === 'rule').map((i) => `${i.id}${i.status ? `:${i.status}` : ''}`).sort()
  // Untrusted: the cli provider is not started; the file provider needs no trust.
  const untrusted = await cli(root, ['collect'])
  assert.equal(untrusted.code, 0, untrusted.err)
  assert.deepEqual(ids(untrusted.out), ['rule:arch/*:unverified', 'rule:base', 'rule:team/naming'])
  const ph = jsonl(untrusted.out).find((i) => i.id === 'rule:arch/*')!
  assert.match(String(ph.description), /не довірений/)
  const trusted = await cli(root, ['collect', '--trust-repo'])
  assert.deepEqual(ids(trusted.out), ['rule:arch/0', 'rule:base', 'rule:team/naming'])
  const piped = await cli(root, ['pipe', 'collect | where kind=rule', '--trust-repo'])
  assert.deepEqual(ids(piped.out), ['rule:arch/0', 'rule:base', 'rule:team/naming'])
  // report: provider rules count as rules; an unavailable source is listed as unverified.
  const rep = JSON.parse((await cli(root, ['report', '--json'])).out)
  assert.deepEqual(rep.rulesNeverDelivered.sort(), ['base', 'team/naming'])
  assert.deepEqual(rep.rulesUnverified.map((u: { id: string }) => u.id), ['arch/*'])
  const repT = JSON.parse((await cli(root, ['report', '--json', '--trust-repo'])).out)
  assert.deepEqual(repT.rulesNeverDelivered.sort(), ['arch/0', 'base', 'team/naming'])
  assert.equal(repT.rulesUnverified, undefined)
  assert.match((await cli(root, ['report'])).out, /Не перевірено \(unverified\): arch\/\* — правила провайдера arch не отримано/)
})

test('itemSources prompt-dir: a custom section dir is read next to prompt.dir (core promptSectionDirs)', async () => {
  const { promptSectionDirs, isMarkdownSectionFile } = await import('../packages/core/src/assemble.ts')
  const { loadConfig } = await import('../packages/core/src/config.ts')
  assert.deepEqual(promptSectionDirs({}), ['.claude/prompt'])
  assert.deepEqual(promptSectionDirs({ prompt: { dir: './prompts/' }, itemSources: [
    { kind: 'prompt-dir', dir: './team/sections/', as: 'section' }, { kind: 'prompt-dir', dir: 'prompts' }, { kind: 'prompt-dir', dir: 'x', as: 'skill' }, { kind: 'prompt-dir', dir: '../out' }, { kind: 'markdown-dir', dir: 'docs' },
  ] }), ['prompts', 'team/sections'])
  assert.equal(isMarkdownSectionFile('README.md'), false)
  assert.equal(isMarkdownSectionFile('a.md'), true)
  assert.ok(loadConfig(JSON.stringify({ itemSources: [{ kind: 'prompt-dir' }] })).diagnostics.some((d) => d.code === 'G313'))
  assert.ok(loadConfig(JSON.stringify({ itemSources: [{ kind: 'prompt-dir', dir: 'x', as: 'rule' }] })).diagnostics.some((d) => d.code === 'G313'))
  const { cli, jsonl } = await import('./cli-helpers.ts')
  const root = join(sandbox(), 'repo')
  write(root, {
    '.claude/gate.json': JSON.stringify({ itemSources: [{ kind: 'prompt-dir', dir: 'team/sections', as: 'section' }] }),
    '.claude/prompt/own.md': '---\nid: own\nscope: static\n---\nOwn section.',
    'team/sections/shared.md': '---\nid: shared\nscope: static\n---\nShared {{ gate.tier }} section.',
    'team/sections/shared.quick.md': 'Shared quick.',
    'team/sections/README.md': '# not a section',
  })
  const r = await cli(root, ['run', '--tier', 'standard', '--no-markers'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /Own section\./)
  assert.match(r.out, /Shared standard section\./)
  assert.match((await cli(root, ['run', '--tier', 'quick', '--no-markers'])).out, /Shared quick\./)
  const sections = jsonl((await cli(root, ['collect'])).out).filter((i) => i.kind === 'section').map((i) => `${i.name}@${(i.provenance as { path?: string }).path}`)
  assert.deepEqual(sections.sort(), ['own@.claude/prompt/own.md', 'plan-then-act@builtin:plan-then-act', 'shared@team/sections/shared.md'])
})
