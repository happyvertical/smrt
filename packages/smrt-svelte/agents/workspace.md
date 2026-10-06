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

### Responsive chrome, viewport defaults, resizable edges

The root grid has five rows: `header` · top edge · body · bottom edge · phone
bottom bar. The header and phone-bar tracks are `0rem` unless their snippets
render, so hosts that pass none of the new props get the original layout; keep
that invariant (`AdminShell.responsive.test.ts` "backward compatibility").
Phone drawers and the bottom drawer offset themselves by the header and phone
bar tracks. `shell.viewport` comes from `ADMIN_SHELL_PHONE_QUERY` (48rem, the
same boundary as the CSS media query — never make one configurable without the
other) and `ADMIN_SHELL_DESKTOP_QUERY` (64rem); `installShellViewport` runs on
mount and the `ShellState` constructor detects the initial class so the first
paint is right.

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

## App shell and owner setup (`./app`)

`@happyvertical/smrt-svelte/app` (`src/components/app/`) is browser-only. It
lives beside, not inside, `./workspace` so the AdminShell barrel stays free of
`Provider` and its tests.

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
  (`{ tool, label, icon? }[]`) renders icon buttons at the right of the shell
  header (the AdminShell `header` row, shown only when the prop is non-empty),
  each toggling the `ShellDockTool` with that id: `aria-pressed` and
  `aria-expanded` follow the dock, `aria-controls` is
  `smrt-admin-shell-right-panel`, the label is the tooltip, and `assistant`
  defaults to a chat-bubble icon (`icon: 'chat'`; other text is a glyph). A
  toggle whose tool is not registered yet is `aria-disabled`. Hosts, routes and
  assistants drive the same dock with `useShellDock()` from `./workspace`
  (`{ active, tools, has, isOpen, open, close, toggle }`, throws outside a
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
