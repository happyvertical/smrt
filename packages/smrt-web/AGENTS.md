# @happyvertical/smrt-web

Browser client data runtime — **spike scaffold for #1756 (go/no-go pending)**.
Do not build on this package until the spike review lands; the TanStack DB bet
may be replaced by the documented fallback (same generated fetchers over
TanStack Query).

## What it does

Wraps TanStack DB query collections over the generated SMRT REST surface.
Consumers never import TanStack directly — the beta surface (TanStack DB 0.6)
is absorbed here so a runtime swap stays a one-package change.

- `createSmrtCollection(definition, options)` — typed collection factory over
  a generated `@happyvertical/smrt-virt-web` definition. Stale-while-revalidate
  reads (`staleTimeMs`, default 30s); optimistic inserts persist through the
  REST surface and roll back automatically on server error.
- `createDefinitionFetchers(definition, basePath, fetchFn)` — CRUD fetchers
  derived from the generated definition (same URL scheme as the generated
  client, but HTTP error statuses reject instead of resolving).
- `unwrapListResult` / `unwrapItemResult` — normalize generated-client
  payloads (`T[]`, `{ data }` envelopes, `{ error }` bodies → thrown
  `SmrtWebRequestError`).
- `@happyvertical/smrt-web/svelte` — re-exports `useLiveQuery` from
  `@tanstack/svelte-db` for the demo binding. Production placement for
  framework bindings is `@happyvertical/smrt-svelte` (PRD #1755).

## Conventions

- No inter-smrt dependencies: this package depends only on TanStack packages
  (dependency-DAG guardrails). Definitions and fetchers arrive as arguments.
- Rows are plain DTOs with a required `id`; optimistic inserts use
  `newLocalId()` — the generated REST layer strips client ids on create
  (#1540), so the post-persist refetch reconciles server-assigned ids.
- `@tanstack/svelte-db` publishes only a `svelte` export condition: the
  `/svelte` subpath resolves exclusively under a Svelte-aware bundler.

## Reference consumer

`packages/products` — `src/lib/stores/product-live-collection.ts` (generated
definition + factory), `src/app/pages/LiveProductsPage.svelte` (live query,
optimistic create, forced-error rollback), `src/demo-live-server.ts` (real
generated REST stack with a forced-500 valve).
