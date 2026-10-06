---
id: workflow
scope: profile
budget: 1500
---
Правила сервісу:
@each r in cursor.always
- {{ r.body }}
@end

Перевірка перед комітом: `{{ pkg.scripts.test }}`; міграції: `{{ pkg.scripts.migrate }}`.
@if gate.profile == "db"
Перед міграцією переглянь останні файли в `migrations/` і повтори їхню структуру.
@end
