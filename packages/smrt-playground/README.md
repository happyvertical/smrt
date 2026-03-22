# @happyvertical/smrt-playground

Shared playground discovery, runtime helpers, and host components for SMRT UI packages.

## Purpose

`@happyvertical/smrt-playground` powers the shared `smrt playground` experience. It discovers package-owned playground modules and renders them in a common host without forcing those packages to share a single route tree.

This package is about previews, not app routing.

## Surface Model

SMRT UI packages can expose three different surfaces:

- `./svelte` for reusable components
- `./playground` for preview metadata
- package-local page shells under `src/svelte/routes` and `src/routes` when needed

`@happyvertical/smrt-playground` consumes `./playground`, not package route trees.

For this release, most UI packages should stop at `./svelte` and `./playground`. Route/page shells can stay package-local until there is a concrete downstream need to standardize a public route contract.

For the full convention, see [docs/ui-surfaces.md](../../docs/ui-surfaces.md).

## Package-Owned Playground Modules

Packages opt in by defining `src/svelte/playground.ts`.

That module should:

- export stable preview entry IDs
- point at real package components
- provide mock fixtures or live configuration
- stay importable from workspace source for `smrt playground list`

The shared host discovers these modules and renders them. Package pages do not need to be mounted into the shared playground.

## Relationship To `smrt playground`

The `smrt playground` CLI commands are the public entry point.

- `smrt playground init`
- `smrt playground dev`
- `smrt playground list`

This package provides the runtime and host implementation behind those commands.
