# AdminShell Migration

The first-generation workspace family (`WorkspaceShell`, `RoleShell`,
`NavTree`, `Breadcrumbs`, `ToolsDock`) is no longer the public
`@happyvertical/smrt-svelte/workspace` surface. Treat those source files as a
migration reference while moving apps to `AdminShell`.

## Adopting AdminShell is additive

Moving to `AdminShell` is a non-breaking, opt-in change — nothing is removed
from under you:

- **Existing consumers keep working.** The first-generation classes still ship
  in this package and still render. Migrate a route or an app at your own pace;
  there is no flag day.
- **Adopt by wrapping, not rewriting.** Mount `AdminShell` in a layout around
  your existing pages (`{@render children()}`). Page-level data loading is
  unchanged — in SvelteKit, keep loading data in each route's server `load` and
  refreshing with `depends()` / `invalidate()`; the shell is chrome around the
  page, not a replacement for its data flow.
- **SSR-safe by construction.** The public core renders statically on the
  server; WASD hotkeys, `localStorage` persistence, and activity hydration all
  activate after mount. Mounting it in a layout — even one whose pages are
  server-rendered — is safe. Build tenant nav server-side with
  `tenantNavFromManifest()` and pass it in as layout data rather than fetching
  it on the client.

The `template-sveltekit` scaffold adopts AdminShell this way by default — see
its `src/routes/+layout.server.ts` / `+layout.svelte` for a worked example.

## Concept Map

| First-generation concept | AdminShell concept |
| --- | --- |
| `WorkspaceShell` outer layout | `AdminShell` four-edge layout |
| `RoleShell` wrapper | App-owned config + `TenantNav` |
| `NavTree` | `TenantNav` fed by app data or `tenantNavFromManifest()` |
| `ToolsDock` / `defineToolsDock` | Focus edge tools through `ShellState.registerFocusTool()` or `ShellDockTool` |
| Dock localStorage | Sparse `ShellSettingsDelta` through `ShellSettingsAdapter` |
| App-specific job panels | `SystemScopePanel` fed by app stores/endpoints |

## Minimal Shape

```svelte
<script lang="ts">
  import {
    AdminShell,
    TenantNav,
    SystemStatusChips,
  } from '@happyvertical/smrt-svelte/workspace';
</script>

<AdminShell title="My App">
  {#snippet tenantPanel()}
    <TenantNav items={navItems} currentHref={currentPath} />
  {/snippet}

  {#snippet systemBar()}
    <SystemStatusChips chips={statusChips} />
  {/snippet}

  {@render children?.()}
</AdminShell>
```

## Notes

- `hidden` means the app omitted an edge; users normally persist only
  collapsed/expanded panel deltas.
- Push versus overlay is an app decision per edge.
- Expanded panels are independent by default. Use matching `exclusiveGroup`
  values on panel config to make panels mutually exclusive.
- Hotkeys use `KeyboardEvent.code` so the WASD cluster remains physical across
  keyboard layouts.
- URL synchronization is intentionally adapter-owned. The shell exposes
  serializable state and commands; apps decide their route/query shape.
- Shell activities are client-side records. Server jobs, polling, WebSockets,
  and `smrt-web` SSE live updates can all feed them through adapters.
