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

### Bounded multi-collection reads

When one request needs several independent collections, use a keyed read plan
instead of an unbounded `Promise.all`. Every entry still uses the normal
collection `list()` path, but only the requested number of operations run at
once:

```typescript
import {
  executeCollectionReadPlan,
  type SmrtCollectionReadPlanEntry,
} from '@happyvertical/smrt-core';

const categories: SmrtCollectionReadPlanEntry<Category> = {
  className: 'Category',
  options: { orderBy: 'name ASC' },
};
const products: SmrtCollectionReadPlanEntry<Product> = {
  className: 'Product',
  options: { where: { isPublished: true }, orderBy: 'name ASC' },
};
const records = await executeCollectionReadPlan(
  {
    categories,
    products,
  },
  {
    collectionOptions: { db: 'file:products.db' },
    maxConcurrency: 2,
  },
);
```

`maxConcurrency` is required and must be a positive integer. If an entry
fails, the executor starts no further queued entries, waits for already-running
entries to settle, and rethrows the first error. Read plans do not compose SQL,
cache whole-plan results, or change database pool defaults.

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

#### Reuse a verified generation snapshot in CI

Independent Vite invocations can reuse one generation snapshot prepared by an
earlier job without rescanning or rewriting it. First run one normal generation
invocation with `smrtPlugin()` and `smrtConsumer()` enabled. After both plugins
finish, `.smrt/manifest.json` contains the project and dependency views. Wrap
that aggregate once:

```typescript
import { readFileSync, writeFileSync } from 'node:fs';
import {
  serializeSmrtGenerationSnapshot,
  sha256SmrtGenerationSnapshot,
} from '@happyvertical/smrt-core/vite-plugin';

const provenance = process.env.GITHUB_SHA!;
const sourceRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
const manifest = JSON.parse(readFileSync('.smrt/manifest.json', 'utf8'));
const bytes = serializeSmrtGenerationSnapshot(manifest, provenance, {
  sourceRoot,
});
writeFileSync('.ci/smrt-generation-snapshot.json', bytes);
console.log(sha256SmrtGenerationSnapshot(bytes));
```

Transport the exact bytes and digest together, then configure the consumers
with caller-trusted provenance (normally the checked-out commit or tree). Both
plugins use the same snapshot; each selects its own manifest view. `sourceRoot`
is the current checkout root, so normalized source paths remain portable across
workers:

```typescript
import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';
import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';

const provenance = process.env.GITHUB_SHA!;

const generationSnapshot = {
  path: '.ci/smrt-generation-snapshot.json',
  sha256: process.env.SMRT_GENERATION_SNAPSHOT_SHA256!,
  provenance,
  sourceRoot: process.env.GITHUB_WORKSPACE ?? process.cwd(),
};

smrtPlugin({ generationSnapshot });
smrtConsumer({ generationSnapshot });
```

Both plugins fail closed when the snapshot is missing, malformed, has different
bytes, declares different provenance, cannot resolve its portable paths, or the
current source-file digests differ from the prepared inputs. Reuse mode still
generates routes, types, registration, and virtual modules, but it disables
source/package scans, watch rescans, and manifest writes. Omit
`generationSnapshot` for normal local development.

### Generated SvelteKit routes

Enable SvelteKit route generation with `svelteKit: { enabled: true }`. Its
default output directory is `src/routes/api`; set `svelteKit.routesDir` when
your application uses a different route root.

The plugin records only the concrete `+server.ts` files it generated in a
bounded `.gitignore` block. Handwritten handlers below `routesDir` remain
visible to Git, including routes that live beside generated resource handlers.
Generation refreshes that block, so stale generated paths stop being ignored
when the generator no longer owns them.

**Migration note:** generation replaces the legacy block below with the bounded
exact-path block:

```gitignore
# SMRT auto-generated routes (from Vite plugin)
src/routes/api/**/+server.ts
!src/routes/api/v1/**/+server.ts
```

Migration takes the recognized `# SMRT auto-generated routes (from Vite plugin)`
header — matched as a whole line — plus the contiguous run of
recursive `+server.ts` wildcards directly beneath it, negations included. The
run is matched by shape rather than against your current `routesDir`, so a
project that moved `routesDir` after adopting the plugin still migrates, and
migration still runs once the bounded block exists — leaving a stale negation
in place would silently re-include whatever the bounded block stops listing.

The first line that is not a recursive `+server.ts` wildcard ends the run. A
broad rule you added or moved yourself is left unchanged, including an
identical pattern elsewhere in the file; remove or narrow it manually if it
hides a handwritten route.

Generated routes are build output and are not meant to be committed: they are
regenerated on every dev-server start and are not formatted to your Biome or
Prettier configuration, so tracking them makes a lint job fail on output no
one edits. Track the handwritten handlers beside them — the bounded block
lists only generator-owned paths, so they stay visible to Git.

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
| `ErrorUtils` | Retry policy (`withRetry`, `isRetryable`) plus sanitization helpers |

### Database error classification

Driver errors reach the model layer wrapped by `@happyvertical/sql`, which
stringifies the driver text into `context.originalError` — so the constraint
wording never appears on `error.message`. Classify through the cause chain
instead of matching messages.

| Export | Description |
|--------|------------|
| `classifyDatabaseError` | Walks the cause chain and returns the kind plus `deterministic` / `retryable` |
| `classifyDialectMessage` | Matches a single raw dialect message (the DuckDB fallback) |
| `isUniqueViolationError` | Unique or primary-key violation anywhere in the chain |
| `isNotNullViolationError` | NOT NULL violation anywhere in the chain |
| `isAbortedTransactionError` | Statement issued inside an aborted PostgreSQL transaction (`25P02`) |
| `isDeterministicDatabaseError` | A retry cannot change the outcome |
| `isTransientDatabaseError` | Contention or availability; a retry may succeed |
| `DatabaseErrorKind` | Union of classification kinds |
| `DatabaseErrorClassification` | Structured result of `classifyDatabaseError` |

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

### Durable MCP tasks

Long-running item actions may opt into the experimental
`io.modelcontextprotocol/tasks` extension. Tasks are disabled by default; list
the action names explicitly, and — if the class restricts what the job runner
may dispatch — include the action in that allowlist:

```typescript
import { backgroundEligible } from '@happyvertical/smrt-jobs';

@smrt({
  mcp: { include: ['generateReport'], tasks: ['generateReport'] },
})
class Report extends SmrtObject {
  @backgroundEligible()
  async generateReport(): Promise<ReportResult> { /* ... */ }
}
```

`@backgroundEligible()` is owned and enforced by `@happyvertical/smrt-jobs`, not
by this package. It is **restrictive**: a class with no marked methods lets
`TaskRunner` dispatch any of its methods, and the first marked method turns the
set into an exhaustive allowlist that excludes every other method on the class.
Use it to narrow the reachable surface, and mark every method you dispatch.

The generated MCP server advertises the extension only when at least one task
action is enabled. A task-aware client can request the action as a durable job,
then use `tasks/get`, `tasks/update`, and `tasks/cancel` to observe or control
it. Generated stdio servers run an `mcp-tasks` worker automatically.

## Dependencies

- `@happyvertical/ai` -- AI client (is/do operations, embeddings)
- `@happyvertical/sql` -- Database interface (SQLite, PostgreSQL)
- `@happyvertical/files` -- Filesystem adapter
- `@happyvertical/logger` -- Structured logging
- `@happyvertical/smrt-types` -- Shared type definitions

## Contributor guide

See [`AGENTS.md`](./AGENTS.md) for package architecture, invariants, validation,
and contributor guidance.
