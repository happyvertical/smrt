# smrt-overviews

Production persistence for the overview surfaces of
`@happyvertical/smrt-svelte/overview` (#3727 phase 3). The surface, model,
validation and load contract are in
[smrt-svelte overview-surfaces.md](../smrt-svelte/agents/overview-surfaces.md);
this package owns the `_smrt_overview_overrides` table and the server API.

## Why a package of its own

The repo puts each layered-override table in the package that owns its
resolution (`smrt-prompts`, `smrt-playbooks`, `smrt-features`, `smrt-fields`).
`smrt-svelte` has no runtime dependency on core, tenancy or users and holds no
tables, so the table, the permissions and the store live here. The store
imports only the Svelte-free `@happyvertical/smrt-svelte/overview/server`
entry (`checkOverviewOverride`, `resolveOverview`, `loadOverview`, ...).

## Pieces

| File | Contents |
| --- | --- |
| `src/models/OverviewOverrideRecord.ts` | The row: `(tenantId, overviewId, scopeType, scopeKey)` natural key, `userId`, `overrideJson` (canonical `OverviewOverride`), `formatVersion`, `updatedBy`. Owns identity, scope shape and authorization |
| `src/collections/OverviewOverrideRecordCollection.ts` | Undecorated reads (`findTier`); no generated surface |
| `src/store.ts` | `createOverviewStore({ db })`: `load`, `save`, `reset`, `loadPage`, `loadWidget`; `withTenantDefaults` |
| `src/context.ts` | The ambient principal (tenancy ALS, then the users session ALS) and `OverviewAccessError` |
| `src/permissions.ts` | `overviews.customize`, `overviews.personalize`, registered in the users catalog |

## Invariants

- **Tiers.** `definition.defaults` < tenant row (`scopeType: 'tenant'`,
  `scopeKey: '__tenant__'`, `userId` null) < user row (`scopeType: 'user'`,
  `scopeKey = userId`). The tenant document becomes the user tier's defaults
  (`withTenantDefaults`), so a user override is a delta against the tenant
  default and later tenant changes flow through untouched entries. User rows
  are per tenant (unlike smrt-fields' user tier): widget options name the
  tenant's data.
- **Validate on save, again on load.** `save` runs `checkOverviewOverride`
  against the tier's definition (user tier: tenant-merged) and stores only the
  canonical result; a `null` canonical override deletes the row. `load`
  resolves each stored tier leniently and reports dropped entries per tier
  (`tenant.issues`, `user.issues`); it never rewrites the row. The model
  itself checks only the envelope (`version: 1` JSON), because it has no
  widget registry.
- **Identity is ambient.** No API takes a tenant or user id. A missing
  principal throws `OverviewAccessError`; a principal without a user id has
  no user tier and cannot write one. A session-only principal (users
  `createSessionHandler()` without `enterTenantContext`) is entered as a
  tenant context with the same identity before any table access.
- **Tenancy.** The model is `@TenantScoped({ mode: 'required' })`, and every
  store read also names the tenant explicitly (a super-admin bypass context
  does not filter reads). `save()`/`delete()` refuse a row whose stored tenant,
  overview id or tier differs from memory (matched by predicate: DuckDB returns
  raw UUID columns as lossy HUGEINTs), a foreign tenant, and a user row that is
  not the principal's.
- **Permissions.** Tenant tier: `overviews.customize`. User tier:
  `overviews.personalize` plus ownership. Checked in the model (fail closed,
  `assertOperationPermission`) and as `canCustomize` in the store
  (`checkOperationPermission`, `onDeny: 'return'`) against the principal's
  permission set. The users resolver denies a principal with no user id even
  with the slug in its set. `overviews.personalize` is in users' built-in
  self-personalization list (seeded for owner/admin/member/viewer once
  registered).
- **Concurrency.** Optimistic, never last-writer-wins: every save passes the
  `revision` (ISO `updated_at`) it loaded, `null` meaning "no row". An update
  uses core's revision CAS (`save({ expectedUpdatedAt })`), a first write is a
  strict insert (`_insertOnly`) so a racing first write hits the unique index,
  and a delete is guarded the same way. Any mismatch returns
  `{ ok: false, reason: 'conflict' }`. `reset` guards only when given a
  revision (reset is idempotent).
- **`loadWidget`** loads one widget for the client controller (adds,
  reconfigures, reloads). A principal without either customize permission
  may only load a widget that is on their resolved overview (same id, type,
  version, options); anything else is `not_allowed`. The widget is sanitized
  against the page definition before its loader runs.
- **No generated surface** (`api: { include: [] }`, `cli: false`,
  `mcp: { include: [] }`): a generated route has no widget registry and would
  bypass content validation.

## Schema and migrations

The table ships through manifest-driven migrations (`smrt db:migrate`), never
runtime DDL; `src/__tests__/migration.test.ts` applies it with
`migrateSmrtSchemas` on SQLite and DuckDB and asserts parity afterwards. On
DuckDB only this table is migrated in tests: smrt-users' tables carry ON
UPDATE CASCADE foreign keys DuckDB cannot create. `tenantId`/`userId` are
native UUIDs on PostgreSQL/DuckDB. All four natural-key columns are NOT NULL,
so the unique index is total on every engine.

## Tests

`pnpm test` runs the store suite on SQLite and DuckDB plus the migration
suite; `pnpm test:postgres` runs the same store suite on PostgreSQL
(`store.optional.test.ts`, skipped without a database).
