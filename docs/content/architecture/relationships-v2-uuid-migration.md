# 0.27 UUID Tenant Migration

SMRT 0.27 promotes primary `id` columns and `@foreignKey()` /
`@crossPackageRef()` columns to the framework `UUID` type. On PostgreSQL this
renders as native `uuid`; on SQLite it still renders as `TEXT`.

## Tenant IDs

`@happyvertical/smrt-users` `Tenant.id` is now a UUID-backed primary key on
fresh PostgreSQL schemas. Human-readable tenant identifiers such as
`bentleyalberta`, `tenant-bentley`, or other slug-shaped values must move to
`Tenant.slug` or another text field before adopting fresh 0.27 schemas.

This matters because migrated and fresh databases can otherwise diverge:

- Existing PostgreSQL databases may still have `tenants.id` as `TEXT`. The
  schema differ intentionally tolerates `TEXT` and `uuid` so it does not perform
  an unsafe automatic type rewrite.
- Fresh PostgreSQL databases created from the 0.27 manifest create
  `tenants.id` and tenant foreign-key columns as native `uuid`.
- A slug-shaped tenant ID that works in the migrated `TEXT` schema fails in the
  fresh native-UUID schema with a PostgreSQL `22P02` cast error.

## Upgrade Steps

Before upgrading a PostgreSQL consumer that stores non-UUID tenant primary keys:

1. Create canonical UUIDs for every existing tenant.
2. Rewrite `tenants.id` to those UUIDs.
3. Rewrite every tenant reference, including `tenant_id`,
   `memberships.tenant_id`, `groups.tenant_id`, and
   `tenant_permission_overrides.tenant_id`.
4. Preserve the old human-readable value in `Tenant.slug` or a project-specific
   text column if the application still needs it.
5. Run `smrt db:migrate`, then run `smrt db:migrate-uuid`.

`smrt db:migrate-uuid` only converts schema-declared UUID columns when all
non-empty values are already UUID-shaped — not necessarily canonical UUID
strings. A value being converted to
native `uuid` counts as UUID-shaped in either the hyphenated form
(`8-4-4-4-12` hex groups) or the bare 32-hex form with no hyphens — PostgreSQL's
`::uuid` cast accepts both as the identical value, and the conversion normalizes
either input to the same canonical hyphenated `uuid` value, so a foreign key
between a hyphenated-form column and a bare-hex-form column still converts and
recreates correctly. Braces and partially-hyphenated values are never accepted.
It deliberately skips dirty columns instead of coercing slug-shaped data.
Because the hyphenated and bare-hex forms — and, for the shape probe, upper
and lower case — are accepted as the same value, TEXT→uuid is many-to-one.
That is only a hazard for a column covered by a unique/PK index — single-key
or composite (e.g. SMRT's own generated `UNIQUE (tenant_id, slug, context)`
on tenant-scoped tables, or a link table's `UNIQUE (source_id, target_id)`
where both sides are themselves declared UUID and converting in the same
run). A covered column that holds two distinct TEXT rows normalizing to the
same uuid, with every other key column of that index also matching — an
other key column that is itself a declared-UUID candidate is compared on
its own normalized value too, not its raw text, so a pair that only collides
after BOTH columns convert is still caught — is detected before conversion
and skipped as dirty — reported as "N duplicate value(s) after
normalization" — rather than reaching `ALTER COLUMN … TYPE uuid` and failing
the whole transaction on a duplicate-key error when that index is rebuilt.
That skip also propagates to its foreign-key partners exactly like a
non-uuid-shaped skip does. Following ordinary PostgreSQL `NULLS DISTINCT`
semantics (the default), a NULL in another key column never counts toward a
collision, however the rest of the row compares. A column with no covering
unique index at all, or one whose other key columns disagree (or are NULL
under a `NULLS DISTINCT` index), normalizing several rows to the same value
is the intended, harmless outcome (e.g. an ordinary FK column with
mixed-case or mixed-hyphenation spellings across rows) and is never flagged.

Four narrow, deliberately-deferred imprecisions in this collision probe are
known and out of this fix's bounded scope. Three are safe-direction
(over-cautious skip, never a missed collision or a whole-run abort): a
partial unique index's `WHERE` predicate is not read, so rows outside it can
still be counted toward a collision; an expression-based key column of a
composite index is not modeled, which only widens (never narrows) what that
index's check flags; and a composite index's OTHER key column is normalized
in the group-by whenever it is merely schema-declared UUID, not only when it
will actually convert — a partner column that stays TEXT (skipped for dirty
data or otherwise) can therefore cause a false "duplicate value(s) after
normalization" skip on an otherwise-clean column sharing that index, which
then propagates to that column's own FK partners. Re-running after cleaning
the partner converges normally. The fourth is not safe-direction, but is
narrowly reachable: under an index declared `NULLS NOT DISTINCT`
(PostgreSQL 15+), two rows whose values both collapse to empty/NULL under
the conversion's own `NULLIF(btrim(...), '')` (one literal `NULL`, one `''`
or whitespace-only) are excluded from the probe entirely rather than counted
as the collision `NULLS NOT DISTINCT` would make them, and so can still
abort that specific, uncommon run — this predates #2702, since the
empty-to-NULL collapse comes from the original `USING` clause, not from the
widened shape probe.
A generated TEXT bridge column (below) is narrower: it stays TEXT and is
regenerated as `sourceColumn::text` over the now-native column, and
`uuid::text` always renders the canonical hyphenated form — so a bare-hex
bridge value would come back silently re-hyphenated, breaking the bridge's
one job (matching its TEXT FK children exactly). The bridge's own sample probe
therefore accepts only the canonical hyphenated form, never the bare-hex one.

