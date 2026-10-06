// Helpers for test/cli-*.test.ts: temp copies of fixtures, isolated HOME / XDG_CACHE_HOME, in-process CLI.
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after } from 'node:test'

export const REPO = resolve(import.meta.dirname, '..')
export const FIXTURE = join(REPO, 'test', 'fixtures', 'cli-repo')

const temps: string[] = []
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }) })

/** A fresh temp dir; HOME and XDG_CACHE_HOME point into it so trust/cache never touch the real ones. */
export function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cg-cli-'))
  temps.push(dir)
  process.env.HOME = join(dir, 'home')
  process.env.XDG_CACHE_HOME = join(dir, 'cache')
  return dir
}

/** Copies a fixture into a new sandbox and returns the repo path. */
export function copyFixture(src = FIXTURE, name = 'repo'): string {
  const dir = sandbox()
  const repo = join(dir, name)
  cpSync(src, repo, { recursive: true, filter: (p) => !p.includes(`${'/'}.compiled`) && !p.includes('/.trace') })
  return repo
}

export interface CliResult { code: number; out: string; err: string }

/** Runs the CLI in-process (`main(argv, io)`) with `--root <root>` and optional stdin. */
export async function cli(root: string, argv: string[], stdin = ''): Promise<CliResult> {
  const { main } = await import('../packages/cli/src/main.ts')
  let out = ''
  let err = ''
  const code = await main([...argv, '--root', root], { out: (s) => { out += s }, err: (s) => { err += s }, stdin: async () => stdin })
  return { code, out, err }
}

export const jsonl = (s: string): Record<string, unknown>[] => s.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
