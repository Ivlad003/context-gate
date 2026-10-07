---
id: work-state
scope: volatile
when: gate.profile != "agents-md"
budget: 1800
---
@run bash cache=30s as=tickets
grep -H -m1 '^Status:' .scratch/*/issues/*.md 2>/dev/null | sed 's|^\.scratch/||; s|/issues/| |; s|\.md:Status:| →|'
@end
@run bash cache=30s as=handoff
ls -t HANDOFF.md .scratch/*/handoff*.md 2>/dev/null | head -1
@end
Version {{ pkg.version }} on branch `{{ git.branch }}`, {{ git.ahead }} commits not pushed, {{ git.behind }} commits behind the remote.
@if tickets
Tickets right now (answer "what's the status?" from this list, do not search again):
```text
{{ tickets | truncate(1200) }}
```
@end
@if handoff
The latest handoff is `{{ handoff }}`. Read it before you continue earlier work.
@end
