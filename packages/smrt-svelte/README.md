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
  import { PermissionCheck, permission } from '@happyvertical/smrt-ui';
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

This is the complete `exports` map of this package. Anything not listed is not
importable, even if it appears in `dist/`.

| Import Path | Contents |
|-------------|----------|
| `@happyvertical/smrt-svelte` | `Provider`, hooks (`useAppState`, `useAuth`, `useLLM`, `useSocket`, `useSTT`, `useTheme`, `useTTS`), app state/context, `ModulePanel`, and the form components below |
| `@happyvertical/smrt-svelte/forms` | Form inputs (TextInput, Select, MoneyInput, DateTimeInput, Toggle, etc.) |
| `@happyvertical/smrt-svelte/settings` | Server-paged settings search, selection, and list/detail layout (`SettingsCatalog`, `paginateSettingsCatalog`) |
| `@happyvertical/smrt-svelte/workspace` | AdminShell, ShellState, tenant nav, focus tools, settings, activities, and system/app panels |
| `@happyvertical/smrt-svelte/workspace/legacy` | Opt-in ToolsDock compatibility surface for applications migrating to AdminShell |
| `@happyvertical/smrt-svelte/workspace/server` | Server-side workspace helpers (Node only) |
| `@happyvertical/smrt-svelte/workspace/live` | `systemFeed` — the AdminShell system scope (jobs/schedules/dispatch) polled from an app status endpoint; deliberately carries no `smrt-web` dependency |
| `@happyvertical/smrt-svelte/browser-ai` | Browser AI client (STT/TTS/LLM adapters, capability detection) |
| `@happyvertical/smrt-svelte/browser-ai/svelte` | Svelte AI components (VoiceInput, CapabilityGate, etc.) |
| `@happyvertical/smrt-svelte/web` | `smrt-web` live-query bindings (`liveCollection`, `activityFeed`, `useUpdateAvailable`) |
| `@happyvertical/smrt-svelte/i18n/server` | Server-side i18n resolver (Node only) |

Domain-agnostic UI lives in `@happyvertical/smrt-ui`. There is no `ui`,
`layout`, `calendar`, `data`, `chat`, `feedback`, `registry`, `themes`, `i18n`,
or `styles/tokens.css` subpath on `smrt-svelte`, so those specifiers only
resolve against `smrt-ui`:

| Import Path | Contents |
|-------------|----------|
| `@happyvertical/smrt-ui` | `PermissionCheck`, `permission` / `hasPermission` / `hasAnyPermission` / `hasAllPermissions` |
| `@happyvertical/smrt-ui/ui` | UI primitives (Button, Card, Badge, Pagination) |
| `@happyvertical/smrt-ui/layout` | Layout (Container, Grid, Header, Footer, Masthead, etc.) |
| `@happyvertical/smrt-ui/calendar` | Calendar and DayView |
| `@happyvertical/smrt-ui/data` | DataTable, CollectionList/ContentList, CollectionToolbar |
| `@happyvertical/smrt-ui/feedback` | Modal, ConfirmDialog, LoadingOverlay, ProgressBar |
| `@happyvertical/smrt-ui/chat` | Message bubble, reaction picker, typing indicator |
| `@happyvertical/smrt-ui/registry` | ModuleUIRegistry for agent admin panels |
| `@happyvertical/smrt-ui/themes` | Canonical ThemeProvider, Material/Glass/Studio/s-m-r-t/HappyVertical presets, CSS generation |
| `@happyvertical/smrt-ui/i18n` | Client i18n (`useI18n`, `Trans`) — the counterpart to `smrt-svelte`'s `/i18n/server` |
| `@happyvertical/smrt-ui/styles/tokens.css` | Design tokens CSS |

`forms` is the one name on both: `@happyvertical/smrt-ui/forms` holds the
Provider-free primitives (`Input`, `Select`, `Textarea`, `Toggle`, `FormGroup`),
and `@happyvertical/smrt-svelte/forms` re-exports those and adds the
Provider-backed inputs, so it stays the one-stop barrel for applications.

The first-generation `WorkspaceShell`, `RoleShell`, `NavTree`, and `Breadcrumbs`
have no entry point at all. Their `.svelte` files are copied into `dist/` but no
export subpath or barrel names them, so they cannot be imported from an
installed package — see the [migration
guide](./src/components/workspace/MIGRATION.md). `AdminShell` supersedes them.

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
