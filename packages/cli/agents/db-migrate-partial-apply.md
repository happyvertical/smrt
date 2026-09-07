# `db:migrate --apply-unblocked` and `--null-orphans` (#2748)

Both are opt-in and off by default; default `db:migrate` behavior is
unchanged either way. Implementation: `packages/cli/src/commands/
db-migrate-actions.ts` (pure partition/planning functions) and
`packages/cli/src/commands/utilities.ts`'s `db:migrate` handler (wiring,
I/O). Core side: `SchemaChange.orphanBlocked` / `.orphanNullable`
(`packages/core/src/schema/types.ts`), set by the FK-orphan advisory branch
in `compareForeignKeys()` (`packages/core/src/migrations/differ.ts`), and
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
intervention's blocked `table.column` identity. `partitionUnblockedMigrations()`
then withholds any `add_index` / `add_foreign_key` / `alter_column` /
`drop_column` that reads or writes one of those columns:

- an index on a column whose type upgrade is blocked;
- a foreign key whose child *or* parent column is blocked (a parent column
  mid-type-upgrade is just as unsafe to reference as the child);
- an `alter_column`/`drop_column` on the blocked column itself.

`add_column` and an executable `type_upgrade` never depend on another
column's state — a new column add is self-contained, and a type upgrade is
the fix itself — so they always apply. Everything independent goes through
the exact same transaction/tracker path an unflagged run uses.

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
the whole batch has actually committed (`errorCount === 0`); on a rollback
the generic atomic-failure message already covers it — nothing in that
batch, including this disposition, applied.

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
