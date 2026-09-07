# `db:migrate --apply-unblocked` and `--null-orphans` (#2748)

Both are opt-in and off by default; default `db:migrate` behavior is
unchanged either way. Implementation: `packages/cli/src/commands/
db-migrate-actions.ts` (pure partition/planning functions) and
`packages/cli/src/commands/utilities.ts`'s `db:migrate` handler (wiring,
I/O). Core side: `SchemaChange.orphanBlocked` / `.orphanNullable` /
`.engineUnsupported` (`packages/core/src/schema/types.ts`), set by the
FK advisory branches in `compareForeignKeys()`
(`packages/core/src/migrations/differ.ts`), and
`renderForeignKeyAddStatements()` (`packages/core/src/schema/
foreign-key-ddl.ts`).

## `--apply-unblocked`: partial apply

Today's unflagged batch already excludes every individually blocked change
(a FK-with-orphans, a manual `type_upgrade`/`alter_column`) — those never
leave `SchemaDiff.changes` as executable SQL, so they never enter the atomic
tracker batch on their own. `--apply-unblocked` adds a second, opt-in
partition on top of that: it withholds not just the blocked changes
themselves but anything that *depends* on one, and applies everything else.

**Dependency rule.** `computeBlockedColumns()` reads every manual
intervention's blocked `table.column` identity, plus every report-only
`type_upgrade` **advisory** (the #2608 refused uuid convergence — the only
producer of that shape) — an advisory-only finding never enters
`manualInterventions` (it carries no SQL) but names a live column just as
concretely, and a dependent index/alter/drop on that column is exactly as
unsafe as one on a manual-intervention column (review finding, #2748: the
advisory bucket was previously excluded, so `--apply-unblocked` did not
honor its own stated guarantee for that class of blocked type upgrade).
`partitionUnblockedMigrations()` then withholds any `add_index` /
`add_foreign_key` / `alter_column` / `drop_column` that reads or writes one
of those columns:

- an index on a column whose type upgrade is blocked (manual intervention
  or report-only advisory);
- a foreign key whose child *or* parent column is blocked (a parent column
  mid-type-upgrade is just as unsafe to reference as the child);
- an `alter_column`/`drop_column` on the blocked column itself.

