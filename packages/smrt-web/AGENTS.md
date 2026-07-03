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

## The capability extension seam (#1755)

`createSmrtCollection` takes an optional `capabilities: SmrtWebCapability[]` —
plug-ins that hook the collection lifecycle so the three follow-on client slices
(offline outbox #1762, persistence #1764, live SSE invalidation #1763-client)
each live in their OWN module instead of contending on `index.ts`. Capabilities
run in **array order** at six fixed points:

1. `contributeCacheKey(ctx)` — ONCE, before construction. Returned segments are
   appended to the collection's cache id/key, extending the base
   `smrt:(scope:)name` scheme so a capability can partition the cache.
2. `warmStart(ctx)` — ONCE, before the first read. Returns rows that seed the
   cache (the persistence rehydrate-from-disk path). **`initialData` wins**: it
   is the fresher same-request SSR truth, so `warmStart` is consulted only when
   `initialData` is undefined; the FIRST capability that returns rows contributes.
3. `wrapMutation(envelope, ctx)` — per mutation, BEFORE the fetcher. Return
   `{ handled: true, result }` to take over the write (the fetcher is skipped and
   `result` reconciles the optimistic row — the offline path); return
   `{ handled: false }`/`undefined` to fall through. The FIRST `{ handled: true }`
   wins and later capabilities' `wrapMutation` are skipped (`runWrapMutation`).
4. `onSettled(envelope, outcome, ctx)` — per mutation, after it settles, on BOTH
   a successful persist (`{ ok: true, result }`) AND a fetcher throw
   (`{ ok: false, error }`). Never swallows the throw — a rejected fetcher still
   rolls the optimistic state back.
5. `onAttach(ctx)` — ONCE, right after the engine collection is constructed. The
   ONLY place a capability wires an external (non-mutation) trigger such as an
   SSE subscription; `ctx.invalidate()` enters the same relationship-derived
   invalidation the factory runs post-mutation.
6. `teardown(ctx)` — inside `cleanup()`, AFTER the engine's own cleanup; awaited
   if async.

The context (`SmrtWebCapabilityContext`) and mutation envelope
(`SmrtWebMutationEnvelope`) are typed **entirely in SMRT-owned terms**
(`SmrtWebCollectionDefinition`, `SmrtCrudFetchers`, `SmrtWebRow`, plain TS) — no
`@tanstack/*` type, so the seam stays inside the engine boundary. A capability
needing deeper engine access reaches it through the existing
`getEngineCollection()` unknown-bridge from its own module, never by widening
these types.

**No-op guarantee.** With `capabilities` undefined or `[]` every code path is
byte-for-byte the collection of today: zero contributeCacheKey/warmStart/
onAttach/teardown calls, `wrapMutation` always falls through to the real
fetcher, `onSettled` runs nothing, and relationship-derived invalidation fires
exactly as before. This PR ships the plug-in point and the shared durable-store
foundation but **zero concrete capabilities** by design.

### Shared durable-store foundation (#1755)

`durable-store.ts` is the ONE SMRT-layer namespacing + wipe registry both the
future outbox (#1762) and persistence (#1764) slices build on — pure
bookkeeping, ZERO `@tanstack/*` imports.

- `durableStoreNamespace(key)` — deterministic
  `smrt-web:${apiBase}:${tenantId ?? '-'}:${identityId ?? '-'}:${manifestHash}`,
  so a logout, tenant switch, or schema change each land on a different
  namespace (`manifestHash` source is #1764's call; this layer is source-agnostic).
- `registerDurableResource(namespace, resource)` → unregister; `wipeDurableStore(namespace)`
  clears every registered `DurableResource` under a namespace (best-effort — a
  rejected `clear()` doesn't abort the sweep) then drops it; a safe no-op on an
  unknown/empty namespace.

Rationale: TanStack DB persistence (SQLite-WASM/OPFS) and
`@tanstack/offline-transactions` (IndexedDB) are **separate storage engines**,
so the shared foundation lives one level up — each slice keys its own TanStack
primitive under a shared namespace, and `wipe()` clears both through the registry
without the two modules importing each other. Nothing calls this yet; it ships
ahead of its consumers so #1762/#1764 agree on it from day one.

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
