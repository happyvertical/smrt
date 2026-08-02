# @happyvertical/smrt-core

ORM, code generation, AI integration, and the DispatchBus. Everything else in the s-m-r-t framework builds on this.

Use `smrt-core` when you are defining domain objects, querying collections,
generating interfaces, or extending the framework runtime. If you want a full
application scaffold with users and tenancy already wired, start with
[`smrt-template-sveltekit`](../template-sveltekit/README.md).

## Installation

```bash
pnpm add @happyvertical/smrt-core
pnpm add -D @happyvertical/smrt-cli @happyvertical/smrt-vitest
```

Requires Node.js 24.18.0 or newer. s-m-r-t projects use the Vite plugin to generate
manifests and the CLI to apply schema migrations before runtime.

## Usage

### Define a class with `@smrt()`

```typescript
import {
  foreignKey,
  smrt,
  SmrtCollection,
  SmrtObject,
} from '@happyvertical/smrt-core';

@smrt()
class Category extends SmrtObject {
  name = '';
}

@smrt({ api: true, cli: true, mcp: true })
class Product extends SmrtObject {
  name = '';
  price: number = 0.0;          // DECIMAL (has decimal point)
  quantity: number = 0;          // INTEGER (no decimal point)
  isPublished = false;

  @foreignKey(Category)
  categoryId = '';
}

class ProductCollection extends SmrtCollection<Product> {
  static readonly _itemClass = Product;
}
```

### Basic CRUD

```typescript
const products = await ProductCollection.create({ db: 'products.db' });

// Create
const product = await products.create({ name: 'Widget', price: 9.99 });

// Query
const results = await products.list({
  where: { isPublished: true, price: { op: '>', value: 5 } },
  orderBy: 'price DESC',
  limit: 20,
});

```

### Generate metadata and migrate

Configure Vite 8's Oxc decorator transform and point `smrtPlugin()` at the
directory containing your objects:

```typescript
// vite.config.ts
import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  oxc: {
    decorator: { legacy: true, emitDecoratorMetadata: true },
  },
  plugins: [
    smrtPlugin({
      include: ['src/objects/**/*.ts'],
      exclude: ['**/*.test.ts'],
    }),
  ],
});
```

```bash
pnpm vite build
pnpm smrt db:migrate
```

Runtime verifies application tables but does not create them. Rebuild the
manifest and rerun the migration after changing persisted object fields.

### Generated SvelteKit routes

Enable SvelteKit route generation with `svelteKit: { enabled: true }`. Its
default output directory is `src/routes/api`; set `svelteKit.routesDir` when
your application uses a different route root.

The plugin records only the concrete `+server.ts` files it generated in a
bounded `.gitignore` block. Handwritten handlers below `routesDir` remain
visible to Git, including routes that live beside generated resource handlers.
Generation refreshes that block, so stale generated paths stop being ignored
when the generator no longer owns them.

**Migration note:** the first generation after this release replaces the
legacy adjacent pair below with the bounded exact-path block:

```gitignore
# SMRT auto-generated routes (from Vite plugin)
src/routes/api/**/+server.ts
```

Only that recognized SMRT pair is migrated. A broad rule that you added or
moved yourself is left unchanged; remove or narrow it manually if it hides a
handwritten route.

### AI operations

With an AI provider configured, every object can use the inherited `is()` and
`do()` operations:

```typescript
const isExpensive = await product.is('costs more than the average product');
const description = await product.do('Write a short marketing description');
```

### Opt-In Read Cache

SSR apps that re-query read-heavy / write-rare collections on every request
can memoize `list()` and `get()` results with an opt-in TTL. Defaults are
off — nothing is cached unless a call or model opts in.

```typescript
// Per call
const published = await resumes.list({
  where: { status: 'published' },
  cache: { ttl: 60_000 },
});

// Per model — list()/get() on this collection cache by default
@smrt({ cache: { ttl: 60_000 } })
class Resume extends SmrtObject {}

// Force a fresh read on hot paths that must read through
const latest = await resumes.list({ cache: false });
```

