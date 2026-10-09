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

## Sortable and shell layout

`@happyvertical/smrt-svelte/sortable` provides `Sortable`, an accessible
(pointer, touch, keyboard, screen-reader announcements) list of containers and
items that share Board's drag engine. `AppShell` lets users customize their
shell: pass `layout` and `onlayoutchange` to own persistence (for example in an
exported app blueprint), or neither to store it in the user's settings. Mount
`ShellLayoutEditor` (from `/app` or `/workspace`) on a settings page, and call
`useShellLayout()` to make the same changes from code or an assistant. Users can rename sections and individual navigation entries (`items`, `renameItem`), hide section titles, and create or delete their own sections. See
`agents/workspace.md`; the pure `ShellLayout` model is published without Svelte
as `@happyvertical/smrt-svelte/workspace/layout`.

```svelte
<AppShell {nav} {navGroups} layout={stored} onlayoutchange={(next) => (stored = next)}>
  <ShellLayoutEditor />
</AppShell>
```

Opt in to editing the real shell in place with `layoutEditing` on `AppShell`: a
pencil toggle ("Edit layout", highlighted while editing; press again or Escape to exit) joins the header (as does the app title, a movable
`item:brand` in `header.start`), and while on, every slot is a
labelled drop zone, shell items and navigation get grips (drag, or Space and
arrow keys), section headings get icon overlays and a floating toolbar, and
hidden regions show as strips. Apps add per-section icon buttons (an Options
gear, Help) with `sectionActions`; pass `layoutEditing={{ floating: true }}` to pin the
toggle in the top-right corner instead of the header; `useShellLayout()` exposes `editing` and
`setEditing`. See `agents/workspace.md`.

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
`loading`, `refreshing`, `stale`, `error`, `retry`, `lastUpdated`, and the
latest applied `result`. The result getter also follows query-scoped live
replacements, so consumers can keep envelope metadata in sync with the rows.

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

A page with its own hand-rolled list markup — not `DataTable` — that already
mirrors a headless `DataTableController`'s search/filters/sort/page/selection
can register that same registry in one call with `mountListDataSurface`
(`@happyvertical/smrt-svelte/web`) instead of hand-writing the registration:

```ts
import { createDataTableController } from '@happyvertical/smrt-ui/data';
import { mountListDataSurface } from '@happyvertical/smrt-svelte/web';

const controller = createDataTableController();
const handle = mountListDataSurface({
  registry: surfaces,
  descriptor: myListDescriptor,
  controller,
  context: { totalRows, queryFingerprint },
  refresh: () => reload(),
});

// Only `controller` is observed automatically. App-owned `context` is a
// one-time snapshot at mount — publish a fresh one whenever totalRows,
// queryFingerprint, or freshness changes (an $effect keyed on those values
// is the usual place):
handle.update({ totalRows, queryFingerprint });

// on unmount:
handle.destroy();
```

It mirrors `controller` into the registry, translates visible table commands
back into `controller.dispatch()` calls, and routes the fixed
`refresh`/`retry`/`focus`/`reveal`/`highlight` controls to callbacks; any
other `controlId` goes through an `onControl` escape hatch (denied by
default) — except a canonical table-control id (`set-filters`, `reset`,
`set-page`, … the full `DATA_TABLE_SURFACE_CONTROL_IDS` list from
`@happyvertical/smrt-ui/data`), which is always intercepted first and never
reaches `onControl`, even under a custom label. See
`docs/data-surface-conformance.md` for the full contract.

Three lifecycle hooks cover the common page shapes without any registration
code; each resolves the nearest Provider's registry (or an explicit one),
re-mounts on an identity change, and unmounts with the component:

- `useListSurface(() => ({ surfaceId, label, description, columns, rows }))`
  publishes the page's rendered rows, projected to the declared columns and
  capped (`maxRows`, default 50), as `state.rows`. Columns marked
  `searchable` enable a `find` control: `{ text }` publishes the rows whose
  searchable columns contain the text (any case, accents ignored) across all
  rows, with `state.find = { text, matches }` — so an agent can look an
  article up by title on the page. It narrows only what the agent reads;
  table commands stay refused and the page's own controls stay in charge.
