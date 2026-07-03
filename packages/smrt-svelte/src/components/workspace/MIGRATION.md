# AdminShell Migration

The first-generation workspace family (`WorkspaceShell`, `RoleShell`,
`NavTree`, `Breadcrumbs`, `ToolsDock`) is no longer the public
`@happyvertical/smrt-svelte/workspace` surface. Treat those source files as a
migration reference while moving apps to `AdminShell`.

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
