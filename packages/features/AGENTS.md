# smrt-features

Code-first feature flag system with global and tenant-hierarchy resolution.

## Core pieces

- `FeatureDefinition` (`_smrt_feature_definitions` table) — code-owned definition mirrored to DB at registration
- `FeatureOverride` (`_smrt_feature_overrides` table) — runtime override state, scoped by `(featureKey, scopeType, scopeId)`
- `FeatureResolver` — resolves the effective state of a feature in a given context, walking the scope chain
- `FeatureSyncService` — keeps `_smrt_feature_definitions` in sync with code-registered defaults at boot
- `FeatureOverrideService` — the only write path; asks a host-supplied authorizer before every write and fails closed (#3013)
- `FeatureSettingsService` — read/write helper for a management screen: `listFeatureSettings()` returns one row per definition (definition fields, `effectiveEnabled`, `globalEffect`, `tenantEffect`), `setFeatureOverride()` refuses unknown keys and scopes the resolver never reads back, then delegates to `FeatureOverrideService` (#3052)
- `./svelte` subpath — `FeatureSettingsPanel`, the presentational management panel (#3052)

## Resolution chain (priority high → low)

1. Tenant scope (`scopeType: 'tenant'`) — root-to-leaf traversal; a child inherits only when its parent allows cascading and it allows inheritance, otherwise its baseline resets to the post-global state (grant, then global override)
2. Global scope (`scopeType: 'global'`, `scopeId: GLOBAL_FEATURE_SCOPE_ID`) — applies on top of the grant; `inherit` keeps the granted state
3. Plan grant (#4761) — a key the tenant's plan grants becomes enabled; an ungranted key keeps its default
4. Boolean `defaultEnabled` from the registered class or framework definition, falling back to its synced definition

`FeatureResolver` is instantiated with database options; call `isEnabled(key, { tenantId, grantSource? })`, `explain(key, context)` (`{ enabled, decidedBy }`, the layer that set the state; the gate reads it), or `isEnabledFor(Class, localId, { tenantId })` on that instance. With no tenant context only global/default apply (grants are tenant-level). There is no user scope.

## Plan grants, standard keys, gates (#4761)

- **Grant source slot.** Features never imports `smrt-subscriptions`. A `FeatureGrantSource` (`getGrants(tenantId)`, optional `findGrantingPlan()`) is taken from `context.grantSource`, else `FeatureResolverOptions.grantSource`, else the global slot (`setFeatureGrantSource()`, stored under `Symbol.for(FEATURE_GRANT_SOURCE_SLOT_KEY)`; `smrt-subscriptions` writes the same key, so never rename it). `null` at either level disables grants. No source = no grants = pre-#4761 behavior. Local installs get a source from the signed device entitlement cache in `smrt-app-runtime` (`./device-entitlements`, #4787), registered through this slot; features never imports it. A global override outranks a plan grant: a global row is an explicit operator act, so a global DISABLE stops the feature fleet-wide, granted tenants included. Tenant overrides still beat both (the per-tenant escape hatch). Grant-source errors propagate (an outage must not read as "no plan").
- **Framework features** (`framework-features.ts`): dotted keys (`inference.hosted`) owned by no class, registered on `globalThis` via `defineFrameworkFeature()` (identical re-definition is a no-op, a conflicting one throws). The resolver reads their default before the class registry. `FeatureSyncService.syncFrameworkDefinitions()` upserts them as rows with an empty `qualifiedClassName`; class-sync pruning skips those rows.
- **Standard paid keys** (`standard-features.ts`): `FEATURE_SYNC_DEVICES`, `FEATURE_BACKUP_VAULT`, `FEATURE_CLOUD_HOSTED`, `FEATURE_INFERENCE_HOSTED`, `FEATURE_PLUGINS_REMOTE` (also `STANDARD_FEATURE_KEYS`, `STANDARD_FEATURES`); all `metadata.paid: true`, default off, seeded lazily (no import side effect). Gates import the constants, never string literals; plans grant the same strings.
- **Gates** (`require-feature.ts`): `requireFeature(key, { resolver, tenantId, grantSource? })` throws `FeatureUnavailableError` (`status` 403, `.code`, `.denial`, `.toResponse()`) for services; `featureGateResponse()` returns `null` or the JSON denial `Response` (`featureDenialResponse()`) for SvelteKit routes; `checkFeature()` returns `{ allowed, featureKey, denial? }`. `FeatureGateDenial` is a union discriminated by `code`, sharing `featureKey`, `label`, `paid`, `tenantId`, `message`: `feature_upgrade_required` (`FEATURE_UPGRADE_REQUIRED_CODE`) adds `grantingPlan`; `feature_disabled` (`FEATURE_DISABLED_CODE`) adds `disabledBy` and names no plan. The gate answers `feature_disabled` when `explain()` reports a global or tenant DISABLE decided the state (no upgrade could help) and never calls `findGrantingPlan()` then; otherwise a failing plan lookup only nulls `grantingPlan`. Never a bare 403. Semantics are "feature present", not identity: callers authenticate and authorize the principal and pass the tenant they verified.

## Kill switches (#4760)

`src/kill-switch.ts`: `readKillSwitch()` / `setKillSwitch()` /
`KillSwitchService` store DISABLE rows in `_smrt_feature_overrides` but
read them as an incident lever, not a flag: a global DISABLE wins over
everything, then the tenant's own DISABLE; ENABLE/INHERIT rows are
ignored, so "on" means no DISABLE row and enabling deletes it. Tenant rows
are written lower-cased and read in either spelling; enabling clears every
spelling. Reads are uncached. Kill-switch keys have no definition (so
`FeatureResolver` refuses them and `FeatureSettingsService` never lists
them). Keys belong to their consumer: `inference.hosted.enabled` is
smrt-inference's `HOSTED_INFERENCE_KILL_SWITCH`. `KillSwitchService.set()`
writes without an authorizer (the CLI's database credentials are the
authorization); admin UIs write through `FeatureOverrideService`.

## Conventions

- Declare features in `@smrt({ features: { drafts: { defaultEnabled: false } } })`. Keys are `<qualifiedClassName>#<localId>`, e.g. `@your/app:Invoice#drafts`.
- Definitions are code-owned. Construct `new FeatureSyncService(dbOptions)` and call `syncDefinitions({ classNames?, constructors?, pruneStale? })`; filtered syncs never prune siblings. `syncManifest(manifest)` accepts a SMRT class manifest with decorator metadata.
- Neither object exposes generated REST routes, MCP tools, or CLI commands (`api: false`, `mcp: false`, `cli: false`, #3013): override rows can target any scope and the object is not tenant-scoped, so a generated authentication-only surface would let any signed-in principal set another tenant's flag. Hosts write overrides server-side with `FeatureOverrideService` (which requires an explicit authorizer for every write) or `FeatureOverrideCollection.setOverride()` / `removeOverride()` only after their own authorization decision.
- `FeatureOverrideCollection.setOverride()` persists typed values but does not validate them against a definition. `FeatureOverrideService` adds authorization; `FeatureSettingsService` additionally rejects unknown keys and invalid scope shapes. Definitions have no `allowedScopes` or `defaultEffect` fields.
- The default hierarchy loader dynamically discovers `@happyvertical/smrt-users`; a missing dependency falls back to flat tenant lookup. Hosts can override `tenantHierarchyLoader` with a provider or `null`. Other loading failures propagate.
- Every collection this package builds internally (`FeatureResolver`'s ancestor-chain override read, `FeatureSettingsService`'s catalog enumeration, `FeatureSyncService`'s prune enumeration) is created through the internal `src/list-bounds.ts#withoutListBounds`, so a host-configured `defaultListLimit`/`maxListLimit` on the caller's options bag can never silently truncate one of these correctness-critical reads (#3056, same hazard class as `smrt-users`' `authorization-read-options.ts#withoutListBounds`, #3048). Neither object exposes a generated, paginated list surface (see above), so there is no legitimate internal read here that a host bound should reach. The helper is local to avoid a required dependency on `smrt-users`.

## Management UI (`./svelte`)

- Built like every other Svelte-shipping package here (`smrt-tenancy`/`smrt-personas` are the closest models): `vite build --mode library && svelte-package -i src/svelte -o dist/svelte`, an `./svelte` export with a `svelte` condition, `svelte` as an **optional** peer dependency — plus `scripts/prune-svelte-package-artifacts.js` (as `smrt-content` does), because `svelte-package` otherwise copies `__tests__/` and `*.test.*` into the published `dist/svelte`. The root export stays Svelte-free so server-only consumers are unaffected.
- `FeatureSettingsPanel` is presentational: rows and callbacks in, no fetching, no authorization. `src/svelte/types.ts` deliberately imports nothing from `smrt-core` or the `@smrt()` models, so the browser bundle stays thin; `showKeys` (default true) hides the raw key/package lines for end-user surfaces while keeping the hidden `featureKey` input; `FeatureSettingsRow` is structurally assignable to `FeatureSettingsView`.
- Each row is its own `<form>`, so `formAction` gives a working screen with no client JS; `onSave` intercepts the submit instead and reads the row's values straight off the form. The global column is opt-in (`showGlobal` / `globalEditable`) because most apps have no platform-admin tier.
- Two invariants the selects have to keep, both regression-tested. (1) The tenant column's *Default* option must never name the code default: the tenant scope inherits the global override and, with a `FeatureTenantHierarchyProvider`, ancestor tenants' overrides too, so `defaultEnabled` would tell an operator the opposite of what choosing it does. `inheritedOptionLabel()` names `FeatureSettingsView.inheritedEnabled` when the row carries it and says "Default (inherited)" otherwise; `FeatureSettingsService` sets it only where it is exactly knowable (no tenant override → inherited is the effective state), never derived from `globalEffect`. The global column does name the code default — nothing sits above global. (2) The rows remount on `contextKey ?? features`, so an unsaved choice cannot survive a reload or a tenant switch and be submitted against the new rows.
- Writes validate the **scope shape** before the authorizer runs: `scopeType` must be `global` or `tenant`, a global write must use `GLOBAL_FEATURE_SCOPE_ID`, and a tenant id must be non-blank and already trimmed. A host authorizer cannot catch this — `scopeType: 'global'` with someone else's tenant id reads as an ordinary global write to an authorizer that only gates the global scope — and the resolver looks rows up by the exact `(featureKey, scopeType, scopeId)` triple, so a row written elsewhere is invisible state, not a setting.
- **Authorization stays with the consumer.** `FeatureSettingsService` reads are unfiltered and every write goes through `FeatureOverrideService`; constructing the settings service without an `authorize` option makes it read-only (writes fail closed). Never add an authorization decision to this package — hosts differ, and the generated surfaces are closed precisely so that decision has to be theirs.
- `vitest.config.ts` runs two projects because the halves need incompatible resolution: `server` (node, `smrtVitestPlugin`) and `svelte` (jsdom, `@sveltejs/vite-plugin-svelte`, `conditions: ['browser']`). The browser condition would send `smrt-core` to its browser build, so it must not be global.

## Feature keys are persisted identifiers

Overrides are stored keyed by the exact `featureKey` string and the resolver looks them up by that string. **Renaming a key orphans every existing override and silently reverts all tenants to the definition default.** Treat a shipped key as immutable; a rename needs a data migration over `_smrt_feature_overrides.feature_key`, not an edit. Renaming the owning package is the usual trigger — migrate persisted keys when the qualified class identity changes.

## Integration with `@happyvertical/smrt-users`

When `smrt-users` is present, `FeatureResolver` uses it to walk the tenant hierarchy (parent → grandparent → root). The default loader discovers it dynamically; a custom `tenantHierarchyLoader` may supply a `FeatureTenantHierarchyProvider`. Without it, tenant lookup is single-level.