- `useLinkSurface(() => ({ surfaceId, label, description, links, navigate }))`
  exposes a menu or tab row as an `open` control (see `registerLinkSurface`
  in smrt-ui).
- `useStepSurface(() => ({ surfaceId, …, steps, current, next, back,
  nextWrites, showNext }))` exposes a wizard's `next`/`back`/`go-to`; a step
  whose forward button writes is revealed for the person, never pressed.

The default prefix is `smrt_ui_`. Configure `ui.prefix` when multiple Providers
must coexist in one document; the same prefix cannot be registered twice. The
six derived names are reserved through the document-global tool-name lock, so
a generated model tool, a view intent, or a `useWebMcpTool` tool that would
take one of them under your prefix fails at registration with a message naming
the tool and its current owner, rather than being silently dropped by the
browser.
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

#### `<Form webmcp>` with SvelteKit `enhance` and smrt-ui fields

The rich `Form` renders its own `<form>`, so it forwards every native form
attribute (`method`, `action`, `enctype`, `novalidate`, `autocomplete`,
`aria-*`, `data-*`, …) and attachments (`{@attach …}`) to that element. A
component cannot take `use:`, so pass SvelteKit's `enhance` as a prop — it is
applied to the rendered `<form>` and torn down with it. Without `onsubmit`
the Form never prevents submission, so `enhance` (or a native POST) runs as
usual and an error summary above the fields keeps working:

```svelte
<script lang="ts">
  import { enhance } from '$app/forms';
  import { Form } from '@happyvertical/smrt-svelte/forms';
  import { ErrorSummary, FormGroup, Input } from '@happyvertical/smrt-ui/forms';
</script>

<Form formId="setup-network" webmcp method="POST" action="?/create" novalidate
  enhance={(form) => enhance(form, submit)}>
  <ErrorSummary errors={errors} />
  <FormGroup label="Network name" id="name"><Input name="name" bind:value={name} /></FormGroup>
</Form>
```

Its `<formId>_stage_changes` tool describes rich fields (`TextInput`,
`MoneyInput`, …) and every other control the registry holds for the form:
smrt-ui primitives (`FormGroup` + `Input`/`Select`/`Textarea`/`Combobox`/…)
and composites registered with `useControlRegistration`. Proposals for either
kind are staged for the person to review and apply; nothing is written or
submitted by the tool.

`FormScope` (`@happyvertical/smrt-svelte/forms`) is the same tool and review
surface without a `<form>` element — for a fetch-driven wizard, an editor
saved in parts, or a page that must keep its own `<form>` markup. It joins
the nearest Provider's control registry (or a local one) and registers no
tool until at least one proposable control is mounted.

`tryUseWebMcpUi()` returns the Provider's mounted-UI registries, or `null`
when there is no Provider or its WebMCP UI is off — use it to fall back to a
local registry instead of catching `useWebMcpUi()`'s throw (#2915).

Custom rich fields may continue to call `registerField(field)` and later
`unregisterField(name)`. New code should retain and invoke the disposer returned
by `registerField`: it is bound to that exact registration, so cleanup cannot
remove a same-name replacement. The return value is additive; legacy form
contexts whose `registerField` returns `void` remain supported. Context accessors
bind legacy name-based cleanup to registrations made by that caller, so
overlapping same-name fields can unmount in either order without retaining a
detached control.

### Voice typing where the browser cannot (on-device Whisper and Moonshine)

