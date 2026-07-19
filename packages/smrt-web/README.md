# @happyvertical/smrt-web

Framework-agnostic browser data runtime for generated s-m-r-t REST collections. It
turns manifest-generated collection definitions into cached, reactive,
optimistic client collections while keeping the underlying data engine behind a
s-m-r-t-owned public contract.

Use it for browser-side collection state, shared request deduplication, offline
writes, persisted read caches, and live invalidation. Svelte bindings live in
[`@happyvertical/smrt-svelte/web`](../smrt-svelte/README.md).

## Installation

```bash
pnpm add @happyvertical/smrt-web
```

## Quick start

s-m-r-t's Vite plugin emits collection definitions through the
`@happyvertical/smrt-virt-web` virtual module:

```ts
import {
  createSmrtCollection,
  createSmrtWebClient,
} from '@happyvertical/smrt-web';
import { getCollectionDefinition } from '@happyvertical/smrt-virt-web';

const client = createSmrtWebClient();
const products = createSmrtCollection(
  getCollectionDefinition('products'),
  { basePath: '/api/v1', client },
);

await products.preload();
console.log(products.toArray);

const transaction = products.insert({
  id: crypto.randomUUID(),
  name: 'New product',
});
await transaction.isPersisted.promise;
```

Pass the same `client` to related collections for shared cache identity,
in-flight request deduplication, and relationship-derived invalidation.

## Data behavior

- Reads are stale-while-revalidate; `staleTimeMs` defaults to 30 seconds.
- Concurrent identical reads coalesce into one network request.
- Inserts are optimistic and roll back if persistence fails.
- `initialData` seeds SSR-hydrated rows without a duplicate first-render fetch.
- Public rows are plain DTOs; data-engine types and virtual fields do not cross
  the package boundary.

## Optional capabilities

Capabilities are opt-in per collection and run through a stable lifecycle seam.
A collection without them preserves the basic runtime behavior.

### Durable offline writes

```ts
import { offlineOutbox } from '@happyvertical/smrt-web';

const products = createSmrtCollection(definition, {
  capabilities: [
    offlineOutbox({
      object: definition,
      namespace: {
        apiBase: '/api',
        tenantId,
        identityId: userId,
        manifestHash,
      },
      syncApplyBasePath: '/api',
    }),
  ],
});
```

The IndexedDB outbox replays FIFO through the generated sync-apply contract.
Client UUIDs and idempotent strict inserts reconcile the optimistic row instead
of creating a second server identity. Web Locks elect one replay leader across
tabs when supported.

### Persisted read cache

`persistCollection()` warm-starts from an IndexedDB snapshot, then revalidates
in the background. Its namespace includes API, tenant, identity, and manifest
hash, so user switches and contract changes cannot hydrate another scope's rows.
Sensitive collections should omit this capability.

### Live invalidation

Create one app-wide `createSmrtWebEventSubscriber()` and register
`liveInvalidation({ subscriber, tableName })` on each collection. It consumes
named `_events` SSE frames and permanently downgrades to `_changes` polling when
SSE is unavailable or fatally closed. Authorization and tenancy stay on the
generated server read path; signals contain no row payload.

### Update awareness

`createUpdateState()` combines bundle-update and manifest-contract signals.
The Svelte adapter `useUpdateAvailable` connects it to SvelteKit's update store.

## Engine boundary

The current implementation uses TanStack DB internally, but no `@tanstack/*`
type may appear in the public API or generated declarations. Applications must
depend on `SmrtWebCollection` and `SmrtWebClient`, which keeps the engine
replaceable and prevents Svelte-only exports from entering the framework-neutral
core.

## Public API groups

| Group | Main exports |
| --- | --- |
| Collections | `createSmrtCollection`, `createSmrtWebClient`, `newLocalId` |
| HTTP | `createDefinitionFetchers`, `unwrapListResult`, `unwrapItemResult` |
| Offline | `offlineOutbox`, `getOutboxHandle` |
| Persistence | `persistCollection`, `wipeDurableStore` |
| Live updates | `createSmrtWebEventSubscriber`, `liveInvalidation` |
| Version awareness | `createUpdateState` |
| WebMCP | `registerWebMcpTools` |

## Development

```bash
pnpm --filter @happyvertical/smrt-web test
pnpm --filter @happyvertical/smrt-web typecheck
pnpm --filter @happyvertical/smrt-web build
```

The build includes a generated-declaration scan that rejects leaked engine
types. See [`AGENTS.md`](./AGENTS.md) for cache, outbox, SSE, persistence, and
engine-boundary invariants.
