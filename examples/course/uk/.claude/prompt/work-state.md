---
id: work-state
scope: volatile
budget: 1800
---
@run bash cache=30s as=tickets
grep -H -m1 '^Status:' .scratch/*/issues/*.md 2>/dev/null | sed 's|^\.scratch/||; s|/issues/| |; s|\.md:Status:| →|'
@end
@run bash cache=30s as=handoff
ls -t HANDOFF.md .scratch/*/handoff*.md 2>/dev/null | head -1
@end
Версія {{ pkg.version }} на гілці `{{ git.branch }}`: {{ git.ahead }} комітів не запушено, {{ git.behind }} комітів відстає від remote.
@if tickets
Тікети зараз (на «який статус?» відповідай з цього списку, не шукай знову):
```text
{{ tickets | truncate(1200) }}
```
@end
@if handoff
Останній handoff — `{{ handoff }}`. Прочитай його, перш ніж продовжувати попередню роботу.
@end