Browsers differ on speech recognition: Chrome and Safari have it, Firefox does
not, and Brave has the API without a speech service behind it. `probeBrowserSpeech()`
says which you have (`'works' | 'missing' | 'unreliable'`) without a network
call or a microphone prompt. For the last two, offer a one-time model download
and dictate with a speech model running in the browser (WebGPU where available,
single-thread WASM otherwise; no cross-origin isolation needed). The engine is
`@happyvertical/speech/local` (an optional peer, `>=0.102.5`, as is
`@huggingface/transformers`).

| `model` | Size | Notes |
| --- | --- | --- |
| `moonshine-tiny` (`onnx-community/moonshine-tiny-ONNX`) | ~32 MB | English, fastest: best for live dictation |
| `moonshine-base` (`onnx-community/moonshine-base-ONNX`) | ~67 MB | English, more accurate |
| `whisper-tiny.en` (default) | ~45 MB | English |
| `whisper-base.en` / `whisper-small.en` | ~85 / ~260 MB | English |
| any Hugging Face id, e.g. `onnx-community/whisper-base` | varies | multilingual Whisper |

```ts
import {
  createLocalSpeechModel,
  createSttDictationSource,
  probeBrowserSpeech,
} from '@happyvertical/smrt-svelte/browser-ai';
// The worker is the one module that imports the optional peers statically,
// so only apps that build it bundle them.
import SpeechWorker from '@happyvertical/smrt-svelte/browser-ai/whisper-worker?worker';

if ((await probeBrowserSpeech()) !== 'works') {
  const model = createLocalSpeechModel({
    model: 'moonshine-tiny',
    createWorker: () => new SpeechWorker(),
    loadSpeech: () => import('@happyvertical/speech/local'),
  });
  model.estimateSize();            // ~32 MB, for the consent text
  await model.isCached();          // already downloaded on this device?
  await model.load({ onProgress, signal }); // downloading -> extracting ("Getting ready") -> complete; abort() cancels
  const dictation = createSttDictationSource({ type: 'moonshine', modelHandle: model });
}
```

`createWhisperLocalModel`, `{ type: 'whisper-local' }` and the `whisper-wasm`
alias keep working. Without `createWorker` the model runs on the page's thread
and `loadModule: () => import('@huggingface/transformers')` supplies the
runtime. With a worker, `device` and `dtype` are the worker entry's (`auto`
and `q8`).

Push-to-talk: the microphone records until stopped, then one final result is
emitted. For hands-free dictation (each sentence written down when the speaker
pauses) give smrt-ui's `Dictation` `mode: 'hands-free'` and
`createHandsFreeCapture`; these adapters' `transcribePcm()` writes down each
utterance. English-only models (`*.en`, Moonshine) ignore a requested language.

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

#### Responsive chrome and resizable edges

AdminShell carries the phone/tablet/desktop chrome itself, so hosts do not
wrap it in a frame. Everything below is opt-in; without these props and config
keys the shell renders exactly as before.

```svelte
<script lang="ts">
  import {
    AdminShell,
    createShellState,
    PhoneBottomBar,
    PhoneTopBar,
    ShellNavToggle,
    ShellTitle,
    phoneTopBarFor,
  } from '@happyvertical/smrt-svelte/workspace';

  const shell = createShellState({
    config: {
      top: false,
      bottom: false,
      left: {
        label: 'Navigation',
        // Drawer on phones, icons on tablets, open on desktop.
        viewportDefaults: { phone: 'collapsed', tablet: 'collapsed', desktop: 'expanded' },
      },
      right: {
        label: 'Assistant',
        expandedSize: '28rem',
        resizable: { min: 320, max: 720 }, // drag, arrows, Home/End, double-click resets
        phone: 'sheet', // or 'hidden' when the host shows it elsewhere on phones
        keepMounted: true, // closing the sheet keeps the chat (and its draft) alive
        overlayMedia: '(max-width: 99.9375rem)', // slide over the page below 1600px
      },
    },
    storageKey: 'my-app-shell',
  });
</script>

<AdminShell state={shell} path={page.url.pathname} phone={{ scrim: true, swipeToClose: true }}>
  {#snippet header()}
    <ShellNavToggle expanded={shell.panels.left === 'expanded'} onclick={() => shell.togglePanel('left')} />
    <ShellTitle title="Acme" href="/" />
  {/snippet}
  {#snippet phoneTopBar()}
    <PhoneTopBar model={phoneTopBarFor({ path, homeHref: '/', homeTitle: 'Acme', navItems })} homeHref="/" />
  {/snippet}
  {#snippet phoneBottomBar()}
    <PhoneBottomBar {items} />
  {/snippet}
  {#snippet overlays({ viewport })}<!-- PhoneSheet, WorkingStrip, … -->{/snippet}
  …
</AdminShell>
```

