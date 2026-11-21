# `db:migrate` concurrency (#3634, #5435)

Two processes migrating one PostgreSQL database at once — two workloads that
gate startup on `db:migrate`, a rolling restart, a break-glass Job beside running
pods — used to both compare the live schema, plan the same batch, and the
second failed part way with `42701`/`42P07` "already exists" or a `40P01`
deadlock. The tracker's per-migration `running` rows cannot prevent that: they
are written after the diff, when both runs have already planned.

## Contract

- A non-dry-run `db:migrate` on PostgreSQL calls core `acquireMigrationLock()`
  right after connecting, before the system-timestamp step, tracker bootstrap,
  and schema comparison, and releases it in the handler's `finally`. Every
  other migrate entry point (core `migrateSmrtSchemas`, lazy activation, the app
  model editor) takes the same lock: see core `agents/schema-paths.md`, "The
  migration lock".
- The lock is `pg_try_advisory_lock(hashtext('smrt'), hashtext('db:migrate'))`
  (`MIGRATION_ADVISORY_LOCK_KEYS`) on a pinned `acquireSession()` connection,
  polled once a second, holding no transaction while it waits. Never change the
  keys: runs of an old and a new release must still exclude each other.
- **The whole run executes on `lock.db`**, the pinned session that holds the
  lock: planning, the batch, the concurrent-index phase and the migrate record.
  The pool handle is used only to connect and to close. So the run needs one
  connection, and when that connection ends (failover, an idle-connection
  reaper, a terminated backend) the run's next statement fails and the server
  rolls back the open transaction: the run exits 1 and the next run converges.
  `lock.assertHeld()` before applying and before the contract check reports
  `MigrationLockLostError`.
- A waiting run logs `Another db:migrate run holds the migration lock…`, then,
  once it holds the lock, compares a current schema and applies nothing.
- The wait is bounded by `migrations.postgres.migrationLockTimeout` (default
  `15min`; `ms`/`s`/`min`/`h` forms; `0` waits indefinitely), counted from the
  call and covering the checkout. On expiry the run fails with
  `MigrationLockTimeoutError` before reading any schema.
- The lock dies with its connection: a crashed or killed migrator never strands
  it. The lock session sets `idle_session_timeout = 0` (PostgreSQL 14+).
- A confirmed retirement or recompute writes its ledger row inside the batch
  transaction (`beforeCommit`), and the record after completion carries none.
- Session advisory locks need a real session: a transaction-pooling proxy
  (PgBouncer `pool_mode=transaction`) between `db:migrate` and PostgreSQL
  defeats them. Migrate through a direct or session-pooled connection.
- `--dry-run` only reads and never waits. SQLite/DuckDB need no lock (no-op).
  A PostgreSQL handle from an `@happyvertical/sql` older than
  `MIGRATION_LOCK_MINIMUM_SQL_VERSION` (no connection-affinity claim, or a
  session without `database()`/`destroy()`) is refused
  (`MigrationLockUnsupportedError`) rather than run unserialized.
- The maintenance-window `db:migrate-*` subcommands do not take this lock; run
  them with application migrators stopped.

## Tests

- `packages/core/src/migrations/__tests__/migration-lock.test.ts` — contract on
  a scripted PostgreSQL double.
- `…/migration-lock-postgres.optional.test.ts` — real waits, timeout, release
  on a terminated holder backend (and the holder's `assertHeld()` failing),
  survival under a 1s server `idle_session_timeout`.
- `packages/cli/src/commands/__tests__/db-migrate-concurrent-postgres.test.ts`
  — two concurrent CLI runs apply one batch; a held lock blocks a run before it
  touches schema. Each run gets its own pool (`getDatabase` caches one pool per
  identity in-process, which two real processes would not share).

## Index and flag details

- INVALID indexes — the stump a cancelled or timed-out
  `CREATE INDEX CONCURRENTLY` leaves, which `pg_indexes` still reports as
  present — are detected via `pg_index.indisvalid` and dropped before the
  rebuild.
- `migrations.postgres.useConcurrently: false` vetoes the flag; index DDL then
  runs inside the atomic transaction (still bounded by the timeouts).
- Without the flag, a batch containing explicit `CONCURRENTLY` DDL is rejected
  before the transaction opens — PostgreSQL cannot run it there.
