---
id: repo-state
scope: volatile
---
Branch `{{ git.branch }}`.
@if git.dirty
There are uncommitted changes. Do not lose them:
@run bash cache=1m as=st
git status --short | head -20
@end
```text
{{ st | truncate(1500) }}
```
@end
