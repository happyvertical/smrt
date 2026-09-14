---
'@happyvertical/smrt-core': patch
---

Fix a PostgreSQL race in `DispatchBus.initialize()` that could hang or throw
under concurrent load against a warmed database (#2861).

`_smrt_dispatch`/`_smrt_dispatch_subscriptions` are framework-owned system
tables already covered by `bootstrapSystemTables()`'s advisory-locked
transaction, but `DispatchBus.initialize()` provisioned/verified them through
its own, separate, unlocked path. Two or more `DispatchBus` instances
initializing concurrently against the same PostgreSQL database — e.g.
multiple `Suasor`/`Agent` instantiations in one process, or parallel test
files sharing one CI database — raced on unguarded DDL:

```
Failed to execute raw query: duplicate key value violates unique constraint
"pg_type_typname_nsp_index"
```

`DispatchBus.initialize()` now runs under the same advisory lock
`ensureSystemTables()` uses (`runSerializedAgainstSystemTableBootstrap()`, new
in `system/bootstrap.ts`), making every writer of these tables mutually
exclusive instead of merely idempotent.

That fix exposed a second, related defect: `DispatchCollection.tableExists()`
and `DispatchSubscriptionCollection.tableExists()` probed existence with
`SELECT ... LIMIT 1` wrapped in a try/catch. On PostgreSQL, a caught query
error still aborts the *entire* surrounding transaction (Postgres aborts a
transaction on any statement error, whether or not the application handles
it), so once initialization runs inside a transaction, the probe's own
expected "table missing" error would poison every subsequent statement in
that transaction. Both `tableExists()` methods now delegate to the shared,
engine-aware `tableExists()` helper in `system/compatibility.ts`, which uses
`information_schema.tables` on PostgreSQL and never raises for a missing
table.

Together these two fixes are the root cause of the "re-initialization against
a warmed Postgres database can hang and later report a stale
`assertPostgresSystemTimestampsCurrent()` guard" failures seen under full-test
concurrency downstream (anytown/anytown.ai#1183, #1189, #1190): unguarded
concurrent DDL against a shared system table, not a legacy-typed column
produced by fresh table creation (that mechanism was traced and ruled out).
