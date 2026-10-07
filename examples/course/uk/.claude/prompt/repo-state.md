---
id: repo-state
scope: volatile
when: gate.profile != "agents-md"
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