Inside its single transaction, before converting, it drops every foreign key
that depends on a column being converted and recreates it afterward from the
captured `pg_get_constraintdef`. A column whose foreign-key partner will not
convert — because the partner's data is still dirty, or because the schema
deliberately keeps the partner `TEXT` — blocks that column too, rather than
aborting the whole run: the block propagates transitively (a two-hop chain of
foreign keys blocks every column in the chain), and `--dry-run` lists each
blocked column together with the reason and the foreign key that caused the
block. Every unblocked column still converts, and repeat runs are a no-op.

On PostgreSQL it also preserves a bounded dependency component in one
transaction: schema-declared UUID foreign keys and plain stored `id::text`
integrity bridges with their single-key btree indexes and inbound TEXT foreign
keys. Before it drops a bridge column, it reads PostgreSQL's dependency catalog
and allows only the bridge's generated-column definition, those reconstructable
indexes, and the foreign keys it explicitly captures. Constraints, views,
expression or partial indexes, extended statistics, and every other dependent
catalog object are refused before any schema change. It also refuses views,
partitions, inheritance, non-canonical bridge values, non-default bridge
collations, multi-column foreign keys touching the migration component, foreign
keys that mix a converted endpoint with a retained TEXT bridge, and foreign keys
with nondefault PostgreSQL trigger enforcement; use `--dry-run` to inspect the
exact plan.

## Detecting a pending rename backfill (#2752)

A field rename like the ones above is additive by construction: `smrt
db:migrate` adds the new column and never moves data into it or drops the old
one, because additive migrations never drop. Every consumer that took
relationships-v2 (`events.parent_event_id` → `events.parent_id`,
`assets.parent_id` → `assets.source_asset_id`) had to hand-write a backfill
script for a rename the framework itself authored.

As of #2752, `smrt db:status --parity` reports a `rename_data_pending` finding
when, on one table, a manifest-declared column exists live and holds no
non-null/non-empty values while an undeclared live column of a compatible type
(same type, `TEXT` → `UUID` when every non-empty value is already UUID-shaped,
or `TEXT` → `TEXT`) holds at least one. It is `warning` severity and names both
columns; when several undeclared columns qualify it lists all of them rather
than guessing which one holds the pre-rename data.

`smrt db:diff` (and `db:migrate`, via the same advisory) prints the repair for
each such pair as a commented, never-executed advisory — the same copy-then-
drop shape the anytown backfill scripts hand-wrote, casting to `uuid` when the
new column is native uuid and doing a plain copy otherwise (SQLite has no
`uuid` type). The two engines differ in how safely it can be rerun:

- **PostgreSQL** gets one genuinely idempotent statement: an anonymous
  `DO $$ ... $$` block that checks `information_schema.columns` and only runs
  the `UPDATE` and `DROP COLUMN` when the old column still exists on `public`.
  Rerunning it after the rename is complete is a true no-op — verified against
  a real PostgreSQL 16 instance, including with a same-named table/column in
  another schema.
- **SQLite** has no procedural block or conditional-DDL construct at all, so
  a single self-contained idempotent statement is not expressible in plain
  SQL there. The advisory is explicitly operator-mediated instead: a guard
  query (`pragma_table_info`) plus instructions to run the `UPDATE` and
  `DROP COLUMN` only when it reports the old column still present. Blindly
  rerunning the SQLite statements after the rename is already complete will
  error at the `UPDATE` (the column no longer exists) — that error is safe
  (loud, no data loss) but is not a silent no-op the way the PostgreSQL block
  is.

Review the suggested SQL before running it — this is detection and a printed
repair, not an automatic one; see #2764 for carrying rename intent through the
manifest so `db:migrate` could execute it directly.

## Validation

Run `smrt db:status` after migration. The command now reports a compatibility
precondition for `tenants.id` when:

- the live table is native `uuid`, reminding operators that slug-shaped tenant
  primary keys are no longer accepted in fresh 0.27 PostgreSQL schemas;
- the live table is still `TEXT` but only contains UUID-shaped values, pointing
  operators to `smrt db:migrate-uuid`; or
- the live table is `TEXT` and contains non-UUID values, which must be remapped
  before fresh 0.27 environments can be expected to work.

`smrt db:status`'s UUID-shape probe is independent of `db:migrate-uuid`'s and,
as of this writing, is canonical-hyphenated-only: it does NOT yet recognize
the bare 32-hex form `db:migrate-uuid` accepts. A `tenants.id` column holding
only bare-hex values is reported by `db:status` as containing non-UUID values
that "must be remapped," even though `db:migrate-uuid` converts it cleanly.
Treat that specific `db:status` precondition as informational until the two
probes are unified; trust `db:migrate-uuid --dry-run` for the authoritative
convertibility answer.
