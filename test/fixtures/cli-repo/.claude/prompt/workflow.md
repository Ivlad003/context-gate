---
id: workflow
scope: profile
---
Працюй малими кроками.
@if gate.profile == "frontend"
Профіль фронтенду.
@end
@tier quick
@each ex in fs.examples("apps/web/**/*.js", 1)
Зразок {{ ex.path }}: {{ ex.body }}
@end
@end
