# @happyvertical/smrt-core

ORM, code generation, AI integration, and the DispatchBus. Everything else in the SMRT framework builds on this.

## Installation

```bash
pnpm add @happyvertical/smrt-core
```

## Usage

### Define a class with `@smrt()`

```typescript
import { smrt, SmrtObject, SmrtCollection, foreignKey } from '@happyvertical/smrt-core';

@smrt({ api: true, cli: true, mcp: true })
class Product extends SmrtObject {
  name: string = '';
  price: number = 0.0;          // DECIMAL (has decimal point)
  quantity: number = 0;          // INTEGER (no decimal point)
  isPublished: boolean = false;
  categoryId = foreignKey(Category);
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
await product.save();

// Query
const results = await products.list({
  where: { isPublished: true, price: { op: '>', value: 5 } },
  orderBy: 'price DESC',
  limit: 20,
});

// AI operations
const isExpensive = await product.is('costs more than the average product');
const description = await product.do('Write a short marketing description');
```

## API

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
| `config` | Global SMRT configuration function |
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
