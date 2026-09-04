# Object and collection runtime

`constructor(options)` → `initialize()` → ready for `save()`/`delete()`/`loadFromId()`

- `initialize()`: loads field initializers, applies option values (options override initializers), loads from DB if id/slug provided
- `save()`: upsert with STI validation, interceptor execution, auto-embeddings. Persisted objects (`isPersisted` — set by DB hydration and successful saves) upsert on `['id']` so natural-key edits (e.g. slug renames) update in place; new objects upsert on the natural-key conflict columns for ingestion-style dedup (#1472)
- Persisted `save()` uses loaded `updated_at` in its `UPDATE`; zero rows throws
  `RUNTIME_REVISION_CONFLICT`. Explicit `expectedUpdatedAt` binds a save or
  delete to an earlier snapshot. Remote guarded deletes bind the same predicate
  into the final `DELETE`; embedded adapters compare inside the shared write queue
  before cascading. That queue serializes same-process saves, deletes, and full
  `SmrtObject.withTransaction()` callbacks. Custom writes must preserve this
  public CAS ordering contract. PostgreSQL predicate:
  [revision-guard.md](revision-guard.md).
- Native DuckDB UUID columns are hydrated as canonical strings before model
  initialization, natural-key lookup, and embedded revision claims. Exact
  natural-key probes retain the interceptor-authorized filter when
  canonicalizing a wrapped identity. Custom embedded-CAS paths that consume
  persisted rows must use `getCanonicalPersistedRow()` so UUID identities are
  cast in the same coherent read before reuse.
- `is(criteria)` / `do(instructions)` / `describe()`: AI operations via function calling. They inject the object's own `toPublicJSON()` (sensitive fields stripped) as a "content body" so the model reasons over the instance. Options: `includeData: false` skips injection (for callers that already curate the relevant fields into the instruction); `maxDataLength` overrides the truncation budget. Neither key is forwarded to `ai.message()`. (#1567)
- `save()` error contract (#2366): unique/PK violation → `ValidationError` `VALIDATION_UNIQUE_CONSTRAINT`, NOT NULL → `VALIDATION_REQUIRED_FIELD`, both on the first attempt on every adapter; any other database failure → `DatabaseError` with the driver error on `cause`
- `getSlug()`: auto-generates from name → title → label → id
- `loadRelated(fieldName)`: lazy-loads relationships (cached in `_loadedRelationships` Map)


## SmrtCollection Query

Projection, latest-related, facets, counts, and bounded read plans are
documented in [collection-reads.md](collection-reads.md).

`list()` and `query()` hydrate model instances serially in result order because
an `initialize()` hook may query through the same transaction-bound PostgreSQL
client. Keep this serialization invariant; use `select` when callers need plain
rows without model hydration.

Native DuckDB model hydration casts declared UUID columns to `VARCHAR` in the
read query because its JavaScript binding otherwise returns lossy HUGEINT
wrapper objects. Explicit projections apply the same cast for selected UUID
fields so bounded query envelopes preserve canonical row and relationship ids.
For STI child columns, raw `query()` SELECTs, and latest-related projections,
the read path describes the output types without evaluating the query, then
performs one data-bearing SELECT with UUID result columns cast to `VARCHAR`;
mutation statements are never reinterpreted or replayed.

**WHERE operators**: `=`, `>`, `<`, `>=`, `<=`, `!=`, `in`, `not in`, `like`.
Arrays auto-detect `IN`. NULL is a value, not an operator: `{ deletedAt: null }`
renders `IS NULL` and `{ 'deletedAt !=': null }` renders `IS NOT NULL`.

`convertWhereKeys` must accept only operators executable by the SQL builder.
`contains` and dot-notation JSON paths reject at the boundary; use `like` with
explicit wildcards. Adding operators requires SQL support first.
`src/__tests__/issue-2276-where-contract.test.ts` executes the accepted set.

STI child collections auto-filter by `_meta_type`. Query bounds — `LIMIT 1` on `get()`, the `limit`/`offset` parser, the `orderBy` whitelist and sensitive/permission refusals, and the deterministic generated-list ordering (#2367) — are in [query-bounds.md](query-bounds.md).


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
