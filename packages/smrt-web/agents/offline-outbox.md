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
