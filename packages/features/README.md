# @happyvertical/smrt-features

Code-first feature flags for s-m-r-t applications, with global and tenant-hierarchy resolution.

## Installation

```bash
pnpm add @happyvertical/smrt-features
```

## Quick start

Declare features on their owning class. Import that class before syncing or
resolving it. Supply `dbOptions` for your migrated application database and
`currentTenantId` from your authenticated server context.

```typescript
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  FeatureResolver,
  FeatureSyncService,
} from '@happyvertical/smrt-features';

@smrt({
  packageName: '@your/app',
  features: {
    drafts: {
      defaultEnabled: false,
      label: 'Invoice drafts',
      description: 'Save invoices as drafts before sending.',
    },
  },
})
export class Invoice extends SmrtObject {}

const sync = new FeatureSyncService(dbOptions);
await sync.syncDefinitions({ constructors: [Invoice] });

// This example uses flat tenant resolution.
const resolver = new FeatureResolver(dbOptions, {
  tenantHierarchyLoader: async () => null,
});
const enabled = await resolver.isEnabledFor(Invoice, 'drafts', {
  tenantId: currentTenantId,
});
// Equivalent key-based lookup:
const enabledByKey = await resolver.isEnabled('@your/app:Invoice#drafts', {
  tenantId: currentTenantId,
});
```

Keys have the form `<qualifiedClassName>#<localId>`. The example's key is
`@your/app:Invoice#drafts`. `syncDefinitions()` takes optional `classNames`,
`constructors`, and `pruneStale` options; a filtered sync never prunes sibling
class definitions. An unfiltered sync uses all registered classes and prunes
stale definitions in touched packages by default. `syncManifest()` separately
accepts a s-m-r-t `SmartObjectManifest` containing class decorator metadata.

## Resolution

The resolver starts with the registered class's `defaultEnabled` (falling
back to the synced definition), then applies the global override and tenant
overrides. Without a tenant context, only the global override applies.

The default hierarchy loader discovers `@happyvertical/smrt-users` when
available. Alternatively, supply `tenantHierarchyLoader` as the resolver's
second constructor argument; return a `FeatureTenantHierarchyProvider` or
`null` for flat tenant resolution. Hierarchy traversal runs root to leaf:
a child inherits its parent's state only when the parent has
`cascadePermissions` and the child has `inheritPermissions`; otherwise its
baseline resets to the global state. Each tenant's own override then applies.
`inherit` preserves that baseline. Supported scopes are `global` and `tenant`.

## Storage

- `_smrt_feature_definitions` — code-owned class identity, local id, boolean default, label, description, and metadata
- `_smrt_feature_overrides` — runtime override keyed by feature key, scope type, and scope id

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
package is the usual way this happens: migrate stored keys when the qualified class identity changes.)

## Documentation

- See [`AGENTS.md`](./AGENTS.md) for package-internal patterns
- See [`docs/content/standards.md`](../../docs/content/standards.md) for monorepo conventions
- See [`docs/content/architecture/`](../../docs/content/architecture/) for cross-package architecture
