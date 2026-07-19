# @happyvertical/smrt-svelte

Svelte 5 component library for the s-m-r-t framework. Provides UI components, browser AI integration (STT/TTS/LLM with warm cache), a theme system, permission-aware rendering, and module UI registry for agent admin panels.

## Installation

```bash
pnpm add @happyvertical/smrt-svelte
```

## Usage

### Provider Setup

```svelte
<script>
  import { Provider } from '@happyvertical/smrt-svelte';
  let { children } = $props();
</script>

<Provider user={data.user} permissions={data.permissions}
  ai={{ preload: 'idle', stt: { type: 'whisper-cpp' } }}>
  {@render children()}
</Provider>
```

### Form Components

```svelte
<script>
  import { TextInput, Select, MoneyInput, DateTimeInput, Toggle } from '@happyvertical/smrt-svelte/forms';
</script>

<TextInput label="Name" bind:value={name} />
<MoneyInput label="Price" bind:value={price} currency="USD" />
<DateTimeInput label="Launch Date" bind:value={date} />
<Toggle label="Active" bind:checked={active} />
```

### UI Foundation

```svelte
<script>
  import { Button, Card, Badge, Pagination } from '@happyvertical/smrt-ui/ui';
  import { DataTable } from '@happyvertical/smrt-ui/data';
</script>

<Card>
  <DataTable columns={cols} data={rows} pageSize={20} />
  <Pagination currentPage={1} totalPages={5} />
</Card>
```

### Permission-Aware Rendering

```svelte
<script>
  import { PermissionCheck, permission } from '@happyvertical/smrt-svelte';
</script>

<PermissionCheck requires="admin:write">
  <button>Admin Action</button>
</PermissionCheck>

<!-- Or as a Svelte action -->
<div use:permission={{ slug: 'admin:read', permissions: userPermissions }}>
  Protected content
</div>
```

### Theme System

```svelte
<script>
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
</script>

<ThemeProvider preset="glass" colorScheme="system">
  {@render children()}
</ThemeProvider>
```

### Admin Workspace

```svelte
<script lang="ts">
  import { manifest } from '$lib/smrt-manifest';
  import {
    AdminShell,
    TenantNav,
    tenantNavFromManifest,
  } from '@happyvertical/smrt-svelte/workspace';

  let { children } = $props();

  const sections = tenantNavFromManifest(manifest, {
    sectionHints: {
      '@happyvertical/smrt-content': 'Content',
      '@happyvertical/smrt-profiles': 'Profiles',
    },
  });

</script>

<AdminShell title="Admin">
  {#snippet tenantPanel()}
    <TenantNav items={sections} currentHref="/admin/articles" />
  {/snippet}

  {@render children?.()}
</AdminShell>
```

Filter the same manifest by role permissions when only a subset of resources
should be visible:

```ts
import { tenantNavFromManifest } from '@happyvertical/smrt-svelte/workspace';

const editorSections = tenantNavFromManifest(manifest, {
  permittedResources: [
    '@happyvertical/smrt-content:Article',
    '@happyvertical/smrt-content:Document',
  ],
  sectionHints: {
    '@happyvertical/smrt-content': 'Content',
  },
});
```

In SvelteKit, build the nav in a `+layout.server.ts` (server-side, no client
fetch) and mount `AdminShell` in `+layout.svelte`. The `template-sveltekit`
scaffold adopts AdminShell as its default chrome exactly this way; copy its
`src/routes/+layout.server.ts` / `+layout.svelte` / `settings/+page.svelte`.

- **Migration guide** (first-generation `WorkspaceShell`/`RoleShell` →
  `AdminShell`; adoption is additive and non-breaking):
  [`src/components/workspace/MIGRATION.md`](./src/components/workspace/MIGRATION.md)
- **Playground demos**: `playground/src/routes/admin-shell` exercises all four
  scopes, focus tools, and activities; `admin-shell-activity-feed` and
  `admin-shell-system-feed` show live feeds.

## Exports

### Entry Points

