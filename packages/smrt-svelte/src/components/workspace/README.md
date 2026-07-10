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
- `ShellDockTool`, `TenantNav`, `WorkspaceAccountMenu`
- `ActivityBadge`, `ActivityList`, `ActivityItem`, `ActivityToasts`
- `AppScopePanel`, `SystemStatusChips`, `SystemScopePanel`
- `tenantNavFromManifest`

Use `AdminShell`'s `tenantFooter` snippet with `WorkspaceAccountMenu` to keep a
single-line tenant/account control pinned below scrolling tenant navigation.
Tenant switching and sign-out stay app-owned callbacks, so the workspace core
remains independent of SvelteKit and `smrt-users` route conventions.

## Migration

See [MIGRATION.md](./MIGRATION.md) for the first-generation workspace migration
map.
