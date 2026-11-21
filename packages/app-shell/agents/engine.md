# Shared app engine (`src/engine/`)

Runs a person's own smrt app from a versioned JSON definition. The host
(`AppHost`) owns the version history (through a `VersionStore`) and the data
directory; the app itself runs in a worker thread with its own registry and
`app.db`. Every definition change starts a fresh worker (the registry only
adds) and swaps it in once it is ready. The engine must not import SvelteKit,
`$lib`, or anything under `src/lib`.

## Rules

- **Approval gate.** `RISKY_COMMANDS`, `isRiskyCommand` and `isRiskyTool` live
  in `commands.ts`. `execute` throws `ApprovalRequiredError` for a risky
  command without `approved: true`; `callAppTool` does the same for
  `<model>_delete`, and `rest` for `DELETE`. Approval carries reviewed mutation counts: the plan is recomputed inside the
  execute queue and growing load/extract/merge, calculation, field-removal or type-conversion counts require a fresh decision before writes.
- **Queue.** Work inside the change queue must call `callApp`, never `onApp`
  (which awaits the queue): the old `clean_up` deadlock.
- **Migrations** (`app-runtime.ts`) run in one transaction in the new worker,
  reading through the transaction handle. Destructive ones retire the old worker
  first and restart the old definition if the new one fails. They hold no SQL
  that names a database: column types, storage families and the few differing
  statements come from the dialect (see "Database" below). Copies, snapshots and
  publish differ per database (see "PostgreSQL copies, snapshots and publish").
- **app.db is runtime-managed.** The engine builds app.db's schema itself
  (`_app_meta.version` is its record); core's migrate never runs on it. So
  `AppRuntime.boot` declares the handle with core's
  `declareRuntimeManagedDatabase` right after its one `getDatabase` call, and
  core's production startup check does not ask app.db for a migrate record.
  Tables are still checked. Every app.db the engine touches is opened there:
  live, draft copies, publish rehearsal and the read-only report worker. Open
  app.db nowhere else; `scripts/check-runtime-managed-databases.mjs` allows the
  call only in `app-runtime.ts`; that check runs only inside this repository, so
  outside it the declaration is the app author's explicit, logged choice (core
  logs each handle's declaration once at `info`, and exports the function from
  `@happyvertical/smrt-core/migrations` only). `production-start.test.ts` boots the engine
  with `NODE_ENV=production`.
- **Column storage.** No column-type history: re-adding a field checks the real
  column's storage family. Text defaults can be `''`, so counts and archives use
  `IS NOT NULL AND <> ''`. Renames do not rewrite method code; the plan lists
  `affectedMethods`.
- **App subclass rule.** `enableRecipe('profiles')` adds the app model
  `Profile` (`extends` the shipped class). Its fields are nullable columns on
  the shipped `profiles` table (STI). Never subclass `ProfileType` (its
  subclass would get its own table). Creating a Profile find-or-creates the real
  `person` `ProfileType`.