Because s-m-r-t owns every mutation path (`save()`, `delete()`,
`collection.create()`, `getOrUpsert()`, junction attach/detach), any write
automatically invalidates the affected table's cached entries in-process —
including STI siblings sharing the table. Cached values are raw rows:
hydration and read interceptors (tenancy, audit) still run on every call.

Caches are per-process. For multi-replica deployments, add
`crossProcess: true` to broadcast invalidations over the database adapter's
notification capability (e.g. Postgres LISTEN/NOTIFY) so peers drop their
entries immediately instead of waiting out the TTL:

```typescript
@smrt({ cache: { ttl: 60_000, crossProcess: true } })
class Resume extends SmrtObject {}
```

Model-level config is the reliable cross-process opt-in: every process
writing the model knows to broadcast, and STI children writing the shared
table broadcast even if they opted out of caching their own reads. As a
per-call option (`list({ cache: { ttl, crossProcess: true } })`), writes
broadcast only from processes that have already performed such a read —
typical for homogeneous replicas running the same routes, but a
write-only process never learns about a call-site opt-in.

Writes that bypass s-m-r-t (raw SQL, external processes without
`crossProcess`) are only bounded by the TTL — pick one that matches how
stale the data may be.

### Bundled Runtimes And External Manifests

Long-lived bundled runtimes such as SvelteKit servers, background workers, and
CLI entrypoints should ship two things together:

1. The generated `smrt-register` runtime entrypoint for local class
   registration.
2. The `manifest.json` exports for any installed external `@happyvertical/smrt-*`
   packages the runtime needs to hydrate at query time.

`ObjectRegistry.ensureManifestLoaded()` can now auto-load installed external
classes by either simple name (`'EventType'`) or qualified name
(`'@happyvertical/smrt-events:EventType'`). `SmrtCollection.list()` and
`SmrtCollection.get()` use that path when they encounter STI discriminators from
external packages, so bundled runtimes do not need to import every child class
eagerly just to hydrate rows correctly.

If you want to avoid on-demand manifest discovery in a long-lived process, call
`ObjectRegistry.loadAllManifests()` during startup after your local registration
file has run.

## API

### Entry points

| Import | Purpose |
| --- | --- |
| `@happyvertical/smrt-core` | Objects, collections, decorators, registry, configuration |
| `@happyvertical/smrt-core/vite-plugin` | Manifest, route, client, and knowledge generation |
| `@happyvertical/smrt-core/consumer-plugin` | Consume manifests from installed s-m-r-t packages |
| `@happyvertical/smrt-core/generators` | REST, OpenAPI, CLI, and MCP generator APIs |
| `@happyvertical/smrt-core/manifest` | Runtime manifest loading and inspection |
| `@happyvertical/smrt-core/testing` | Database and registry test helpers |

### Core Classes

| Export | Description |
|--------|------------|
| `SmrtClass` | Base class with DB, AI, and filesystem access |
| `SmrtObject` | Persistent object — save, delete, is(), do() |
| `SmrtCollection` | CRUD collection — list, get, create, upsert |
| `ObjectRegistry` | Global singleton for class/field metadata |
| `smrt` (decorator) | Registers a class for code generation and AI |

### Field Decorators

| Export | Description |
|--------|------------|
| `field` | General-purpose field decorator |
| `foreignKey` | Foreign key relationship |
| `oneToMany` | One-to-many relationship |
| `manyToMany` | Many-to-many relationship |
| `meta` | STI child field stored in `_meta_data` JSONB |

### Dispatch (Inter-Agent Messaging)

| Export | Description |
|--------|------------|
| `DispatchBus` | Persistent message bus with wildcard subscriptions |
| `createDispatchBus` | Factory function for DispatchBus |
| `Dispatch` | Dispatch record model |
| `DispatchSubscription` | Persistent subscription model |

### Code Generators

| Export | Description |
|--------|------------|
| `APIGenerator` | Generates OpenAPI-compliant REST endpoints |
| `MCPGenerator` | Generates Model Context Protocol tool servers |
| `createRestServer` | Creates an Express REST server from config |
| `generateOpenAPISpec` | Generates OpenAPI/Swagger spec |

### Embeddings (Semantic Search)

| Export | Description |
|--------|------------|
| `EmbeddingProvider` | Generates embeddings via AI provider |
| `EmbeddingStorage` | Persists/queries embedding vectors |
| `CosineSimilarity` | Ranks results by vector similarity |
| `ContentHasher` | Content hashing for change detection |

