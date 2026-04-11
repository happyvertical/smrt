---
'@happyvertical/smrt-cli': patch
---

Fix static-site export queries on Postgres by passing raw SQL parameters to the database adapter as variadic arguments instead of a single wrapped array.
