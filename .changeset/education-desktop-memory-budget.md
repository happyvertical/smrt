---
'@happyvertical/smrt-education': minor
---

`requireIngestionMemoryLimit` accepts an explicit `desktopBudget` option so single-user macOS and Windows hosts can run capture analysis with an advisory, fail-closed memory budget. Linux cgroup-v2 behaviour is unchanged. Closes #4964.
