# smrt-web/offline outbox

Module semantics for `offline/`. Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## Offline outbox (#1762)

The first concrete capability over the seam — durable offline writes for
opted-in collections. `offlineOutbox(config)` (from the root entry) returns a
`SmrtWebCapability`; add it to a collection's `capabilities` array and mutations
are captured in a durable IndexedDB queue that survives reloads/crashes, then
replayed FIFO against the sync-apply batch contract (#1759) when connectivity
returns, with exponential-backoff retries. A collection **without** it is
byte-for-byte unaffected (the seam's no-op guarantee) — that IS the "opt-in per
model" acceptance criterion.

**Config** (`OfflineOutboxConfig`): `object` (the SAME generated definition
passed to `createSmrtCollection` — its `name` is the sync-apply `object` route
segment); `namespace` (a `DurableStoreKey` — folds api/tenant/identity/manifest;
`manifestHash` is opaque caller-supplied config here, canonical source is
#1764's call); `syncApplyBasePath` (default `/api/v1`; set `/api` for the
generated SvelteKit route); `fetchFn`; `backoff` (`initialDelayMs`=1000,
`multiplier`=2, `maxDelayMs`=60000); `onSyncStateChange` / `onConflict`
(push callbacks, NOT a store — smrt-svelte wraps them later).

**Hand-rolled, NOT `@tanstack/offline-transactions`.** That layer's public API
is engine-typed (`Collection<…>`, `mutationFns`), so importing it would emit a
`@tanstack/` specifier into `dist/*.d.ts` and FAIL
`check-smrt-web-engine-boundary.mjs` (an unconditional dist-wide scan). It also
pins `@tanstack/db` exactly and competes with smrt-web's own mutation lifecycle.
So the outbox is a raw IndexedDB FIFO queue + native Web Locks, with ZERO new
runtime dependency (only `fake-indexeddb` as a test devDep). The public surface
is engine-free by construction (the boundary check is the proof).

**Replay is sync-apply-ONLY** (`offline/engine.ts` → `POST
{basePath}/sync/apply`), never `ctx.fetchers.create`. This is load-bearing:
the normal REST create strips the client id (#1540) and mints a NEW server id,
which would orphan the optimistic row the outbox is keeping; sync-apply's
strict-insert path preserves the client UUID, so replay reconciles the exact
optimistic row. `wrapMutation` enqueues then returns `{ handled: true, result:
envelope.data }`, and the factory suppresses the post-mutation refetch +
`invalidateRelated()` (its `{ refetch: false }` path) so the optimistic row is
not dropped by a refetch of a server list that has never seen the offline write.

**Idempotency / no duplicates.** Rows carry client-generated UUIDs and the
endpoint is idempotent (`_insertOnly` create + no-op re-apply), so a batch that
was sent but whose response was lost is blindly re-sent with no duplicate rows —
the ambiguous-failure AC. Result → durable-transition mapping follows the
sync-apply-contract's "Web outbox (#1762)" consumer notes: `applied` → remove /
`synced`; `conflict` → remove + fire `onConflict` / `synced` (a conflict is a
RESOLVED outcome, not a failure); retryable `write_failed` → keep + backoff /
`pending`; `auth_required`/`forbidden` → PAUSE the loop until re-auth, keep
queued; other terminal rejections → remove / `failed`; network/non-200/lost
response → whole batch stays `pending`.

**Shared, namespace-keyed engine** (`offline/engine.ts`,
`getOrCreateOutboxEngine`): N collections under the same `namespace` share ONE
ref-counted engine = ONE IndexedDB db + ONE leader lock + ONE FIFO queue. This
is REQUIRED for correctness, not an optimization — independent per-collection
locks would let two tabs each win a different collection's lock and both replay.
The last collection to detach (via `teardown`) disposes the engine; the durable
ROWS survive for the next load.

**Web Locks leader election** (`offline/leader.ts`): with multiple tabs, exactly
one replays the queue. A tab requests an EXCLUSIVE `navigator.locks` lock keyed
`smrt-web-outbox-leader:<namespace>` and holds it while leader; the browser
auto-releases on tab crash/close (no heartbeat) so the next tab takes over
instantly. **Single-tab fallback (documented gap):** no `navigator.locks` →
warn once + acquire leadership unconditionally; the outbox still replays but the
multi-tab exactly-one-replayer guarantee does not hold across fallback tabs
(NOT a BroadcastChannel shim in v1).

**Observable state + bridge.** State events route by collection `object` (NOT by
itemId), so rows REHYDRATED from IndexedDB after a reload still reach the
reloaded collection's `onSyncStateChange` even though this session never
enqueued them. `getOutboxHandle(durableStoreNamespace(key))` (a bridge like
`getEngineCollection`) exposes `snapshot()` + `retry(itemId)` for trusted
callers.

**Reload-visibility gap (this slice's scope).** The outbox does NOT rehydrate
the READ cache after a reload — a reloaded tab's `collection.toArray()` will not
show captured-offline rows until a fetch runs; that read-side rehydrate is
#1764's `warmStart`. So durability is proven via `OutboxHandle.snapshot()` / the
raw IndexedDB store, not `collection.toArray()`. The WRITE side (capture →
durable → exactly-once replay) is complete here.

**Durable-store integration.** The engine registers its queue as an `outbox`
`DurableResource` under `durableStoreNamespace(config.namespace)`, so
`wipeDurableStore(namespace)` (a logout / tenant-switch) empties the queue; the
namespace is also the IndexedDB dbName and the leader-lock root.

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
  pollIntervalMs?=5000, withCredentials?=true, manifestHash?, updateState? }`.
  `manifestHash` + `updateState` enable live contract detection from the
  server's connection-open `manifest` SSE frame (#1859). Public surface:
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
  (the browser mirrors it to `MessageEvent.lastEventId`). `event: manifest`
  carries `{ manifestHash }` at connection open so a reconnect can latch the
  contract update signal. `resync` uses its `id:` as the fresh horizon for any
  later polling downgrade. Heartbeats are `: heartbeat` comment lines
  EventSource ignores natively.
- Pull — the `_changes` route (`changes-route.ts`): `GET {changesUrl}?since=
  &tables=` → `{changes, cursor, resyncRequired?, resyncCursor?}`, the full
  fallback.

**The NAMED-event gotcha.** The frames are named, so the subscriber wires
`es.addEventListener('change', …)` / `('resync', …)` / `('manifest', …)` — **`onmessage` never
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

**Polling fallback + resync cursor.** `poll()` skips work until at least one
table is registered, then fetches `{changesUrl}?since=${lastSeq ?? 0}&tables=`
for the current registered physical tables; each returned change invalidates
its table and the cursor advances to the page cursor. `resyncRequired: true`
(HTTP 200, with `cursor` still echoing the rejected value) invalidates
everything and resumes from `resyncCursor`, the server's current horizon after
the client performs a full refetch. A fetch **rejection** is a separate path:
caught + logged, the interval keeps ticking (self-heals).

**Idempotent → no client-side seq dedup.** Re-invalidating on a replayed change
(a reconnect replays the tail) is safe — invalidation only schedules a background
refetch, and relationship-derived invalidation is itself idempotent. So a
replayed signal STILL fires, which is exactly what makes a reconnect miss no
invalidation. `lastSeq` is a resume cursor for the poll fallback, not a dedup
filter.
