# smrt-features

Code-first feature flag system with global, app-level, and tenant-hierarchy resolution.

## Core pieces

- `FeatureDefinition` (`_smrt_feature_definitions` table) — code-owned definition mirrored to DB at registration
- `FeatureOverride` (`_smrt_feature_overrides` table) — runtime override state, scoped by `(featureKey, scopeType, scopeId)`
- `FeatureResolver` — resolves the effective state of a feature in a given context, walking the scope chain
- `FeatureSyncService` — keeps `_smrt_feature_definitions` in sync with code-registered defaults at boot

## Resolution chain (priority high → low)

1. User scope (`scopeType: 'user'`) — when context includes a userId
2. Tenant scope (`scopeType: 'tenant'`) — walks up the tenant hierarchy via `@happyvertical/smrt-users` if present
3. Global scope (`scopeType: 'global'`, `scopeId: GLOBAL_FEATURE_SCOPE_ID`)
4. Definition default (registered in code)

## Conventions

- Feature keys should be namespaced by package or domain, e.g. `commerce.invoice.draft-mode`, `content.editor.ai-suggestions`
- Definitions are code-owned. Don't write `FeatureDefinition` rows directly — use `FeatureSyncService.syncDefinitions()` at startup with the manifest of expected features
- Overrides are write-time validated against the matching definition (effect must be a known `FeatureOverrideEffect`, scope must be valid for the definition's `allowedScopes`)
- The `@happyvertical/smrt-users` peer is optional — without it, tenant-hierarchy resolution falls back to a flat tenant scope

## Integration with `@happyvertical/smrt-users`

When `smrt-users` is present, `FeatureResolver` uses it to walk the tenant hierarchy (parent → grandparent → root). Configure via `FeatureTenantHierarchyProvider`. Without it, tenant lookup is single-level.
