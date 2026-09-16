# workspace/

Canonical AdminShell family for SMRT admin web apps.

`@happyvertical/smrt-svelte/workspace` now exports the four-edge AdminShell
contract:

- App scope on the top edge
- Tenant scope on the left edge
- Focus scope on the right edge
- System scope on the bottom edge

The shell owns geometry, keyboard behavior, settings deltas, responsive
presentation, focus tool registration, activity registry/watch components, and
optional SMRT-fed content seams. It does not depend on jobs, users, tenancy, or
SvelteKit route APIs; apps pass data, endpoints, and permission-filtered nav in.

## Main Exports

- `AdminShell`
- `ShellState` / `createShellState`
- `ShellSettingsPanel`, `HotkeyInput`, `ShortcutsOverlay`
- `ShellCorner`, `ShellDockTool`, `TenantNav`, `WorkspaceAccountMenu`
- `ActivityBadge`, `ActivityList`, `ActivityItem`, `ActivityToasts`
- `AppScopePanel`, `SystemStatusChips`, `SystemScopePanel`
- `tenantNavFromManifest`

Use `AdminShell`'s `tenantFooter` snippet with `WorkspaceAccountMenu` to keep a
single-line tenant/account control pinned below scrolling tenant navigation.
Tenant switching and sign-out stay app-owned callbacks, so the workspace core
remains independent of SvelteKit and `smrt-users` route conventions.

Keep the `appBar` snippet for content in the center header band. Side-aligned
identity and action content belongs in `topLeftCorner` / `topRightCorner`,
wrapped in `ShellCorner side="left"` or `ShellCorner side="right"` so it follows
the corresponding shell track as that edge expands and collapses.

## AssistantDock recipe (#2904)

`ShellDockTool` also hosts `@happyvertical/smrt-chat/svelte`'s `AssistantDock`
— a route-aware assistant surface. This package has no runtime dependency on
`@happyvertical/smrt-chat` (only a devDependency, for tests); the composition
below is intentionally application code, not a `workspace/` export:

```svelte
<script lang="ts">
  import { ShellDockTool } from '@happyvertical/smrt-svelte/workspace';
  import { AssistantDock } from '@happyvertical/smrt-chat/svelte';
</script>

<ShellDockTool id="assistant" label="Assistant" icon="bot">
  {#snippet render()}
    <AssistantDock {transport} {registry} />
  {/snippet}
</ShellDockTool>
```

`registry` is the same `DataSurfaceRegistry` instance mounted routes register
their descriptors on. See
[`docs/assistant-dock.md`](../../../../../docs/assistant-dock.md) for the full
design.

## Migration

See [MIGRATION.md](./MIGRATION.md) for the first-generation workspace migration
map.
