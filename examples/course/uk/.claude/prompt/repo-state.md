---
id: repo-state
scope: volatile
---
Гілка `{{ git.branch }}`.
@if git.dirty
Є незакомічені зміни. Не загуби їх:
@run bash cache=1m as=st
git status --short | head -20
@end
```text
{{ st | truncate(1500) }}
```
@end
