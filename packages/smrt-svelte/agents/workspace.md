# smrt-svelte/workspace / AdminShell

Module semantics for `src/components/workspace/` (`./workspace` + `./web`). Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## AdminShell workspace surface

The `./workspace` subpath (`src/components/workspace/`) is the canonical
AdminShell family for SMRT admin web apps. It exports the four-edge shell
contract (`AdminShell`, `ShellState`, settings, hotkeys, focus tools,
activities, tenant nav, app/system panels) from `workspace/admin-shell/`.

The first-generation workspace family (`WorkspaceShell`, `RoleShell`,
`NavTree`, `Breadcrumbs`, `ToolsDock`) remains in source as migration reference
only. Do not re-export it from the public `./workspace` barrel just to preserve
compatibility. Applications that still need ToolsDock during migration may use
the explicit `@happyvertical/smrt-svelte/workspace/legacy` subpath; keep legacy
additions isolated there so the canonical workspace surface remains AdminShell.

Of that family, only ToolsDock has an entry point. `WorkspaceShell`,
`RoleShell`, `NavTree`, and `Breadcrumbs` are named by no subpath and no barrel,
so they are unreachable from an installed package even though their `.svelte`
files are copied into `dist/`. Do not document them as available API; removing
them from the published artifact versus exporting them is tracked in #2286.

**Principles**:
- SvelteKit-agnostic core — no `$app/state` or `$app/navigation` imports
- SSR-safe public shell import/render path; browser listeners and localStorage
  activate after mount
- No token bridges — consume `var(--smrt-color-*)` directly
- App-owned configuration for hidden edges, push/overlay presentation, and
  exclusivity groups
- User-owned preferences persist as sparse `ShellSettingsDelta` values
  through a `ShellSettingsAdapter` (`LocalStorageShellSettingsAdapter` by
  default). Server-side, per tenant and user, they can persist as the
  `shell-layout` kind of `@happyvertical/smrt-preferences`
  (`createShellSettingsPreferences`, the server half of an adapter); it
  validates with `sanitizeShellSettingsDelta`, the untrusted-input reader on
  the Node-safe `./workspace/server` entry (with `mergeShellSettingsDelta`)
- Focus tools may register imperatively through `ShellState` or declaratively
  through Svelte helpers
- Shell activities are client-side records; server jobs, polling, WebSockets,
  and `smrt-web` SSE can feed them through app adapters

At widths up to 48rem, side panels overlay the main area directly between the
header and footer. App/system drawers span the shell width independently of
saved desktop side-panel states and scroll within the available vertical space.
App settings, tenant names and environment badges wrap within narrow drawers.
`SystemStatusChips` stays on one horizontally scrollable row so fixed-height
system bars never clip wrapped chips. Custom bars must allow this flex child
to shrink; use safe alignment if aligning its contents to the end.

Sidebar-only shells may set `top: false`. In that mode the configured brand is
shown at the top of the expanded tenant panel as well as in the compact rail.
When the top header is visible, its brand is the only copy; collapsing the
left sidebar does not add a second logo to the rail.
Use `tenantRailFooter` for a control pinned below collapsed navigation; it sits
outside the rail's scroll clip so menus can open over the workspace. Pair it
with `WorkspaceAccountMenu compact` for an avatar-only trigger that retains the
full account identity as its accessible name. Keep the ordinary
`tenantFooter` for the expanded panel.

### Responsive chrome, viewport defaults, resizable edges

The root grid has five rows: `header` · top edge · body · bottom edge · phone
bottom bar. The header and phone-bar tracks are `0rem` unless their snippets
render, so hosts that pass none of the new props get the original layout; keep
that invariant (`AdminShell.responsive.test.ts` "backward compatibility").

**Empty regions render nothing.** The header band, footer band and right edge
are skipped (and their tracks collapse to `0rem`, the grid keeps its five rows)
when nothing would render in them: no slot content, `appBar`/`systemBar`, corners,
toggles, focus tools, mounted drawer, or edit-mode controls. A default
`AdminShell` still shows its brand, so its header stays; an app with no
footer content and no dock tools has no footer and no right strip.

