# @happyvertical/smrt-core

ORM, code generation, AI integration, and the DispatchBus. Everything else builds on this.

Key surfaces are `SmrtObject`, `SmrtCollection`, `ObjectRegistry`,
`DispatchBus`, `GlobalInterceptors`, and `LearningMemory`; this file documents
their invariants and source locations, and the module docs below cover the
per-subsystem semantics.

## Modules

Subsystem semantics live in sibling module docs — read the one for the
subsystem you are editing. This file keeps what holds across all of them.

| Module | Scope | Module doc |
|---|---|---|
| `src/change-feed.ts` | the adapter-agnostic change-observation spine — `_smrt_changes`, cursors, table versions, generated `_changes` routes, retention | [agents/change-feed.md](agents/change-feed.md) |
| `src/change-signals.ts` + the generated `_events` SSE route | the push companion to the change feed — the signal bus, cross-replica fan-out, the SSE route, and its documented gaps | [agents/change-signals.md](agents/change-signals.md) |
| `src/generators/` + `src/vite-plugin/web-collections.ts` | REST/CLI/MCP/web-collection generation, the `manifestHash` emission sites, and generated conditional-GET / ETag v2 semantics | [agents/generators.md](agents/generators.md) |
| `src/schema/` | the five `SchemaGenerator` entry points, which two reach production, why schema drift stayed invisible, and the #2382 index/tenancy rules | [agents/schema-paths.md](agents/schema-paths.md) |

## SmrtObject Lifecycle

`constructor(options)` → `initialize()` → ready for `save()`/`delete()`/`loadFromId()`

