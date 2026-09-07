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
non-empty values are already canonical UUID strings. A value being converted to
native `uuid` counts as UUID-shaped in either the hyphenated form
(`8-4-4-4-12` hex groups) or the bare 32-hex form with no hyphens — PostgreSQL's
`::uuid` cast accepts both as the identical value, and the conversion normalizes
either input to the same canonical hyphenated `uuid` value, so a foreign key
between a hyphenated-form column and a bare-hex-form column still converts and
recreates correctly. Braces and partially-hyphenated values are never accepted.
It deliberately skips dirty columns instead of coercing slug-shaped data.
Because the hyphenated and bare-hex forms are accepted as the same value,
TEXT→uuid is many-to-one: a column that holds BOTH forms of the identical
uuid as two distinct rows (a re-import or dedupe artifact) is detected before
conversion and skipped as dirty — reported as "N duplicate value(s) after
normalization" — rather than reaching `ALTER COLUMN … TYPE uuid` and failing
the whole transaction on a duplicate-key error from the column's PK/unique
index. That skip also propagates to its foreign-key partners exactly like a
non-uuid-shaped skip does.
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
