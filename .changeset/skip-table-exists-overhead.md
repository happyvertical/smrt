---
"@happyvertical/smrt-core": patch
---

Skip tableExists() check for migration-managed database adapters

`Collection.create()` now checks `db.requiresSchemaCheck` before running
`tableExists()`. Postgres and SQLite adapters (which manage schema via
migrations) no longer pay the cost of an extra round-trip per collection
initialization. This eliminates ~1s per collection over high-latency
connections (e.g. Tailscale).
