// Ambient module types for non-code imports in prompts (loaders of `context-gate build`).
// `.md`/`.txt`/`.mdc`: default export = text without frontmatter, `meta` = parsed frontmatter.

declare module '*.md' {
  const text: string
  export default text
  export const meta: Record<string, unknown>
}
declare module '*.mdc' {
  const text: string
  export default text
  export const meta: Record<string, unknown>
}
declare module '*.txt' {
  const text: string
  export default text
  export const meta: Record<string, unknown>
}