**A report-only `alter_column` advisory is deliberately excluded from that
second loop**, even though `SchemaAdvisory` allows the type. Unlike
`type_upgrade`, the only producer of an advisory-only `alter_column` is an
un-opted-into relaxation (`drop_default`/`drop_not_null` when
`--relax-columns` was not passed) — it says the live column is *stricter*
than the manifest, not that anything about the column blocks convergence,
and it reappears on every run regardless of `--apply-unblocked`. Blocking on
it reproduced the exact `engineUnsupported` defect for a different shape:
permanently withholding unrelated executable DDL on that column, worse than
omitting the flag (review finding, #2748, second pass). A genuinely blocked
`alter_column` — NOT NULL required with live NULLs and no default to
backfill — carries its refusal as comment-only SQL and already reaches
`manualInterventions` (keyed by `columnName`), so it was never affected.

`add_column` and an executable `type_upgrade` never depend on another
column's state — a new column add is self-contained, and a type upgrade is
the fix itself — so they always apply. Everything independent goes through
the exact same transaction/tracker path an unflagged run uses.

**An `add_foreign_key` blocked only because this engine cannot express the
constraint at all is not a column-state block.** SQLite (table rebuild
required) and DuckDB (no `ALTER TABLE ADD CONSTRAINT`) each carry
`engineUnsupported: true` on that advisory — distinct from a conflicting
constraint or an incompatible-type block, which genuinely do implicate the
column and stay blocking. `blockedColumnForAction()` excludes only the
`engineUnsupported` case: every real differ `add_foreign_key` advisory sets
`foreignKey`, so gating on its mere presence blocked this case too (review
finding, #2748) and, since no rerun on that engine ever resolves it, made
`--apply-unblocked` permanently withhold unrelated dependent DDL on that
column — strictly worse than omitting the flag.

**An orphan-blocked `add_foreign_key`'s block is a row-data condition, not
a column-state one — an `alter_column` relaxation on that same column is
its remediation, not something unsafe against it.** With `--relax-columns
--apply-unblocked`, a FK child column that is physically `NOT NULL` while
the manifest declares it nullable (with live orphan rows) stays
orphan-blocked — `--null-orphans` can't resolve a NOT NULL child. The
executable `DROP NOT NULL` relaxation for that same column is exactly what
makes the block eventually resolvable (the column becomes nullable, then a
later `--null-orphans` run can null the references). Gating that
relaxation on the orphan block (review finding, #2748) made the run
withhold it on every pass, so the column never became nullable, the
orphan block never cleared, and the batch failed forever — worse than
omitting the flag. `computeOrphanOnlyBlockedColumns()` identifies a
`table.column` whose *only* manual-intervention block is an orphan-blocked
FK on that column, and `partitionUnblockedMigrations()` excludes that key
from gating an `alter_column` specifically — an index, a different foreign
key, or a `drop_column` on that same orphan-blocked column still correctly
stays withheld.

Withheld items print under `🔒 Withheld — depends on a blocked change`, each
naming the `table.column` it depends on and the same reason text the manual
intervention above it carries. `--dry-run` shows the identical
applied/withheld partition (the partition is pure and runs before the
dry-run/apply branch splits). A rerun is a no-op for what already applied
and repeats the same withheld list until the underlying blocker is resolved
— nothing here is remembered between runs; the partition is recomputed from
the live diff every time.

## `--null-orphans`: opt-in orphan-FK disposition

Targets one specific blocked-item shape: a foreign key `db:migrate` would
otherwise refuse only because live child rows don't match any parent row
(`SchemaChange.orphanBlocked`). `planOrphanDispositions()` splits manual
interventions into nullable (a disposition is possible) and not-nullable
(unconditional refusal) using `SchemaChange.orphanNullable` — never by
parsing `advisory.message` text.

For a nullable child column: the *exact* `UPDATE ... SET <column> = NULL
WHERE ...` the differ already generated for that relationship
(`advisory.suggestedSql[1]` — never re-derived, so the disposition can never
drift from what the differ decided the safe repair is) and the `ADD
CONSTRAINT ... NOT VALID` + `VALIDATE CONSTRAINT` pair from
`renderForeignKeyAddStatements()` (the same helper the differ's own safe-add
branch uses) are combined into **one** `add_foreign_key` migration action —
`sqlStatements: [repairSql, ...addStatements]` — and applied atomically
through the normal tracker path, not run as a separate direct query before
it (review finding, #2748: running the UPDATE outside the batch let a later
failure elsewhere in the same batch roll back the FK add while leaving the
just-nulled rows committed, silently splitting one promised disposition
into two). The resolved FK moves from `manualInterventions` into the
executable `migrations` bucket before the `--apply-unblocked` partition
runs, so a relationship this flag resolves is never a blocked column for
that dependency rule. Post-apply before/after counts are only printed once
the batch that carries this disposition has actually committed; on a full
rollback the generic atomic-failure message already covers it — nothing in
that batch, including this disposition, applied.

**The combined migration can still be withheld by `--apply-unblocked`
itself**, if the FK's *parent* column is separately blocked (e.g. a
report-only `type_upgrade` advisory) — resolving out of
`manualInterventions` only means this specific relationship's *child*-side
orphan block is gone, not that the dependency partition can't withhold it
for an unrelated reason. `filterUnresolvedOrphanDispositions()` drops a
pending post-apply report entry whose exact migration action ended up
withheld, matched by object identity (the same reference is pushed into
both `migrations` and the pending entry) rather than by table/column, so
the report never prints a `✓ ... resolved` line for a migration that never
executed (review finding, #2748) — that relationship is already covered by
the `🔒 Withheld` listing.

**"Committed" is not simply `errorCount === 0`.** In PostgreSQL
concurrent-index mode (`--postgres-safe` with
`migrations.postgres.useConcurrently`), the non-index batch — including
this disposition's combined migration — commits in its own transaction
before any deferred `CREATE INDEX CONCURRENTLY` migrations run separately
and non-transactionally; a later index build failure still increments
`errorCount` even though the non-index changes already committed. Gating
the report on `errorCount === 0` alone silently suppressed the resolution
line for a mutation that did commit (review finding, #2748). The gate is
`errorCount === 0 || deferredIndexMigrationsCount > 0` — the same signal
the console error branch above it already relies on to tell the operator
non-index changes were committed — and a partial-commit run adds an extra
line noting the caveat before the per-relationship resolution lines.

For a `NOT NULL` child column: refuse with the same "Manual repair required"
text `db:migrate` always prints for that case. Nulling is not a legal repair
there, and **this flag never deletes rows** either way — the only mutating
statement is the UPDATE that nulls references, never a DELETE.

`--dry-run` prints the exact UPDATE statement plus the live orphan count
(`orphanCountSql()` wraps the differ's read-only detector SELECT as a
`COUNT(*)`) before applying anything; a real run reports the count before
and after. Composes with `smrt db:orphans` (#2753, `packages/cli/agents/
db-orphans.md`) — same probe, same repair SQL, no duplicated logic.

**Fails closed on the count probe too** (review finding, #2748):
`countOrphanRows()` throws rather than swallowing a query failure into `0`.
An orphan-count probe that cannot run at all is exactly the "unexpected
shape" case this flag must report and withhold on — proceeding to null data
on an unverified count would violate the fail-closed requirement. A probe
failure withholds that one relationship's disposition (printed, left in
`manualInterventions`) without aborting the rest of the batch or the other
dispositions.

## Fails closed on an unexpected shape

`planOrphanDispositions()` routes an orphan-blocked, nullable change to the
refusal bucket (never guesses SQL) if it is missing its `foreignKey`
definition or its `advisory.suggestedSql` pair — a differ-side contract
violation, not something this disposition should paper over.
