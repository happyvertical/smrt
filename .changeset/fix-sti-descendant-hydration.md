---
'@happyvertical/smrt-core': patch
---

Rehydrate STI descendants before save-time serialization so stale external runtime field caches do not coerce sibling integer fields to empty strings.