- **`header`** is a full-width row above every edge (`#smrt-admin-shell-header`,
  `--smrt-admin-shell-header-size`, default 3.5rem). On phones it is replaced
  by `phoneTopBar` when one is given.
- **Viewport classes**: `shell.viewport` is `phone` (≤ 48rem), `tablet`
  (≤ 64rem) or `desktop`; `ADMIN_SHELL_PHONE_QUERY` / `ADMIN_SHELL_DESKTOP_QUERY`.
  `viewportDefaults` apply on first render and whenever the class changes; such
  an edge never persists its open/closed state.
- **Phone chrome**: `phoneTopBar` overlays the top of the main region and hides
  on scroll (`phone.hideOnScroll`, pinned by `pinChrome` or an open drawer);
  `phoneBottomBar` is a bottom row that a form's `[data-form-action-bar]` (see
  smrt-ui `FormActionBar`) replaces and the on-screen keyboard hides
  (`:root[data-keyboard-open]`). `phone.scrim` dims the page behind a drawer or
  sheet, `phone.swipeToClose` closes drawers by swiping. A `path` change on a
  phone closes open drawers. `overlays` is a layer above the edges (and above
  the bottom bar's row) for `PhoneSheet`s and status strips.
- **Page contracts** on phones: `data-shell-breadcrumbs` is hidden only when
  the phone bar contains `data-shell-page-navigation-replacement` (the back
  link in `PhoneTopBar` detail mode declares it). A title alone leaves
  breadcrumb navigation available.
  `data-shell-page-title` is visually hidden only when the phone top bar
  contains `data-shell-page-title-replacement`. `PhoneTopBar` marks its detail
  title automatically; a workspace-name or action-only bar leaves the page
  heading visible. Custom bars should mark only an actual replacement title.
  `data-shell-tabs` sticks under the top bar and slides away with it. smrt-ui's `PageHeader` renders the first two.
- **Page trail**: `shellPageTrailFor({ path, homeHref, homeTitle, navItems,
  parents })` is the one source for a page's ancestors: section homes (home
  and top-level nav pages) have none; other pages get the home, the nav items
  above them, then page-given `parents`, never the page itself. Pass the
  `crumbs` to `PageHeader`; `phoneTopBarFor` (same input plus `pageTitle`)
  sends the phone back arrow to the last crumb.
- **Resizable edges**: `resizable` on a `push` side edge adds a
  `role="separator"` (with `aria-valuenow/min/max` in px) on its inner border.
  Sizes are stored as `ShellSettingsDelta.sizes` through the settings adapter;
  `persist: false` / `{ state?: false, size?: false }` opts an edge out of
  storage.
- **Overlay edges**: `overlayMedia` on a side edge is a media query under
  which the expanded edge slides over the page (above a scrim, content keeps
  its width) instead of pushing it, on tablet and desktop; above it the edge
  docks. `shell.presentationFor(edge)` reports the live presentation. While
  an overlay is open the page and the other edge are `inert`, the panel takes
  focus (unless something inside already has it) and returns it on close;
  Escape or a scrim click closes it, sliding it back out as the scrim fades
  (no motion under `prefers-reduced-motion`). Resizing applies only while docked.
