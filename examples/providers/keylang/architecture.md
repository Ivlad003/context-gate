---
id: architecture
scope: profile
when: arch != null
budget: 2000
---
Межі архітектури (з keylang):
@each d in arch.deny
- {{ d.from }} не імпортує {{ d.to }}{{ d.reason ? " — " + d.reason : "" }}
@end

Пояснення use case: {{ arch.code("application.purchase.buy").explain }}
