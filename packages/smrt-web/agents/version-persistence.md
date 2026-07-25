# smrt-web/version awareness & persistence

Module semantics for `persistence/` + `update-state.ts`. Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## Version awareness & persistence (#1764)

The read-side twin of the outbox plus a first-class "an update is available"
signal. Two locked architecture decisions (maintainer): the manifest-hash source
is a **build-time inject** (core's web-module generator emits a `manifestHash`
constant — NOT a runtime endpoint), and the ETag salt is **folded into this PR**
(the same hash threads into `computeTableVersionEtag`, closing #1765's documented
shape-change staleness gap). See `packages/core/agents/generators.md` (the
`manifestHash` emission sites and ETag v2) and `packages/core/agents/change-feed.md`
for the core halves.

### Persistence capability — `persistCollection(config)` (opt-in)

The read-cache rehydrate the outbox left to #1764. Add it to a collection's
`capabilities`; a collection **without** it is byte-for-byte non-persistent — the
seam's no-op guarantee, and the "opt-in per model" AC. **Sensitive models simply
omit the capability and never touch disk.**

- `warmStart(ctx)` reads the persisted snapshot for
  `(durableStoreNamespace(namespace), collection)` and returns its rows to seed
  the cache — the stale render paints instantly; the engine then revalidates in
  the background via its normal SWR (the preload path AWAITS the async warmStart,
  so the first `list()` is suppressed). **Manifest-hash change drops caches
  automatically:** the namespace INCLUDES `manifestHash`, so a contract-changing
  deploy lands on a DIFFERENT IndexedDB database → the old snapshot is never found
  → an empty warmStart → a fresh fetch with NO stale-schema hydration. No explicit
  invalidation.
- Write-back: `onAttach` subscribes to the collection's changes (via the seam's
  engine-free `ctx.subscribe`/`ctx.snapshot` — added for this slice, plain-DTO
  payloads only, no engine type) and persists the current rows DEBOUNCED (250ms
  trailing default; the scheduler is timer-based even at 0ms so a pending write is
  cancelable). `teardown` sets `detached` and CLEARS the pending timer FIRST so
  the "rows removed" change that the engine's own `cleanup()` fires just before
  teardown can't persist an empty snapshot over the good one, then drains any
  in-flight write. The per-change write-back already persisted the latest rows
  during the collection's life, so the durable snapshot survives for the next
  load.
- Storage: `persistence/snapshot-store.ts` — raw IndexedDB, ONE blob per
  `(namespace, collection)`, mirroring the outbox's hand-rolled queue (ZERO
  `@tanstack/*`; the boundary check is the proof). N collections under one
  namespace share ONE ref-counted store; the last detach closes the db.
