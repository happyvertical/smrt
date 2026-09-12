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
- `normalizePersistenceData(data)` is the synchronous final derived-column hook:
  shared save preparation passes read-only snake-case row data after the complete polymorphic
  `toJSON()` / `transformJSON()` chain and UUID coercion, then merges the returned
  columns before every insert/update/upsert branch. Derive only schema-backed
  columns; do not change source, identity, tenant or revision columns or perform
  I/O. Preserve `super` results. It does not alter plain/public serialization;
  use `transformJSON()` for that existing contract. Ordinary saves and eligible
  junction batches share this preparation. A custom normalization override makes
  a junction ineligible for batching, preserving its virtual per-row save path.
- `save()` error contract (#2366): unique/PK violation → `ValidationError` `VALIDATION_UNIQUE_CONSTRAINT`, NOT NULL → `VALIDATION_REQUIRED_FIELD`, both on the first attempt on every adapter; any other database failure → `DatabaseError` with the driver error on `cause`
- `getSlug()`: auto-generates from name → title → label → id
- `loadRelated(fieldName)`: lazy-loads relationships (cached in `_loadedRelationships` Map)

Relationship I/O resolves canonical source and target identities, not the public
display names. `relationship-loader.ts` owns target manifest hydration and inverse
selection for lazy, eager, junction and latest-related reads. An unresolved exact
constructor or ambiguous target fails before querying or caching a foreign peer;
legacy external string targets retain manifest discovery. Junction column naming
conventions still use display names. Cached reads retain their tenant rechecks.


## Plain-object serialization

`toPlainObject()` materializes the `toJSON()` / `transformJSON()` result directly,
without an intermediate JSON string for ordinary payloads. Native `JSON.rawJSON()`
literals are decoded once with `JSON.parse()`. Nested hooks and JSON omission/coercion
rules still apply. The active ancestor stack rejects cycles while allowing
shared siblings, which become independent plain copies. Arrays skip boxed-value
brand checks; other objects use intrinsic brand checks without reading user
`Symbol.toStringTag` getters. Customize the payload through `transformJSON()`.
The focused `to-plain-object.test.ts` suite compares legacy output and reports
warmed, interleaved per-row timings without a flaky timing assertion.

`pnpm --filter @happyvertical/smrt-core test:browser` bundles the production
`src/plain-json.ts` helper and executes it in Chromium with `process` and
`JSON.isRawJSON` unavailable. It is an opt-in local/browser release gate rather
than part of the default core suite: it requires the repository's
`playwright-core` dependency and an installed Chromium binary. The normal test
suite covers the same helper through `toPlainObject()` on Node.

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


## Junction reads and compatible writes

`byLeft(id, { relationship: 'attachment', limit: 20, offset: 40 })` and
`byRight()` forward `limit`/`offset` to the collection's existing bounds parser;
other options remain field filters. Pagination is read-only: `detach()` still
requires field filters and never deletes a page. Cursor pagination is not part
of this API; callers can use deterministic limit/offset pages.

`setLinks()` preserves replacement semantics: even retained right IDs get new
junction IDs/timestamps and delete/create change entries. `detach()` and
`setLinks()` batch compatible models automatically. Within 100 removed + added
rows and 900 inserted bind values, a warm SQLite/DuckDB/PostgreSQL operation uses
constant framework SQL: one snapshot, grouped owned-memory cleanup and delete,
one multi-row natural-key upsert, and one feed append per nonempty mutation
phase. Bootstrap, retries, and caller-defined work are excluded. The read
snapshot and in-memory work remain proportional to link count.

Eligibility is deliberately conservative and rechecked each call: base runtime
methods/accessors and collection create/attach behavior, one non-STI table,
compiler-owned declarative validators, no validated cross-package references,
no embedding generation, no incoming typed references, non-NULL unique
conflict values with no duplicate input conflict keys, and explicit consent
from every mutation interceptor. Otherwise the original virtual per-row path
runs. Larger sets retain that fallback; there is no truncated replacement.
Polymorphic association cleanup remains grouped through the owning cascade API
and invalidates every affected table. JSON export adapters retain their ordinary
lifecycle; unrecognized transaction-only DuckDB handles also fall back.
The tenancy interceptor consents only without directory dispatch/custom error
callbacks. Tenant checks and auto-population still run per row. The change-feed
interceptor appends every row and preserves tenant IDs and tombstones.

Bulk lifecycle preparation and completion are owned by `SmrtObject`; collection
initialization shares `createUnsaved()` with `create()`. Additional interceptors
may supply `bulkMutation.compatible()` only if grouped before/persist/after
phases preserve their behavior and before hooks have no side effects beyond
instance/context mutation. Preparation can discover an unsupported shape and
fall back; before hooks must tolerate that rehearsal. Unknown interceptors never
opt in implicitly.
The compiler marks its own callback-free validators by function identity.

The whole replacement remains nontransactional unless the caller supplies a
transaction. A delete group is atomic with its owned-memory cleanup and each
multi-row insert is atomic, so database failure can leave the deletion phase
committed without new links. No per-row prefix is promised for a failed batch.
The batch delete reuses an existing DuckDB transaction when the SDK explicitly
refuses savepoint nesting before running any work; it never replays a callback.
The legacy fallback retains its existing detectable nested-transaction refusal
for ordinary deletes inside caller-owned DuckDB transactions
([#2824](https://github.com/happyvertical/smrt/issues/2824)).
Public ordinary `save()` still owns revision CAS; batches only create new
instances and never use this path to overwrite a loaded revision.


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
