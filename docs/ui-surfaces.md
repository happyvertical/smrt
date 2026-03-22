# UI Surfaces

SMRT packages can expose UI at three different levels. These surfaces are related, but they are not interchangeable.

## `./svelte`

`./svelte` is for reusable components.

Examples:

- `ContentEditor`
- `ArticleCard`
- `MessageList`
- `UserForm`

Use `./svelte` when a consuming app wants to place package UI inside its own custom pages, layouts, and workflows.

## `./playground`

`./playground` is for preview metadata.

Package-owned playground modules live at `src/svelte/playground.ts` and are consumed by the shared `smrt playground` host. The shared playground uses these modules to discover preview entries, fixtures, and live/mock modes.

`./playground` is the default UI standard for SMRT packages with Svelte components.

## `./routes`

`./routes` would be for package-owned page or workflow surfaces.

This is not the same thing as the generated API surface. SMRT already standardizes backend endpoints through generated `+server.ts` routes. `./routes` is only for page-level UI that a downstream app may want to mount.

Examples:

- content workspace
- content governance
- asset manager
- image studio

Use `./routes` only when a package owns a real reusable app surface that downstream apps would otherwise keep rebuilding.

Do not add `./routes` just because a package:

- has backend models
- has generated API endpoints
- has reusable components
- has a playground module

Many packages should stop at `./svelte` and `./playground`.

## Current Standard

- UI packages may expose `./svelte`.
- UI packages with previews should expose `./playground`.
- Packages may keep package-local page shells under `src/svelte/routes` and package-local SvelteKit files under `src/routes`.
- SMRT is not standardizing a public `./routes` package export for this release.

If downstream apps later need reusable page-surface contracts, we can standardize `./routes` intentionally from that real usage instead of carrying it speculatively.

## Downstream Ownership

Even if we later expose `./routes`, the consuming app would still own:

- physical SvelteKit route files
- URL structure
- layouts
- auth and tenancy
- app-specific route extensions

Package route modules provide the canonical page surface. The consuming app decides where and how to mount it.