- `registerDurableResource(namespace, { kind: 'persisted-collection', clear })` at
  first attach, unregistered on last detach BEFORE the db closes (so a later
  `wipeDurableStore` is a no-op, not a double-clear — the #1762 discipline).
- **Namespace segregation:** the namespace folds api/tenant/identity/manifest, so
  switching users on one device lands on a different database — one user can never
  read another's persisted rows.
- **Logout wipe clears the outbox too:** the outbox (#1762) registers its queue
  under the SAME namespace, so ONE `wipeDurableStore(namespace)` clears BOTH the
  persisted collections AND the outbox queue.
- **IndexedDB unavailable** (probe `open()` throws — private mode, sandboxed
  iframe): `console.warn` ONCE + behave as non-persistent (warmStart returns
  nothing, write-back is a no-op). Never throws — the outbox's `probeIndexedDb`
  posture.

### `updateAvailable` primitive — `createUpdateState(config)` (framework-free)

A tiny pub/sub (`update-state.ts`) with TWO INDEPENDENT signals; `updateAvailable
= bundle || contract`:

- **bundle** — the client BUNDLE changed on the server. SvelteKit detects it
  natively (`updated` store); the consumer/smrt-svelte binding pushes it via
  `notifyBundleUpdated()`. This module owns no polling.
- **contract** — the API CONTRACT (manifest hash) changed, which only SMRT knows.
  Under BUILD-TIME INJECT: on init the primitive compares the RUNNING build's
  `manifestHash` (passed in by the consumer, imported from
  `@happyvertical/smrt-virt-web`) against a persisted "last-seen manifestHash" in
  durable storage; if they differ → fire `contract` + store the new value. First
  run (no baseline) records without firing. The live `_events` manifest frame
  can also push the same sticky signal via `notifyContractUpdated()` (#1859).

The last-seen hash lives in `update-state/meta-store.ts` (a tiny IDB key/value
store) under the durable namespace, registered as a durable resource so
`wipeDurableStore` clears it too (the "wipe clears the last-seen-hash record"
AC). Degrades gracefully if IndexedDB is absent (bundle-only) or no running hash
is supplied.

> **Trade-off:** live contract detection is reconnect-based. The server hash is
> advertised when the `_events` stream opens, so a deploy surfaces when the tab
> reconnects (instant when the deploy drops old SSE connections, otherwise on
> the next natural reconnect). Reconnect-independent fan-out remains a later
> enhancement.

The reactive Svelte binding (`useUpdateAvailable`) ships in
`@happyvertical/smrt-svelte/web` — it wires SvelteKit's `updated` store into the
bundle signal and surfaces both reactively for a toast/reload UX.

### Persistence capability — `persistCollection(config)` (opt-in)

The read-cache rehydrate the outbox left to #1764. Add it to a collection's
`capabilities`; a collection **without** it is byte-for-byte non-persistent — the
seam's no-op guarantee, and the "opt-in per model" AC. **Sensitive models simply
omit the capability and never touch disk.**

- `warmStart(ctx)` reads the persisted snapshot for
  `(durableStoreNamespace(namespace), collection)` and returns its rows to seed
  the cache — the stale render paints instantly; the engine then revalidates in
  the background via its normal SWR (the preload path AWAITS the async warmStart,
  so the first `list()` is suppressed). **Manifest-hash change drops caches
  automatically:** the namespace INCLUDES `manifestHash`, so a contract-changing
  deploy lands on a DIFFERENT IndexedDB database → the old snapshot is never found
  → an empty warmStart → a fresh fetch with NO stale-schema hydration. No explicit
  invalidation.
- Write-back: `onAttach` subscribes to the collection's changes (via the seam's
  engine-free `ctx.subscribe`/`ctx.snapshot` — added for this slice, plain-DTO
  payloads only, no engine type) and persists the current rows DEBOUNCED (250ms
  trailing default; the scheduler is timer-based even at 0ms so a pending write is
  cancelable). `teardown` sets `detached` and CLEARS the pending timer FIRST so
  the "rows removed" change that the engine's own `cleanup()` fires just before
  teardown can't persist an empty snapshot over the good one, then drains any
  in-flight write. The per-change write-back already persisted the latest rows
  during the collection's life, so the durable snapshot survives for the next
  load.
- Storage: `persistence/snapshot-store.ts` — raw IndexedDB, ONE blob per
  `(namespace, collection)`, mirroring the outbox's hand-rolled queue (ZERO
  `@tanstack/*`; the boundary check is the proof). N collections under one
  namespace share ONE ref-counted store; the last detach closes the db.
- `registerDurableResource(namespace, { kind: 'persisted-collection', clear })` at
  first attach, unregistered on last detach BEFORE the db closes (so a later
  `wipeDurableStore` is a no-op, not a double-clear — the #1762 discipline).
- **Namespace segregation:** the namespace folds api/tenant/identity/manifest, so
  switching users on one device lands on a different database — one user can never
  read another's persisted rows.
- **Logout wipe clears the outbox too:** the outbox (#1762) registers its queue
  under the SAME namespace, so ONE `wipeDurableStore(namespace)` clears BOTH the
  persisted collections AND the outbox queue.
- **IndexedDB unavailable** (probe `open()` throws — private mode, sandboxed
  iframe): `console.warn` ONCE + behave as non-persistent (warmStart returns
  nothing, write-back is a no-op). Never throws — the outbox's `probeIndexedDb`
  posture.

### `updateAvailable` primitive — `createUpdateState(config)` (framework-free)

A tiny pub/sub (`update-state.ts`) with TWO INDEPENDENT signals; `updateAvailable
= bundle || contract`:

- **bundle** — the client BUNDLE changed on the server. SvelteKit detects it
  natively (`updated` store); the consumer/smrt-svelte binding pushes it via
  `notifyBundleUpdated()`. This module owns no polling.
- **contract** — the API CONTRACT (manifest hash) changed, which only SMRT knows.
  Under BUILD-TIME INJECT: on init the primitive compares the RUNNING build's
  `manifestHash` (passed in by the consumer, imported from
  `@happyvertical/smrt-virt-web`) against a persisted "last-seen manifestHash" in
  durable storage; if they differ → fire `contract` + store the new value. First
  run (no baseline) records without firing. The live `_events` manifest frame
  can also push the same sticky signal via `notifyContractUpdated()` (#1859).

The last-seen hash lives in `update-state/meta-store.ts` (a tiny IDB key/value
store) under the durable namespace, registered as a durable resource so
`wipeDurableStore` clears it too (the "wipe clears the last-seen-hash record"
AC). Degrades gracefully if IndexedDB is absent (bundle-only) or no running hash
is supplied.

> **Trade-off:** live contract detection is reconnect-based. The server hash is
> advertised when the `_events` stream opens, so a deploy surfaces when the tab
> reconnects (instant when the deploy drops old SSE connections, otherwise on
> the next natural reconnect). Reconnect-independent fan-out remains a later
> enhancement.

The reactive Svelte binding (`useUpdateAvailable`) ships in
`@happyvertical/smrt-svelte/web` — it wires SvelteKit's `updated` store into the
bundle signal and surfaces both reactively for a toast/reload UX.
