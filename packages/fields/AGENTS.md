# smrt-fields

Layered field policy store and resolution engine (epic #2045). Personalizes
per-field `{defaultValue, visibility, help, label, order, locked}` for any
`@smrt()` object at app, tenant, and user scope over the code seed.

## Core pieces

- `FieldPolicy` (`_smrt_field_policies` table) — sparse override rows keyed
  `(objectRef, fieldName, scopeType, scopeKey)`; NULL column = inherit from
  the lower layer, reset = row DELETE (later lower-layer changes flow through)
- `FieldPolicyCollection` — CRUD surface plus the `resolveBatch` custom
  collection-scoped action (`POST /<collection>/resolve`)
- `resolveFieldPolicy(objectRef, { tenantId, userId, db })` — merged policy
- `resolveFieldPolicyExplained(...)` — merged policy plus ordered per-layer
  contributions (code/app/tenant/user) for gear/admin UIs (#2049/#2050)

## Resolution layers (priority low → high)

1. Code seed — manifest field defaults, `description` as help, `_meta.ui`
   hints (#2046: `basic`/`group`/`order`/`locked`; cold-start rule: no
   `basic` markers ⇒ everything basic, any marker ⇒ unmarked fields advanced)
2. App rows — `scopeType: 'app'`, `tenantId`/`userId` null
3. Tenant rows — hierarchy walk root → leaf via an injected
   `tenantHierarchyLoader` (smrt-features shape); the default loader
   dynamic-imports `@happyvertical/smrt-users` and falls back to a flat
   single-tenant chain when absent; chain nodes that break permission
   inheritance reset their baseline to the app-layer state
4. User rows — keyed by `userId` alone (preferences follow the user); both
   defaults AND visibility resolve through this tier

## Invariants

- **Scope shape**: app ⇒ `tenantId`+`userId` null; tenant ⇒ only `tenantId`;
  user ⇒ only `userId`. `scopeKey` (`userId ?? tenantId ?? '__app__'`) exists
  ONLY to keep the `conflictColumns` unique index total — never read it for
  scoping logic.
- **Manifest as definition registry**: writes validate against the live
  `ObjectRegistry` (never checked-in manifest.json artifacts): unknown
  objectRef/fieldName rejected; defaults type-checked against the field type;
  system fields and relationship pseudo-fields are not policy-addressable.
- **Security rail**: defaults are refused on `transient`, `sensitive`, and
  `readPermission`-gated fields (both top-level and `_meta` flags checked).
  `resolveBatch` responses omit sensitive/read-permission-gated fields for
  every caller (fail closed) and transient fields (client-emission parity).
- **Required-field invariant**: demoting a required field to
  advanced/hidden requires a usable resolved default (not null/empty) —
  enforced at write time AND re-enforced at resolution (a required field with
  no usable default always resolves `basic`, flagged `visibilityForced`).
- **Org lock**: `locked` may be set on app/tenant rows only; while the
  code/app/tenant tiers resolve locked, user-scope writes are rejected and
  existing user rows are skipped at resolution.
- **Isolation**: a non-bypass tenant context may only resolve/write its own
  tenant (and own user when the context carries one); app-scope writes inside
  a tenant context require super-admin bypass. `resolveBatch` takes identity
  exclusively from the ambient tenant context — the request body cannot
  select another tenant or user.

## Caching and invalidation

- Resolver results cached per `(dbNamespace, objectRef, tenantId, userId)`
  with a 30s TTL (`cache.ts` mirrors smrt-prompts' `getDbNamespace`).
- `FieldPolicy.save()`/`.delete()` invalidate ALL entries for the row's
  `(db, objectRef)` — coarser than prompts because tenant hierarchy makes a
  parent-tenant row affect every descendant's resolution.
- `_smrt_field_policies` rows do NOT ride the client change feed: core's
  change-feed writer deliberately skips `_smrt_`-prefixed system tables, and
  the emit side is private. Live client invalidation is a core-side decision;
  do not add custom push/emit paths here.

## Gotchas

- The sort-order column is `displayOrder` (resolved output exposes `order`):
  a column literally named `order` is an SQL keyword the runtime INSERT path
  does not quote.
- `FieldPolicy` deliberately has NO class-level `@TenantScoped` (the
  prompts/features precedent): resolution legitimately reads app rows and
  ancestor-tenant rows, which the tenancy interceptor would block. Isolation
  is enforced at the resolver/save boundaries instead.
- Identity changes (objectRef/fieldName/scope) on a persisted row go through
  delete-then-insert (transactional when the driver supports it) because the
  natural-key upsert would otherwise collide with the primary key.

## Related

- `@happyvertical/smrt-prompts` / `smrt-languages` / `smrt-features` — the
  same architecture family (override rows + layered resolver + TTL cache)
- Core `FieldUIHints` (#2046) — the `@field({ ui })` code seed this package
  resolves over
