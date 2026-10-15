# Invoice quantity persistence

InvoiceLineItem accepts nonnegative decimal quantities with at most six decimal
places. The `1.0` default declares a floating-point quantity column. Unit price,
discount and amount stay safe integer minor units. Every save goes through the
invoice money aggregate, which recomputes the line under money v2 and ignores
any supplied amount. Tax comes from the line's resolved tax code, never from a
stored rate. See the [commercial money model](money-model.md).

## Existing integer columns

Run a backup and pause invoice writers for this explicit migration. With a root
database handle and its known engine (`sqlite`, `postgres`, or `duckdb`), call
`preflightInvoiceEditorStorage(db, engine)`, resolve every reported invalid row,
then `migrateInvoiceEditorStorage(db, engine)`. The preflight rejects negative,
nonfinite, unsafe, excess-precision, and numerically non-roundtripping quantities.
The migration uses a transaction (and a PostgreSQL writer lock) and never rescales
or rounds stored values. PostgreSQL widens INTEGER/BIGINT to DOUBLE PRECISION;
DuckDB widens to DOUBLE. Repeating it leaves an already widened declaration alone.
An absent table is reported as absent and is never marked migrated.

SQLite uses the public core table-rebuild planner to change the declaration to
REAL while preserving existing columns, constraints, indexes, and triggers. If
incoming foreign keys make that rebuild unsafe, the migration throws with the
planner reason and rolls back; it does not disable constraints or lose children.
Resolve that maintenance condition before deploying fractional writers. The
migration no longer adds an editor-state column. An `invoice_editor_state_json`
column that an earlier version added is left in place and unused. No schema
mutation runs implicitly during runtime initialization or model save.

The actual DuckDB quantity/storage migration is tested. Complete Commerce model
persistence on DuckDB is currently unsupported because its hard foreign keys use
ON UPDATE CASCADE, which DuckDB cannot preserve; the schema builder refuses that
contract. SQLite and PostgreSQL exercise complete save/reload model behavior.
