---
'@happyvertical/smrt-core': minor
'@happyvertical/smrt-cli': minor
'@happyvertical/smrt-tenancy': minor
---

**BREAKING: a save can no longer take over another tenant's row, and tables
that carry `tenantId` are keyed per tenant.** Run `smrt db:migrate` with this
release, in the order below.

- A class with a `tenantId` field is tenant-owned even without a tenancy
  declaration (the shape a consumer registers with
  `registerTenantScopedClass()` at runtime, such as Anytown's Ludis
  League/Team). Its default natural key and unique index lead with
  `tenant_id`: `(tenant_id, slug, context)`. Explicit `conflictColumns` are
  never rewritten, the read policy is never inferred, and the implicit
  `tenant_id` never turns a tenant foreign key into a delete CASCADE.
- **A slug is no longer unique across tenants** (or between a tenant and the
  global scope) on those tables. A slug-only lookup outside a tenant filter
  (`withSystemContext()`, a hand-written query) can match several rows: scope
  it by `tenantId` and treat more than one match as ambiguous.
- **A save that collides with another owner's row now throws**
  `TenantIsolationError` (`TENANT_ISOLATION_VIOLATION`, never naming the other
  owner) instead of overwriting it, under `withSystemContext()` too. Every
  ownership column counts: `tenant_id`, the declared tenant column,
  `@tenantId` fields, and runtime registrations on a custom field
  (`registerTenantScopedClass('Team', { field: 'organizationId' })`, reported
  to core through the new `ObjectRegistry.registerOwnershipColumnSource()`;
  `ObjectRegistry.getOwnershipColumns()` lists them). An owner the save leaves
  unset counts as NULL. A same-owner row is adopted by id, so `DO UPDATE`
  never rewrites a primary key. A slug derived from a name moves to a free
  slug instead of throwing.
- The junction batch path never rewrites an existing row's primary key: it
  probes the natural keys and falls back to per-item saves when one names a
  row it is not removing, and its `DO UPDATE SET` never lists `id`,
  `created_at` or an ownership column.
- `db:status` reports tenant-owned tables whose live unique is still the
  global `(slug, context)`: **it exits 1** while the tenant-led unique is
  missing, and warns while the legacy global unique survives beside it.
- `@happyvertical/smrt-tenancy`: `registerTenantScopedClass()` audits the model
  a selector resolves to and logs once (an error when the model has no such
  field, a warning when its natural key omits the tenant column);
  `auditTenantScopedRegistrations()` returns every finding.

**Rollout (expand, then contract).** Old code upserts on
`ON CONFLICT (slug, context)`, new code on `ON CONFLICT (tenant_id, slug,
context)`, and PostgreSQL rejects each (42P10) unless a unique index over
exactly those columns exists.

1. Before deploying: `smrt db:migrate` with this release's manifests. It builds
   the tenant-led unique under its own name (`<table>_tenant_id_slug_idx`) and
   keeps the global `<table>_slug_context_idx`; the new key is a superset, so it
   cannot fail on existing rows. In the default atomic mode the build holds a
   SHARE lock (writes wait, reads continue); `--postgres-safe` builds it
   `CONCURRENTLY` but refuses a nullable `tenant_id` (that NULL-equal index
   needs the atomic mode), so schedule a quiet window for large tables.
2. Deploy. While the legacy unique stands, a second tenant's save of a slug
   another tenant uses fails with a unique violation (nothing is overwritten).
3. Once no old code runs: `smrt db:migrate --drop-legacy-natural-key` (also
   `db:diff --drop-legacy-natural-key`, `DiffOptions.dropLegacyNaturalKey`)
   drops the global index. `--drop-indexes` alone never drops it.

`--postgres-safe` now also rebuilds any same-name unique index
build-then-swap (temporary name, drop, rename), so a table never runs without
a unique index.