**Phone defaults.** `phone.scrim` and `phone.swipeToClose` are on (pass `false`
to turn one off). Opening the left or right surface collapses the other
(`ShellState.closeExclusivePeers`, not persisted), and starting a layout edit
closes any open surface. The Menu opener is an icon button (hamburger, name
"Menu"); the left drawer's title is the app brand and its close control is an
icon-only "Close menu". While the right edge has focus tools, phones get a
"Tools" icon opener at the header end (`phoneDockOpener`, default true;
`AppShell` turns it off when `dockToggles` already open the dock) and the edge
presents as a drawer (or sheet) with an icon-only "Close tools". Chrome buttons,
rail tool buttons and dock toggles use `--smrt-touch-target-min` on phones. A
tool without an icon uses the generic tool icon, never its first letter.
The dock (right edge) defaults to `overlayMedia: '(max-width: 79.9375rem)'`
(#4100): from the xl breakpoint (80rem) it sits beside the page and the main
area shrinks; below it slides over the page. A dock card that navigates calls
`announceShellNavigation(element, { focus? })` (`admin-shell/navigation.ts`):
the shell closes the dock only while it overlays the page (overlay or phone
sheet; `closeOnNavigate: false` keeps it), then focuses the incoming page's heading (never one already on the page).
Phone drawers and the bottom drawer offset themselves by the header and phone
bar tracks. `shell.viewport` comes from `ADMIN_SHELL_PHONE_QUERY` (48rem, the
same boundary as the CSS media query — never make one configurable without the
other) and `ADMIN_SHELL_DESKTOP_QUERY` (64rem); `installShellViewport` runs on
mount and the `ShellState` constructor detects the initial class so the first
paint is right.

**Phone tab bar (`AppShell` `phoneTabBar`, default `false`).** On phones it
fills `AdminShell`'s `phoneBottomBar` track; conceptually that is the footer
region's phone presentation (its center slot), not a new region. Tabs, in
order: the first N top-level nav items (flat `nav`, then group entries, or one
per group in `navMode: 'sections'`; icon + label, `aria-current="page"` from
`currentHref`, placeholder glyph when no icon), the dock tab (first
`dockToggles` entry, else a "Tools" tab while the right edge has tools), then
"More" (opens the left drawer) only when nav overflows. `N` defaults to 4 and
includes the dock tab; `phoneTabBar={{ items: n }}` overrides. Selection is the
pure `planPhoneTabs` in `app/phone-tabs.ts`; `PhoneTabBar.svelte` renders it
through `PhoneBottomBar` (which now also takes `iconName` entries and an
`iconComponent`). With the bar on, the header "Tools" opener and the header copy
of the dock tab's toggle are not rendered on phones. `phoneDock` (`'sheet' |
'drawer'`, default `'sheet'` with the tab bar, else `'drawer'`; an explicit value
beats `config.right.phone`) sets the right edge's phone presentation; the sheet
already sits between the top bars and the phone-bar track, so it rises above the
tab bar. Both props are read once at mount (like `config`). Header-end slot
content (`slots['header.end']`, e.g. a future account avatar) stays in the
header band on phones. Safe-area padding is `env(safe-area-inset-bottom)` in
the bar's CSS.

Edge config: `viewportDefaults` (applied per class change; such an edge never
stores its state), `phone: 'drawer' | 'sheet' | 'hidden'` (`sheet` is right
edge only), `resizable` (side edges, `push` only, not on phones) and `persist`.
`stripUnpersistedSettings` runs on both `hydrate()` and adapter writes;
runtime `applySettings` is never filtered. Resized widths live in
`ShellSettingsDelta.sizes` (px; `null` = configured size, pruned on write).
Drags update with `persist: false` and persist once on pointer up.

The resize separator is a focusable `role="separator"`: its svelte-ignore of
the non-interactive a11y warnings is deliberate (WAI-ARIA window splitter).

Run `pnpm --filter @happyvertical/smrt-svelte test:e2e` after building the
package dependencies. The package-local fixture exercises real Chromium bounds
and touch input across mobile widths and desktop panel-state combinations.

See `src/components/workspace/MIGRATION.md` for the old-to-new concept map.

### Regions and slots

Four regions map to the existing edges (ids and `ShellLayout.panels` keys are
unchanged): Header (`top`), Left sidebar (`left`), Right sidebar (`right`),
Footer (`bottom`). Default labels are those names; override via `config`.
`AdminShell`/`AppShell` take `slots?: Partial<Record<ShellSlot, Snippet>>`
(`ShellSlot` from `./workspace`): `header.start|center|end`,
`footer.start|center|end`, `leftSidebar.header|footer`,
`rightSidebar.header|footer`. Header/footer slots sit in the bar (start after
the brand/menu opener, end after the account), sidebar header sits above and
footer below the sidebar's main area. Defaults: brand/title/menu opener/account
stay where they were (`header.start`/`header.end` areas), `tenantFooter` stays
the left sidebar footer, `dockToggles` default to `header.end`. There is no
separate header row.

Fallback when a slot's region is hidden (or a sidebar is collapsed), first
visible wins (`slotFallbackChain`): header.X -> leftSidebar.header ->
rightSidebar.header -> footer.X; footer.X -> leftSidebar.footer ->
rightSidebar.footer -> header.X; leftSidebar.header -> header.start ->
rightSidebar.header -> footer.start; leftSidebar.footer -> footer.start ->
header.start -> rightSidebar.footer; rightSidebar.header -> header.end ->
leftSidebar.header -> footer.end; rightSidebar.footer -> footer.end ->
header.end -> leftSidebar.footer. The legacy `tenantFooter` prop keeps its own
`footerInHeader` fallback.

### Edge toggles and hotkeys are opt-in (#3661)

`AdminShell`/`AppShell` `edgeToggles?: boolean | Partial<Record<PanelEdge,
boolean>>` defaults to `false`: no edge toggle buttons, no hotkey hints, and
WASD/`?` are inert. Regions are laid out inline: the left sidebar is docked
open off phones (`ShellState.setInlineEdges`/`isInline`; viewport defaults and
`overlayMedia` do not apply), and the header/footer are plain bands without a
drop-down drawer (so `appPanel`/`systemPanel` are not reachable). Visibility
comes from `ShellLayout.panels.visible` and edit mode. The right edge is the
dock: dock toggles and focus tools still open it, it just loses its button.
`hotkeys` (default: follows the toggles) forces shortcuts on (`true`, panels
behave as drop-downs without buttons) or off. Phones keep the Menu opener and
the left drawer's close toggle. The left edge toggle is an icon above the
sidebar header content in both expanded and collapsed states, with a tooltip
and accessible expand/collapse name. `showTenantToggle` is a deprecated alias for
`edgeToggles.left`. Migration: pass `edgeToggles` (true) to keep the previous
behaviour.

The left edge's toggle is an icon-only chevron, not a labelled button: it
points the way the panel will move (left to collapse, right to expand), its
accessible name is `Collapse sidebar` / `Expand sidebar` (the hotkey rides
in the tooltip, there is no visible `<kbd>`), and off phones it closes the
navigation region: it sits at the end of the nav (`margin-block-start: auto`),
above the `leftSidebar.footer` slot, never below it. Order top to bottom, expanded
and collapsed: nav, chevron, footer (the account menu; the compact avatar last
in the collapsed rail). Expanded it lives inside the sidebar body
(`tenant-stack`) and hugs the inner edge; collapsed it is the middle row of the
rail stack (content, chevron, `tenantRailFooter`) and is centred. Only a rail
with neither nav nor footer content draws it alone at the bottom. Phones replace it with the drawer's
icon-only "Close menu" at the top, so opening the drawer still focuses a close control. The
header, footer and right toggles keep their region label and hotkey hint.

### Moving items between slots

Movable items have stable ids: dock toggles `dock:<tool>`, each host `slots`
snippet `slot:<slot>`, and host `slotItems` (`AppShell`, `{ id, label, slot,
render }[]`, exported type `ShellSlotItem`; keep ids stable, they are stored in
layouts). `AppShell` also supplies the built-in item `item:brand` (the shell
`logoSrc`/`logoAlt`, title and subtitle, linked to `homeHref` when set, default slot `header.start`, movable, same fallback chain
when the header is hidden); it sets `AdminShell` `brandInSlot` so the top band
draws no brand of its own (standalone `AdminShell` still does). The menu
opener and the legacy `account`/`tenantFooter` snippets are not items.

`AppShell` also supplies three more built-in items (ids are stored in layouts,
keep them stable), all movable in the layout editor like `item:brand`:

| Item | Default slot | Phone | Opt out |
| --- | --- | --- | --- |
| `item:account` | `leftSidebar.footer` | compact avatar, last in the header band (`header.end`) | `accountMenu={false}`; `accountMenu={{ slot }}` sets the default |
| `item:color-scheme` | `header.end` | icon-only (no label), accessible name kept | `colorSchemeToggle={false}`; `{ slot }` sets the default |
| `item:command-palette` | `header.center` | search glyph button | off unless `commandPalette` is passed |

`item:account` renders `WorkspaceAccountMenu` only when `user` is set (nothing
for `null`). Menu: name and email (when present on the user object), a Settings
link when `settingsHref` is set, Sign out when `onSignOut` (callback, wins) or
`signOutHref` (link) is given; plus tenant switching when used standalone. The
trigger carries `aria-expanded`, focus moves into the menu on open, Escape
closes only the menu and returns focus to the trigger. In an expanded sidebar
it shows the full identity (menu opens upward); everywhere else, and in the
collapsed rail, it is the compact avatar. In the collapsed rail `AppShell`
passes it as `tenantRailFooter` (outside the rail's scroll clip; the menu opens
to the inline end over the workspace) instead of letting the footer slot fall
back to another region. `item:color-scheme` reuses `ColorSchemeToggle` from
`@happyvertical/smrt-ui/themes` (no second switcher). `item:command-palette`
mounts the existing `CommandPalette` (`commandPalette: { providers, placeholder? }`,
types `AppShellCommandPalette`/`AppShellAccountMenu` from `./app`): it owns the
dialog and the global shortcut, so it mounts once. Planner-style hosts that
rendered their own `header.end` assistant toggle should pass `dockToggles`
(`dock:assistant`) and `user` instead.

Async sign-out (#3860): `onSignOut?: () => void | Promise<void>` (AppShell,
`WorkspaceAccountMenu`, `ShellSettingsPage`/`ShellSettingsPanel`) is awaited.
While pending the control is busy (`aria-busy`) and disabled, so a second
activation never fires the callback again; on success the account menu closes;
on rejection the menu (or Account section) stays as it was and shows an inline
`role="alert"` "Couldn't sign out. Try again." (`ui.shell_settings.sign_out_failed`).
A rejection is caught, never an unhandled rejection; the control is usable again
for a retry. `signOutHref` links are unchanged.

Unrendered regions in settings (#3860): `ShellState.regionsRendered:
Record<PanelEdge, boolean>` (read-only for consumers; `AdminShell` writes it
from the same `topRendered`/`bottomRendered`/`rightRendered`/`isEdgeShown('left')`
logic that collapses empty bands and edges, default all `true`) says whether a
region is actually on screen, distinct from the user's visibility choice. The
Layout rows in `ShellSettingsPanel` list a region when it is rendered, or when
the user hid it (so Show can always restore it); a shown region that is not
rendered (empty band, edge not presented at this width) has no row. The
"cannot hide the last region" guard still counts every shown region. In edit
mode every band renders, so every available region is listed.

`user` prop type (#3860): `AppShell`'s `user` is `ShellUser` (exported from
`./app`): `null` or `{ id: string | null | undefined; email?; name?; avatarUrl?
(string | null) }`, all readonly. The runtime's `SessionLayoutUser`
(`data.session.user`) and a full `User` both assign without a cast
(`__tests__/shell-user.test.ts` proves it with `expectTypeOf`). `id` stays
required but accepts `null`/`undefined` because an unsaved `User` carries
that. The shell reads `name`, `email` and `avatarUrl` for the account menu
(the avatar now shows) and forwards the same object to `Provider` untouched
(one internal cast; the Provider is typed for the full `User`), so nothing is
added or invented on the way.

DockToggle fallback (#3860): a `dockToggles` entry also takes `href?`, `ready?`
(reactive, default `true`), `labelNotReady?` and `onpress?(event, { registered,
ready }) => boolean | void`. Precedence on activation: (1) `onpress` runs first;
returning `false` or calling `event.preventDefault()` stops everything (no
toggle, no navigation). (2) If the tool is registered with `useShellDock()`
(and the dock is available) and `ready !== false`, the dock toggles as before.
(3) Otherwise `href` is followed, else nothing happens (the inert
`aria-disabled` button, unchanged). With an `href` in state 3 the toggle renders
as an `<a>` (middle-click and open-in-new-tab work) with no `aria-pressed` /
`aria-expanded`. Its name and tooltip are `labelNotReady`, else "Set up {label}"
(`ui.dock_toggles.set_up`), whenever it is not ready or links. The phone tab
bar's dock tab (the first toggle) follows the same resolution through the shared
`resolveDockToggle` / `runDockTogglePress` helpers in `dock-toggle.ts`; that tab
becomes a link entry. `PhoneBottomBarItem.onclick` now receives the click event.

`ShellLayout.placements?: Record<itemId, ShellSlot>` (additive, still version
1) overrides default slots. Pure helpers in `layout.ts` (also `./workspace/layout`):
`placeShellItem(layout, id, slot, defaultSlot?)` (passing the default drops a
no-op override; re-placing puts the item last), `resetShellItemPlacement`,
`resolveShellPlacements(items, layout)` (default order first, then placement
order; unknown ids and slots ignored) and `resolveShellVisiblePlacements(items,
layout, visible)` (placement first, then the hidden-region fallback above).
`useShellLayout()` adds `placeItem(id, slot)`, `resetItem(id)`, and readers
`placementItems`, `placements` (per slot) and `isRegionVisible(region)`.

### Editing the layout in place

`AppShell` `layoutEditing?: boolean | { slot?; floating? }` opts in (off: no toggle,
`setEditing(true)` refused, existing apps unchanged). It adds the built-in item
`item:layout-edit` (default slot `header.end`, normal hidden-region fallback):
a pencil `ShellIconButton` named "Edit layout" with `aria-pressed`; the same
button turns edit mode off (it stays a pencil, highlighted while on). Escape
also exits when no section toolbar is open (an open toolbar, or a keyboard move,
consumes Escape first).
`{ floating: true }` instead renders the same button fixed in the top-right
corner (round, elevated, safe-area aware, z-index 45): not a slot item, not
movable, never displaced by hidden regions. The header reserves end padding for
it, or, when the header is hidden, the right sidebar reserves top padding, or main
does when no right sidebar is shown
(`--smrt-shell-floating-reserve-inline|block|main`, set by `AppShell`).
A polite live region announces the mode. `useShellLayout()` has
`editable`, `editing` and `setEditing(boolean)` for hosts and assistants.

While `editing`:

- `AdminShell` `layoutEdit` (`ShellLayoutEditSurface`, set by `AppShell`) renders
  every slot of a visible region as a dashed drop zone (entering edit mode
  expands a collapsed left/right sidebar so its header/footer zones exist, and
  leaving restores it; a railless `rail: false` edge is never revealed: it
  stays as the user left it, and while editing a closed railless right edge
  with focus/dock tools shows a slim "Open <tool>" indicator tab
  (`data-edit-indicator`, z 21, no layout shift) that opens it and closes it
  again on exit) (`data-smrt-edit-zone`)
  labelled "Header · Left", empty ones included, highlighted
  (`data-drop-target`) while a drag targets it. Movable items render exactly as
  on the site (inside an `inert` wrapper) with a grip; the toggle itself is
  fixed. One headless `createSortable` engine (confined to the shell root,
  `allowSameContainerReorder: false`) drives pointer, native-drag and keyboard
  moves (Space, Up/Down across zones in visual order, Enter drops, Escape
  cancels) with the same announcements as `Sortable`
  (`sortable/announce.ts`), committing `placeItem(id, slot)`. Items whose region
  is hidden show in the zone they fall back to.
- Nothing in the header band renders outside the drop zones except each
  region's edit control: the brand is an item in `header.start`, and the Menu
  opener is hidden off phones. Every region, a collapsed sidebar rail included, gets an icon-only eye-off
  "Hide <region>" button (`ShellLayoutEditSurface.regionControl`, end of the
  header/footer band, top of a sidebar) that writes
  `setPanel(edge, { visible: false })`; the strip's "Show" restores it. The
  last visible region's button is disabled with an explanatory tooltip. Items
  of a hidden region (the edit toggle included) follow the fallback chain.
  Hiding the right sidebar (the dock) makes `useShellDock().available` false:
  dock toggles render unregistered and `open` is refused until it is shown.
- Hidden, available regions render as thin dashed strips ("Right sidebar ·
  hidden") with an eye "Show <region>" button (`setPanel(edge, { visible })`).
- `ShellNavEditor` replaces `TenantNav`: the real rows plus grips on every
  heading and item (existing reorder/move-across-sections), icon-only
  `ShellIconButton`s (eye `aria-pressed` = shown in navigation, heading
  `aria-pressed` = title shown, host actions) on each section and an eye per
  item, and a "New section" button at the end.
- Clicking a section heading opens its floating toolbar (rename input focused,
  title, hide, delete for custom sections with a confirm when non-empty, host
  actions). With `(hover: hover) and (pointer: fine)` hovering also opens it
  (closes on leave unless a click pinned it); touch or no hover is click/tap
  only. One toolbar at a time; Escape closes and returns focus to the heading;
  a pinned toolbar closes on outside pointer or focus leaving.

Host extension point: `AppShell` `sectionActions?: Snippet<[ShellSectionActionsContext]>`
(`{ sectionId, label, custom, editing }`) renders icon buttons in both the
section overlay and its toolbar (e.g. the planner's Options gear and Help);
use `ShellIconButton` (from `./workspace`) for matching looks. It renders only
while editing.

`ShellLayoutEditor` no longer has a Placement section (superseded by dragging in
place); it keeps panels, the navigation sort (icon toggles `aria-pressed` for
"Show <name> in navigation" / "Show title of <name>"), the preview and Reset.
The layout helpers and `placeItem`/`resetItem` stay.

### Activity ticker

`ActivityTicker` accepts app-owned `activities: ReadonlyArray<ShellActivity>` plus
optional `label` and `emptyLabel`. It never fetches data or establishes authority.
Render it in `AdminShell`'s `systemBar` slot with `activities={shell.activities}`;
render `ActivityList filter={{ status: 'running' }}` in `systemPanel` for details.
Connect the same registry to actual jobs through an authenticated app adapter or
the `activityFeed` below. Queued and terminal records never appear as running.

A single running activity is static. Multiple activities scroll continuously with
a persistent Pause/Resume control and pause on hover/focus. A separate accessible
list contains each process once; visual loop copies are hidden from assistive
technology. Reduced motion disables animation and allows manual horizontal
scrolling. Optional finite 0–100 progress is shown; no progress is inferred.

Focused validation: `pnpm --filter @happyvertical/smrt-svelte exec vitest run
src/components/workspace/__tests__/ActivityTicker.test.ts
src/components/workspace/__tests__/index.test.ts`, then the activity ticker's
Chromium scenarios via the package's documented `test:e2e` command.

### Live activity feed adapter (`./web`, #1779)

`activityFeed({ collection, map, shell })` (from `@happyvertical/smrt-svelte/web`)
bridges a `@happyvertical/smrt-web` live collection into a `ShellState` activity
registry: it subscribes the collection through `liveCollection`, reactively maps
each row → `ShellActivity` via the app-supplied editorial `map`, and drives
`upsertActivity` / `updateActivity` / `removeActivity` as rows appear, change,
and vanish (a row mapping to `null` is excluded / retracted). Returns a disposer
that removes exactly the activities it created. Must be called during component
init (installs a `$effect`); the subscription tears down on unmount.

It lives behind the opt-in `./web` entry — which pulls the TanStack client-data
engine — and is **never** imported under `components/workspace/`, so the
AdminShell core (`./workspace`) stays transport-agnostic and TanStack-free (epic
#1766). The pure diff core is `ActivityFeedReconciler` (engine-free, unit-tested
against a real `ShellState`). Demo: `playground/.../admin-shell-activity-feed`.

### `updateAvailable` binding (`./web`, #1764)

`useUpdateAvailable({ state, updated? })` (from `@happyvertical/smrt-svelte/web`)
is the Svelte 5 reactive wrapper over smrt-web's framework-free `UpdateState`
(from `createUpdateState()`). It surfaces `updateAvailable` / `bundle` /
`contract` reactively (`$state`/`$derived`) for a toast or reload prompt, and
wires SvelteKit's native `updated` store as the **bundle** signal. The
**contract** signal (a manifest-hash change across loads, or a live `_events`
manifest-frame mismatch latched by smrt-web on reconnect) is surfaced as-is.

`updated` is passed IN as a reactive accessor (`() => updated.current` on modern
`$app/state`, or a `$derived` over the legacy `$updated` store) rather than
imported here — `$app/*` only resolves inside a SvelteKit app, so a library that
imported it could not build/test standalone; the other `./web` adapters take
runtime input the same way. Must be called during component init (installs
`$effect`s that subscribe to the primitive and watch `updated`); both tear down
on unmount. Construct ONE `createUpdateState()` per app (it owns the durable
last-seen-hash bookkeeping) and pass its `manifestHash` from
`@happyvertical/smrt-virt-web`. Browser-safe, engine-free (no `@tanstack/*`
type). NOTE: `.svelte.ts` runes tests may not run under the local Darwin/vite8
toolchain (CI is the gate) — the binding is covered by typecheck + svelte-check +
a light unit test.

### Dock availability gates (server-side)

`ToolDef.gates?: string[]` declares the gates a tool must pass to be visible.
Convention: `<prefix>:<identifier>` (e.g. `permission:articles.publish`,
`feature:video-tools`, `myapp:show-jobs`). `composeDockAvailability` from
`@happyvertical/smrt-svelte/workspace/server` evaluates them — register one
evaluator per prefix, throws on unknown prefixes (loud-fail beats silent-leak),
AND semantics across a tool's gates. Node-safe, no Svelte imports.

The framework does NOT ship built-in evaluators — every prefix the dock sees
must have a caller-supplied evaluator in the map (otherwise composition
throws). `permission:` and `feature:` are recommended conventions for
ecosystem cohesion (consumers typically wire `PermissionResolver` from
smrt-users and `FeatureResolver` from smrt-features as those evaluators), but
they're not reserved — apps may pick any namespace. App-specific gates
should use a dedicated namespace (e.g. `myapp:`) to avoid colliding with
future built-ins.

Recommended pattern: in the consumer's `+server.ts` endpoint that backs
`fetchAvailability`, wrap `PermissionResolver` (smrt-users) and `FeatureResolver`
(smrt-features) as evaluators and pass them in. Tools without `gates` stay
unconditionally visible (back-compat). Anytown's hand-coded
`apps/dashboard/src/lib/server/content-tool-dock.ts` is a candidate for
migration in a follow-up.

Legacy ToolsDock treats availability fetch failures as degraded presentation
state: it preserves the current context's last successful tool IDs, labels,
and badges. Before the first success, or after a context change, it falls back
to registered-tool metadata so contextual values do not cross boundaries.
Consumers can read `dock.availabilityError` to surface the current context's
failure; a context change or later successful refresh clears the signal, and
success applies the new snapshot.
Availability is never an authorization boundary—server operations must still
enforce permissions.

`ActivityTicker` accepts optional `statuses` restricted to queued/running; running-only remains the default. Opting into queued work adds an explicit localized Queued label without progress. Terminal outcomes belong in expanded `ActivityList`, with retention controlled by the app-owned data source.

### Motion (#3858)

All durations and easings are theme tokens, never literals. The CSS motion sits
in `@media (prefers-reduced-motion: no-preference)` (or is zeroed by the reduced
block), and `tokenDuration()` returns 0 under reduced motion. `data-motion` is
set on the shell root after hydration and two frames, so first paint, SSR and a
persisted layout restoring never animate; phone drawers keep their own
`onEdgeAnimationEnd` / `waitForPanelAnimations` handshake (no track transition
on phone, and the tracks are on the shell root, not the panel, so `inert` is
never held by a transition).

| Motion | Token | Reduced motion |
| --- | --- | --- |
| Left sidebar / right dock track (`grid-template-columns`, desktop push), `--smrt-easing-emphasized`; stays immediate while `data-resizing` | `--smrt-duration-short4` | none |
| Revealed sidebar / dock content fade-in | `--smrt-duration-short2` | none |
| Edit mode: drop zones, strips, region controls, item grips fade and scale in | `--smrt-duration-short2` | none |
| List reorder/filter `animate:flipRow` on TenantNav rows, section-menu cards/rows, overview tiles, `Sortable` items (`ShellNavEditor` rows go through `Sortable`) | `--smrt-duration-short4` via `tokenDuration()` | duration 0 |
| Colour-scheme crossfade of shell background/colour, while `data-smrt-theme-changing` is set for one transition | `--smrt-duration-medium1` | not set |
| View transitions: brand, nav, dock persist while the page crossfades | browser default | `runViewTransition` skips |

Host-facing helpers, exported from `@happyvertical/smrt-svelte/app` and free of
`$app/*` (a hash router or non-SvelteKit host can use them):

- `runViewTransition(update, { skip? }): Promise<void>` calls
  `document.startViewTransition(update)` when present and reduced motion is off,
  else awaits `update()`. Resolves when the DOM update is applied; an aborted or
  skipped transition never throws, an error from `update` does. `AppShell`
  wraps the edit-mode toggle in it.
- `createOnNavigateViewTransition(options?)` returns a function for SvelteKit's
  `onNavigate(createOnNavigateViewTransition())`. It takes the navigation
  structurally (`{ complete, type?, willUnload? }`).

While a transition runs `<html data-smrt-view-transition>` is set and only then
does the shell assign `view-transition-name: smrt-shell-brand`, `smrt-shell-nav`
and `smrt-shell-dock` (so they never become containing blocks otherwise).
Names must be unique per document: hosts must not reuse them.
`tokenDuration(name, element?)` and `flipRow` live in
`workspace/admin-shell/motion.ts` for in-package lists.

## Shell layout customization

Users can show/hide the edge panels and reorder, hide, and move navigation
sections and items. Source: `workspace/admin-shell/layout.ts` (pure model),
`layout-controller.svelte.ts` (the API), `ShellLayoutEditor.svelte` (the
control panel), wired by `app/AppShell.svelte`.

- **`ShellLayout`** is a versioned (`version: 1`), JSON-serializable sparse
  delta: `sectionOrder`, `itemOrder` (per section), `hidden` (section and item
  ids), `moved` (item id to section id), `panels` (per edge `visible` /
  `initial`). It is what a host stores or exports (smrt-planner bundles it in
  its app blueprint). `normalizeShellLayout(unknown)` reads untrusted JSON and
  never throws (unknown version yields an empty layout).
- **Ids.** Sections: `ShellNavGroup.id ?? heading`; items: `ShellNavItem.id ??
  href`; one shared namespace (duplicates get `#2`, `#3`). Set explicit ids
  when headings are translated or hrefs change. The flat `nav` items are the
  implicit first section, `@root` (`SHELL_NAV_ROOT_SECTION_ID`): items can be
  moved in and out, the section itself cannot move or hide.
- **`applyShellLayout(nav, groups, panels, layout)`** is pure and total. Ids the
  host no longer has are ignored; new host items and sections keep their
  default slots (listed ids permute among the slots they occupy). A hidden
  section hides its items; a section the layout empties is dropped from
  `groups`; an empty layout returns the inputs unchanged. A layout can hide a
  panel but cannot bring back one the host removed (`false` / `initial:
  'hidden'`). Published from the browser-safe `./workspace/layout` subpath (no
  Svelte) as well as `./workspace`.
- **Persistence is host-owned.** `AppShell` takes `layout` and `onlayoutchange`:
  with `layout` the host is the single source of truth (pass `null` for none);
  with only `onlayoutchange` the shell keeps the value in memory and reports
  edits; with neither, the layout lives in the settings-core user tier
  (`ShellSettingsDelta.layout`, via `storageKey`). `AppShell` now creates the
  `ShellState` itself and passes it to `AdminShell`, so panel overrides reach
  it (`ShellState.setLayoutPanels`); a layout-hidden edge ignores toggles,
  hotkeys, viewport defaults, and the restore opener.
- **Layout API** (`useShellLayout()` / `tryUseShellLayout()` under an
  `AppShell`, also `ShellLayoutController`): `moveSection(id, toIndex)`,
  `moveItem(id, sectionId, toIndex?)`, `hide(id)`, `show(id)`, `setPanel(edge,
  { visible?, initial? })`, `reset()`, each returning whether anything changed,
  plus readers (`layout`, `sections`, `panels`, `applied`, `customized`,
  `isHidden`; item placement is in "Moving items between slots", edit mode in
  "Editing the layout in place"). An assistant calls the same methods the editor does. The
  context is separate from `useAdminShell()` because `AppShell`, not
  `AdminShell`, owns the navigation.
- **Sections belong to the app.** Hosts (and recipes, via the host) suggest
  sections as `ShellNavGroup`s; the user overrides them in the same additive
  version-1 layout: `sections[id] = { label?, showTitle? }` (rename; hide the
  title) and `customSections: { id: 'custom:...', label }[]` (user-created).
  Custom sections join `sectionOrder`, receive items through `moved`, show in
  the editor when empty but not in the nav, and get a unique `custom:` id.
  `showTitle: false` (also settable by a host on `ShellNavGroup.showTitle`)
  renders the items flat in a `role="group"` named by the heading, no
  `<details>`/`<summary>`. `applyShellLayout` keeps the section's original id
  on renamed output groups. Helpers: `renameShellSection`,
  `setShellSectionTitleVisible`, `createShellSection`, `deleteShellSection`
  (custom only; items return to their default sections). Old stored layouts
  need no migration; new host sections and items land in their suggested slot.
  Controller: `renameSection`, `setSectionTitleVisible`, `createSection(label)`
  (returns the id), `deleteSection`.
- **Item labels.** The same layout renames single navigation entries:
  `items[itemId] = { label? }` (additive; trimmed, blank removed; ids as above,
  top-level items of `nav` and groups). `resolveShellNavModel` items carry
  `label` / `defaultLabel`; `applyShellLayout` emits the renamed item with
  `label` = the user's and `defaultLabel` = the host's (so nav, breadcrumbs and
  titles that read `nav` follow the rename). Helper `renameShellItem(nav, groups,
  layout, itemId, label | null)`; controller `renameItem(itemId, label | null)`
  (null or blank resets). Edit mode: each `ShellNavEditor` row has an icon-only
  "Rename <label>" button opening an inline field (Enter saves, Escape cancels,
  blur saves) and, once renamed, "Reset <label> to <original>"; the original shows
  as the row tooltip. Presets ("cookbooks") ship it in the stored layout.
- **Section navigation (`navMode: 'sections' | 'sections-with-items'`).** `AppShell`
  (and `TenantNav` / `ShellNavEditor` directly) also support `'items'` (the
  default). `'sections'` keeps one link per section with no entries.
  `'sections-with-items'` adds indented entry links in the expanded drawer;
  its collapsed rail still shows section icons with tooltips. In edit mode,
  this variant exposes both section icons and entry editing. The section link
  goes to `ShellNavGroup.href`, else
  `AppShell` `sectionHref(sectionId)` (user-created sections), else the first
  entry; it is `aria-current="page"` on that page and `"true"` on any of the
  section's entry pages. `AppShell` also takes `iconComponent` for host icon
  names. `ShellNavGroup.icon` / `.href` are additive; the user override is
  `sections[id].icon` (trimmed; blank or the host's icon removes it), helper
  `setShellSectionIcon(nav, groups, layout, id, icon | null)`, controller
  `setSectionIcon(id, icon | null)`; `resolveShellNavModel` sections carry
  `icon` / `defaultIcon` and `applyShellLayout` emits the effective `icon`.
  Icons are shell icon names (`SHELL_SECTION_ICONS` is the picker set, drawn
  from Material icons like the rest of `SHELL_ICON_PATHS`;
  `SHELL_DEFAULT_SECTION_ICON` is `folder`) or host names rendered by
  `iconComponent`. Entry and action icons use built-in SVGs when no host
  renderer is supplied, falling back to the default section glyph for unknown
  names. Edit mode in `sections` mode: sections keep grip,
  rename, hide, delete; the title toggle is replaced by an "Icon of <label>"
  popover grid ("Use <icon> icon", `aria-pressed` on the current one; Escape
  closes the grid before the toolbar). Entries are not in the sidebar in
  `sections` mode; `sections-with-items` shows them under their section.
- **TenantNav rows.** `ShellNavItem.icon` renders in items mode and the collapsed rail (host `iconComponent` first, else `SHELL_ICON_PATHS`); an iconless item shows the `placeholder` glyph in the rail only. The current row has a `secondary-container` fill plus a start indicator bar (`aria-current="page"` unchanged). Row block-size is `--smrt-touch-target-min` at the phone boundary (`max-width: 48rem`) and `--smrt-control-target-min` otherwise; `ShellNavEditor` item rows use the same sizing.
- **`ShellSectionMenu`** (`sectionId`, `controller?`, `meta(entry)`,
  `actions(entry)`, `iconComponent`, `aria-label`, `layout`): the section's page body.
  `layout="cards"` renders an auto-fill grid (min 16rem) of cards: 32px icon in a
  tinted circle, title, `ShellNavItem.description` (2 lines), then `meta` and
  `actions` at the bottom; one stretched link, actions stay separate controls;
  edit mode keeps grip/rename/hide in the grid. Unknown icon names draw the
  default glyph (dev warning), never the name. `layout.items[id].description` (host/preset-set, not editable in the UI)
  overrides an item's `description`. Default `list`: A
  `<ul>` of rows (icon, label link, host `meta`, host `actions`, chevron; the
  row is one stretched link, actions sit above it) in applied order with
  renames; hidden entries are omitted. While editing, the same rows become the
  nav editor's chrome (single-container `Sortable` grip with keyboard moves,
  inline rename/reset, show/hide toggle) driving `moveItem`/`renameItem`/
  `hide`/`show`; rows are not links then. `ShellSectionMenuEntry` is the snippet
  argument (`id, href, label, defaultLabel, icon, hidden, item`).
- **`ShellLayoutEditor`**: `controller` (default: context), `preview` (default
  true), `iconComponent`. Each section has an inline name input, icon toggles
  for visibility and title, and (custom only) a trash button, which confirms
  when non-empty; a New section button creates one. Mount it on a settings page or in a dock tool.

### Sortable and the Board engine

`components/sortable/controller.svelte.ts` is the headless engine extracted from
`Board`: keyboard pick-up (Space/Enter, arrows, Escape), pointer and native-drag
moves with a 6px threshold, one in-flight move at a time (a rejected `commit`
restores and announces), focus return, and announcements as typed events the
host localizes. `Board` (own markup and `ui.board.*` strings) and `Sortable`
(`ui.sortable.*`) both use it. `Sortable` renders stacked containers of items
with a move handle per item, optional `reorderContainers` (a second engine; `fixed`
containers lead and stay put), a drop marker, and cancel-on-blur; it is
controlled and never mutates `items`. Item moves report `target.index` after
removing the item from `source`.

## App shell and owner setup (`./app`)

`@happyvertical/smrt-svelte/app` (`src/components/app/`) is browser-only. It
lives beside, not inside, `./workspace` so the AdminShell barrel stays free of
`Provider` and its tests.

- `AppShell` built-in items (`item:account`, `item:color-scheme`,
  `item:command-palette`, with `user`, `onSignOut`, `signOutHref`, `accountMenu`,
  `colorSchemeToggle`, `commandPalette`) are documented under "Moving items
  between slots".
- `AppShell` composes `Provider` (`webmcp`, `user`, `permissions` pass through
  unchanged), `ThemeProvider`, the theme CSS (`themes/styles/{all,fonts}.css`
  are imported by the component — forgetting them leaves `--smrt-*` unresolved),
  `AdminShell`, `TenantNav` from the consumer's `nav`/`navGroups`/`currentHref`,
  and an `AppScopePanel`. `ShellNavItem.action` (trailing icon link, optional `visibility: 'active'` = only while the item's section is current; omitted when collapsed) is rendered by `TenantNav` and passed through `AppShell` unchanged. Panels start collapsed as in `AdminShell`; pass
  `config` to change that. `dock` is a snippet rendered inside the shell: a host
  places its assistant there in a `ShellDockTool`, so this package never
  imports `smrt-chat`. It receives the Provider's `DataSurfaceRegistry`
  (`{#snippet dock(registry)}`), the instance mounted routes register on
  when `webmcp` UI is on; pass it to `<AssistantDock {registry} />`. `runtimeDiagnostics` (default false) mounts the
  read-only `smrt.runtime.diagnostics.read` WebMCP tool. `dockToggles`
  (`{ tool, label, icon?, slot? }[]`) renders icon buttons in the shell slot
  named by `slot` (default `header.end`; see "Regions and slots"), each toggling the `ShellDockTool` with that id: `aria-pressed` and
  `aria-expanded` follow the dock, `aria-controls` is
  `smrt-admin-shell-right-panel`, the label is the tooltip, and `assistant`
  defaults to a chat-bubble icon (`icon: 'chat'`; other text is a glyph). A
  toggle whose tool is not registered yet, or whose dock is not `available`
  (the right edge removed by the host or hidden by the user's layout), is
  `aria-disabled` and `open`/`toggle` return false. Hosts, routes and
  assistants drive the same dock with `useShellDock()` from `./workspace`
  (`{ active, tools, available, has, isOpen, open, close, toggle }`, throws outside a
  shell). Opening moves focus into the dock (first focusable, else the panel);
  closing by Escape, toggle or code returns it to the opener when focus was left
  in the dock. `open(tool, { focus: false })` skips the focus move. The
  dock-control state lives on `ShellState` (`openDockTool`, `toggleDockTool`,
  `closeFocusTool`, `openFocusToolId`). Playground:
  `playground/src/routes/app-shell-dock-toggles`. Server code that
  lists that tool (the diagnostics route's `toolNames`) imports
  `RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME` from `./app/runtime-diagnostics`,
  which is plain TypeScript; the `./app` barrel loads Svelte components and
  theme CSS.
- `OwnerSetupForm` is props-driven and imports nothing server-side. Contract
  (lane 3369 server): `default` form action; fields `token` (hidden), `name`,
  `email`, optional `tenantName` (`askTenantName`); `load` data
  `{ available, token }` (`available: false` renders a neutral unavailable
  state); failures `fail(status, { code, message })`, `message` shown as given
  and never branched on. Pass `data` and `form` straight from the route. The
  form is a plain `method="POST"`; pass `enhance` from `$app/forms` to enhance
  it. The token is a hidden field only and is never stored, logged or shown.
  Single-use, loopback-only enforcement stays server-side.

## Theme (premium baseline)

The shell only consumes theme tokens; CSS and tokens changed, DOM and behaviour did not.

- Surface ladder: main and phone top bar on `--smrt-surface-ground`; header, footer and top/bottom bands, corners and the left sidebar on `--smrt-surface-panel`; the dock (right edge), drawers, phone sheet and phone drawers, popovers, toasts and the shortcuts dialog on raised glass (`--smrt-glass-surface-strong`, `--smrt-elevation-3`, drawers and sheet `--smrt-elevation-4`, plus `--smrt-inset-highlight`). Edit-mode strips use `--smrt-surface-sunken`.
- Region edges are `--smrt-hairline`; no solid outline-variant borders remain in the shell. Edit-mode drop zones and strips use the hairline with `border-style: dashed` and state tokens for fill. The resize separator keeps its own primary affordance.
- Glass: the header, phone top bar, phone tab bar, dock, drawers, sheet and popovers set `backdrop-filter: blur(var(--smrt-glass-blur)) saturate(var(--smrt-glass-saturation))` over `--smrt-glass-surface` (`-strong` for raised regions). Outside the Glass preset the tokens are opaque with blur 0. `backdrop-filter` makes the element a containing block for fixed descendants; the e2e suite covers the account menu and the floating layout toggle.
- State layers: rows, tabs, rail buttons, toggles and the account trigger use one `::after` veil (`background: currentColor`, opacity from `--smrt-state-hover` / `-pressed` / `-selected`); transparent icon buttons use the equivalent `color-mix`. The selected nav row keeps its container fill and start indicator under the veil. Disabled uses `--smrt-state-disabled`. Focus rings come from `--smrt-focus-ring-*`; control radius and heights from `--smrt-control-*`.
- E2E fixture: `ShellFixture` accepts `?theme=glass|material|studio|smrt` and `?scheme=dark` (all presets are imported) for per-preset screenshots.

## Forced colors

Under `forced-colors: active` the shell follows the smrt-ui token layer (CanvasText hairlines, no shadows or blur, Highlight focus ring; see `packages/smrt-ui/src/themes/README.md#forced-colors`). Style blocks add `@media (forced-colors: active)` rules only where selection carried meaning by colour alone: the tenant nav start bar (Highlight) and bold row, phone tab bar current tab, dock toggles, focus tools, pressed shell icon buttons and the open account trigger. Chart series cycle system colours. Verified by `e2e/forced-colors.spec.ts`; the fixture (`forced-colors.html`) imports `base.css`, which carries the token layer.
