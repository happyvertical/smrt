# @happyvertical/smrt-core

ORM, code generation, AI integration, and the DispatchBus. Everything else builds on this.

## Key Classes

| Class | File | Purpose |
|-------|------|---------|
| SmrtObject | `src/object.ts` | Base persistent object — save, delete, is(), do(), loadFromId/Slug |
| SmrtCollection | `src/collection.ts` | CRUD collection — list, get, create, delete, getOrUpsert |
| ObjectRegistry | `src/registry.ts` | Global singleton (globalThis) — class metadata, fields, STI chains, manifests |
| DispatchBus | `src/dispatch/bus.ts` | Inter-agent messaging — emit, subscribe (persistent), process |
| GlobalInterceptors | `src/interceptors.ts` | Plugin system — beforeList/Get/Save/Delete hooks (used by tenancy) |

## SmrtObject Lifecycle

`constructor(options)` → `initialize()` → ready for `save()`/`delete()`/`loadFromId()`

- `initialize()`: loads field initializers, applies option values (options override initializers), loads from DB if id/slug provided
- `save()`: upsert with STI validation, interceptor execution, auto-embeddings
- `is(criteria)` / `do(instructions)`: AI operations via function calling
- `getSlug()`: auto-generates from name → title → label → id
- `loadRelated(fieldName)`: lazy-loads relationships (cached in `_loadedRelationships` Map)

## SmrtCollection Query

```typescript
await collection.list({
  where: { status: 'active', price: { op: '>', value: 10 } },
  limit: 50, offset: 0, orderBy: 'created_at DESC'
});
```

**WHERE operators**: `=`, `>`, `<`, `>=`, `<=`, `!=`, `in`, `not in`, `like`, `is null`, `is not null`. Arrays auto-detect `IN`. Dot notation for JSON paths: `metadata.userId`.

STI child collections auto-filter by `_meta_type`.

## @smrt() Decorator Options

Key options: `tableName`, `tableStrategy` ('cti'|'sti'), `conflictColumns`, `api`/`mcp`/`cli` (generation config), `ai` (callable methods), `hooks` (beforeSave/afterSave/beforeDelete/afterDelete), `embeddings` (auto-generate), `tenantScoped`, `agent`.

Registration sets `SMRT_TABLE_NAME` static property (survives minification).

## DispatchBus

- `emit(signalType, payload, metadata)` → creates persistent Dispatch record
- `on(pattern, handler)` → in-memory handler (immediate)
- `subscribe({ signalType, subscriber })` → persistent subscription (survives restarts)
- `process(subscriberName, handler)` → process pending dispatches
- Wildcards: `campaign.*` matches `campaign.completed` (single segment only)
- Tables: `_smrt_dispatch`, `_smrt_dispatch_subscriptions`
- Status: `pending → processing → completed` (or `failed`)

## Single Table Inheritance (STI)

- Base: `@smrt({ tableStrategy: 'sti' })` — children inherit, share one table
- Discriminator: `_meta_type` column with qualified names (`@happyvertical/smrt-content:Article`)
- Child fields: `@meta()` decorator → stored in `_meta_data` JSONB (not as columns)
- Polymorphic queries: collection loads `_meta_type`, creates correct subclass dynamically
- Validation: fail-fast on save if `_meta_type` missing or mismatched

## Code Generators

| Generator | Location | Output |
|-----------|----------|--------|
| REST API | `src/generators/rest.ts` | OpenAPI-compliant CRUD endpoints |
| CLI | `src/generators/cli.ts` | Commander commands with auto-help |
| MCP Server | `src/generators/mcp.ts` | Model Context Protocol tools |

## Vite Plugin

```typescript
// vite.config.ts — required for @smrt() decorators
export default defineConfig({
  esbuild: {
    tsconfigRaw: {
      compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true }
    }
  }
});
```

## Gotchas

- **Never override toJSON()** — handles STI discriminator + meta field extraction. Use `transformJSON()`
- **Property init order**: TypeScript initializers run first, then `initialize()` applies option values (options win)
- **Lazy table creation**: tables created on first DB op, not on `initialize()` — safe for SSR/prerendering
- **Retry logic**: `db.get()` (3 retries, 250ms) and `db.upsert()` (3 retries, 500ms) have built-in retry
- **Field caching**: `_cachedFields` populated during `Collection.create()` — eliminates async `getFields()` per query
- **Smart cloning**: arrays/objects shallow-cloned in property init to prevent aliasing (Issue #22)
- **Table verification cache**: `isTableVerified(dbUrl, tableName)` avoids redundant `tableExists()` calls
- **Manifest required**: build-time AST scanning creates manifest. Without vitest plugin → "No field metadata"
