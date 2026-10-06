---
scope: profile
budget: 1500
---
@each r in cursor.always
- {{ r.body }}
@end
@if gate.profile == "explore"
Результат дослідження закінчуй висновком у 3 пунктах і переліком файлів, які варто перенести в `pipelines/`.
@end
