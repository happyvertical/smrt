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

## Modules

Per-capability semantics live in sibling module docs — read the one for the
module you are editing. This file keeps what holds in every module.

| Module | Scope | Module doc |
|---|---|---|
| `index.ts` hooks + `durable-store.ts` | the six capability hook points, hook error isolation, the no-op guarantee, and the shared durable-store namespacing/wipe registry | [agents/capability-seam.md](agents/capability-seam.md) |
| `offline/` | durable offline writes — config, sync-apply-only replay, idempotency, the shared namespace-keyed engine, and Web Locks leader election | [agents/offline-outbox.md](agents/offline-outbox.md) |
| `sse-client.ts` | the client half of live cache invalidation — the app-wide subscriber, the wire contract it consumes, and SSE-vs-polling behaviour | [agents/live-invalidation.md](agents/live-invalidation.md) |
| `webmcp.ts` | framework-agnostic WebMCP registrar; keeps legacy list-backed tools on collection state and executes canonical tool-only definitions directly through REST fetchers | — |
| `persistence/` + `update-state.ts` | the read-cache rehydrate capability and the framework-free `updateAvailable` primitive (bundle + contract signals) | [agents/version-persistence.md](agents/version-persistence.md) |
| `data-query.ts` | dependency-free browser mirror and defensive response normalizer for the canonical bounded data-query envelope (#2444) | — |
| `remote-query.ts` | query-shaped remote pages over a `SmrtWebCollection`, with keyed stale cache, execution modes, cancellation/latest-query-wins, and optional query-scoped live subscriptions (#2445) | — |

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

- **WebMCP definition mirror** — `WebMcpToolDefinition` textually mirrors the
  generated `@happyvertical/smrt-virt-web` / physical `@smrt/web` declaration.
  It is transport-complete and does not imply that a list-materialized client
  collection exists. Keep the mirror dependency-free. Pass canonical tools
  alongside legacy collection definitions to `registerWebMcpTools`; duplicate
  names prefer the collection-backed path. Direct mutations invalidate their
  own and relationship-derived collection names through the public
  `invalidateSmrtWebCollections()` seam when the host supplies its shared
  `SmrtWebClient`. Legacy `filter` callbacks receive complete collection
  metadata; canonical definitions use `filterTool`. Mixing canonical tools with
  only the legacy filter fails closed rather than fabricating incomplete field
  metadata for a policy decision.
  Canonical writes validate that shared client handle before registration, and
  string or structured `{ error }` REST envelopes fail before cache
  invalidation. The private `__smrt_options` GET sentinel is reserved only for
  no-path single-options-bag actions; positional actions preserve a legitimate
  parameter with that name.

- **No inter-smrt dependencies** — depends only on TanStack packages
  (dependency-DAG guardrails). Definitions and fetchers arrive as arguments.
- **Data-query mirror** — `data-query.ts` mirrors the portable
  `smrt-types` request/result shape structurally because this package cannot
  depend on another SMRT package. Server adapters own authorization and full
query/result policy; browser code calls `executeSmrtWebDataQuery()` to reject
malformed or over-limit returned envelopes — including a response for a
different request id — before they reach a UI surface.
- Rows are plain DTOs with a required `id`; optimistic inserts use
  `newLocalId()` — the generated REST layer strips client ids on create
  (#1540), so the post-persist refetch reconciles server-assigned ids.
- To swap the engine, reimplement the SMRT-owned public types over a different
  backend; the boundary guard keeps consumers insulated from the change.

## Reference consumer

`packages/products` consumes the runtime as its reference store across npm,
federation, and standalone modes (see the smrt-web track, PRD #1755).