- **Railless edges**: `rail: false` gives a side edge no rail (no tool buttons, open or closed); closed, it takes
  no space and renders nothing to see or tab to, and opens from elsewhere (a
  header dock toggle, `useShellDock()`). Pair it with `presentation: 'overlay'`
  for a chat that slides over the page. Layout edit mode leaves a railless edge
  as it is (closed stays closed) and, while editing, shows a small "Open
  <tool>" tab on the shell's right edge when it has content.
- **Kept panels**: `keepMounted: true` keeps a collapsed edge's panel content
  (`appPanel`, `tenantPanel`, the focus panel, `systemPanel`) mounted with the
  `hidden` attribute instead of unmounting it, so component state (a chat
  draft, scroll position) survives closing. The rail renders as usual; the
  left edge keeps only a `tenantPanel`.
- **Nav attention**: a `ShellNavItem` with `attention: true` (or a string
  label) shows a dot in `TenantNav`, over the icon when collapsed, and
  announces the label ("Needs attention" by default) inside the link.
- **Nav action**: a `ShellNavItem` with `action: { href, label, icon?,
  visibility? }` renders a separate icon-only link after the item's link
  (`aria-label`/tooltip = `label`, default settings-gear icon,
  `aria-current="page"` on its own page). `visibility: 'active'` omits the link
  from the DOM unless the item's section is current: for a `ShellNavGroup`
  item, any item of the group, their children, or any action href is current;
  for a top-level item, the item, its children, or its action href. A collapsed
  nav renders no actions (the action page stays reachable by its route).
  `AppShell` passes `nav`/`navGroups` through unchanged.
- **Public region ids** (`ADMIN_SHELL_REGION_IDS`): `smrt-admin-shell-header`,
  `smrt-admin-shell-{top,left,right,bottom}-panel`, and
  `smrt-admin-shell-main`, which is the page scroller.

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
| `@happyvertical/smrt-svelte/app` | `AppShell` (Provider + themes + AdminShell + nav/dock slots, `dockToggles` buttons and host `slots` for the header/footer/sidebar regions), `OwnerSetupForm` (first-run owner setup), `ShellSettingsPage`, `RuntimeDiagnosticsWebMcp` |
| `@happyvertical/smrt-svelte/app/runtime-diagnostics` | Svelte-free diagnostics WebMCP registration and its tool name/endpoint constants, importable from server routes |
| `@happyvertical/smrt-svelte/workspace/legacy` | Opt-in ToolsDock compatibility surface for applications migrating to AdminShell |
| `@happyvertical/smrt-svelte/workspace/server` | Server-side workspace helpers (Node only) |
| `@happyvertical/smrt-svelte/workspace/live` | `systemFeed` — the AdminShell system scope (jobs/schedules/dispatch) polled from an app status endpoint; deliberately carries no `smrt-web` dependency |
| `@happyvertical/smrt-svelte/browser-ai` | Browser AI client (STT/TTS/LLM adapters, capability detection) |
| `@happyvertical/smrt-svelte/browser-ai/svelte` | Svelte AI components (VoiceInput, CapabilityGate, etc.) |
| `@happyvertical/smrt-svelte/web` | `smrt-web` live-query bindings (`liveCollection`, `activityFeed`, `useUpdateAvailable`) plus `mountListDataSurface` (custom-list data-surface registration) |
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
| `@happyvertical/smrt-ui/calendar` | CalendarView (deprecated: Calendar, DayView) |
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

**Forms**: `AddressInput`, `CheckboxInput`, `DateRangeInput`, `DateTimeInput`, `FileUpload`, `Form`, `FormGroup`, `FormMicButton`, `Input`, `MeasurementInput`, `MoneyInput`, `NumberInput`, `PhoneInput`, `RelationInput` (deprecated re-export; import from `@happyvertical/smrt-ui/forms`), `SearchInput`, `Select`, `SelectInput`, `Textarea`, `TextareaInput`, `TextInput`, `Toggle`

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

## Portable MCP Apps

