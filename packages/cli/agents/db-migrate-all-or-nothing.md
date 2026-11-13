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

Migrate compares loaded packages with the last successful migrate record.
Every package seen last time must still be loaded. A missing package may have
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

Pass `packagesSeen: { recorded, current, confirmedRemoved }` for package checks;
use `collectMigrateRecordInput().packages` for `current`. The result contains
`proceed`, `stops`, `packageStops`, `notices`, and `heldBack`. `migrateSmrtSchemas()`
returns `applied:false` and `refused:true` on refusal, with those stops and held
changes. It keeps `unactionableChanges` and `hasManualDrift` for existing callers.
Proceeding and in-sync results have `refused:false`. Wrappers need no separate
partial-apply policy. `migrateSmrtSchemas({ confirmRemovedPackages: [name], ... })`
checks packages itself and returns the same package stops and notices.
