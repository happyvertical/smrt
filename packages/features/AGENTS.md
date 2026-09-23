# smrt-features

Code-first feature flag system with global, app-level, and tenant-hierarchy resolution.

## Core pieces

- `FeatureDefinition` (`_smrt_feature_definitions` table) — code-owned definition mirrored to DB at registration
- `FeatureOverride` (`_smrt_feature_overrides` table) — runtime override state, scoped by `(featureKey, scopeType, scopeId)`
- `FeatureResolver` — resolves the effective state of a feature in a given context, walking the scope chain
- `FeatureSyncService` — keeps `_smrt_feature_definitions` in sync with code-registered defaults at boot
- `FeatureOverrideService` — the only write path; asks a host-supplied authorizer before every write and fails closed (#3013)
- `FeatureSettingsService` — read/write helper for a management screen: `listFeatureSettings()` returns one row per definition (definition fields, `effectiveEnabled`, `globalEffect`, `tenantEffect`), `setFeatureOverride()` refuses unknown keys and scopes the resolver never reads back, then delegates to `FeatureOverrideService` (#3052)
- `./svelte` subpath — `FeatureSettingsPanel`, the presentational management panel (#3052)

## Resolution chain (priority high → low)

1. User scope (`scopeType: 'user'`) — when context includes a userId
2. Tenant scope (`scopeType: 'tenant'`) — walks up the tenant hierarchy when a `FeatureTenantHierarchyProvider` is configured (DI); otherwise resolves a flat tenant scope
3. Global scope (`scopeType: 'global'`, `scopeId: GLOBAL_FEATURE_SCOPE_ID`)
4. Definition default (registered in code)

## Conventions

- Feature keys should be namespaced by package or domain, e.g. `commerce.invoice.draft-mode`, `content.editor.ai-suggestions`
- Definitions are code-owned. Don't write `FeatureDefinition` rows directly — use `FeatureSyncService.syncDefinitions()` at startup with the manifest of expected features
- Neither object exposes generated REST routes, MCP tools, or CLI commands (`api: false`, `mcp: false`, `cli: false`, #3013): override rows can target any scope and the object is not tenant-scoped, so a generated authentication-only surface would let any signed-in principal set another tenant's flag. Hosts write overrides server-side with `FeatureOverrideService` (which requires an explicit authorizer for every write) or `FeatureOverrideCollection.setOverride()` / `removeOverride()` only after their own authorization decision.
- Overrides are write-time validated against the matching definition (effect must be a known `FeatureOverrideEffect`, scope must be valid for the definition's `allowedScopes`)
- Tenant-hierarchy resolution is an optional integration wired by dependency injection (`FeatureTenantHierarchyProvider`), not a static dependency — `smrt-features` never imports `@happyvertical/smrt-users`. Without a configured provider, tenant-hierarchy resolution falls back to a flat tenant scope. (The consumer that wants hierarchy installs `smrt-users` itself and supplies the provider; `smrt-users` is a dev-only dependency here for tests.)

## Management UI (`./svelte`)

- Built like every other Svelte-shipping package here (`smrt-tenancy`/`smrt-personas` are the closest models): `vite build --mode library && svelte-package -i src/svelte -o dist/svelte`, an `./svelte` export with a `svelte` condition, `svelte` as an **optional** peer dependency — plus `scripts/prune-svelte-package-artifacts.js` (as `smrt-content` does), because `svelte-package` otherwise copies `__tests__/` and `*.test.*` into the published `dist/svelte`. The root export stays Svelte-free so server-only consumers are unaffected.
- `FeatureSettingsPanel` is presentational: rows and callbacks in, no fetching, no authorization. `src/svelte/types.ts` deliberately imports nothing from `smrt-core` or the `@smrt()` models, so the browser bundle stays thin; `FeatureSettingsRow` is structurally assignable to `FeatureSettingsView`.
- Each row is its own `<form>`, so `formAction` gives a working screen with no client JS; `onSave` intercepts the submit instead and reads the row's values straight off the form. The global column is opt-in (`showGlobal` / `globalEditable`) because most apps have no platform-admin tier.
- Two invariants the selects have to keep, both regression-tested. (1) The tenant column's *Default* option must never name the code default: the tenant scope inherits the global override and, with a `FeatureTenantHierarchyProvider`, ancestor tenants' overrides too, so `defaultEnabled` would tell an operator the opposite of what choosing it does. `inheritedOptionLabel()` names `FeatureSettingsView.inheritedEnabled` when the row carries it and says "Default (inherited)" otherwise; `FeatureSettingsService` sets it only where it is exactly knowable (no tenant override → inherited is the effective state), never derived from `globalEffect`. The global column does name the code default — nothing sits above global. (2) The rows remount on `contextKey ?? features`, so an unsaved choice cannot survive a reload or a tenant switch and be submitted against the new rows.
- Writes validate the **scope shape** before the authorizer runs: `scopeType` must be `global` or `tenant`, a global write must use `GLOBAL_FEATURE_SCOPE_ID`, and a tenant id must be non-blank and already trimmed. A host authorizer cannot catch this — `scopeType: 'global'` with someone else's tenant id reads as an ordinary global write to an authorizer that only gates the global scope — and the resolver looks rows up by the exact `(featureKey, scopeType, scopeId)` triple, so a row written elsewhere is invisible state, not a setting.
- **Authorization stays with the consumer.** `FeatureSettingsService` reads are unfiltered and every write goes through `FeatureOverrideService`; constructing the settings service without an `authorize` option makes it read-only (writes fail closed). Never add an authorization decision to this package — hosts differ, and the generated surfaces are closed precisely so that decision has to be theirs.
- `vitest.config.ts` runs two projects because the halves need incompatible resolution: `server` (node, `smrtVitestPlugin`) and `svelte` (jsdom, `@sveltejs/vite-plugin-svelte`, `conditions: ['browser']`). The browser condition would send `smrt-core` to its browser build, so it must not be global.

## Feature keys are persisted identifiers

Overrides are stored keyed by the exact `featureKey` string and the resolver looks them up by that string. **Renaming a key orphans every existing override and silently reverts all tenants to the definition default.** Treat a shipped key as immutable; a rename needs a data migration over `_smrt_feature_overrides.feature_key`, not an edit. Renaming the owning package is the usual trigger — keep the old key namespace and let `packageName` track the new package.

## Integration with `@happyvertical/smrt-users`

When `smrt-users` is present, `FeatureResolver` uses it to walk the tenant hierarchy (parent → grandparent → root). Configure via `FeatureTenantHierarchyProvider`. Without it, tenant lookup is single-level.
