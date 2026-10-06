// Shared prompt components: imported by entry prompts, never built on their own.
import { Section, If } from '@context-gate/jsx'

export interface IdentityProps {
  /** Build-time constant: the repository name. */
  repo: string
  stack?: string
}

/** Static identity section: stable across the session, so it stays in the prompt cache. */
export const Identity = ({ repo, stack = 'TypeScript' }: IdentityProps) => (
  <Section id="identity" scope="static">
    Ти senior {stack}-інженер у проєкті {repo}.

    Відповідай українською, код і ідентифікатори — англійською.
  </Section>
)

/** Safety rules, stricter on `level="strict"` (build-time prop, evaluated once). */
export const SafetyRules = ({ level }: { level: 'strict' | 'normal' }) => (
  <Section id="safety" scope="static">
    Не виконуй деструктивних команд (`rm -rf`, `git push --force`) без явного підтвердження.
    {level === 'strict' ? 'Перед зміною публічного API спитай, чи є споживачі поза репозиторієм.' : null}
    <If test="git.dirty">У робочому дереві є незакомічені зміни — не губи їх.</If>
  </Section>
)
