# `db:migrate` concurrency (#3634)

Two processes migrating one PostgreSQL database at once — two workloads that
gate startup on `db:migrate`, a rolling restart, a break-glass Job beside running
pods — used to both compare the live schema, plan the same batch, and the
second failed part way with `42701`/`42P07` "already exists" or a `40P01`
deadlock. The tracker's per-migration `running` rows cannot prevent that: they
are written after the diff, when both runs have already planned.

## Contract

- A non-dry-run `db:migrate` on PostgreSQL calls core `acquireMigrationLock()`
  right after connecting, before the system-timestamp step, tracker bootstrap,
  and schema comparison, and releases it in the handler's `finally`.
- The lock is `pg_try_advisory_lock(hashtext('smrt'), hashtext('db:migrate'))`
  (`MIGRATION_ADVISORY_LOCK_KEYS`) on its own `acquireSession()` connection,
  polled once a second. Polling, not a blocking `pg_advisory_lock`, so the
  connection's `lock_timeout` never cuts the wait short and the wait can be
  logged. Never change the keys: runs of an old and a new release must still
  exclude each other.
- A waiting run logs `Another db:migrate run holds the migration lock…`, then,
  once it holds the lock, compares a current schema and applies nothing.
- The wait is bounded by `migrations.postgres.migrationLockTimeout` (default
  `15min`; `ms`/`s`/`min`/`h` forms; `0` waits indefinitely). On expiry the run
  fails with `MigrationLockTimeoutError` before reading any schema.
- The lock dies with its connection: a crashed or killed migrator never strands
  it. `SessionHandle.release()` runs `pg_advisory_unlock_all()` and destroys the
  connection.
- `--dry-run` only reads and never waits. SQLite/DuckDB need no lock (no-op).
  A PostgreSQL adapter without `acquireSession()` is refused
  (`MigrationLockUnsupportedError`) rather than run unserialized.
- The maintenance-window `db:migrate-*` subcommands do not take this lock; run
  them with application migrators stopped.

## Tests

- `packages/core/src/migrations/__tests__/migration-lock.test.ts` — contract.
- `…/migration-lock-postgres.optional.test.ts` — real waits, timeout, release
  on a terminated holder backend.
- `packages/cli/src/commands/__tests__/db-migrate-concurrent-postgres.test.ts`
  — two concurrent CLI runs apply one batch; a held lock blocks a run before it
  touches schema. Each run gets its own pool (`getDatabase` caches one pool per
  identity in-process, which two real processes would not share).
