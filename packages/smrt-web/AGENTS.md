# @happyvertical/smrt-web

Browser client data runtime — the web twin of `smrt-mobile`. Materializes the
manifest-generated web collection definitions (`@happyvertical/smrt-virt-web`)
as cached, reactive collections over the generated SMRT REST surface.

## What it does

Wraps a client-data engine (currently TanStack DB) so consumers get
stale-while-revalidate reads, concurrent-request dedup, and optimistic
mutations without hand-wiring cache keys or fetch/state.

- `createSmrtCollection(definition, options)` — typed collection factory over a
  generated `@happyvertical/smrt-virt-web` definition. Stale-while-revalidate
  reads (`staleTimeMs`, default 30s); N concurrent identical reads coalesce into
  one request; optimistic inserts persist through the REST surface and roll back
  automatically on server error. Pass `initialData` (SMRT-owned
  `SmrtWebRow<T>[]`) to seed the cache from server-rendered rows so the first
  client read serves them WITHOUT a duplicate first-render fetch — the SvelteKit
  `+page.server.ts` → hydrate path (#1761). The seed is fresh for `staleTimeMs`;
  fold the same `scope` used for reads into it under a shared `client`.
- `createSmrtWebClient()` — an opaque shared-cache handle. Pass one app-wide
  instance so collections share a cache and deduplicate requests.
- `createDefinitionFetchers(definition, basePath, fetchFn)` — CRUD fetchers
  derived from the generated definition (same URL scheme as the generated
  client, but HTTP error statuses reject instead of resolving).
- `unwrapListResult` / `unwrapItemResult` — normalize generated-client payloads
  (`T[]`, `{ data }` envelopes, `{ error }` bodies → thrown
  `SmrtWebRequestError`).

## The engine-absorption boundary (ratified conditions, #1761)

1. **No engine types in the public API.** `@tanstack/*` types must never appear
   on this package's public surface. Collections are handed back as the
   SMRT-owned `SmrtWebCollection`, and the shared cache as the opaque
   `SmrtWebClient`. Enforced by `scripts/check-smrt-web-engine-boundary.mjs`,
   run at the end of `build` (fails the build on any `@tanstack/` reference in
   an emitted `.d.ts`).
2. **Framework-agnostic core.** This entry imports no UI framework and must not
   import `@tanstack/svelte-db` (it ships only a `svelte` export condition,
   unresolvable outside Svelte bundlers). Svelte live-query bindings ship in a
   separate entry/package.
3. **Code-split / lazy.** The engine (~76 kB gzip) must never load on public /
   smrt-sites pages. Consumers load the runtime only on surfaces that use live
   collections.

## Conventions

- **No inter-smrt dependencies** — depends only on TanStack packages
  (dependency-DAG guardrails). Definitions and fetchers arrive as arguments.
- Rows are plain DTOs with a required `id`; optimistic inserts use
  `newLocalId()` — the generated REST layer strips client ids on create
  (#1540), so the post-persist refetch reconciles server-assigned ids.
- To swap the engine, reimplement the SMRT-owned public types over a different
  backend; the boundary guard keeps consumers insulated from the change.

## Reference consumer

`packages/products` consumes the runtime as its reference store across npm,
federation, and standalone modes (see the smrt-web track, PRD #1755).
