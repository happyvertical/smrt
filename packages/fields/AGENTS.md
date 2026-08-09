# smrt-fields

Layered field policy store and resolution engine (epic #2045). Personalizes
per-field `{defaultValue, visibility, help, label, order, locked}` for any
`@smrt()` object at app, tenant, and user scope over the code seed.

## Core pieces

- `FieldPolicy` (`_smrt_field_policies` table) — sparse override rows keyed
  `(objectRef, fieldName, scopeType, scopeKey)`; NULL column = inherit from
  the lower layer, reset = row DELETE (later lower-layer changes flow through)
- `FieldPolicyCollection` — write surface plus the `resolveBatch` custom
  collection-scoped action (`POST /<collection>/resolve`). NO generated
  surface exposes read verbs: API `list`/`get` on this non-tenant-scoped
  model would enumerate every tenant's and user's rows; the model's CLI is
  writes-only (the generated CLI invokes over HTTP, and the cli↔api
  coherence gate rejects CLI entries without API routes); the runtime
  CLI/MCP surfaces are closed by the collection config (ContentContributions
  precedent). Reads go through `resolveBatch` (context-scoped) or the
  server-side resolver. Keep the api include lists in lockstep: a decorated
  collection's config is the RUNTIME registry authority for its item class,
  while build-time generation reads each manifest object's own config. Both
  transports dispatch the action: generated SvelteKit routes natively, and
  core's runtime `APIGenerator` via its decorator-route dispatch
  (single-segment collection-scoped paths; multi-segment custom paths remain
  SvelteKit-only).
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
   uses `@happyvertical/smrt-users`' `TenantCollection`; an injected loader
   may return no provider (or no chain for a tenant), which falls back to a
   flat single-tenant chain. `smrt-users` itself is a required Fields runtime
   dependency for policy authorization, not an optional hierarchy dependency.
   A node that breaks permission
   inheritance discards every earlier tenant contribution (chain-structural),
   so only the suffix from the LAST break participates — in merging AND in
   the explained layers, which therefore replay to the merged result
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
  system fields, relationship pseudo-fields, and STI meta storage fields are
  not policy-addressable (the resolver excludes them, so rows would silently
  never apply).
- **Security rail**: defaults are refused on `transient`, `sensitive`, and
  `readPermission`-gated fields (both top-level and `_meta` flags checked).
  Reference-field (`foreignKey`/`crossPackageRef`) defaults must be UUID
  strings unless the field declares `idType: 'text'` — the columns are
  native UUID on PostgreSQL/DuckDB and a non-UUID default would fail at
  insert time. `resolveBatch` responses omit sensitive/read-permission-gated
  fields for every caller (fail closed) and transient fields
  (client-emission parity).
- **Required-field invariant**: demoting a required field to
  advanced/hidden requires a usable resolved default (not null/empty) —
  enforced at write time AND re-enforced at resolution (a required field with
  no usable default always resolves `basic`, flagged `visibilityForced`).
- **Org lock**: `locked` may be set on app/tenant rows only; while the
  code/app/tenant tiers resolve locked, user-scope writes are rejected and
  existing user rows are skipped at resolution.
- **Write-time org checks reuse the resolver**: the required-demotion default
  and the user-write lock are computed by `resolveFieldPolicy` over the org
  tiers (default hierarchy loader), so cascading ancestor-tenant defaults and
  locks are honored at save time too. On updates the persisted row is excluded
  from projected lower-layer resolution, so clearing the row's only default
  while demoting a required field is rejected before mutation; that projected
  lookup bypasses the shared cache. The resolver-side safety net remains
  authoritative when a different row is later deleted.
- **Isolation — a MISSING identity component DENIES, it never skips.** This
  is the package rule; both the write guard
  (`FieldPolicy.assertScopeOwnedByAmbientContext`) and the read guard
  (`assertResolutionAllowedInContext`) obey it. A non-bypass tenant context
  may only resolve/write its own tenant, and the user tier only for its own
  user id — a context carrying permissions but NO `userId` (no `resolveUserId`
  hook configured: API-key auth, service principals, background jobs, a bare
  `withTenant({ tenantId })`) may not touch the user tier at all. Skipping
  that check instead of denying it was a live ownership bypass: user rows are
  `tenantId: null` by design, so nothing else contains such a write. App-scope
  writes inside a tenant context require super-admin bypass. `fields.policy.manage`
  authorizes app/tenant policy mutations; `fields.policy.personalize` authorizes
  only the caller's user tier (default-seeded for built-in roles). With NO ambient
  identity at all (tenancy ALS never entered), policy writes/deletes fail closed;
  trusted system and super-admin contexts retain their explicit bypasses.
  Context-LESS *reads* stay allowed because `resolveFieldPolicy` is a trusted
  server-side API. `save()`/`delete()`
  on an existing row additionally authorize against the row's PERSISTED
  scope, looked up by primary key AND — because a generated create always
  mints a fresh UUID while the `conflictColumns` upsert still replaces the
  occupant — by NATURAL key. `resolveBatch` takes identity exclusively from
  the ambient context; the request body cannot select another tenant or user.
- **Scope attribution**: inside an ambient context the model DERIVES a
  missing `tenantId` (tenant rows) or `userId` (user rows) from that context,
  and always stamps `updatedBy` from it. Core's mass-assignment guard treats
  `tenantId` as server-managed and strips it from every generated write body
  while `FieldPolicy` is deliberately not `@TenantScoped`, so without this the
  org tier is write-dead over REST/SvelteKit (scope-shape validation throws).
  Deriving grants nothing — the ownership guard already pinned the value to
  the ambient one. An explicit value is never overwritten, so a super-admin
  bypass caller writing ANOTHER tenant's row must go through a server-side
  model call; the generated routes still strip it.

## Caching and invalidation

- Resolver results cached per
  `(dbNamespace, objectRef, tenantId, userId, hierarchyLoader)` with a 30s TTL
  (`cache.ts` mirrors smrt-prompts' `getDbNamespace`). The loader identity is
  part of the key because an injected `tenantHierarchyLoader` yields a
  different ancestor chain — and so different defaults/locks — for the same
  `(db, objectRef, tenant, user)`; it goes LAST so the `(db, objectRef)`
  prefix scan still invalidates every loader's entries.
- `FieldPolicy.save()`/`.delete()` invalidate ALL entries for the row's
  `(db, objectRef)` — coarser than prompts because tenant hierarchy makes a
  parent-tenant row affect every descendant's resolution.
- `_smrt_field_policies` rows do NOT ride the client change feed: core's
  change-feed writer deliberately skips `_smrt_`-prefixed system tables, and
  the emit side is private. Live client invalidation is a core-side decision;
  do not add custom push/emit paths here.

## Gotchas

- Defaults have TWO explicit constructor channels, never sniffed:
  `defaultValue` is ALREADY JSON-encoded (the wire contract — generated write
  routes hand the request body straight to the constructor, and #2049's gear
  posts `JSON.stringify(draft.defaultValue)`), while `defaultValueRaw` is a
  plain value that is always serialized, strings included. Passing both throws.
  One option cannot carry both meanings: `'"TBD"'` and `'TBD'` are
  indistinguishable, so `{ defaultValue: 'Net 30' }` is a parse error that
  names `defaultValueRaw` in its message. `setDefaultValue()` is the
  method-level plain channel.
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
- `FieldPolicyCollection` MUST repeat FieldPolicy's `conflictColumns`. A
  decorated collection emits its OWN manifest schema for the item's table, and
  without the natural key that schema falls back to SmrtObject's default unique
  `(slug, context)` index; manifest-driven migrations aggregate both onto
  `_smrt_field_policies`, where the stray index rejects legitimate layered rows
  (all policy rows have NULL slug/context). The runtime registry cannot catch
  this — `getAllSchemas()` is keyed by TABLE name, so the two schemas collapse
  into one entry. Pinned against the generated manifest in
  `generated-surfaces.test.ts`.
- `withSystemContext()` does NOT unlock tenant/user-scope writes:
  `getCurrentTenant()` returns undefined inside it, so the context-absent rule
  rejects those tiers before any bypass check. Seeds and migrations that must
  write org/user rows use a `superAdminBypass` context instead.
- The MODEL's `cli`/`mcp` decorator config is dead at runtime: the registry
  re-registers the item slot with the COLLECTION's config wholesale, so
  `FieldPolicyCollection`'s `cli: false, mcp: false` is what actually closes
  those surfaces. Keep both in lockstep anyway — build-time generation reads
  the model's own config. Related: `ObjectRegistry.getTableName(
  'FieldPolicyCollection')` resolves to the UNPREFIXED collection fallback
  `field_policies`; persistence uses the item class
  (`_smrt_field_policies`), and both are pinned in
  `generated-surfaces.test.ts`.

## Svelte generated forms (#2049)

- `ObjectForm` accepts direct generated `fields` plus a resolved `policy` for
  SSR and explicit hosts, or accepts only `objectRef` beneath an
  `ObjectFormSourceProvider`. `ObjectFormSourceRegistry` is per app and maps
  canonical refs to generated web collection definitions before calling the
  generated `resolveBatch` custom action. It uses structural types only: this
  package must never import `smrt-web`.
- Generated custom-action clients resolve `Promise<any>`; validate their
  `policies[objectRef]` response at the registry boundary and fail closed on a
  missing/mismatched definition or policy. The component renders an accessible
  loading state and alert rather than a partial form.
- Browser manifest types are `text`, `integer`, `decimal`, `boolean`,
  `datetime`, `json`, `foreignKey`, and `crossPackageRef`; there is no `select`
  wire type. Apps use the per-app `FieldInputRegistry.registerField` seam for
  select-like widgets. Reference fields intentionally default to identifier
  inputs unless an app supplies a chooser.
- `policyToVisibleColumnIds(policy, columns)` feeds smrt-ui `DataTable`'s
  `visibleColumnIds`; it filters policy-hidden mapped fields, preserves unmapped
  computed/action columns, and cannot reveal a static `column.hidden` column.

## Defaults control panel (#2050)

- `buildFieldPolicySettingsCatalog()` is the server-side, URL/GET-driven
  catalog builder. It structurally targets `SettingsCatalog`, but this package
  must not import `smrt-svelte`; hosts inject `SettingsCatalog` into
  `FieldPolicyControlPanel` and retain their own route and transport adapters.
- `policyAudit` is the only routed organization roll-up. It requires
  `fields.policy.manage`, returns only the caller tenant's editable rows and
  read-only app summaries, and represents other users strictly as per-field
  counts. It resolves only requested page refs; never pre-resolve the catalog.
- Display code/app/org values by replaying the explained resolver layers, not
  by independently calculating precedence. Reset and drift prune are ordinary
  model deletes, so existing scope/permission validation remains authoritative.
  The panel asks for an explicit confirmation before either destructive action;
  SSR hosts can inject that confirmation decision instead of relying on
  `window.confirm`.
- `fieldPolicyControlPanelNavItem()` is a structural AdminShell tenant-nav
  seam. It never imports `smrt-svelte` or `smrt-web`; the host supplies the
  returned entry and must enforce its real route permission server-side.

## Related

- `@happyvertical/smrt-prompts` / `smrt-languages` / `smrt-features` — the
  same architecture family (override rows + layered resolver + TTL cache)
- Core `FieldUIHints` (#2046) — the `@field({ ui })` code seed this package
  resolves over
