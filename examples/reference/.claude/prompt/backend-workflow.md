---
id: backend-workflow
scope: profile
when: gate.profile == "backend"
budget: 2000
---
Бекенд (`apps/api`): контролер → сервіс → Prisma. Перед зміною схеми прочитай `apps/api/prisma/schema.prisma`.

@if gate.tier == "quick"
1. Зміни `schema.prisma`.
2. Створи міграцію: `npx prisma migrate dev --name <що>` (стару не редагуй).
3. Онови сервіс і тест поряд, запусти `npm test -w apps/api`.
@else
Міграції лише додаються; деструктивні кроки — у дві міграції. Скрипти пакета: {{ pkg.scripts | len }} у корені.
@end
