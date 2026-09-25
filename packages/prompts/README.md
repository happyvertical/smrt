# @happyvertical/smrt-prompts

Typed prompt definitions, tenant-aware prompt overrides, and runtime prompt resolution for s-m-r-t applications.

## Installation

```bash
pnpm add @happyvertical/smrt-prompts
```

## Quick start

```typescript
import { definePrompt, resolvePrompt } from '@happyvertical/smrt-prompts';

// 1. Register a prompt's defaults at startup
definePrompt({
  key: 'projects.issue.incorporateFeedback',
  template: 'Rewrite the issue body incorporating this feedback: {feedback}',
  ai: {
    profile: 'default',
    params: { temperature: 0.4 },
  },
});

// 2. Resolve at runtime (auto-uses tenant context from AsyncLocalStorage)
const resolved = await resolvePrompt('projects.issue.incorporateFeedback', {
  vars: { feedback: '...' },
});

// resolved.template — the merged template with overrides applied
// resolved.ai     — the merged AI configuration (profile, model, params)
```

## What this package provides

- **`definePrompt()`** — code-first prompt registration in a global process registry
- **`resolvePrompt()`** — layered resolution: code default → config override → stored app override → stored tenant override → runtime override
- **`PromptOverride`** — model for app-level and tenant-level prompt settings, stored in `_smrt_prompt_overrides`
- **`PromptOverrideService`** / **`PromptSettingsService`** — the authorized write path and the read/write helper for a management screen (see "Management UI" below)
- **Named AI profiles** loaded from `packages.prompts` config — prompts select profile names, profiles resolve to provider/model in config
- **TTL cache** keyed by `(key, tenantId)`, invalidated on override save/delete

Stored overrides support partial fields, so applications can override only the template, profile, model, or AI params without forking the rest of a prompt.

## Generated surfaces

`PromptOverride` ships with generated REST routes, MCP tools, and CLI
commands closed (`api: false`, `cli: false`, `mcp: false`). Override rows are
authorization state for every scope, so write them only from server code
through `PromptOverrideService`, which asks an authorizer you bind to the
current caller before every write and fails closed:

```typescript
const service = new PromptOverrideService(overrides, (request) =>
  request.scopeType === 'tenant' && request.scopeId === session.tenantId &&
  session.permissions.has('prompts.manage'),
);
await service.setTemplateOverride(key, 'tenant', session.tenantId, 'New text.');
```

## Management UI

The package ships the settings screen so consuming apps do not each rebuild
it: `PromptSettingsService` (root export) produces the rows, and
`PromptSettingsPanel` (the `./svelte` subpath) renders them. The root export
stays Svelte-free, so a server-only consumer is unaffected; `svelte` is an
optional peer dependency.

### Consumer recipe

**1. Register the prompt in code** (see Quick start above), including
`editable` if you want tenants or the app-wide default to be overridable:

```typescript
definePrompt({
  key: 'projects.issue.incorporateFeedback',
  template: 'Rewrite the issue body incorporating this feedback: {feedback}',
  description: 'Rewrites an issue body from reviewer feedback.',
  editable: { template: true },
});
```

**2. Load the rows in your server load.** The load is where *your* permission
check lives — the package makes no authorization decision:

```typescript
// src/routes/settings/prompts/+page.server.ts
export async function load(event) {
  const auth = requirePermission(event, APP_PERMISSIONS.tenantAdmin);
  const settings = await PromptSettingsService.create({ db });
  return {
    tenantId: auth.tenantId,
    prompts: await settings.listPromptSettings({ tenantId: auth.tenantId }),
  };
}
```

`listPromptSettings()` returns one `PromptSettingsRow` per registered
key — the effective template for the requested tenant, the raw override text
at each scope (`appTemplate`/`tenantTemplate`), what reverting each scope
produces (`appDefaultTemplate`/`inheritedTemplate`), and `supplyingLevel`. The
row is structurally assignable to the panel's `PromptSettingsView`, so no
mapping step is needed.

**3. Render the panel:**

```svelte
<script lang="ts">
  import { PromptSettingsPanel } from '@happyvertical/smrt-prompts/svelte';
  let { data, form } = $props();
</script>

<PromptSettingsPanel
  prompts={data.prompts}
  contextKey={data.tenantId}
  formAction="?/savePrompt"
  message={form?.message}
  error={form?.error}
/>
```

The panel is presentational: it takes rows and callbacks, fetches nothing and
authorizes nothing. Each row renders the key, description, effective text, and
which level supplied it, plus a checkbox + text editor for the tenant scope
(and, when `showApp`/`appEditable` are set, the app scope). Unchecking the box
reverts that scope — the preview text next to it shows exactly what reverting
produces. Supply `onSave` instead of `formAction` to drive it from a client
handler.

**4. Wire the write with your own permission check.** `setPromptOverride()`
refuses any key without a definition and any field the definition's
`editable` config disallows, then delegates to `PromptOverrideService`, which
asks your authorizer and fails closed:

```typescript
export const actions = {
  savePrompt: async (event) => {
    const auth = requirePermission(event, APP_PERMISSIONS.tenantAdmin);
    const form = await event.request.formData();
    const settings = await PromptSettingsService.create(
      { db },
      {
        // Your decision, bound to this caller. Returning anything but `true` denies.
        authorize: (request) =>
          request.scopeType === 'tenant' && request.scopeId === auth.tenantId,
      },
    );

    try {
      await settings.setTenantPromptOverride(
        String(form.get('key') ?? ''),
        auth.tenantId,
        form.has('tenantOverride') ? String(form.get('tenantTemplate') ?? '') : null,
      );
    } catch (error) {
      if (error instanceof UnknownPromptKeyError) return fail(400, { error: 'Unknown prompt.' });
      if (error instanceof PromptFieldNotEditableError) return fail(400, { error: 'Not editable.' });
      if (error instanceof InvalidPromptScopeError) return fail(400, { error: 'Invalid scope.' });
      if (error instanceof PromptOverrideAuthorizationError) return fail(403, { error: 'Not permitted.' });
      throw error;
    }
    return { message: 'Prompt overrides saved.' };
  },
};
```

Constructing the service **without** an `authorize` option makes it
read-only: every write then fails closed with
`PromptOverrideAuthorizationError`. That is the right shape for a load
function.

### What the consumer still owns

- the route, its navigation entry, and the page shell;
- the permission check on both the load and the action;
- the `authorize` callback (this package never decides who may write);
- resolving the session's `tenantId` — a tenant id from the URL or a form
  field is a selector, not authorization;
- registering prompts with `definePrompt()` at startup.

### Prompt keys are persisted identifiers

Overrides are stored keyed by the exact `key` string and resolved by that
string at runtime. **Renaming a key orphans every existing override**,
silently reverting all tenants to the registry default — the change looks
harmless in a diff and shows up as prompt text mysteriously resetting. Treat a
key as immutable once shipped. A rename needs a data migration that rewrites
`_smrt_prompt_overrides.key`, not an edit.

## Documentation

- See [`AGENTS.md`](./AGENTS.md) for package-internal patterns
- See [`docs/content/standards.md`](../../docs/content/standards.md) for monorepo conventions
- See related: [`@happyvertical/smrt-languages`](../languages) (mirrors this package for language strings), [`@happyvertical/smrt-features`](../features) (feature flags — same management-UI treatment, #3052)
