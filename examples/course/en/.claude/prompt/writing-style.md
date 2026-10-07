---
id: writing-style
scope: profile
when: gate.profile == "docs"
budget: 2500
---
@let langs = ["README.md", "README.uk.md"]
Documentation style:

- Write plain, human language. Every sentence is complete and carries one whole thought; do not leave fragments or bare lists of nouns.
- Explain an idea first, then show an example of it.
- The English and the Ukrainian docs say the same thing. When you change one, change the other in the same commit:
@each f in langs
  - `{{ f }}`
@end
@tier quick
Before you finish, re-read each changed paragraph and check: is any sentence cut off, and does each term have a short explanation the first time it appears?
@end