The opt-in `@happyvertical/smrt-svelte/mcp-apps` entry exports `useMcpApp` for
mount-owned host negotiation/disposal and `useMcpAppIntent` for component-local
public registry interactions. It does not require `document.modelContext` or
export mounted closures to remote MCP. Agent proposals retain trusted human
staged review. See the [bridge contract](../mcp-apps/README.md) for origin
configuration, capabilities, fallback and synthetic-browser evidence limits.

AdminShell's optional `homeHref` turns default branding into a named home link.
Use `logoSrc`/`logoAlt` for a logo or a `brand` snippet receiving `{ compact }`
for custom marks. A collapsed tenant rail keeps a compact linked logo or initial;
the default app bar keeps the full brand visible at narrow widths. A custom
`appBar` continues to own its branding. Without these props, branding stays text.

### Voice mode migration (#3261)

**Changed default:** Provider and standalone `createAppState()` now keep voice
mode off unless explicitly requested. Omitted `autoEnableSmrt` defaults to
`false`; speech-capable browsers stay in `default` mode. Apps that relied on
automatic voice activation must opt in with `autoEnableSmrt={true}`. Use
`mode="smrt"` for an explicit voice-mode choice. An explicit `mode="default"`
wins over auto-detection from the start of initialization, including when
`autoEnableSmrt` is true; no transient voice-mode activation occurs.
Standalone state callers can opt in through initial session preferences
(`autoEnableSmrt: true`); `initialMode` takes precedence. Runtime mode prop
updates retain their existing behavior.

### Runtime panel controls (#3246)

Use `shell.setPanelState(edge, 'hidden' | 'collapsed' | 'expanded')` to persist
runtime panel preferences; app-configured hidden edges remain unavailable.
AdminShell's edge toggle buttons and WASD hotkeys are opt-in via `edgeToggles`
(default `false`: regions lay out inline; pass `true`, or a per-edge map, to
keep the drop-down behaviour; `showTenantToggle` is a deprecated alias for
`edgeToggles.left`), a Menu opener in narrow layouts, and the
system toggle alongside a custom `systemBar` that has a `systemPanel` to open
(a `systemBar` with no `systemPanel` owns the bottom band and draws no toggle). Closed narrow drawers are inert;
opening focuses the first control, and closing or Escape restores the opener.
TenantNav accepts `density="touch"` for canonical 48px link targets, including
collapsed rail links; omit density to inherit the theme's control density.

`AdminShell` keeps a supplied `tenantFooter` in the app bar while the left pane
is collapsed, hidden, or a closed narrow drawer; it moves back to the expanded
pane without duplicate account controls. Use the optional `account` snippet for
an account permanently in the app bar (including with a custom `appBar`).
`WorkspaceAccountMenu density="touch"` sizes its trigger and menu actions to the
canonical 48px target; omit density to inherit the theme, or choose
`"comfortable"`. Account menus in the shell app bar open below the bar so the
existing footer's default placement stays reachable on narrow screens.

Sections-only navigation: pass `navMode="sections"` to `AppShell` and give
each `ShellNavGroup` an `icon` and `href`; the sidebar then lists only the
sections, and the section's page renders its entries with `ShellSectionMenu`
(`meta`/`actions` snippets for counts and "New ..." links). In layout edit mode
the menu rows get grip, rename and hide controls, and the sidebar's section
toolbar gets an icon picker (`useShellLayout().setSectionIcon`).

`TenantNav` accepts optional `groups: ShellNavGroup[]` (`{ heading, items }`)
next to its existing flat `items`. Each group has a labelled `role="group"` and
native disclosure summary; keyboard and touch users can collapse it even in the
icon rail. Groups start open, preserve nested links and active-route markers,
and inherit the navigation density. Supply `aria-label="Shop navigation"` for
an instance-specific landmark name; omission uses the localized default.
`ShellNavGroup` is exported from `@happyvertical/smrt-svelte/workspace`.
