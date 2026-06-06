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
non-empty values are already canonical UUID strings. It deliberately skips dirty
columns instead of coercing slug-shaped data.

## Validation

Run `smrt db:status` after migration. The command now reports a compatibility
precondition for `tenants.id` when:

- the live table is native `uuid`, reminding operators that slug-shaped tenant
  primary keys are no longer accepted in fresh 0.27 PostgreSQL schemas;
- the live table is still `TEXT` but only contains UUID-shaped values, pointing
  operators to `smrt db:migrate-uuid`; or
- the live table is `TEXT` and contains non-UUID values, which must be remapped
  before fresh 0.27 environments can be expected to work.
