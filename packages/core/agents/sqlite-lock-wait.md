# SQLite lock wait for collection connections (#4978)

Every connection `host.ts`'s `getDatabase` opens on a file-backed SQLite
database (either engine) waits for a lock instead of failing at once with
`database is locked` (`applyCollectionLockWait`, once per cached connection,
only when no timeout is set yet; #4978): `SQLITE_COLLECTION_BUSY_TIMEOUT_MS`
(250 ms, short because `node:sqlite` waits synchronously on the main thread).
`SQLITE_BUSY_TIMEOUT_MS` (5000) is for the runtime's own connection and the
jobs liveness thread's reopened connection, where waiting is harmless.

`setBusyTimeoutIfUnset(db, ms)` never overrides a timeout that is already set (so the runtime's 5000 ms or this 250 ms value is never lengthened or shortened by a later caller); `TaskRunner.start()` uses it too. Concurrent callers of `applyCollectionLockWait` share one attempt.

One connection per file (#5022): the local runtime opens its handle through
`resolveDatabase`, so `runtime.database()` and collections are one cached
`smrt:<url>` connection and `tuneLocalSqlite` raises it to 5000 ms. Two
main-thread handles on one file would wait on each other synchronously, so
never open a second one; only the liveness thread and lock worker (own threads)
and the uncached operator token store keep separate connections.
