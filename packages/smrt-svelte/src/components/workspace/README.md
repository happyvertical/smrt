# workspace/

Upstream admin shell primitives for SMRT consumer apps. These pieces are
SvelteKit-agnostic, SSR-safe, and carry no domain coupling — they slot into
any Svelte 5 app that wants a sidebar + topbar + tools-dock layout.

## Tracking

- Epic: [happyvertical/smrt#1226](https://github.com/happyvertical/smrt/issues/1226)
- Implementers:
  - `WorkspaceShell` — [#1227](https://github.com/happyvertical/smrt/issues/1227)
  - `NavTree`, `Breadcrumbs` — [#1228](https://github.com/happyvertical/smrt/issues/1228)
  - `ToolsDock`, `defineToolsDock`, `useToolsDock` — [#1229](https://github.com/happyvertical/smrt/issues/1229)

## Shared types (this PR)

Exported from `./types.js` via the barrel:

- `NavItem`, `BreadcrumbItem`
- `ToolDef`, `AvailableTool`, `ToolsDockContext`, `ToolsDockApi`

## Planned component exports

- `WorkspaceShell` (#1227) — outer shell layout primitive
- `NavTree`, `Breadcrumbs` (#1228) — navigation primitives consuming `NavItem` / `BreadcrumbItem`
- `ToolsDock` + `defineToolsDock` + `useToolsDock` (#1229) — right-rail tools dock + registry

## Principles

- **SvelteKit-agnostic** — no `$app/state` or `$app/navigation` imports
- **SSR-safe** — guard all `window` / `localStorage` access
- **No token bridges** — consume `var(--smrt-color-*)` tokens directly
- **No domain coupling** — domain-specific tools live in consumer packages
- **Extensible tool IDs** — tool IDs are arbitrary strings, not an enum
