# SQLite lock wait for collection connections (#4978)

Every connection `host.ts`'s `getDatabase` opens on a file-backed SQLite
database (either engine) waits for a lock instead of failing at once with
`database is locked` (`applyCollectionLockWait`, once per cached connection,
only when no timeout is set yet; #4978): `SQLITE_COLLECTION_BUSY_TIMEOUT_MS`
(250 ms, short because `node:sqlite` waits synchronously on the main thread).
`SQLITE_BUSY_TIMEOUT_MS` (5000) is for the runtime's own connection and the
jobs liveness thread's reopened connection, where waiting is harmless.

`setBusyTimeoutIfUnset(db, ms)` never overrides a timeout that is already set (so the runtime's 5000 ms or this 250 ms value is never lengthened or shortened by a later caller); `TaskRunner.start()` uses it too. Concurrent callers of `applyCollectionLockWait` share one attempt.
