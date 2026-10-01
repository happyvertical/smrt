---
'@happyvertical/smrt-core': minor
---

List `orderBy` terms accept `NULLS FIRST` / `NULLS LAST`, so a caller can state
an engine-independent NULL placement (PostgreSQL sorts NULLs first when
descending). `toSnakeCase` is exported.
