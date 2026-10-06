// Script tools (SPEC «Виконавці скриптів»): interpreter detection. The `# gate-tool:` header parser is core
// `toolheader.ts`.


const EXT_LANG: Record<string, string> = {
  sh: 'bash', bash: 'bash', js: 'node', mjs: 'node', cjs: 'node', ts: 'node', mts: 'node', py: 'python', rb: 'ruby', php: 'php', deno: 'deno',
}

/** Language of a script: shebang first (`#!/usr/bin/env python3` → python), then the extension. */
export function scriptLang(path: string, text?: string): string | undefined {
  const first = text?.split('\n', 1)[0] ?? ''
  if (first.startsWith('#!')) {
    const parts = first.slice(2).trim().split(/\s+/)
    let bin = (parts[0] ?? '').split('/').pop() ?? ''
    if (bin === 'env') bin = (parts.find((p, i) => i > 0 && !p.startsWith('-')) ?? '').split('/').pop() ?? ''
    if (/^python/.test(bin)) return 'python'
    if (/^(ba|z|)sh$/.test(bin)) return 'bash'
    if (bin === 'node' || bin === 'tsx') return 'node'
    if (bin === 'deno') return 'deno'
    if (bin) return bin
  }
  const ext = /\.([\w]+)$/.exec(path)?.[1]?.toLowerCase()
  return ext ? EXT_LANG[ext] : undefined
}

/** Function name of a script file: base name without extension, `-` → `_`. */
export function scriptFnName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_')
}
