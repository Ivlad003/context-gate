---
id: lint-state
scope: volatile
when: eslint != null
budget: 1200
---
ESLint: {{ eslint | len }} файлів перевірено, з помилками — {{ eslint | where("errorCount") | len }}.
@if len(eslint | where("errorCount")) > 0
Найгірші файли (виправ, якщо торкаєшся їх):
@each f in eslint | where("errorCount") | sort("-errorCount") | take(3)
- {{ f.filePath }}: {{ f.errorCount }} помил., перша — рядок {{ f.messages[0].line }} {{ f.messages[0].ruleId }}
@end
@end
