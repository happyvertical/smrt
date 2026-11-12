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

An ordinary run applies one atomic transaction batch. A failure in a later
statement rolls back the earlier changes and tracker rows too.

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
Work-style wrappers can read `getPendingSchemaStatements().decision`, or call
`decideMigrationRun({ changes, addedTables, engine })` for their own preview.
A wrapper planning an explicit data step can pass `resolvedStops`, a set of the
exact original changes it will resolve in the same atomic batch. It must not
mark a stop resolved without scheduling that repair.

The result contains `proceed`, `stops`, and `heldBack`. `migrateSmrtSchemas()`
returns `applied:false` and `refused:true` on refusal, with those stops and held
changes. It keeps `unactionableChanges` and `hasManualDrift` for existing callers.
Proceeding and in-sync results have `refused:false`. Wrappers need no separate
partial-apply policy.
