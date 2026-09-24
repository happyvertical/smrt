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
{basePath}/sync/apply`), never `ctx.fetchers.create` — unless the consumer
declared its own replay transport (see "Consumer-declared replay transports"
below). This is load-bearing:
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
ref-counted engine = ONE IndexedDB db + ONE queue, with one leader lock per
replay route (see #3021 below; all sync-apply collections are one route). This
is REQUIRED for correctness, not an optimization — independent per-collection
locks would let two tabs each win a different collection's lock and both replay.
The last collection to detach (via `teardown`) disposes the engine; the durable
ROWS survive for the next load.

**Web Locks leader election** (`offline/leader.ts`): with multiple tabs, exactly
one replays each route. A tab requests an EXCLUSIVE `navigator.locks` lock keyed
`smrt-web-outbox-leader:<namespace>` (sync-apply; unchanged name) or
`smrt-web-outbox-leader:<namespace>:transport:<name>` for each route it has a
binding for, and holds it while leader; the browser
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

## Consumer-declared replay transports (#3021)

Sync-apply calls `collection.create()` directly, so it cannot carry a write
whose rules live in a hand-written, permission-gated service (or a model whose
generated verbs are closed). Two entry points replay through the consumer's own
operation instead, on the SAME engine:

- `offlineOutbox({ transport })` — a collection's writes queue with
  `row.transport = object.name`; `syncApplyBasePath` is ignored.
- `offlineCommandQueue({ name, namespace, transport })` — no collection;
  `enqueue()` returns the idempotency key, or `undefined` when the write was
  not captured durably (the caller performs it online). Its `name` shares the
  per-object event routing, so it must not equal a sibling collection name.

`dataSurfaceActionCommandTransport` adapts a data-surface action transport:
the request is built at REPLAY time (current `expectedRevision`), `apply`
carries `idempotencyKey`, `preview: true` runs preview first for its
`confirmationToken`, and `classifySmrtWebDataSurfaceActionResult` maps reasons
(transient → `write_failed`, auth → `auth_required`, stale → `conflict`,
anything else incl. `denied` → terminal).

Invariants:

- **Durable route, never re-routed.** The row stores the transport NAME
  (functions are not durable). A transport row never falls back to
  `sync/apply`: that is the path its consumer closed.
- **Per-route leadership, FIFO, and backoff.** Leadership is one Web Lock per
  route, requested by a tab only while it has a binding serving that route
  (sync-apply keeps the legacy lock name, so it stays exclusive with older
  builds). A tab that cannot serve a route never leads it, so it can never
  strand another tab's rows for that route — the failure a single
  namespace-wide lock had. Rows of a route no attached tab serves (e.g. after
  a reload, before its queue re-attaches) simply wait; they gate nothing else.
  FIFO and backoff gating hold within a route, not across routes; sync-apply
  rows still batch (≤1000), a transport row replays alone.
- **Sync-apply endpoint comes from bindings, not the engine creator.** A
  command queue may create the shared engine first; the first sync-apply
  binding supplies `basePath`/`fetchFn`.
- **Same state machine.** `OutboxCommandResult` uses the sync-apply result
  vocabulary and goes through `applyResult`; a thrown transport is the
  ambiguous path (backoff, resend with the SAME `idempotencyKey`, `attempt`
  incremented). The server operation must dedupe on that key.
- Rows written before #3021 lack `transport` and keep their sync-apply
  meaning, so no IndexedDB schema bump.
