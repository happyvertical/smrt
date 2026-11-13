# `db:migrate` is all or nothing (#4927)

Migrate works out every change before it writes anything. If any change stops,
it applies none. This is the default and the only behavior. Fix the stop, then
rerun the full migration.

The policy lives in core's `migrations/change-kinds.ts` (`SCHEMA_CHANGE_KINDS`).
Each kind says apply, report, or stop. Data stops say which `table.column` would
lose or invent data and why. The table also records unresolved engine or adapter
limits. Those still stop a run. Reports never stop a run, even warning reports.

The refusal lists every stop, its reason, and available repair SQL. Under
`Held back (nothing was applied)` it lists every new table and every apply
change. Unrelated columns and indexes stay held back too. Tracker bootstrap,
system timestamp conversion, `--repair-data`, and the successful migrate record
are skipped. A PostgreSQL session advisory lock can be taken while planning;
it writes no table rows. `--dry-run` prints the same refusal and exits 1.

On every engine the run is the same (#4937). SQLite and DuckDB rebuild a table
where they have no `ALTER` for the change, inside the same transaction; the
list of what still differs, with reasons, is in core's `schema-paths.md` under
"The three engines apply the same kinds".

An ordinary run applies one atomic transaction batch. A failure in a later
statement rolls back the earlier changes and tracker rows too.

## Missing packages (#4928)

Migrate compares the packages that own tables in the app's build (its project
manifest) with the last successful migrate record, so the CLI, an in-app
`migrateSmrtSchemas`, a dev install and a production install compare the same
list. Every package seen last time must still be in the build. A missing package may have
declared required columns. Without it, migrate could loosen those columns and
let empty rows in. This stops the whole run before any write. The output names
each unconfirmed missing package and lists every held-back change.

If a package was removed on purpose, pass `--confirm-removed-package <name>`.
Repeat the flag for each removed package. One confirmation cannot clear another
package's stop. Names match the record exactly: `@scope/pkg`, app scopes, and
`<unqualified>` for classes with no package. Quote `<unqualified>` in a shell.
A confirmation for a package that is not missing prints an ignored notice.
Added packages are fine.

An older or first-run database has no earlier record. Migrate prints that the
package comparison was skipped and that a record will be written on success.
It proceeds. A successful run records the loaded packages, excluding confirmed
removals, even when the schema was already current. Refused runs and dry runs
write nothing. Dry-run shows the same missing-package stop and exits 1.

## `--null-orphans`

This explicit data step stays available. It clears orphan foreign-key references
only when both the manifest and the live child column allow NULL. It never
deletes rows. It uses the differ's detector and suggested UPDATE SQL.

The UPDATE and FK addition enter the same atomic batch. If another stop remains,
neither runs. A failed count probe or missing repair plan leaves the orphan stop
unresolved and refuses the whole run. A NOT NULL child requires an operator
repair. Dry-run shows the UPDATE and count without executing them. A real run
reports before/after counts only for a disposition that committed.

## `--postgres-safe`: the one exception to atomic apply

Table changes commit first. Indexes then build with CREATE INDEX CONCURRENTLY.
Migrate has not finished until every index is built. A failed index exits with
an error; committed table changes remain. Fix the data and rerun to finish the
indexes. The tracker marks unfinished builds for retry. A stop still refuses
the entire run before either phase. Configuration can veto concurrent indexes.
See [concurrent-index details](db-migrate-concurrency.md).

## Removed `--apply-unblocked`

`--apply-unblocked` is removed because partial apply is gone. Using it exits 1
before opening the database or taking a migration lock. Scripts that used the
old behavior must fix all stops first, then run `db:migrate` without that flag.

## Application wrappers

Both the CLI and `migrateSmrtSchemas()` call core's `decideMigrationRun()`.
`getPendingSchemaStatements().decision` covers schema changes only. For a full
preview, wrappers can call
`decideMigrationRun({ changes, addedTables, engine, packagesSeen })`.
A wrapper planning an explicit data step can pass `resolvedStops`, a set of the
exact original changes it will resolve in the same atomic batch. It must not
mark a stop resolved without scheduling that repair.

For package checks pass `packagesSeen: packagesSeenInput(collectMigrateRecordInput(),
await readLastMigrateRecord(db), confirmedRemoved)`. Both come from the app's
build (its project manifest; see core `schema-paths.md`, "The build's schema"),
so every writer and every install compares the same package list. A build
package whose tables the run has not loaded is a stop no confirmation clears. The result contains
`proceed`, `stops`, `packageStops`, `notices`, and `heldBack`. `migrateSmrtSchemas()`
returns `applied:false` and `refused:true` on refusal, with those stops and held
changes. It keeps `unactionableChanges` and `hasManualDrift` for existing callers.
Proceeding and in-sync results have `refused:false`. Wrappers need no separate
partial-apply policy. `migrateSmrtSchemas({ confirmRemovedPackages: [name], ... })`
checks packages itself and returns the same package stops and notices.

## `doctor --db`: next migrate

After live-schema parity, doctor prints a read-only preview of the next ordinary
`smrt db:migrate`. It reads the loaded registry, live schema and row counts, and
the last `_smrt_migrate_runs` record. It creates no tables and writes no records.
An unreachable database or failed inspection is an issue, never a pass.

- **Constraints made by hand that the next migrate removes** names NOT NULL,
  default, foreign-key, index and stale `smrt_ck_` removals from the differ's
  change kinds. Declare a constraint in code to keep it. Relaxations requiring
  opt-in are listed separately as **kept until you opt in**.
- **Rules in code the database is not enforcing** names required columns and
  missing shared-table subclass checks. It explains whether migrate can add
  the rule, existing rows break it, or the engine leaves it to save-time
  validation. PostgreSQL reads CHECK names from `pg_constraint`.
- **What the next migrate applies** groups apply changes by kind with counts
  and up to ten names, then lists new tables. **Packages** compares the last
  migrate's packages with loaded packages. Missing packages stop migrate and
  name `--confirm-removed-package`; new packages are informational. No earlier
  record means the first successful migrate will write one.
- **What the next migrate stops on** uses the shared migration decision. It
  shows kind, reason, table/column and row count. Required NULLs count NULL
  rows; a missing required column counts table rows; foreign-key orphans use
  the differ's detector; data-loss stops count table rows. An unreadable count
  stays visible beside the stop. **Held back** lists changes refused with it.
- **Database release** compares the last recorded release with
  `OLDEST_SUPPORTED_RELEASE`, including the first upgrade to run when older.
  Without a record its age is unknown.
- **Schema fingerprint** shows the build's stamp and the database's hash side by side, twelve
  characters normally and full values with `--verbose`. A mismatch or absent
  record explains the production startup refusal and asks for `smrt db:migrate`.

Every group prints `none` when empty. Stops and missing packages are issues;
unenforced rules, planned constraint removals, release age and fingerprint
mismatch are warnings. One stop holds every apply change, including unrelated
tables. STI CHECK additions and removals are ordinary apply changes
(`check.add`, `check.drop`); rows that already break a rule stop the run
(`check.violated`).
