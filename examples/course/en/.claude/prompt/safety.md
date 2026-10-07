---
id: safety
scope: static
---
Things that are hard to undo:

- Never write passwords, tokens or keys into files. If a tool needs one, use the system keyring or ask me.
- Another session may be editing this checkout at the same time. Stage only the files you changed yourself, by name, never with `git add -A`.
- Pushing is fine after the checks pass. Publishing a package is mine: prepare everything and give me the exact command.
