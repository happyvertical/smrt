# @happyvertical/smrt-features

Code-first feature flags for s-m-r-t applications, with global, app-level, and tenant-hierarchy resolution.

## Installation

```bash
pnpm add @happyvertical/smrt-features
```

## Quick start

```typescript
import {
  FeatureDefinition,
  FeatureResolver,
  FeatureSyncService,
} from '@happyvertical/smrt-features';

// 1. Sync code-defined feature definitions at startup
await FeatureSyncService.syncDefinitions({
  manifest: [
    {
      key: 'commerce.invoice.draft-mode',
      description: 'Allow users to save invoices as drafts before sending',
      defaultEffect: 'enabled',
      allowedScopes: ['global', 'tenant', 'user'],
    },
    // ...
  ],
});

// 2. Resolve at runtime
const enabled = await FeatureResolver.isEnabled('commerce.invoice.draft-mode', {
  tenantId: currentTenantId,
  userId: currentUserId,
});
```

## Resolution

Features resolve in this priority order:

1. **User override** (most specific) — `FeatureOverride` row with `scopeType: 'user'` for the active user
2. **Tenant override** — `FeatureOverride` row with `scopeType: 'tenant'`. Walks the tenant hierarchy if `@happyvertical/smrt-users` is installed.
3. **Global override** — `FeatureOverride` row with `scopeType: 'global'`
4. **Code default** — registered via `FeatureSyncService` from the manifest

The first match wins.

## Storage

- `_smrt_feature_definitions` — code-owned feature shape (default effect, allowed scopes, metadata)
- `_smrt_feature_overrides` — runtime overrides at any scope level

## Generated surfaces

`FeatureDefinition` and `FeatureOverride` ship with generated REST routes,
MCP tools, and CLI commands closed (`api: false`, `mcp: false`,
`cli: false`). Override rows are authorization state for every scope, so
write them only from server code through `FeatureOverrideService`, which
asks an authorizer you bind to the current caller before every write and
fails closed:

```typescript
const service = new FeatureOverrideService(overrides, (request) =>
  request.scopeType === 'tenant' && request.scopeId === session.tenantId &&
  session.permissions.has('features.manage'),
);
await service.setOverride(key, 'tenant', session.tenantId, FeatureOverrideEffect.ENABLE);
```

## Documentation

- See [`AGENTS.md`](./AGENTS.md) for package-internal patterns
- See [`docs/content/standards.md`](../../docs/content/standards.md) for monorepo conventions
- See [`docs/content/architecture/`](../../docs/content/architecture/) for cross-package architecture