- `initialize()`: loads field initializers, applies option values (options override initializers), loads from DB if id/slug provided
- `save()`: upsert with STI validation, interceptor execution, auto-embeddings. Persisted objects (`isPersisted` — set by DB hydration and successful saves) upsert on `['id']` so natural-key edits (e.g. slug renames) update in place; new objects upsert on the natural-key conflict columns for ingestion-style dedup (#1472)
- `is(criteria)` / `do(instructions)` / `describe()`: AI operations via function calling. They inject the object's own `toPublicJSON()` (sensitive fields stripped) as a "content body" so the model reasons over the instance. Options: `includeData: false` skips injection (for callers that already curate the relevant fields into the instruction); `maxDataLength` overrides the truncation budget. Neither key is forwarded to `ai.message()`. (#1567)
- `save()` error contract (#2366): unique/PK violation → `ValidationError` `VALIDATION_UNIQUE_CONSTRAINT`, NOT NULL → `VALIDATION_REQUIRED_FIELD`, both on the first attempt on every adapter; any other database failure → `DatabaseError` with the driver error on `cause`
- `getSlug()`: auto-generates from name → title → label → id
- `loadRelated(fieldName)`: lazy-loads relationships (cached in `_loadedRelationships` Map)

## LearningMemory (#1886)

`LearningMemory` provides tenant-isolated, confidence-scored recall over
`_smrt_contexts` plus optional injected semantic search. `capture()` reinforces
successes and decays failures while updating outcome counters; `recall()`
applies confidence, expiry, time-decay, and hierarchical-scope filters and
refreshes `last_used_at`. Keep semantic search behind the
`SmrtCollection.semanticSearch`-compatible injection boundary.

## SmrtCollection Query

```typescript
await collection.list({
  where: { status: 'active', 'price >': 10 },
  limit: 50, offset: 0, orderBy: 'created_at DESC'
});
```

Projection primitive (#1902): pass `select: ['id', 'title', 'tenantId']` to
`list()` when an admin/list workflow needs compact rows. `select` uses SMRT
field names, maps them to DB columns internally, and returns plain objects keyed
by the same SMRT field names without hydrating `SmrtObject` instances. It
composes with `where`, `orderBy`, `limit`, and `offset`; `beforeList`
interceptors still run. It is for column-backed fields only and cannot combine
with `include`/relationship eager loading.

`list()` and `query()` hydrate model instances serially in result order because
an `initialize()` hook may query through the same transaction-bound PostgreSQL
client. Keep this serialization invariant; use `select` when callers need plain
rows without model hydration.

**WHERE operators**: `=`, `>`, `<`, `>=`, `<=`, `!=`, `in`, `not in`, `like`.
Arrays auto-detect `IN`. NULL is a value, not an operator: `{ deletedAt: null }`
renders `IS NULL` and `{ 'deletedAt !=': null }` renders `IS NOT NULL`.

This list is the set `@happyvertical/sql`'s `buildWhere` can execute, and
`convertWhereKeys` accepts nothing outside it — an operator accepted here but
unknown there fails inside the query builder, after the API said the query was
valid (#2276). Two entries were removed for that reason and now reject at the
API boundary: `contains` (never existed in the SQL layer; use `like` with
explicit wildcards) and dot-notation JSON paths such as `metadata.userId` (never
rewritten into an extraction expression, so they reached SQL as qualified column
references). Re-adding either requires the query builder to support it first;
`src/__tests__/issue-2276-where-contract.test.ts` executes every accepted
operator against a database to keep the two in step.

STI child collections auto-filter by `_meta_type`.

## Bounded Collection Read Plans

Use `executeCollectionReadPlan()` when one operation needs several independent
collections. It bounds top-level `collection.list()` concurrency while keeping
all reads on the normal registry/collection path. Callers must choose an
explicit positive `maxConcurrency` and pass their normal shared
`collectionOptions` when database or tenant context matters.

The executor deliberately does not compose SQL, cache the plan, or change pool
defaults. On failure it stops starting queued entries, drains operations already
in flight, and rethrows the first error.

## Object Memory & Semantic Search

Two persistence primitives every `SmrtObject`/`SmrtCollection` inherits — load-bearing for learning agents, usable by any object. Full guide: `docs/content/core.md` → "Context Memory System".

- **Context memory** (`remember`/`recall`/`recallAll`/`forget`/`forgetScope`, table `_smrt_contexts`): stores any JSON value keyed by `(owner_class, owner_id, scope, key, version)` with a `confidence` score (0–1) and a stored `expiresAt` (metadata — `recall()` does **not** filter expired rows; expiry is caller-managed). `recall()` returns the highest-confidence match with an optional `minConfidence` floor and **opt-in** hierarchical scope fallback (`includeAncestors: true` → `'a/b/c' → 'a/b' → 'a' → 'global'`; default off); `recallAll()` returns a `Map`. Typical use: cache a learned strategy (e.g. a working selector per host) and reuse it across sessions. `success_count`/`failure_count` columns exist for outcome-weighting: `SmrtObject.remember()` leaves them untouched, `SmrtCollection.remember()` resets them to zero, and neither recall path updates them. `LearningMemory` is the layer that maintains them (and that does filter expired rows).
- **Semantic search** (on `SmrtCollection`, table `_smrt_embeddings`): `semanticSearch(query)`, `findSimilar(object)`, `findSimilarToEmbedding(vector)` — cosine ranking over embeddings of the fields declared in `@smrt({ embeddings })`. Native pgvector/HNSW when configured, in-memory `CosineSimilarity` fallback otherwise; default local model `Xenova/bge-base-en-v1.5` (768-dim) or AI `text-embedding-3-small`. Hits hydrate via `list({ 'id in': … })`, so `@TenantScoped` isolation applies to results.

## @smrt() Decorator Options

Key options: `tableName`, `tableStrategy` ('cti'|'sti'), `conflictColumns`, `api`/`mcp`/`cli` (generation config), `ai` (callable methods), `hooks` (beforeSave/afterSave/beforeDelete/afterDelete), `embeddings` (auto-generate), `tenantScoped`, `agent`, `ui` (`{ icon, label, description }` — nav/help hints round-tripped through the manifest as plain data; `description` is the object-level seed for form-level help, #2046).

Registration sets `SMRT_TABLE_NAME` static property (survives minification).

## @field() UI hints (#2046)

`@field({ ui: { basic, group, order, locked } })` — a static, presentation-only
seed for the field-policy rail (epic #2045). Carried in the manifest under the
field's `_meta.ui` (never a top-level `FieldDefinition` key), readable at
runtime via `getAllFields()` at `field._meta.ui`, and emitted (sanitized) with
`description` into generated web-collection definitions and browser MCP tool
schemas. No schema/persistence/security effect — `sensitive`/`readPermission`
stay the security rail, and `sensitive`/`transient` fields never emit to the
client at all.

## Domain Knowledge Artifacts

`smrtPlugin()` writes runtime manifests and agent/developer knowledge artifacts:

- local dev/build: `.smrt/manifest.json` and `.smrt/smrt-knowledge.json`
- package build: `dist/manifest.json` and `dist/smrt-knowledge.json`

Keep `manifest.json` runtime-focused. `smrt-knowledge.json` is the deterministic
agent contract for downstream review and architecture tools.

The schema-version-1 object projection is additive and high-signal: it retains
normalized tenant mode/field, explicit `cti`/`sti` strategy, conflict columns,
method signatures, and field defaults/constraints/readonly/transient flags.
Sensitive fields are removed before both `fields` and `relationships` are
derived, including legacy flags stored under `_meta`; matching field and
snake-case column names are also removed from projected conflict columns, and a
sensitive custom tenant field is omitted while retaining scope and mode.
Generated artifacts assert this boundary with `sensitiveFieldsExcluded: true`;
the optional marker keeps schema version 1 additive while letting readers
identify older artifacts that require raw-manifest corroboration.

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

## Single Table Inheritance (STI)

- Base: `@smrt({ tableStrategy: 'sti' })` — children inherit, share one table
- Discriminator: `_meta_type` column with qualified names (`@happyvertical/smrt-content:Article`)
- Child fields: `@meta()` decorator → stored in `_meta_data` JSONB (not as columns)
- Polymorphic queries: collection loads `_meta_type`, creates correct subclass dynamically
- Validation: fail-fast on save if `_meta_type` missing or mismatched

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

For independent CI invocations, both `smrtPlugin()` and `smrtConsumer()` accept
the same `generationSnapshot: { path, sha256, provenance, sourceRoot }`. The
schema-v1 snapshot produced by `serializeSmrtGenerationSnapshot()` contains the
merged project/dependency manifest, portable source paths, and source-file
digests; each plugin selects its own view. Reuse mode fails closed on
byte/provenance/path/content drift, skips scans and manifest writes, and still
generates routes, types, registration, and virtual modules. Omit it for normal
local development and watch mode.

## Schema paths (#2382)

Production DDL comes from the **manifest** paths
(`generateSTISchemaFromManifest`/`generateCTISchemaFromManifest`, selected in
`src/scanner/manifest-generator.ts` → registered `schema` → `db:migrate`). The
**registry** paths feed `getTestDatabase()` and emit foreign-key indexes
production never gets: the suite runs on a richer schema than it ships.

- Change column/index emission on every shipping path, proven by a path-parity
  test (#2359 adds one). A "same as migrations" comment is a claim to check.
- Every new query predicate ships with its index, or a reason it doesn't.
- Numeric types, uuid casts, conflict targets, timestamps, migrations: run the
  `test:postgres` lane — SQLite affinity accepts what PostgreSQL rejects.
- Read `dist/manifest.json`/regenerated schemas for what a decorator produced;
  count across all packages instead of sampling.
- Tenant scoping is whole-path: every unique constraint and conflict target on a
  tenant-scoped table carries the tenant column, and every read path — not only
  `list()` — is interceptor-aware.
- Rolling indexes out is part of the change: a bulk `CREATE INDEX` batch needs
  the bounded, concurrent migrate path (#2362, Gotchas), or it takes production
  down on deploy.

## Gotchas

- **Filesystem support is a lazy boundary (#1979)**: `SmrtClass` acquires `options.fs` adapters via `createFilesystemAdapter()` (`src/filesystem-loader.ts`), never a static `@happyvertical/files` import — the files SDK statically pulls @aws-sdk/client-s3 and reaches googleapis, and a static edge here would land it in every downstream SSR bundle. Node/tsx/vite-dev runtimes resolve it on first use; fully-bundled deployments import `@happyvertical/smrt-core/filesystem` at startup. Use `importOptionalDependency()` (`src/lazy-external.ts`) for any similar optional heavyweight dependency.
- **Never override toJSON()** — handles STI discriminator + meta field extraction. Use `transformJSON()`
- **Property init order**: TypeScript initializers run first, then `initialize()` applies option values (options win)
- **No runtime schema creation**: application tables must be prepared explicitly via migrations/tooling; runtime verification is `tableExists()` only (`src/schema/table-verifier.ts`) — no column, type, or index check
- **PostgreSQL migrate batches are always time-bounded (#2362)**: `MigrationTracker.applyAll({ atomic: true })` emits `SET LOCAL lock_timeout`/`statement_timeout` before any DDL, so a batch blocked on one table cannot hold its earlier locks indefinitely. `postgresSafe: true` adds concurrent-index mode — non-index DDL commits atomically, then index DDL runs `CONCURRENTLY` on a session pinned via `db.acquireSession()` (a pooled `db.query` would not keep the `SET` and the DDL on one connection). That mode is deliberately **not atomic**: unfinished index migrations are recorded `failed`, not `running`, and their `error_message` carries a `[smrt: concurrent-index phase 1 committed]` marker so a reconciling re-run resumes at the index build instead of replaying committed DDL. INVALID indexes are found via `pg_index.indisvalid` (`pg_indexes` reports them as present) and dropped before rebuild. Operational detail: `packages/cli/AGENTS.md`.
- **Retry logic is transient-only (#2366)**: `db.get()`/`db.upsert()` retry 4× total (initial + 3), but `ErrorUtils.withRetry` classifies via the cause chain (`src/db-errors.ts`) and rethrows deterministic failures immediately — constraint violations, bad input syntax, missing tables, aborted PG tx (`25P02`). `@happyvertical/sql` stringifies the driver text into `context.originalError`, so **never match `error.message`**; use `classifyDatabaseError()` / `isUniqueViolationError()` / `isAbortedTransactionError()`.
- **Field caching**: `_cachedFields` populated during `Collection.create()` — eliminates async `getFields()` per query
- **Smart cloning**: arrays/objects shallow-cloned in property init to prevent aliasing (Issue #22)
- **Table verification cache**: `isTableVerified(dbUrl, tableName)` avoids redundant `tableExists()` calls
- **Manifest required**: build-time AST scanning creates manifest. Without vitest plugin → "No field metadata"
- **ManifestBuilder fails on scanner errors**: every production manifest path
  must abort before adapting partial scan results. A syntax error or unresolved
  `@smrt()` config spread cannot be allowed to emit a default-open manifest.
- **Vite plugin loads scanner from `dist/` first**: `src/vite-plugin/import-build-aware.ts` prefers `dist/` when it exists on disk; it only falls back to `src/` on fresh clones. So if you edit `src/scanner/*.ts` or `src/schema/generator.ts` and want those edits reflected in consumer manifest generation, you must rebuild (`pnpm build` or have `pnpm dev` / `pnpm build:watch` running in core). This is intentional — sniffing `.ts` vs `.js` via `import.meta.url` was non-deterministic under tsx and broke 12–13 publishes (#1139).
- **Bundled registry ownership**: flattened production bundles can rewrite constructor names and make decorator-time stack inference attribute provider code to the consumer. Generated registration repairs identity only from the exact imported constructor plus an explicit package and isolated one-object manifest; never infer ownership from output paths, simple names, or table names. Distinct packages may export the same simple name under qualified keys. The production-consumer gate lives in `packages/bundle-gate/src/__tests__/registry-identity.spec.ts` (#2308).
