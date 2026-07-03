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
- `save()`: upsert with STI validation, interceptor execution, auto-embeddings. Persisted objects (`isPersisted` — set by DB hydration and successful saves) upsert on `['id']` so natural-key edits (e.g. slug renames) update in place; new objects upsert on the natural-key conflict columns for ingestion-style dedup (#1472)
- `is(criteria)` / `do(instructions)` / `describe()`: AI operations via function calling. They inject the object's own `toPublicJSON()` (sensitive fields stripped) as a "content body" so the model reasons over the instance. Options: `includeData: false` skips injection (for callers that already curate the relevant fields into the instruction); `maxDataLength` overrides the truncation budget. Neither key is forwarded to `ai.message()`. (#1567)
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

## Domain Knowledge Artifacts

`smrtPlugin()` writes runtime manifests and agent/developer knowledge artifacts:

- local dev/build: `.smrt/manifest.json` and `.smrt/smrt-knowledge.json`
- package build: `dist/manifest.json` and `dist/smrt-knowledge.json`

Keep `manifest.json` runtime-focused. `smrt-knowledge.json` is the deterministic
agent contract for downstream review and architecture tools.

Config precedence for knowledge is defaults → top-level `knowledge` in
`smrt.config.ts` → `packages[packageName].knowledge` → plugin option →
object-level `@smrt({ knowledge })`.

Object-level `knowledge: false` excludes an object from authored context only;
it must not change runtime manifest registration. Use
`knowledge: { tags, summary, risks }` for review-sensitive domain objects.

HTTP knowledge routes are disabled by default. If `knowledge.api.enabled` is
true, generated SvelteKit routes must stay GET-only and guarded by dev mode or
admin auth.

## DispatchBus

- `emit(signalType, payload, metadata)` → creates persistent Dispatch record
- `on(pattern, handler)` → in-memory handler (immediate)
- `subscribe({ signalType, subscriber })` → persistent subscription (survives restarts)
- `process(subscriberName, handler)` → process pending dispatches
- Wildcards: `campaign.*` matches `campaign.completed` (single segment only)
- Tables: `_smrt_dispatch`, `_smrt_dispatch_subscriptions`
- Status: `pending → processing → completed` (or `failed`)

## Change Feed (#1758)

Adapter-agnostic change-observation spine (`src/change-feed.ts`) — the server half of the client/mobile sync contract (PRD #1755):

- `_smrt_changes` system table: one append per framework save/delete via a GlobalInterceptors writer registered at framework init. Deletes are tombstones (`operation: 'delete'`). `_smrt_*` tables are skipped. Feed-append failures log and never fail the user's write.
- Sequences: allocated as `MAX(seq)+1` inside the INSERT with conflict retry — committed rows stay contiguous, so commit order == seq order on SQLite/Postgres/DuckDB (deliberately NOT identity/serial: those allocate before commit and break the cursor guarantee under concurrent writers).
- `getChangesSince(db, { since, tables?, tenantId?, limit? }) → { changes, cursor }`: strictly monotonic cursor; polling with returned cursors misses no committed change and never repeats one. `getTenantScopedChangesSince()` resolves tenant via the DispatchBus resolver hook (fail-closed: tenancy on + no context → global rows only; tenant `T` sees `T` + global rows, never another tenant).
- Generated `_changes` routes: REST (`GET {basePath}/_changes`, requires `authMiddleware`, otherwise 401 — per-model `api.public` does NOT apply) and SvelteKit (`{routesDir}/_changes/+server.ts`, requires an authenticated principal on `locals`; opt out via `sveltekit.changesRoute.enabled: false`). Query params: `since`, `tables` (comma-separated), `limit`.
- Retention: `pruneChangeFeed(db, { maxAgeMs?, maxRows? })` — schedule it; cursors older than the retained window require a client full resync. Raw-SQL writes are invisible to the feed (same documented gap as the #1499 cache); `bumpChangeFeed(db, { table, rowId? })` is the manual escape hatch.

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
| CLI | `src/generators/cli.ts` | `objectname:action` admin commands — writable allowlist, exhaustive-include, `--from-file`, fail-closed tenant context |
| MCP Server | `src/generators/mcp.ts` | Model Context Protocol tools |

Generated reads (`list`/`get`) on the REST and SvelteKit generators support conditional GET (#1757, helpers in `src/generators/conditional-get.ts`): strong body-hash ETag, `If-None-Match` → 304 with an empty body, `private, no-cache` by default. Public models may opt into shared caching via `@smrt({ api: { public: true | 'read', cache: { sMaxage } } })` → `public, max-age=0, s-maxage=<n>`; non-public models never emit shared-cache headers. Tenant-scoped models (any mode) never emit them either — bodies vary with session-cookie tenant context that URL-keyed shared caches cannot see; `sMaxage` is neutralized to `private, no-cache` with a one-time warning.

## Child Accessors (R10)

`src/child-accessors.ts` installs a consistent `get<FieldName>()` instance method for every `@oneToMany` field at `@smrt()` registration time (e.g. `@oneToMany('OrderItem') items` → `order.getItems()`), delegating to `loadRelatedMany`. Two invariants:

- **Additive** — never overwrites a hand-rolled method of the same name (checks the whole prototype chain). `Profile.getMetadata()` (key-value) and `ProfileRelationship.getTerms()` are preserved.
- **Runtime-only** — attached to the prototype, invisible to the build-time manifest, so it never leaks into the REST/CLI/MCP surface.

When the target declares multiple FKs back to the parent, annotate `@oneToMany(Target, { foreignKey: '<inverseField>' })`; `loadRelatedMany` and the eager `include:` loader both honor it (else first-match).

## Vite Plugin

```typescript
// vite.config.ts — required for @smrt() decorators (Vite 8+, oxc transform)
export default defineConfig({
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
});
```

Under Vite 8 the oxc transform does not honor the pre-Vite-8 `esbuild.tsconfigRaw`
recipe (or tsconfig `experimentalDecorators` reached through SvelteKit's
`extends "./.svelte-kit/tsconfig.json"` chain), so that recipe throws
`SyntaxError: Invalid or unexpected token` on the first SSR request. Configure
decorators through `oxc.decorator` instead. Consumers still pinned on vite<8 need
the legacy `esbuild.tsconfigRaw` form with `experimentalDecorators: true,
emitDecoratorMetadata: true`.

## Gotchas

- **Never override toJSON()** — handles STI discriminator + meta field extraction. Use `transformJSON()`
- **Property init order**: TypeScript initializers run first, then `initialize()` applies option values (options win)
- **No runtime schema creation**: application tables must be prepared explicitly via migrations/tooling; runtime only verifies and fails clearly
- **Retry logic**: `db.get()` (3 retries, 250ms) and `db.upsert()` (3 retries, 500ms) have built-in retry
- **Field caching**: `_cachedFields` populated during `Collection.create()` — eliminates async `getFields()` per query
- **Smart cloning**: arrays/objects shallow-cloned in property init to prevent aliasing (Issue #22)
- **Table verification cache**: `isTableVerified(dbUrl, tableName)` avoids redundant `tableExists()` calls
- **Manifest required**: build-time AST scanning creates manifest. Without vitest plugin → "No field metadata"
- **Vite plugin loads scanner from `dist/` first**: `src/vite-plugin/import-build-aware.ts` prefers `dist/` when it exists on disk; it only falls back to `src/` on fresh clones. So if you edit `src/scanner/*.ts` or `src/schema/generator.ts` and want those edits reflected in consumer manifest generation, you must rebuild (`pnpm build` or have `pnpm dev` / `pnpm build:watch` running in core). This is intentional — sniffing `.ts` vs `.js` via `import.meta.url` was non-deterministic under tsx and broke 12–13 publishes (#1139).