- **Sandbox** (`sandbox.ts`): QuickJS, pure function over a copy of the data.
  Everything crossing the boundary is JSON text. Limits: time, memory, a small
  stack (128 KB), 1000 writes, 1 MB output, 8 MB input. The body is checked as a
  function body by V8 first (QuickJS's own `Function` accepts a body that closes
  the wrapper). Writes are validated and a `VACUUM INTO` snapshot is taken before
  they are applied (#5185; a dump file on PostgreSQL, #5187). Method runs are atomic and serialized per app
  (`AppRuntime.runMethod`): one method at a time; the sandbox reads each
  model (at most 1000 rows; more fails the call naming the model, never
  truncates); the data is then re-read and all writes applied in one
  transaction that rolls back on any failure, so a failed method leaves
  nothing behind and the owner has nothing to recover. If the data changed
  between the read and the write (an edit outside methods) the method re-runs
  (3 retries). The snapshot stays as a pre-write undo point (a `.db` file on SQLite, a
  `.pgdump` file on PostgreSQL; `AppHost.restoreSnapshot` puts a dump back). On a PostgreSQL SERVER the
  write transaction first takes `SHARE ROW EXCLUSIVE` on every model table
  (`dialect.writeLock`, sorted, so other connections' writes wait until it
  ends) and only then re-reads and compares; embedded databases have the one
  connection already. A write that holds another table's row lock while
  waiting on ours can deadlock: the server aborts one, the method reports
  "none applied" and can be run again.
  `setMemoryLimit` does not bound large single allocations in this build, and the
  interrupt handler is polled only every ~10,000 operations, so the WebAssembly
  heap itself is capped (`SANDBOX_HEAP_PAGES`, 128 MB): a memory bomb stops in
  ~0.2 s instead of allocating 2 GB.

## Database (#5186)

The host chooses the database; the engine assumes none. `HostOptions.database`
is a `DatabaseConfig` (`engine/db/types.ts`): `{ kind: 'sqlite' }` (the default:
`app.db` in the data directory, as the desktop always did), `{ kind: 'postgres',
schema, connection }` (a server; plain data, each worker opens its own
connection) or `{ kind: 'pglite', schema, client }` (an in-process PGlite owned
by the host thread). Everything that differs sits behind `EngineDialect`, one
pure implementation per database (`db/sqlite-dialect.ts`,
`db/postgres-dialect.ts`): column types (the PostgreSQL ones equal what core's
own DDL creates; `db-dialect.test.ts` checks every field type on both),
storage families, the `_archive` DDL, the non-empty test, text/cast forms,
NULL-safe inequality, the safe-integer read, `ddlEngine` for core's
`planRuntimeModelDDL`. Introspection is `tableColumns` (`getTableSchema`) and
`tableExists` from `@happyvertical/sql`; a PostgreSQL transaction that
introspects is opened with `{ introspection: true }` (`AppRuntime.tx`; SQLite's
`transaction` takes an internal lock as its second argument, so it gets none).
No SQL naming SQLite or PostgreSQL exists outside `engine/db/`
(`sqlite.ts` also holds the portable export's reads); `db-boundary.test.ts`
scans for it.

- **PostgreSQL layout.** One schema per app, UNQUALIFIED table names, addressed
  by a transaction-local `search_path`: `scopeDatabase` (`db/postgres.ts`)
  wraps the handle the engine and core receive, so every statement runs after
  `set_config('search_path', "<schema>", true)` in its transaction, with or
  without one of its own. Fail closed: `table()` throws, sessions and schema
  sync are absent. A config with no schema, `public`, a system schema or a
  schema the host did not create refuses to open (`EngineError` `refused`); the
  engine never creates a schema and never falls back to `public`. Core is
  untouched. The role and policies of a hosted deployment are #5188/#5189.
- **Statement timeout (#5192).** `HostOptions.workerLimits.statementTimeoutMs`
  (shell: `ShellContext.workerLimits`) makes `scopeDatabase` also run
  `set_config('statement_timeout', '<n>ms', true)` as the first statement of
  every transaction it opens (`SET LOCAL`'s effect): the server cancels any one
  statement that runs longer (57014), the transaction rolls back, the call
  rejects (its lease and worker are free again) and the pooled connection goes
  back with no setting left, so it never reaches another app. Default: none.
  SQLite has no per-statement cancel the engine could use and ignores it, so
  the desktop is unchanged. PGlite cannot cancel a statement either; only the
  real-server lane (`postgres-server.test.ts`) proves the cancel, and
  `postgres.test.ts` proves where and how it is set (a recording connection).
- **How the config reaches the worker.** `DatabaseConfig` is plain data except a
  PGlite instance, which cannot cross threads (and two instances on one
  storage corrupt it, yet a new worker boots while the old one still serves).
  So the host thread keeps the one PGlite and `AppWorker` transfers one end of
  a `MessagePort` (`db/pglite-bridge.ts`: `serveBridge` host side, a
  PGlite-shaped `client` worker side, transactions held open on the host until
  the worker ends them, rolled back if it dies). A server config is
  serialised and each worker opens its own connection. The PGlite pass is not a
  test double of the worker: it is the same worker code path.
- **Still SQLite only** (a clear `not supported on this database yet`
  `EngineError`, `requireSqlite`): the portable export and import
  (`openAppDatabase(dataDir)` opens SQLite; they refuse a host that reports
  another database).

## PostgreSQL copies, snapshots and publish (#5187)

Three operations on one schema, each its own thing; the SQL is in
`db/postgres-copy.ts` and takes explicit schema names, so it runs on a worker's
scoped handle and on a host-side admin connection (`withSchemaAdmin`, opened
for the one operation on the host thread; a PGlite uses the host's client).

- **One description, three uses.** `describeSchema` reads the catalog once
  into statements (schema, sequences, tables, keys, indexes under the source's
  names, checks, foreign keys, policies and row-level-security flags,
  comments, plain functions, owners, grants, default privileges, sequence
  positions) naming `TARGET` for the new schema. A fork runs them and copies
  rows with `INSERT ... SELECT` (identity values with `OVERRIDING SYSTEM
  VALUE`, generated columns left to the database); a dump writes them and the
  rows (every value as text, cast back to the column's type) to a file; a
  restore replays that file. The shortcut (`CREATE TABLE ... LIKE` plus
  `INSERT ... SELECT`) loses foreign keys, policies, ownership and grants,
  leaves serial defaults on the source's sequences, does not advance
  identity sequences and fails on generated columns (#5184); each of those is
  an explicit statement. Privileges are exact: an object whose source has an
  explicit ACL is reset (`REVOKE ALL ... FROM PUBLIC`) before the captured
  grants, because a recreated function is PUBLIC-executable by default; tables,
  columns, sequences, functions, the schema and default privileges are
  compared by effective ACL. Values travel as text under a fixed `DateStyle`,
  `IntervalStyle` and `bytea_output`; dumps are mode 0600. Tested by catalog comparison in
  `postgres-drafts.test.ts`. A schema holding what a copy does not carry
  (views, procedures, types, triggers, inheritance, rules) is refused, never
  copied partly. Copies read with `row_security` off: a role a policy would
  filter fails loudly instead of losing rows, so run them as the owner or a
  role that bypasses the policies.
- **Names and ownership.** A copy is `<first 44 of the app's schema>__<d|r|o|n>
  <8 hex of sha256(full schema)><8 random>` (`sideName`, at most 63 bytes); an
  app's own schema may not look like one (`assertAppSchema`). The name is only
  a filter: each copy carries `COMMENT ON SCHEMA 'smrt-side:<FULL app schema>'`
  (set in the creating transaction, moved to the aside by the swap), and
  `dropSchema` / `swapSchemas` / the sweep verify it before touching anything,
  so two apps sharing a prefix never drop each other's copies.
- **One point in time.** The scoped handle cannot set REPEATABLE READ, so a
  fork (`forkSchema`) and a dump (`dumpSchema`) first `lockForCopy`: every table
  `LOCK TABLE ... IN SHARE MODE`, sorted by name (C collation), BEFORE the first
  read (readers continue, writers wait), so no parent/child skew can reach a
  draft or an undo point. The wait is `swapLockTimeoutMs` for a fork (default 5
  s for a dump); a writer that holds on surfaces as a lock-timeout error, the
  transaction rolls back and the connection is released. The role needs UPDATE,
  DELETE or TRUNCATE on each table. Tested by statement recording (PGlite is
  one connection) plus a held-open writer on a real server.
- **One live host per app (PostgreSQL server).** Start-up recovery
  (`reconcilePgPublish`, which runs FIRST while the journal still says what was
  going on) and then the sweep drop the app's `r`/`o`/`n` schemas, which a second host's
  publish or restore would be using. So a live `AppHost.open` first claims the
  app (`claimApp`): `pg_try_advisory_lock(hashtext('smrt-app-shell'),
  hashtext(<app schema>))` on a connection of its own (`max: 1`, never
  idle-closed, never shared), held until `close()` or process end (a dropped
  connection frees it server-side), and refuses with "another host already runs
  the app" when it is taken, before touching anything. A draft host is claimed by
  its live host; PGlite and SQLite claim nothing. Tested by `app-lock.test.ts`
  (modelled lock semantics and statement recording) and, on a real server, by
  `postgres-server.test.ts`.
- **Ownership fencing (#5190).** Each PostgreSQL/PGlite app has an ownership
  generation stored in its own schema: `_app_meta` key `fence` (created at 1 by
  the first host; copied by forks and dumps, so it swaps with the data). A host
  takes ownership at start by advancing it (`acquireOwnership`, first thing in
  `boot`, before recovery and the sweep) and holds the number
  (`AppHost.fence`); every worker it starts (`WorkerDatabaseConfig.fence`)
  carries it. `scopeDatabase` reads the row `FOR SHARE` as the first statement
  of EVERY transaction (reads and writes, boot DDL included) and throws
  `StaleFenceError` (`EngineError` code `stale_fence`, HTTP 409, details
  `{ schema, expected, actual }` when raised by the host or a swap or drop; the
  copy that crosses the worker boundary carries the message only) unless it
  matches. The share lock lasts to
  commit and `swapSchemas` locks every table exclusively first, so a
  transaction either finishes before a swap or fails after it: no commit
  straddles one. The new number is written only into the new live schema, so a
  session still pointed at the renamed old schema is covered by retiring the
  workers at the swap and by the aside's revoke before its drop, not by the
  fence (residual: a session with a cached plan on an old table could write
  into the aside until the revoke). `swapSchemas` (publish, restore, start-up recovery) checks
  `expectFence` under those locks (a host that lost ownership changes nothing)
  and, in the same transaction as the rename, writes the new live data's
  generation (old + 1); the host adopts it for the workers it starts next. A
  swap that undoes this host's own swap (abort, failed restore) checks too: it
  expects the generation its own swap produced (the held one, or held + 1 when
  the swap committed but its reply was lost: the abort and the restore ask the
  catalog for the aside, not their flag), so it cannot swap over a newer owner.
  Dropping a draft's schema (`discard`, `discardIfEmpty`) passes the draft
  host's generation to `dropSchema`, which compares it under an exclusive lock
  on `_app_meta` in the drop's own transaction (`discardOrphanDraft`, for a
  directory no host holds, has none to pass). After the swap commits, the aside's table, sequence and schema
  privileges are revoked from PUBLIC and the connected role in a transaction of
  its own (`revokeSchema`) before it is dropped, so a stale plan fails with
  permission denied; the revoke runs only on a schema that will never be
  swapped back. The error crosses the worker boundary as a `stale` flag on the
  reply (`AppCallError.stale`, the boot message), and the host rethrows it as
  `StaleFenceError`; a caller must reopen the app, never retry the call.
  Two hosts on one app: on a server the advisory claim refuses the second; where
  nothing claims (PGlite) the later opener owns and the earlier one's every
  call fails stale. The desktop has one process per data directory and keeps
  its writer lease, with no generation: `fence` is `undefined`. Tested in
  `postgres-drafts.test.ts` ("ownership fencing").
- **The store in the swap, on the claim (#5470 part 1; hosted PostgreSQL
  server only).** `claimApp` returns an `AppClaim` (`db/claim.ts`): the
  connection that holds the app's session lock (`max: 1`, never idle-closed,
  `connectionTimeoutMillis: 0`). EVERY `claim.transaction` first sets
  `lock_timeout`/`statement_timeout`/`idle_in_transaction_session_timeout`
  (5 s / 10 s / 10 s, `HostOptions.claimOptions`) and PROVES, inside itself,
  that its own session holds the lock (`pg_locks` row with
  `pid = pg_backend_pid()`); a missing row is a `ClaimLostError`
  (`stale_fence`, `resource: 'claim'`), the claim is lost for good (`onLost`,
  the host retires its worker and every call refuses, the shell must reopen)
  and nothing is written. A lock ends only by unlock or the session ending, and
  a transaction cannot commit after its session ended, so whatever committed
  there ran wholly under the claim and no takeover can have committed in
  between. The pool reconnects silently WITHOUT the lock after a terminated
  session, which is why the proof is per transaction. A heartbeat (every 5 s) is
  one proof-only claim transaction. A nested `claim.transaction` throws.
  Publish and snapshot restore run `swapSchemas` on the claim with a `within`
  callback: `VersionStore.commitIn(tx, records, current, expected)` (the shell's
  `ShellVersionStore`) inserts the versions and moves the `App` row only
  `WHERE current_version = expected`, so a stale store (`StaleStoreError`,
  `resource: 'store'`) rolls the swap back too; a publish's draft `published`
  mark rides in it. A live host with a claim refuses to open if its store has no
  `commitIn`, or if the claim cannot see the store's own `App` row (another
  database); `HostOptions.allowUnfencedStore` is the test opt-out.
  Publish order (G = generation, S = store): journal (`atomic`, `id`, `draftId`,
  `numbers`) -> T (proof, swap, `commitIn(final, expected old)`; G+1, S final)
  -> spawn the new worker -> readiness record (`_app_meta` `published` = journal
  id, an upsert) -> mark the journal, drop the aside. A failed spawn, or a
  refused readiness record with the claim proven, runs T': swap back,
  `commitIn([], old, expected final)` and the draft reopened
  (`UPDATE ... WHERE status='published' AND published_versions = <journal
  numbers>`), in one transaction. The records T wrote stay as never-current
  history so version numbers stay unique. Boot, all on the claim and in this
  order: claim, store guard, ownership bump, reconcile, re-read
  `store.current()` (a boot T' moves it), sweep, spawn. An `atomic` journal is
  recovered from the catalog, never from `committed` or the store's current
  version: aside absent -> drop staging; aside present and readiness record =
  journal id -> forward (drop the aside; this also fixes a published-then-undone
  restart that used to swap the old data back); aside present and no record ->
  the new worker was never served: start the store's current version, and if it
  starts write the record and drop the aside, otherwise run T' (draft reopened
  from the journal) and open the old version. A journal without `atomic`
  (older, or a host without a claim) keeps `publishHappened`. Snapshot restore:
  T_r is the swap plus `commitIn([], v, v)` (a compare-only pointer write); a
  failed spawn swaps back with the same compare. Tested in
  `store-in-swap.test.ts` (registered; PGlite with a stand-in claim, and on a
  server the tests marked [S]: a terminated claim, a delayed commit after a
  takeover, the heartbeat, a claim lost right after it was taken) and
  `claim.test.ts`.
  **Unfenced in #5470 part 1** (hosted PostgreSQL; follow-up: #5486):
  - Change and undo store writes (`append`/`setCurrent` after a migration):
    unconditional, on the store pool, no claim proof. A host that loses its
    claim after its worker's migration can still record the version after the
    next host has read the store.
  - Every `DraftVersionStore` write, and a draft host's boot, ownership bump
    and schema drops (admin connections, no claim). The draft's own generation
    still guards its schema.
  - `adoptDraft`'s draft-row writes (starting/extra open -> discarded).
  - The publish journal file (local data directory).
  - `markPurged`; snapshot and rehearsal files.
  - Fork and restore schema creation on admin connections (at worst a leaked
    side schema, removed by the sweep).
  - Portable import's `populate` (claim never proven; unchanged from today).
- **Fork** (a draft, a publish rehearsal): a live schema beside the app's, in one transaction (a
  failure leaves none). `forkDraft` writes the name in the draft marker
  (`schema`, `liveSchema`); `AppHost.open` on that directory takes the live app's database
  config and uses the marker's schema. `discard` drops it (a failure keeps
  the marker, so it can be retried); `discardOrphanDraft(dir, database)` does
  the same for a directory no host holds.
- **Snapshot** (undo points, `.pgdump` in `snapshots/`, same retention as
  `.db`): restore-only, adds no table. `AppHost.restoreSnapshot(name)` builds
  the dump as a side schema, retires the worker, swaps it in and starts a
  new worker; the data it replaces is first kept as its own snapshot
  (`migrate-before-restore`), so a restore can be undone by another. Only a
  snapshot taken at the app's current version restores (the definition and the
  tables must agree); undo to that version first. SQLite's snapshot is a file
  the owner copies back by hand and `restoreSnapshot` refuses it.
- **Publish.** Same stages as SQLite. The rehearsal is a forked schema the
  replay workers run on (`CopyPlace.database`); the swap is ONE transaction
  (`swapSchemas`): every table of both schemas is locked `ACCESS EXCLUSIVE`
  (waiting at most `swapLockTimeoutMs`, default 5 s), live is renamed to an
  aside, the rehearsal to live. The definition version lives in the schema's
  `_app_meta`, so it swaps with the data. A session still using the old tables
  makes the swap fail and change nothing; the worker is retired first, and
  the aside is dropped only after the store has the versions, and only after
  the journal is rewritten with `committed: true` (so a failed drop plus the
  owner's next edit cannot make the next start read "store past the published
  version" as "publish did not happen"). The journal
  carries `pg: { schema, staging, aside }`: at start `reconcilePgPublish`
  swaps the aside back (journal not committed and store behind) or drops it
  (journal committed, or store at or past the published version:
  `publishHappened`, shared with SQLite's `reconcilePublish`), before the app
  opens. A version past `finalVersion` can only be numbered after the
  publish's store commit, so it proves the publish even if the `committed`
  rewrite failed (disk full); that failure is added to `host.notices`, the old
  data stays, and the next start removes it. A failure after the swap (respawn, store)
  swaps back. Leftover side schemas of a crash before the journal are named
  `<schema>__<tag>...` and safe to drop. The unfinished part: the version
  store (the shell's tables) is a different database from the app's, so a
  crash between the swap and the store write is recovered by the journal, not
  by one transaction.
- **Tests.** `pnpm test:pglite` (`vitest.pglite.config.ts`) runs the engine
  suite with `SMRT_APP_SHELL_DB=pglite`: each data directory gets its own
  PGlite in schema `app` (`db/harness.ts`, injected by `pglite-setup.ts`; a
  shipped host is always told its database, default SQLite). Files that read `app.db` with
  `node:sqlite` or exercise snapshots, drafts or publish are excluded there
  (the list is in the config, with the reason); they run on SQLite as before.
  `postgres.test.ts` always runs on PGlite: two apps' schemas stay apart
  through records, REST and tools, an app with no schema fails loudly, and no
  member of the adapter handle reaches the database unscoped.
  `postgres-engine.test.ts` walks migrations, loads (upsert over every field
  type, undo, refused undo), merge, extract, methods and reports on PGlite.
  **Coverage on PostgreSQL is partial**: 25 files, 202 tests, against 41
  files and 383 tests on SQLite; the excluded files are listed with their
  reason in `vitest.pglite.config.ts`.
  `postgres-server.test.ts` and `postgres-drafts.test.ts` are the registered
  `test:postgres` suites (`vitest.postgres.config.ts`; the "Registered
  PostgreSQL Suites" lane, `scripts/run-with-ci-postgres.mjs`); the default and
  PGlite configs exclude them, so each runs once on PGlite. `postgres-drafts`
  covers the copy (keys, identity and serial sequences, generated columns,
  policies, ownership, grants, index names), drafts, publish and a failure at
  every stage, the journal's recovery, snapshot restore, two apps staying
  apart, and (server only) a session holding the old tables stopping the swap.
  `postgres-server.test.ts`:
  open, write, migrate and restart a user app, two apps' isolation, integer,
  money and boolean keys in a data load, and the archive round trip per field
  type (removeField and removeModel, then undo).
  It always runs on PGlite and
  also on a real server when `SMRT_TEST_POSTGRES_URL` is set (a server returns
  BIGINT as digits; PGlite returns numbers). It creates and drops its own
  schemas; run it locally with `pnpm test:postgres` and
  `CI_POSTGRES_BASE_URL` pointing at a server you started.
  `postgres-claim-connection.test.ts` (registered too) checks what #5470 rests
  on, on a connection opened like `claimApp`'s: it reaches the shell's tables
  unqualified as the same role and writes them and an app schema in one
  transaction; the session advisory lock survives a transaction, COMMIT,
  ROLLBACK and a refused COMMIT on it (both on PGlite too); and (server only)
  no other session can take it meanwhile, while a dropped session frees it and
  the pool reconnects on a session without it.
  Whole numbers (integer, money) outside +/-9007199254740991 cannot be read
  back exactly, so they are refused at write time (`coerceValue`: create,
  update, record loads, field conversion, method writes) and, for a value that
  got in some other way, on read (`AppRuntime.unsafeRead`: the error names the
  app, model, field and record ids). Never rounded.
  Core keys state on `db.client` and detects the adapter by its
  `query`/`exec`: the scoped handle shows a stand-in client with those two,
  scoped, never the real one.

## Profile subclass (core gap fixed, #4871)

The app subclass of the shipped `Profile` is registered as
`@local/app:Profile`, the same class name as its parent. Core keeps the two
apart: `registerRuntimeModel` leaves a same-named parent registered (constructor
index, no lineage replacement), and the parent's generated REST and MCP
surfaces are closed with `ObjectRegistry.registerOverride(parent, { api: false,
mcp: false })` in `AppRuntime.register`, so only the subclass's tools exist.
Covered by core's `runtime-model.test.ts` and engine `profile-subclass.test.ts`.

## Safety rules added in review

- **Undo is gated when it overwrites data.** `undo` is not in `RISKY_COMMANDS`;
  the host decides from the *stored* version (`analyseUndo`): a version with a
  `convertColumn` step restores each row's archived original on the way back,
  replacing values written since, so the plan is `risky` with a read-only
  `countOverwrites` preview (`replaced`, `fields[]`). Every other undo stays
  immediate. The shell pins the approval to that version (`undo.version`); the
  host refuses if the app moved on.
- **REST surface.** `restRouteAllowed` (definition.ts) lets only
  `/api/<route>` and `/api/<route>/<id|action>` of the app's own models through,
  in `AppHost.rest` and `AppRuntime.rest`. Core's reserved `sync/apply` (its
  `delete` op deletes records), `_changes`/`_events`/`_inference` and the
  registry fallback to shipped classes (e.g. `ProfileType`) are 404 before the
  DELETE gate. `DELETE` on an allowed route still needs approval.
- **Snapshot retention** (`snapshots.ts`): the worker keeps the newest 20
  `method-*` snapshots after each new one; `cleanUp` removes `migrate-*` and
  `schema-*` snapshots older than the newest change it purges. Only plain files
  matching the engine's own name pattern in `snapshots/` are ever deleted
  (never symlinks, directories or other files).
- **importTemplate preview** lists every method (model, name, description,
  params, code), so what the owner approves is what is shown; a template with
  more than 200,000 characters of method code is refused as unreviewable.

## Drafts (draft then publish)

A draft is a second `AppHost` over a COPY of the live data in its own
directory; publishing replays its changes onto the live data. The engine side
is documented here; the shell's tables, approvals and UI sit on top. The text
below describes the SQLite files; on PostgreSQL the same operations work on
schemas (see "PostgreSQL copies, snapshots and publish"), with the same
stages, refusals, digest and version numbering.

- **Frozen host.** `HostOptions.frozen` / `host.setFrozen(bool)`: `plan` and
  `execute` of every command in `STRUCTURAL_COMMANDS` (all but
  `exportTemplate`, incl. `undo`, `cleanUp`, `importTemplate`) throw
  `EngineError('refused')`; an unknown command type counts as structural.
  `STRUCTURAL_COMMANDS` is a total `Record<CommandType, boolean>`, so a new
  command must pick a side. Records, reports, the app's tools and REST keep
  working. The shell freezes the live host while a draft is open.
- **`autoApprove`** (risky commands, `_delete` tools, REST `DELETE`) is read
  once at construction into a `#private` field: no setter. `AppHost.open`
  refuses it unless the directory holds the engine's draft marker
  (`.smrt-draft.json`, written only by `forkDraft`) naming a different live
  directory. A live directory never has a marker.
- **`live.forkDraft(draftDir, { store })`** (queue, calls drained): worker op
  `copyTo(path)` is `VACUUM INTO` (one consistent state, no -wal/-shm needed).
  The call creates `draftDir` (must not exist, must not be/contain/lie inside
  live), copies `app.db`, writes the marker, seeds the EMPTY draft store with
  a copy of live's current record (the draft's BASE, same version number; not
  a draft version) and returns a draft host (`host.draft` is the marker,
  `autoApprove` on). Failure removes only the directory it just created. A
  draft can neither fork nor `undo` below its base. Draft versions are
  numbered `maxVersion + 1` in the draft store. `draft.discard()` closes the
  host and deletes its directory, only if it holds the marker, is not a symlink
  and does not contain the live directory (`discardDraftDirectory(dir)` does the
  same for an orphan). A restart reopens a draft with
  `AppHost.open(dir, { store, autoApprove: true })`.
- **Publish** (`publish.ts` helpers, `host.ts` orchestration). `live.previewPublish(draft)`
  returns a `PublishPreview`: per-version steps and SQL, definition diff, archive
  counts and EVERY method in full, from a rehearsal on a fresh copy of the CURRENT
  live data (live only waits while the copy is taken); `digest` pins the draft's
  chain and every replayed load/extract/merge count; each version exposes
  `dataSteps` from that sequential rehearsal. A changed count at apply requires
  a fresh preview before any live swap. `live.publishDraft(draft, { author, approved: true, expect: digest, draftName? })`
  refuses without `approved`, without the digest, if the chain or the app it
  started from changed, or if a `.prepublish` file is lying around. Inside the
  queue, calls drained: copy live, replay each draft version in order (one short
  worker per version, its stored definition and steps, the number it will get in
  live; so add-then-rename works; a migration runs only at worker boot, so one
  boot per version is inherent, but the previews of a data step (`previewLoad`,
  `previewExtract`, `previewMerge`) run on the PREVIOUS version's worker, which
  already holds that definition and data, not on a second worker, #5222), write the result as ONE file (`VACUUM INTO`),
  copy the old data to `snapshots/<ts>-0-migrate-prepublish.db`, write
  `publish-journal.json`, retire the live worker, rename `app.db` (+ `-wal`,
  `-shm`, `-journal`; main file last) to `<name>.prepublish`, rename the new file
  in, start the worker, write the versions to the store, then remove journal,
  asides and rehearsal. The versions are N ordinary live versions numbered after
  the store's HIGHEST (live may sit on an undone branch), parent-chained,
  summaries tagged `[draft: name] ...`; archives are keyed by those numbers so
  `undo` works. Direct draft record edits are not carried; draft data commands replay on live. Any failure before the store is
  written renames the asides back (live's `app.db` is byte-for-byte what it
  was, same version) and restarts the old app; `onStage` lets tests fail each
  stage. Use a store with the optional atomic `commit(records, current)`; without
  it a failure mid-append leaves unreachable orphan versions. The queue is held
  until then, so nothing writes to the new file before the commit.
- **Boot reconcile** (`reconcilePublish`, every `AppHost.open`, before the app
  starts; result in `host.recovery`): a journal marked `committed` (rewritten
  once the store has the versions, before the aside goes) or whose
  `finalVersion` the store has reached or passed only needs its leftovers removed; any
  other journal is ROLLED
  BACK (asides restored, the new file removed), not forward: nothing could have
  written to the new file, and the draft stays open to publish again. An
  unreadable journal refuses to start rather than guess. Stray
  `publish-rehearsal-*` directories are removed.
- **`undoTo`** is a command (`{ type: 'undoTo', version, from? }`, structural, so
  frozen hosts refuse it): the same step as `undo` repeated newest first for
  every version after `version` on the current path, one plan, one decision.
  It is `risky` (approval) when any of them has a `convertColumn` step, with the
  summed `countOverwrites` preview; a purged version in the span refuses it
  before anything changes. Each step is its own consistent state, so a failure
  part-way leaves the app at the version reached and the error says
  "undid k of n". `from` pins the current version as `undo`'s pin does.
- **Undo over a re-added name.** Undoing an add or a define keeps its column or
  table (data is never dropped by an undo). So when a removal is undone after
  the same field or model was added again, the archived values go back into the
  column that is there, and an EMPTY table of the model's name is dropped so the
  archived table (with its rows) can return; a table holding rows is never
  dropped and the undo stops with the database's own message.
- **Queued calls.** `onApp` (records, tools, REST) waits until the change queue
  is idle and stable, then runs in the same synchronous step; it counts
  in-flight calls so a change can wait for them (needed for consistent copies).

## Portable export (#5193)

`portable-export.ts`: `exportUserApp({ dataDir, versions, database? })`,
`importUserApp`, `verifyUserApp`, `inspectUserApp`, `checkUserAppBundle`,
`digestVersionHistory`. Not `exportTemplate`: every table of the app's database
(including `_archive`, the `_smrt_*` tables and tables archived for undo) travels
with every stored column and row (hidden fields, timestamps), the current
definition and the caller's version history (the shell passes its
`app_versions`), with SHA-256 digests. SQLite (`<dataDir>/app.db`, opened only
through `openAppDatabase`) and PostgreSQL (`database`: the host's own
`DatabaseConfig`, so the schema comes from the host, never from a bundle) share
one bundle (`format: 2`), so a desktop app moves to a hosted one and back.

- **Values, never SQL.** A bundle holds typed column descriptors
  (`family`: integer, real, boolean, date, json, bytes, text) and values; table
  and column names must be plain identifiers; nothing of a bundle is executed.
  The target's tables come from the definition (the engine starts on the empty
  target at the bundle's version, as on any start); a column the engine does not
  build (a hidden field keeps its column and data) and a table the definition no
  longer names (archived for undo) are added from the descriptors with the
  database's own types. Values are read as the database's text and cast back to
  the target column's own type. SQL per database lives in `db/sqlite-portable.ts`
  and `db/postgres-portable.ts` behind `PortableDb` (`db/portable.ts`).
- **Digests do not depend on the database.** A boolean is 0/1, a date is its UTC
  instant, JSON is key-sorted, bytes are base64; an integer past 2^53 is REFUSED
  at export (a server pool returns BIGINT as digits and a digest over a rounded
  value would call different rows equal). The SQLite export and the PostgreSQL
  export of the same app have the same `digest`. Indexes and constraints of an
  archived table are not carried (only its columns and rows), nor are PostgreSQL
  draft side schemas.
- **Import is idempotent and resumable.** SQLite: builds `<dataDir>.import-<digest>`,
  starts the engine on it, fills it, verifies counts and digests, then renames
  `app.db` into place. PostgreSQL: the engine builds the empty tables in the
  host's schema (which the host provisioned, empty or holding only the empty
  tables of an interrupted import), then ONE transaction (holding the app claim)
  inserts every row, advances the `_archive` identity and verifies counts and
  digests BEFORE it commits; a crash leaves nothing to clean up and a rerun fills
  it. A target that matches is `already-imported`; any other data is refused,
  never overwritten.
- **Approvals and drafts in a move.** Not carried: the caller (the CLI) refuses an
  export while changes wait (a working copy open, or a batch with an active card)
  and drops approvals still waiting (`pending`/`accepted`/`executing`), reporting
  the count; decided approvals stay as history. The version history is not
  written by import: it rides in the caller's own tables, and the engine reads it
  from the store when the app starts.
- **Hosted placement.** `importUserApp({ database })` installs into the schema the
  host chose for ONE tenant's app.
  Receiving a bundle over the network and mapping it to a tenant needs the
  caller hand-off (#5188), so it is not wired here. The CLI's use is in
  `packages/cli/agents/app-commands.md`.
- Tests: `portable-export.test.ts` (SQLite) and
  `portable-export-postgres.test.ts` (registered `test:postgres` suite: SQLite to
  PostgreSQL and back with undo, idempotence, interrupted import, tenant
  schema, 2^53 refusal; PGlite always, a server when `SMRT_TEST_POSTGRES_URL`).

## Lessons

- A worker must not be terminated while `@happyvertical/sql`'s startup HMAC key
  job is pending (Node aborts the process); `app-worker.ts` settles it before
  reporting ready.
- If V8 overflows its own stack inside WebAssembly, QuickJS cannot recover; the
  small QuickJS stack limit keeps its error first, and a host-level failure
  discards the WASM module instance.

## Worker footprint (#5183)

Resident size added per app worker (RSS from `ps`, macOS, Node 26.8.1, SQLite;
ratios, not Linux targets; at 1 worker the host's own share is included), at
1 / 4 / 8 workers: origin/main 153 / 98 / 90 MiB; with items below, unbundled
114 / 68 / 59 (-34% at 8); bundled 81 / 50 / 45 (-50%).

- **Young generation cap (#5212).** `AppWorker` passes `resourceLimits` from
  `HostOptions.workerLimits` (`{ youngMb, oldMb }`; shell:
  `ShellContext.workerLimits`), default `DEFAULT_WORKER_LIMITS` = 16 MiB young,
  512 MiB old; `youngMb: null` restores V8's own (about 48 MiB committed).
  Cost (150 sequential creates, then 30 lists of 400 rows, best of 3 runs,
  median of 7 processes): 16 MiB writes +14%, reads +1%; 8 MiB writes about 2x;
  4 MiB writes about 2x, reads +20% (and 85 vs 153 MiB at 1 worker). Hence 16
  for the desktop; a hosted profile that values memory over write latency may
  pass 4-8. A bundled worker's heap is smaller, so the cap barely moves it.
- **Split worker bundle (#5213).** `tools/bundle-worker.mjs` (esbuild, part of
  `pnpm build`, after `tsc`) writes `worker-bundle/app-worker.js` + chunks (package root, gitignored).
  Opt-in: a host passes `workerUrl` (`bundledWorkerUrl()` finds it) or sets
  `SMRT_APP_SHELL_WORKER=bundle` (engine default and shell; a configured
  `workerUrl` wins; refused if the bundle is not built). Unbundled stays the
  default. The 22 MiB output sits outside `dist/` so it is not in the published
  tarball (a local registry refused it with 413); a host builds it from the
  repo with the package build (`pnpm --filter @happyvertical/smrt-app-shell build`,
  or `node tools/bundle-worker.mjs` after `tsc -p tsconfig.lib.json`).
  `worker-bundle.test.ts` rebuilds it, opens a host in bundle mode, writes and
  reads, and checks the worker thread loaded only bundle files. Rules: NO identifier minification (smrt claims tables by class name;
  `keepNames` also stops the bundler renaming a colliding class); `libsql`
  (native, so a direct dependency here), DuckDB, and `quickjs-emscripten` (its
  `.wasm` sits beside its glue code) stay external and resolve from the
  package, so the bundle must stay inside the package. The whole engine suite runs
  on it: `pnpm test:bundled-worker`. First wake (open, define, create, list):
  about 390 ms unbundled, 237 ms bundled. `NODE_COMPILE_CACHE`: bundled warm
  wake 237 -> 195 ms for +2-5 MiB per worker. Decision: set it for HOSTED
  (replicas wake often; point it at a writable directory kept across restarts,
  shared by the replicas of one build), NEVER for the desktop (one long-lived
  process, the saving is one wake, the memory is paid per worker). The engine
  does not set it; it is the process environment's.
- **Reports load on report paths only (#5214).** The app worker imports
  `@happyvertical/smrt-reports` only to compile a definition's reports at boot
  (an app with none never does), run one, or classify a `runReport` error
  (`reports.ts`, `app-worker.ts`, `worker-handle.ts` import it on demand).
  `definition.ts` loads it for `validate` everywhere except the app worker
  (`workerData.appWorker`), which never validates. `worker-loads.test.ts` runs a
  worker under a module-load recorder (`test-support/load-recorder.mjs`) and
  fails if reads and writes load it. Measured about -10 MiB per worker at 8
  (more than the 3 MiB of source it holds, via what it pulls in); a worker
  serving a first report takes about the same (195 vs 200 ms: the report read
  worker pays the import it used to pay at start). Other rare paths (bulk
  load, extract, merge, sandbox, publish) were measured and left alone: the
  worker loads 13 engine modules of 143 KiB in all, of which those four are
  about 50 KiB of source; publish, import and portable export are not in the
  worker's graph. The remaining weight is core's 290 modules (3.9 MB).

## Calculated fields (#4916)

`FieldDef.calculated` uses core's `GeneratedExpression` (SQL SDK operand data).
`addField` and `setCalculation` validate through `runtimeModelEntry` at plan
time; hidden inputs and generated-to-generated references are rejected by core.
SQLite owns the VIRTUAL column. Writes use the common coercer and generated core
record commands explicitly refuse calculated inputs with typed EngineError (invalid); generated REST/MCP surfaces instead drop them like readonly inputs, allowing whole-record round trips. `setCalculation` requires approval for conversion, replacement and clearing and replaces the column transactionally;
clearing materializes current calculated values into a writable column. Undoing the clear refuses if writable values differ from that materialized snapshot (including populated rows created later), so it never discards later edits. Converting a writable field archives
its originals and is risky. Undo restores those originals or the old expression. Calculation archives encode JavaScript numbers directly, preserving finite double precision.
Renames rewrite expressions; hide/remove/type change refuse named dependents.
Changing a calculated field's type replaces its generated column directly and
validates the expression against the new type, without archiving derived values.
`titleField` optionally names the record label, with first visible text as fallback.
The expression grammar includes SDK 0.112.3 conditional, numeric, text and
calendar functions and typed date-only literals. All are display-only in
`src/engine/formula.ts`; evaluation stays in the database. Engine `date` fields
map to core datetime. Any expression referencing those fields, or containing a
datetime literal, is temporarily refused at plan time on every dialect
(sdk#1516). Date-only literal calendar expressions remain usable for integer/text results. Date outputs are temporarily refused too: core requires an immutable datetime result, while date-only literals and addDays produce date values. Reference and
lookup/title keys cannot be calculated; bulk upsert keys must remain writable. Reference walks include
all nested function arguments and conditional branches. Regression suites:
`portable-calculations.test.ts` and `keyword-fields.test.ts` (all eight SQL
keyword field names across CRUD, bulk loads, reports and calculations).
Test design and required validation: [engine-4916-tests.md](engine-4916-tests.md).

## Definition reports (#4916)

`reports?: Record<string, { label?, description?, spec: RuntimeReportSpec }>`
is additive format 1 data, never the RuntimeReport table. `defineReport`,
`renameReport`, `removeReport` are structural commands. Defining compiles with
smrt-reports against the app's own visible fields; boot revalidates saved specs.
`removeReport` requires approval; `renameReport` is immediate. Renames rewrite field references; destructive field changes list report dependents.
`host.runReport(nameOrSpec, { maxRows?, timeoutMs? })` works frozen or in drafts.
The SQL compiler/runner supplies bounded aggregates on app.db, tenantId null.
Defaults: 1000 rows, 5000 ms; allowed ceilings: 1000 rows, 10000 ms. A dedicated
read worker is terminated on query timeout, without killing the app worker.
Columns preserve the compiler's money/date hints: counts stay unitless, while
sum/min/max/avg keep source units. Choice hints are added from the definition.
Reference dimension columns add
`reference` and `labelColumn`; rows carry that label next to the original id,
resolved in one query per target model, using titleField or first visible text.
The server catalog's engine-tools adapter calls the same owner check and builder
path; app_runreport names the records target, builder commands the structure target.

Assistant `app_runreport` spells filter comparisons the grammar's way before
parsing (`!=`, `<>`, `neq`, `not_equal` become `ne`; the advertised op list comes
from `RUNTIME_REPORT_FILTER_OPS`). A rejected spec keeps its parser reason across
the worker boundary (`reportError.reason`, `invalid_spec` only) so the model can
correct it; the catalog's `report_failure.summary` is the owner's fixed plain
sentence (`reportFailureForOwner`), `error` the model-facing detail (#5172).

## Atomic bulk loads (#4916)

`loadRecords { model, rows, mode: 'insert'|'upsert', key?, references? }`
is structural. Upsert requires visible writable key fields; all modes, including insert and upserts without updates,
require approval outside a draft. Apply re-prepares inside the migration transaction and refuses if updates exceed the reviewed count; callers must plan again. Draft publish prepares fresh bounds in its rehearsal over current live data and pins their counts to the reviewed publish digest. `references[field] = { model, by }`
resolves lookup values with one query per target model. The dry-run preview
returns insert/update/unchanged/rejected counts and up to 100 zero-based row,
field, reason problems, never whole rows. Rejected input refuses the plan with bounded row/field reasons before approval, and refuses the entire load.
All data-command undo journals (load, extract and merge) are capped at 10,000 affected rows and 8 MiB of stored JSON. Preparation refuses oversized source journals; a final check inside the migration transaction includes postimages and rolls back the whole command on overflow. Input fields, upsert keys, lookup keys and merge selectors must name own visible
fields; inherited object keys receive the same typed refusal as unknown fields.
Bounds: 10,000 rows and 8 MiB total JSON command data per call. Calculated input is refused.
Preparation uses the record coercer, then collection writes use bounded
100-record SDK savepoint scopes inside the one migration transaction. Releasing
a savepoint never commits the outer transaction; a later-batch failure rolls
back all earlier batches and archives. Each scope uses core
`withCallerOwnedDatabaseTransaction` so record hooks and validation stay intact.
Load planning reads affected originals and `pragma_table_xinfo` metadata, without
copying a database or writing records, archives, files or SDK defaults. Preparation
and apply share the exact JSON serializer and UTF-8 byte arithmetic: each load
postimage is `{ $load: 1, hashes: { column: SHA256-base64 } }`. Digests have fixed
44-byte values even when SDK slugs, defaults, timestamps, save hooks or generated
columns have unpredictable contents. Inserts protect every stored column; updates
exclude generated columns and restore only columns whose before/after digests
differ. Command inputs retain their independent 8 MiB bound. Apply verifies the
persisted journal byte total agrees with preparation, inside the same transaction.
Planning still builds the existing upsert and reference lookup maps from their
model rows; its read cost is proportional to those models, not the entire database.
Original raw rows (including nulls and timestamps), inserted ids and the versioned
postimages are journaled in `_archive` for undo. Legacy full-value postimages remain
readable. Undo restores only the columns changed by the command, preserving later edits to other fields. Changed command-owned columns, user-deleted rows, edited command-created records, and reused removed ids refuse undo transactionally, even with approval. Older row journals without postimages refuse rather than overwrite data. Every load has a
pre-migration snapshot and stable per-command ids, so draft publish replays the
load against current live keys and lookup data rather than copying draft rows.
Undo of a data migration requires approval; its preview names affected fields, removals and recreations.
Undo plans reuse the down migration’s row/reference/calculation guards in a read-only
preflight against the destination definition. Known conflicts appear as `preview.refusal`;
they never relax the fresh guards inside apply’s transaction. `undoTo` preflights
its first pending step; subsequent steps are checked against the state reached during apply.
Load undo refuses surviving references to its inserted rows (including hidden
references), preserving all rows and the current version on refusal. The shared
load/extraction guard scans each reference field once against the set of created
ids, rather than rescanning its table for every inserted row. Refusals name up to ten surviving referring records with human-readable model, field and record labels.

## Extracting a column (#4916)

`extractModel { model, field, into, titleField?, normalize? }` is structural and
risky: text/choice values become references, originals remain archived for undo.
A new target has a required text title field (`name` by default); an existing
target matches its titleField or first visible text. Exact matching is default;
`normalize: true` trims and compares case-insensitively. The preview reports
rows/distinct/folded/create/matched counts. Empty strings (and whitespace-only strings with normalization) become null references; undo restores their exact original text. Null values remain null. Ambiguous existing labels refuse the command. Undo restores originals
and deletes only created target rows, refusing surviving references (including
hidden references) added since extraction. Source references written after extraction also refuse undo, including references to pre-existing targets, so ids never become text. Publish extracts current live values.

## Merging records (#4916)

`mergeRecords { model, keep, merge: ids[], fields?: { [field]: 'keep' | id } }`
is structural and always risky (1–1000 distinct merged ids). The plan lists
reference counts by app model, including hidden reference fields. Every reference
to a removed id is repointed to keep; chosen writable values survive on keep.
Raw originals and changed-column postimages are archived before updates/removals. Undo
restores only changed columns and merged-away records; later deletions of merge source rows or conflicting edits refuse the whole undo. Referring records deleted later stay deleted and are skipped; undo returns `skipped` and includes that count in its summary (also aggregated by `undoTo`). A removed id reused since the merge also refuses. Draft publish
recomputes affected references on current live data. No arbitrary SQL is accepted.

## Workbook target (#5034)

`createEngineImportTarget(draft)` uses replayable data commands and the shared
spreadsheet contract. Names reverse through the retained plan. Temporary source
row/lookup fields are hidden by `seal()` before the workflow releases its draft
hold; source-row read-back remains bounded through `readStoredRows` (engine-only,
no tool surface). Preflight refuses unsupported calculations before loading.
The 10,000-row fixture rehearses publishing all 500-row command versions under
unchanged journal caps. See [imports](imports.md). `defineModel.titleField`
preserves the workbook's explicit display field.

## ChangeEngine (changes waiting, #5178)

`change-engine.ts`: the interface the shell's batch service talks to, and
`SqliteChangeEngine` (`createSqliteChangeEngine()`) over `forkDraft` /
`previewPublish` / `publishDraft` / `undoTo`. Every method takes a `principal`
(#5188) and an optional `fence` (#5190), unused on SQLite. Hosts are passed in.

- `rebuild(principal, live, { draftDir, store, commands: {key, command}[], author, signal? })`:
  fresh fork, commands replayed in order. A command that no longer applies gets
  a `depends_on_removed` blocker and the rest still replay. Live is only read;
  an abort or fatal error discards the new copy. The caller discards the old copy.
- `checkBatch(principal, live, draft)`: blockers `base_moved`, `replay_failed`,
  `report_uses_removed_field`, `same_field_twice` (`findChainBlockers`, from
  versions and steps); overwrite counts (`recordsUpdated`, `recordsMerged`,
  archived values) are shown only, never blocking; `engineDigest` is the
  rehearsal's `replayDigest` (what `publishDraft` takes as `expect`);
  `reviewDigest` is what the owner's review pins: the chain plus ONLY the
  overwrite figures (load `update`, merge `removed`), so live rows that
  overwrite nothing do not move it; `batchDigest(reviewDigest, cards)` adds the
  cards. Blockers carry plain-words messages and `versions` (the working copy's
  version numbers) so the caller can name the owning cards.
- `undoBatch(principal, live, { versions, author })`: `undoTo` the parent of the
  first applied version. Never restores the pre-apply snapshot, so records added
  after Apply stay and archived values come back. Live must not be frozen.
