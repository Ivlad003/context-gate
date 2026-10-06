// Shared prompt components: imported by the entry prompt, never built on their own.
import { Section, If } from '@context-gate/jsx'

export interface IdentityProps {
  /** Build-time constant: the repository name. */
  repo: string
  stack: string
}

/** Static identity section: stable across the session, so it stays in the prompt cache. */
export const Identity = ({ repo, stack }: IdentityProps) => (
  <Section id="identity" scope="static">
    Ти senior full-stack інженер у монорепозиторії {repo} ({stack}).

    Відповідай українською, код і ідентифікатори — англійською.
  </Section>
)

/** Safety rules (static): destructive commands and migrations need a confirmation. */
export const SafetyRules = () => (
  <Section id="safety" scope="static">
    Не виконуй деструктивних команд (`rm -rf`, `git push --force`, `prisma migrate reset`) без явного підтвердження.
    Не редагуй застосовані міграції в `apps/api/migrations/` — додавай нові.
    <If test="git.dirty">У робочому дереві є незакомічені зміни — не губи їх.</If>
  </Section>
)
