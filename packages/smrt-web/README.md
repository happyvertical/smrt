# @happyvertical/smrt-web

Framework-agnostic browser data runtime for generated s-m-r-t REST collections. It
turns manifest-generated collection definitions into cached, reactive,
optimistic client collections while keeping the underlying data engine behind a
s-m-r-t-owned public contract.

Use it for browser-side collection state, shared request deduplication, offline
writes, persisted read caches, and live invalidation. Svelte bindings live in
[`@happyvertical/smrt-svelte/web`](../smrt-svelte/README.md).

Query-backed surfaces can use `createSmrtWebQuery(collection, transport)` to
fetch one canonical bounded page. Visible runs update state; `background`,
`prefetch`, and `silent` runs stay out of visible state. The controller keeps
stale rows available while refreshing, cancels superseded visible runs, and can
attach a query-scoped live subscription.

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
| Remote queries | `createSmrtWebQuery`, `SmrtWebQueryTransport` |
| HTTP | `createDefinitionFetchers`, `unwrapListResult`, `unwrapItemResult` |
| Offline | `offlineOutbox`, `getOutboxHandle` |
| Persistence | `persistCollection`, `wipeDurableStore` |
| Live updates | `createSmrtWebEventSubscriber`, `liveInvalidation` |
| Version awareness | `createUpdateState` |
| WebMCP | `registerWebMcpTools` |

## WebMCP capability exposure

`registerWebMcpTools()` is secure by default: omitting an exposure policy
registers only `read` tools. CRUD effects are fixed (`list`/`get` are `read`,
`create`/`update` are `write`, and `delete` is `destructive`). A custom action
without declared metadata is treated as destructive, non-idempotent, and open
world. Declare safer custom-action semantics in the route metadata only when
they are true:

```ts
@smrt({
  api: {
    routes: {
      preview: { effect: 'read', idempotent: true, openWorld: false },
    },
  },
})
class Report extends SmrtObject {}
```

Opt into broader capabilities explicitly. `namespace` prevents cross-surface
name collisions, `maxTools` bounds the selected set (default `64`), and
duplicate names or stable model/action identities reject the entire call before
the first browser registration:

```ts
registerWebMcpTools(definitions, {
  effects: ['read', 'write', 'destructive'],
  namespace: 'admin',
  maxTools: 32,
  filter: (collection, tool) => collection.fields.tenantId !== undefined,
  filterTool: (tool) => tool.collection === 'reports',
});
```

`filter` receives legacy collection metadata; `filterTool` receives canonical
per-tool definitions. When canonical definitions are present, configuring only
the legacy `filter` fails closed because canonical tools do not carry complete
collection field metadata.

WebMCP policy controls which capabilities a page advertises; it is not an
authorization boundary. Execution still uses the page's authenticated REST
transport, whose auth, tenancy, writable-field, and sensitive-field guards must
remain enabled. Returned read data is annotated as untrusted content.

Migration note: registrations that previously relied on every descriptor being
exposed must now pass `effects: ['read', 'write', 'destructive']`. Prefer a
narrower allowlist for each browser surface.

## Development

```bash
pnpm --filter @happyvertical/smrt-web test
pnpm --filter @happyvertical/smrt-web typecheck
pnpm --filter @happyvertical/smrt-web build
```

The build includes a generated-declaration scan that rejects leaked engine
types. See [`AGENTS.md`](./AGENTS.md) for cache, outbox, SSE, persistence, and
engine-boundary invariants.
