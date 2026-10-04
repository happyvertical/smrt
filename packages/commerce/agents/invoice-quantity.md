# Invoice quantity persistence and editor recovery

InvoiceLineItem accepts nonnegative decimal quantities with at most six decimal
places. The `1.0` default declares a floating-point quantity column. Unit price,
flat discount, and calculated amount remain safe integer minor units. Save always
validates resolved fields and recalculates amount; a supplied amount is never
trusted. Gross quantity × price and then tax on discounted gross round to minor
units, with ties toward positive infinity (including existing negative-price
credit lines). Tax is a resolved fraction in [0, 1], with eight decimal places.
Accounting export retains an explicit zero rate instead of omitting it.

`applyEditorDraft(draft, authorizedContext)` resolves the shared invoice draft
helper into description/SKU/quantity/price/flat discount/tax and stores cloned
`invoiceEditorStateJson` TEXT, accessed through a guarded typed `invoiceEditorState` getter/setter. It does not save.
`getEditorDraft(authorizedContext)` returns a clone only when currency, inherited
tax authority, and all source fields still agree. Otherwise it returns null so the
caller can reconstruct a flat-discount/explicit-tax editor from resolved fields.
Normal save clears stale editor state and never derives money from metadata.
All other object metadata, authorization, and transaction ownership are unchanged.

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
Resolve that maintenance condition before deploying fractional writers. The same
transaction adds the nullable TEXT `invoice_editor_state_json` column with an empty
string default on every engine. This column is required for updated model saves.
An existing floating quantity column still receives the missing state column.
No schema mutation runs implicitly during runtime initialization or model save.

The actual DuckDB quantity/storage migration is tested. Complete Commerce model
persistence on DuckDB is currently unsupported because its hard foreign keys use
ON UPDATE CASCADE, which DuckDB cannot preserve; the schema builder refuses that
contract. SQLite and PostgreSQL exercise complete save/reload model behavior.
