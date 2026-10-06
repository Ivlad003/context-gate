---
id: data
scope: volatile
use:
  util: scripts/util.py
---
Власник: {{ info.owner }}; сервісів {{ len(info.services) }}.
Наступна версія: {{ util.bump("1.2.3") }}.
@run bash as=greeting
echo '{"hello": "світ"}'
@end
Привіт {{ greeting.hello }}.
@if data.release
Реліз: {{ data.release.tag }}.
@end
@if prs
Відкритих PR: {{ len(prs) }}.
@end