### Context Memory

Every `SmrtObject`/`SmrtCollection` can persist learned knowledge via `remember()` / `recall()` / `recallAll()` / `forget()` (system table `_smrt_contexts`) — confidence-scored and versioned, with opt-in hierarchical scope fallback (`recall({ includeAncestors: true })`) and a stored `expiresAt` the caller filters on (`recall()` does not auto-drop expired entries). Pairs with semantic search (above) for retrieval; contributor-level behavior and invariants live in [`AGENTS.md`](./AGENTS.md).

### Signals (Observability)

| Export | Description |
|--------|------------|
| `SignalBus` | Universal method-tracking event bus |
| `SignalSanitizer` | Sanitizes sensitive data in signals |
| `MetricsAdapter` | Prometheus-compatible metrics adapter |
| `PubSubAdapter` | Broadcast signals to subscribers |

### Manifest (Build-Time Metadata)

| Export | Description |
|--------|------------|
| `ManifestManager` | Reads, writes, and generates manifests |
| `ManifestBuilder` | Orchestrates scanning to manifest |
| `ManifestGenerator` | Converts scan results to manifest format |
| `getManifest` | Async getter for static manifest data |

### Runtime

| Export | Description |
|--------|------------|
| `createMCPServer` / `SmrtMCPServer` | MCP server runtime |
| `createSmrtServer` | REST server runtime |
| `createSmrtClient` | API client runtime |

### Schema & Migrations

| Export | Description |
|--------|------------|
| `SchemaComparer` | Compares current vs. desired schema |
| `generateSchemaDiff` | Produces a diff between two schemas |
| `getSQLFromDiff` | Converts schema diff to SQL statements |

### Interceptors

| Export | Description |
|--------|------------|
| `GlobalInterceptors` | Plugin hooks for beforeList/Get/Save/Delete |
| `createInterceptorContext` | Creates context for interceptor execution |

### Errors

| Export | Description |
|--------|------------|
| `SmrtError` | Abstract base error class |
| `DatabaseError` | Database operation failures |
| `AIError` | AI provider failures |
| `ValidationError` | Field/object validation failures |
| `RuntimeError` | General runtime failures |
| `ErrorUtils` | Sanitization and formatting helpers |

### Tools (AI Function Calling)

| Export | Description |
|--------|------------|
| `generateToolManifest` | Generates AI tool definitions from methods |
| `executeToolCall` / `executeToolCalls` | Executes AI tool calls |

### Utilities

| Export | Description |
|--------|------------|
| `config` | Global s-m-r-t configuration function |
| `resolveDatabase` | Resolves DB config to a DatabaseInterface |
| `smrtPlugin` | Vite plugin for auto-service generation |
| `generateSvelteKitRoutes` | SvelteKit route generator |
| `resetVerifiedTables` | Resets table verification cache (testing) |
| `getTestDatabase` | Creates isolated test databases |
| `parse` / `stringify` / `clone` | JSON utilities with optional SIMD |
| `createQualifiedName` / `parseQualifiedName` | STI qualified name helpers |

## Code Generation

The `@smrt()` decorator controls what gets generated. Set `api`, `cli`, or `mcp` to `true` or `{ include: [...] }`:

```typescript
@smrt({
  api: { include: ['list', 'get', 'create'] },
  mcp: true,
  cli: true,
})
class Product extends SmrtObject { /* ... */ }
```

Generators produce OpenAPI REST endpoints, Commander CLI commands, and MCP server tools respectively. The Vite plugin (`smrtPlugin`) generates virtual modules at dev time for routes, clients, and manifests.

## Dependencies

- `@happyvertical/ai` -- AI client (is/do operations, embeddings)
- `@happyvertical/sql` -- Database interface (SQLite, PostgreSQL)
- `@happyvertical/files` -- Filesystem adapter
- `@happyvertical/logger` -- Structured logging
- `@happyvertical/smrt-types` -- Shared type definitions

## Contributor guide

See [`AGENTS.md`](./AGENTS.md) for package architecture, invariants, validation,
and contributor guidance.
