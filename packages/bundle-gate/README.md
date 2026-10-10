# @happyvertical/smrt-bundle-gate

> **Status:** private CI package; it is not published or installed by consumers.

Consumer-bundle reachability and size regression gate for s-m-r-t packages. It
recreates a downstream SvelteKit SSR build over published-style `dist` exports
and detects provider SDKs that become reachable from provider-neutral imports.

## What it protects

A static import edge through `smrt-chat`, `smrt-personas`, or `smrt-messages`
can make large email, Slack, Google, or file-provider SDKs reachable from every
consumer bundle. Runtime laziness does not help when a bundler can still follow
the import graph.

The gate has two fixtures:

- `consumer-neutral.ts` imports provider-neutral package roots and must not
  resolve any forbidden provider module.
- `consumer-with-providers.ts` opts into
  `@happyvertical/smrt-messages/providers/all` and proves provider modules remain
  available when requested explicitly.

Both fixtures build through package export maps from `dist`, not workspace
source aliases.

## Browser fixture (#3621)

`src/__tests__/browser-boundary.spec.ts` builds every **model package** root
for a browser target and fails when Node-only modules are reachable.

- **Model packages** are derived, not hand-listed: every publishable
  `packages/*` package whose non-test `src` contains a decorated `@smrt(`
  class, plus `smrt-core`. Exclusions live in `MODEL_PACKAGE_EXCLUSIONS`
  (`smrt-cli`: its `@smrt(` hits are scaffold template text and a CLI is
  Node-only). Other publishable packages (`app-cli`, `vitest`, `scanner`,
  `config`, `smrt-dev-mcp`, `mcp-*`, UI packages, asset providers, templates)
  declare no `@smrt()` objects, so they are never selected; private packages
  (this one, fixtures, mobile) are skipped.
- **Dependencies:** every model package is a `workspace:*` devDependency of
  this package so turbo builds its `dist` (`^build`), the changed-package CI
  filter selects the gate when any of them changes, and the cache hash covers
  them. A spec fails with the missing names if a new model package is not
  added (`pnpm install` afterwards).
- **Build:** one `vite build` per package root, resolved through its
  `exports['.']` with browser conditions (`browser`, `module`, `import`,
  `production`, `svelte`, `default`), so `smrt-core` resolves to
  `dist/browser.js`. The Svelte plugin is on so `.svelte` re-exports compile.
- **Forbidden modules:** all `node:` built-ins (and bare aliases such as
  `fs`), anything ending in `.node`, and `FORBIDDEN_NODE_ONLY_MODULES` in
  `src/browser-gate/boundary.ts` (pg family, native SQLite/DuckDB drivers,
  HTTP servers, cosmiconfig, jiti, sharp/resvg/canvas), each justified there.
  A `resolveId` guard records the specifier and externalizes it, then the
  module graph is walked to print the importer chain
  (`entry -> importer -> module`). A bundler error such as a missing export
  (core's browser entry omitting a decorator) also fails the package.
- **Ownership:** a defect in `smrt-core` would otherwise fail every dependent.
  An edge that a dependency's own root also reports is attributed to that
  dependency; a missing export is attributed to the package whose entry lacks
  it (except server-only core APIs such as `startRestServer`, which belong to
  the importing root). An edge through a dependency subpath its root does not
  reach stays with the importer.
- **Ratchet:** `src/browser-gate/expected-failures.ts` lists the packages that
  still fail, each with its tracking issue. The spec fails on an unlisted
  failing package AND on a listed package that now passes. A fix PR deletes
  its package's entry (or trims `issue`/`reason` while other causes remain);
  the goal is an empty object. A new finding that is not yet fixed needs a
  tracking issue before it may be added.
- Unit tests for detection, chains, discovery, attribution, and the ratchet are
  in `browser-boundary-logic.spec.ts`.
- **Capability table (#3709):** the ratchet is also the source of each
  package's browser capability, which the manifest build emits so a catalog can
  label features Live, Mock, Sample or Server. `src/browser-gate/capability.ts`
  derives it (a package is `server-only` when it, or a workspace package it
  depends on, is listed) and generates it into smrt-core;
  `browser-capability.spec.ts` fails when the generated table is stale. Fix PRs
  that delete an expected-failures entry regenerate it with
  `UPDATE_BROWSER_CAPABILITY=1 pnpm --filter @happyvertical/smrt-bundle-gate test`.

## Run the gate

Build its package dependencies first, then run the test:

```bash
pnpm --filter @happyvertical/smrt-chat build
pnpm --filter @happyvertical/smrt-personas build
pnpm --filter @happyvertical/smrt-messages build
pnpm --filter @happyvertical/smrt-bundle-gate test
```

Turbo already supplies those upstream builds in CI.

## Interpreting failures

- **Forbidden module resolution:** fix the import boundary. Do not raise a size
  budget to hide it.
- **Legitimate size growth:** inspect the emitted `[bundle-gate]` report and
  update the budget in the same change with a rationale.
- **New heavyweight provider:** add it to `FORBIDDEN_PROVIDER_MODULES` with a
  comment explaining why provider-neutral consumers must not reach it.

Budgets live beside the consumer-boundary test so a review sees the measurement
and its policy together.

## Ownership

Changes to the package boundaries of chat, personas, messages, core, or assets
must keep this gate green. The gate exists to model the consumer's build, so it
must not use workspace-only aliases or private package internals.

See [`AGENTS.md`](./AGENTS.md) for the regression history and budget-update
rules.
