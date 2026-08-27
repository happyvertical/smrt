# @happyvertical/smrt-svelte

## Board

`@happyvertical/smrt-svelte/board` provides a generic, accessible Svelte 5
Kanban-style board. It has no project, sales, or support dependency: supply
your own cards, columns, card-to-column getter/setter, and typed card snippet.
`cards` is controlled; `defaultCards` enables local state. `onmove` receives a
typed intent and can be async—rejections restore the previous view. Set
`optimistic` to present controlled moves while persistence is pending.
Set `allowSameColumnReorder={false}` when an adapter persists only lane/status
transitions rather than a position within a lane.

```svelte
<script lang="ts">
  import { Board } from '@happyvertical/smrt-svelte/board';
</script>

<Board
  {columns}
  {cards}
  getCardColumnId={(card) => card.stage}
  setCardColumnId={(card, stage) => ({ ...card, stage })}
  getCardLabel={(card) => card.subject}
  card={cardSnippet}
  onmove={({ card, target }) => save({ ...card, stage: target.columnId })}
/>
```

The same primitive can represent support queues (`card.queue`) or a sales
pipeline (`opportunity.stage`) without importing `@happyvertical/smrt-projects`.

Svelte 5 component library for the s-m-r-t framework. Provides UI components, browser AI integration (STT/TTS/LLM with warm cache), a theme system, permission-aware rendering, and module UI registry for agent admin panels.

## Installation

```bash
pnpm add @happyvertical/smrt-svelte
```

## Data-surface browser bridge security

The browser bridge is a transport adapter, not an authentication system.
Configure it only with a session/source binding established by the server and
use a transport that supplies verified peer metadata. It accepts commands only
from the configured server peer and emits acknowledgements/events only on the
bound route; wire `sessionId` and `source` fields must never be treated as
proof of identity.

The adapter canonicalizes requests and applies the shared identifier limit
from `@happyvertical/smrt-ui/data-surface` along with bounded envelopes before
calling the registry. The registry remains the authority for command
authorization and execution. Command IDs are idempotent while their bounded
replay entries are retained; concurrent same-signature requests coalesce, a
conflicting signature is rejected, and replay-capacity exhaustion is reported
explicitly. Malformed requests and unauthenticated peers are ignored before an
acknowledgement; valid requests that expire or encounter disconnect and
transport failures produce bounded protocol outcomes without exposing registry
state.

## Usage

### Query-backed data surfaces

Use the web binding when a table should render one remote page instead of
hydrating its whole collection. It exposes `rows`, `page`, `total`,
`loading`, `refreshing`, `stale`, `error`, `retry`, and `lastUpdated`.

```svelte
<script lang="ts">
  import { remoteQuery } from '@happyvertical/smrt-svelte/web';
  const view = remoteQuery(collection, transport);
  // Failures remain available as view.error for reactive rendering.
  void view.execute(request).catch(() => undefined);
</script>

{#if view.loading}<p>Loading…</p>{/if}
{#each view.rows as row (row.id)}<div>{row.name}</div>{/each}
```

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

The Provider can own generated WebMCP tools for the same lifecycle. Its policy
is identical to `registerWebMcpTools`; omitted `effects` exposes reads only:

```svelte
<Provider webmcp={{
  definitions,
  effects: ['read', 'write'],
  namespace: 'workspace',
  maxTools: 24
}}>
  {@render children()}
</Provider>
```

This controls capability exposure, not authorization. Tool execution still
crosses the authenticated REST boundary and must retain its auth and tenancy
guards. The `effects`, `filter`, and `filterTool` policy applies to generated
data/model tools only; the fixed mounted-UI adapter has the separate controls
described below.

WebMCP test doubles and polyfills should implement the browser's
promise-returning `document.modelContext.registerTool()` contract; declare the
function `async` when migrating older void-returning fixtures.

### Mounted UI through WebMCP

`<Provider webmcp>` registers six fixed `smrt_ui_*` tools for the mounted UI:
list, inspect, and execute for form controls and data surfaces. The tool set does
not change as components mount and unmount; each call reads the current
transport-neutral registries instead of inspecting or simulating the DOM.

Forms automatically join the Provider's control registry. An explicit Form
`interactionRegistry` still takes precedence. Pass the same data-surface
registry used by `DataTable` or `CollectionToolbar` when those mounted surfaces
should be discoverable:

```svelte
<script lang="ts">
  import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
  import { Provider } from '@happyvertical/smrt-svelte';

  const surfaces = createDataSurfaceRegistry();
</script>

<Provider webmcp={{ ui: { dataSurfaceRegistry: surfaces } }}>
  <!-- pass {surfaces} to mounted data-surface components -->
  {@render children()}
</Provider>
```

The default prefix is `smrt_ui_`. Configure `ui.prefix` when multiple Providers
must coexist in one document; the same prefix cannot be registered twice.
`ui: false` disables only the fixed UI adapter while leaving generated model
tools enabled. For compatibility, an object config that omits `ui` continues to
enable only generated model tools; use `webmcp={true}` or provide `ui: {}` to
enable the mounted-UI adapter.

Form commands always run with `source: 'agent'`. WebMCP input cannot assert
confirmation: staging is allowed by the registry policy, while apply, clear,
and undo require a separate human-confirmed path. Secret control values and
hidden data-surface columns are not serialized. Read responses are marked as
untrusted content. Bespoke `useWebMcpTool` and `<Form webmcp>` tools retain their
existing lifecycle and submit behavior.

Custom rich fields may continue to call `registerField(field)` and later
`unregisterField(name)`. New code should retain and invoke the disposer returned
by `registerField`: it is bound to that exact registration, so cleanup cannot
remove a same-name replacement. The return value is additive; legacy form
contexts whose `registerField` returns `void` remain supported. Context accessors
bind legacy name-based cleanup to registrations made by that caller, so
overlapping same-name fields can unmount in either order without retaining a
detached control.

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

**Display** (from `@happyvertical/smrt-ui`): `ConfidenceBadge`, `CurrencyDisplay`, `DateDisplay`, `Icon`, `StatusBadge`

`CurrencyDisplay` accepts Commerce-compatible string currency fields. It trims
and uppercases ISO 4217 codes before formatting, defaults to CAD, and renders an
accessible inline error for malformed or unsupported codes instead of throwing
and interrupting the surrounding collection render.
The historical `unit="cents"` option means ISO minor units, so currencies with
zero or three minor digits are scaled correctly. Minor-unit amounts must be
finite safe integers; fractional or unsafe numeric values render an accessible
inline error. `unit="dollars"` means major units.
ISO codes whose minor unit is `N.A.` require `unit="dollars"`; minor-unit mode
renders an accessible inline error for those codes, while major-unit mode uses
a stable two-digit display policy. CAD and USD retain their symbol display;
all other currencies render their ISO code for deterministic SSR hydration.

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
