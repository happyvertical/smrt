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

## Management UI

The package ships the settings screen so consuming apps do not each rebuild
it: `FeatureSettingsService` (root export) produces the rows, and
`FeatureSettingsPanel` (the `./svelte` subpath) renders them. The root export
stays Svelte-free, so a server-only consumer is unaffected; `svelte` is an
optional peer dependency.

### Consumer recipe

**1. Declare the definitions in code.** Feature toggles are declared on the
`@smrt()` decorator of the class they belong to:

```typescript
@smrt({
  features: {
    drafts: { defaultEnabled: false, label: 'Invoice drafts', description: 'Save invoices as drafts before sending.' },
  },
})
export class Invoice extends SmrtObject {}
```

**2. Sync them at startup**, so `_smrt_feature_definitions` matches code:

```typescript
await new FeatureSyncService(dbOptions).syncDefinitions();
```

**3. Load the rows in your server load.** The load is where *your*
permission check lives — the package makes no authorization decision:

```typescript
// src/routes/settings/features/+page.server.ts
export async function load(event) {
  const auth = requirePermission(event, APP_PERMISSIONS.tenantAdmin);
  const settings = await FeatureSettingsService.create(dbOptions);
  return {
    tenantId: auth.tenantId,
    features: await settings.listFeatureSettings({
      tenantId: auth.tenantId,
      packageName: '@your/app',
    }),
  };
}
```

`listFeatureSettings()` returns one `FeatureSettingsRow` per definition —
the definition fields, `effectiveEnabled` as `FeatureResolver` resolves it
for that tenant, and `globalEffect` / `tenantEffect` for the raw override row
at each level. The row is structurally assignable to the panel's
`FeatureSettingsView`, so no mapping step is needed.

**4. Render the panel:**

```svelte
<script lang="ts">
  import { FeatureSettingsPanel } from '@happyvertical/smrt-features/svelte';
  let { data, form } = $props();
</script>

<FeatureSettingsPanel
  features={data.features}
  tenantLabel="Shop"
  contextKey={data.tenantId}
  formAction="?/saveFeature"
  message={form?.message}
  error={form?.error}
/>
```

The panel is presentational: it takes rows and callbacks, fetches nothing and
authorizes nothing. Each row renders label, description, key, effective state
and a **Default / Enable / Disable** control, where *Default* removes the
override row and returns the feature to whatever the level above resolves to.
Pass `showGlobal` (and `globalEditable`) only if your app has a platform-admin
tier; apps without one omit the column entirely. Supply `onSave` instead of
`formAction` to drive it from a client handler.

Two details worth knowing:

- The tenant column's *Default* option never names the code default, because
  the tenant scope inherits — from the global override, and, when a
  `FeatureTenantHierarchyProvider` is configured, from ancestor tenants too. It
  names the inherited state when the row carries `inheritedEnabled` (the helper
  sets it whenever it is exactly knowable, i.e. when the tenant has no override
  of its own) and otherwise reads "Default (inherited)". The global column's
  *Default* does name the code default, because the global scope inherits
  nothing.
- Unsaved edits are discarded whenever `contextKey` changes, or, when you omit
  it, whenever `features` is replaced with a new array. Pass the tenant id as
  `contextKey` so a half-made choice for one tenant can never be submitted
  against another's rows.

**5. Wire the write with your own permission check.** `setFeatureOverride()`
refuses any key without a definition and any scope the resolver would never
read back — an unknown `scopeType`, a global write under anything but
`GLOBAL_FEATURE_SCOPE_ID`, or a blank/untrimmed tenant id — then delegates to
`FeatureOverrideService`, which asks your authorizer and fails closed:

```typescript
export const actions = {
  saveFeature: async (event) => {
    const auth = requirePermission(event, APP_PERMISSIONS.tenantAdmin);
    const form = await event.request.formData();
    const settings = await FeatureSettingsService.create(dbOptions, {
      // Your decision, bound to this caller. Returning anything but `true` denies.
      authorize: (request) =>
        request.scopeType === 'tenant' && request.scopeId === auth.tenantId,
    });

    try {
      await settings.setTenantFeatureOverride(
        String(form.get('featureKey') ?? ''),
        auth.tenantId,
        featureOverrideEffectFromValue(form.get('tenantEffect')),
      );
    } catch (error) {
      if (error instanceof UnknownFeatureKeyError) return fail(400, { error: 'Unknown feature.' });
      if (error instanceof InvalidFeatureScopeError) return fail(400, { error: 'Invalid scope.' });
      if (error instanceof FeatureOverrideAuthorizationError) return fail(403, { error: 'Not permitted.' });
      throw error;
    }
    return { message: 'Feature overrides saved.' };
  },
};
```

Constructing the service **without** an `authorize` option makes it
read-only: every write then fails closed with
`FeatureOverrideAuthorizationError`. That is the right shape for a load
function.

### What the consumer still owns

- the route, its navigation entry, and the page shell;
- the permission check on both the load and the action;
- the `authorize` callback (this package never decides who may write);
- resolving the session's `tenantId` — a tenant id from the URL or a form
  field is a selector, not authorization;
- calling `FeatureSyncService` at startup.

### Feature keys are persisted identifiers

Overrides are stored keyed by the exact `featureKey` string and resolved by
that string at runtime. **Renaming a key orphans every existing override**,
silently reverting all tenants to the definition default — the change looks
harmless in a diff and shows up as flags mysteriously resetting. Treat a key
as immutable once shipped. A rename needs a data migration that rewrites
`_smrt_feature_overrides.feature_key`, not an edit. (Renaming the owning
package is the usual way this happens: keep the old key namespace and let
`packageName` track the new package.)

## Documentation

- See [`AGENTS.md`](./AGENTS.md) for package-internal patterns
- See [`docs/content/standards.md`](../../docs/content/standards.md) for monorepo conventions
- See [`docs/content/architecture/`](../../docs/content/architecture/) for cross-package architecture