| Import Path | Contents |
|-------------|----------|
| `@happyvertical/smrt-svelte` | Provider, DataTable, permission utilities, hooks, state, components |
| `@happyvertical/smrt-svelte/calendar` | Calendar and DayView |
| `@happyvertical/smrt-svelte/forms` | Form inputs (TextInput, Select, MoneyInput, etc.) |
| `@happyvertical/smrt-svelte/layout` | Layout (Container, Grid, Header, Footer, Masthead, etc.) |
| `@happyvertical/smrt-svelte/ui` | UI primitives (Button, Card, Badge, Pagination) |
| `@happyvertical/smrt-ui/themes` | Canonical ThemeProvider, Material/Glass/Studio/s-m-r-t presets, CSS generation |
| `@happyvertical/smrt-ui/forms` | Provider-free foundational form controls and the agent interaction registry |
| `@happyvertical/smrt-ui/data` | DataTable, CollectionList/ContentList, CollectionToolbar |
| `@happyvertical/smrt-svelte/registry` | ModuleUIRegistry for agent admin panels |
| `@happyvertical/smrt-svelte/workspace` | AdminShell, ShellState, tenant nav, focus tools, settings, activities, and system/app panels |
| `@happyvertical/smrt-svelte/workspace/legacy` | Opt-in ToolsDock compatibility surface for applications migrating to AdminShell |
| `@happyvertical/smrt-svelte/browser-ai` | Browser AI client (STT/TTS/LLM adapters, capability detection) |
| `@happyvertical/smrt-svelte/browser-ai/svelte` | Svelte AI components (VoiceInput, CapabilityGate, etc.) |
| `@happyvertical/smrt-svelte/styles/tokens.css` | Design tokens CSS |

Legacy ToolsDock availability is presentation-only, not authorization.
`fetchAvailability` failures intentionally keep controls usable using the
current context's last-known-good result, or registered-tool metadata after a
context change. Every tool operation and server endpoint must independently
enforce permissions. Consumers can surface current-context degraded state
through `dock.availabilityError`; a context change or later valid refresh
clears it.

### Components by Category

**Forms**: `AddressInput`, `CheckboxInput`, `DateRangeInput`, `DateTimeInput`, `FileUpload`, `Form`, `FormGroup`, `FormMicButton`, `Input`, `MeasurementInput`, `MoneyInput`, `NumberInput`, `PhoneInput`, `SearchInput`, `Select`, `SelectInput`, `Textarea`, `TextareaInput`, `TextInput`, `Toggle`

**Layout**: `Container`, `EmptyState`, `Footer`, `Grid`, `Header`, `Masthead`, `PageHeader`, `SummaryCard`

**UI**: `Badge`, `Button`, `Card`, `Pagination`

**Display**: `ConfidenceBadge`, `CurrencyDisplay`, `DateDisplay`, `Icon`, `StatusBadge`

**Feedback**: `ConfirmDialog`, `LoadingOverlay`, `Modal`, `ProgressBar`

**Navigation**: `FilterChips`, `Tabs`

**Data**: `DataTable`

**Permissions**: `PermissionCheck`, `RoleBadge`, `RoleSelector`

**Other**: `Calendar`, `DayView`, `MembershipCard`, `MembershipList`, `ModulePanel`

> The agent-admin shells (`AgentAdminPanel`, `AgentAdminTabs`, `AgentSettingsShell`) moved to `@happyvertical/smrt-agents/svelte` (#1589).

**Browser AI**: `AILoadingOverlay`, `CapabilityGate`, `DownloadProgress`, `STTTest`, `VoiceInput`

### Hooks

`useAuth`, `useSocket`, `useAppState`, `useSTT`, `useTTS`, `useLLM`, `useTheme`

### Functions & Actions

`hasPermission`, `hasAnyPermission`, `hasAllPermissions`, `permission` (action), `ripple` (action)

### Cache API

`getCachedSTT`, `getCachedTTS`, `getCachedLLM`, `getCacheStats`, `clearAllCaches`

## Dependencies

- `@happyvertical/smrt-types` -- shared type definitions
- Peer: `svelte` >=5.18.2, `@happyvertical/smrt-jobs`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-users` (all optional)
