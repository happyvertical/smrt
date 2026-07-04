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

1. `contributeCacheKey(ctx)` — ONCE, before construction. Returned segments
   extend the base `smrt:(scope:)name` scheme so a capability can partition the
   cache. Segments are spliced into the queryKey **just before the collection
   name, so the name stays the LAST segment** — `invalidateRelated()`'s predicate
   (and thus relationship-derived invalidation #1761 and a capability's own
   `ctx.invalidate()`) identifies a collection by `key[key.length - 1]`, so a
   name-last key is required or a collection using this hook would silently stop
   invalidating. `cacheId` is an opaque engine id the predicate never reads, so it
   appends.
2. `warmStart(ctx)` — ONCE, before the first read. Returns rows that seed the
   cache (the persistence rehydrate-from-disk path). **`initialData` wins**: it
   is the fresher same-request SSR truth, so `warmStart` is consulted only when
   `initialData` is undefined; the FIRST capability that returns rows contributes.
   A **sync** return seeds inline; an **async** return is captured and
   `SmrtWebCollection.preload()` AWAITS it before the engine's own load, so an
   async rehydrate reliably suppresses the first `list()` on the preload path (a
   subscribe-driven read racing an unresolved warmStart may still fetch once —
   bounded, self-heals via the atomic seed updater).
3. `wrapMutation(envelope, ctx)` — per mutation, BEFORE the fetcher. Return
   `{ handled: true, result }` to take over the write (the fetcher is skipped and
   `result` reconciles the optimistic row — the offline path); return
   `{ handled: false }`/`undefined` to fall through. The FIRST `{ handled: true }`
   wins and later capabilities' `wrapMutation` are skipped (`runWrapMutation`).
   When a write is handled offline, the engine's post-mutation refetch AND
   `invalidateRelated()` are **suppressed** (the handler returns `{ refetch:
   false }`) — the offline write never hit the server, so a refetch of the server
   list would DROP the optimistic row #1762's outbox must keep until it replays.
   A mixed batch is conservative: any handled mutation suppresses the whole
   handler's refetch (common case is one mutation per transaction). An unhandled
   write refetches/invalidates exactly as before the seam.
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

**Hook error isolation.** Every hook invocation is wrapped so one misbehaving
capability cannot break the collection: a throwing `contributeCacheKey`,
`warmStart` (sync throw or async reject), `onSettled`, `onAttach`, or `teardown`
is logged via `console.warn` and skipped — a successful mutation still commits
(no rollback), construction still completes, `cleanup()` still resolves, later
capabilities' hooks still run, and an async warmStart rejection never escapes as
an unhandled rejection.

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

### Live invalidation (#1763-client)

`sse-client.ts` is the client half of live cache invalidation — ONE app-wide
subscriber that turns the #1763 server's coarse change signals into collection
refetches, so a dashboard reflects another session's writes without a manual
refresh. It is a capability built on the seam above (`onAttach` registers the
external trigger, `teardown` unregisters); it never touches the engine —
`ctx.invalidate()` is the refetch primitive.

- `createSmrtWebEventSubscriber(config)` — the ONE app-wide instance (mirror
  `createSmrtWebClient`: construct once, pass to every collection; NOT
  auto-derived per collection — one EventSource / one poll loop feeds all).
  Config: `{ eventsUrl, changesUrl, fetchFn?, eventSourceFactory?,
  pollIntervalMs?=5000, withCredentials?=true }`. Public surface:
  `{ transport: 'sse'|'polling'|'idle', registerTable(table, invalidate) →
  unregister, invalidateAll(), close() }`.
- `liveInvalidation({ subscriber, tableName })` — the thin per-collection
  capability. `tableName` is **EXPLICIT** config: a `SmrtWebCollectionDefinition`
  has no physical-table field and STI children share one base table, so the
  subscriber (which keys signals by physical table) must be told the table, not
  guess it.

**Wire contract it consumes** (both channels are generated by the #1763 server
half in `packages/core/src/generators/`):

- Push — the `_events` SSE route (`events-route.ts`): **NAMED** events
  `event: change` / `event: resync`, `data` is `{table, operation, rowId,
  tenantId}`, and the cursor `seq` is carried **only** in the SSE `id:` field
  (the browser mirrors it to `MessageEvent.lastEventId`). Heartbeats are
  `: heartbeat` comment lines EventSource ignores natively.
- Pull — the `_changes` route (`changes-route.ts`): `GET {changesUrl}?since=`
  → `{changes, cursor, resyncRequired?}`, the full fallback.

**The NAMED-event gotcha.** The frames are named, so the subscriber wires
`es.addEventListener('change', …)` / `('resync', …)` — **`onmessage` never
fires** for a named event and would silently receive nothing. A `change` frame's
`data` is JSON-parsed **defensively**: malformed input is logged + dropped, never
thrown back into the EventSource message loop (a throw there breaks later
delivery).

**No tenant logic (server enforces).** The wire carries only a signal, never a
row payload; the subscriber just maps `table → invalidate`, and the refetch
re-reads through the authorized collection routes. So authorization and
tenant-scoping stay **entirely on the read path** — the `_events` stream is
auth-guarded and tenant-scoped at connection open, `_changes` per request. This
module does no tenant filtering and needs no identity.

**SSE vs polling — feature-detect once, downgrade-on-fatal.** Construction
feature-detects EventSource: present → `connectSse()`; absent → `startPolling()`.
`transport` reflects it. A transient SSE `onerror` (readyState still OPEN) needs
no code — the browser auto-reconnects, resending Last-Event-ID. A **fatal** error
(readyState CLOSED — server 401 / route disabled) downgrades to polling **for the
subscriber's life (no flap-back)**.

**Polling fallback + resync reset.** `poll()` fetches `{changesUrl}?since=
${lastSeq ?? 0}`; each change invalidates its table and the cursor advances to
the page cursor. `resyncRequired: true` (HTTP 200, does **not** advance the
server cursor) invalidates everything and **resets `lastSeq` to null** so the
next poll restarts at `since=0` — otherwise it loops forever on the same stale
`since`. A fetch **rejection** is a separate path: caught + logged, the interval
keeps ticking (self-heals).

**Idempotent → no client-side seq dedup.** Re-invalidating on a replayed change
(a reconnect replays the tail) is safe — invalidation only schedules a background
refetch, and relationship-derived invalidation is itself idempotent. So a
replayed signal STILL fires, which is exactly what makes a reconnect miss no
invalidation. `lastSeq` is a resume cursor for the poll fallback, not a dedup
filter.

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
