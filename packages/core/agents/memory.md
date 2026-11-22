<!-- Module doc for packages/core/AGENTS.md. Linked from the Modules table there. -->

# Object memory and semantic search

Context memory (`remember`, `recall`, `recallAll`, `forget`, `forgetScope`) is
stored in `_smrt_contexts`, keyed by tenant partition, owner, scope, key, and
version. Values have
a 0–1 confidence and optional expiry metadata; `recall()` does not filter
expired rows. Ancestor fallback is opt-in (`includeAncestors: true`) and walks
`a/b/c → a/b → a → global`. `LearningMemory` owns outcome counters and expiry
filtering; object/collection recall does not update them.

Semantic search uses `_smrt_embeddings` and cosine ranking over fields declared
by `@smrt({ embeddings })`, with native pgvector/HNSW or an in-memory fallback.
Legacy `semanticSearch` results hydrate through `list({ 'id in': … })`, so normal
tenant isolation still applies. Keep injected search behind the public
`SmrtCollection.semanticSearch` / `semanticSearchIds` boundaries.

`LearningMemory.capture()` reinforces successes and decays failures while
updating outcome counters. Its tenant-isolated `recall()` applies confidence,
expiry, time-decay, and hierarchical-scope filters and refreshes `last_used_at`.

`_smrt_contexts` is partitioned by a NOT NULL `tenant_id` that is part of the
memory identity `(tenant_id, owner_class, owner_id, scope, key, version)`
(`uq_smrt_contexts_identity`, #5449). `''` is the global
partition (`CONTEXTS_GLOBAL_TENANT`); it is a partition key, not a tenant FK,
so it stays TEXT on PostgreSQL. A `LearningMemory` built with a `tenantId`
reads and writes only that tenant's rows, so equal owner strings (a shared
persona `memoryScope`) in two tenants are two memories; without a tenant it
uses the global partition, and neither side falls back to the other. Object
and collection memory always use the global partition (collection memory keys
tenants through `owner_id`, #2365); every upsert targets
`CONTEXTS_IDENTITY_COLUMNS`. `LearningMemory` writes (`capture()`'s update and
recall's `last_used_at` touch) carry `tenant_id` in their predicate; a capture
whose row moved partition after its lookup seeds afresh. Object delete
cascades remove rows whose `owner_class` is the deleted object's class and
`owner_id` its id, in every partition: memory owned by a scope string must use
an `owner_class` that is not a class name (personas use `persona-scope:<class>`).
`partitionTenantId` exposes a memory's binding so signal consumers (the
personas `ReflectionRunner`) can check it before writing. Rows written before
the partition existed move into the global partition in the bootstrap compatibility pass
(PostgreSQL adds the column and drops the old inline UNIQUE; SQLite, DuckDB
and the JSON adapter rebuild the table in one transaction that re-reads the
shape, joining a transaction the caller already owns): they stay readable only
without a tenant and are never attributed to one implicitly. Starters in one
process queue on core's write queue; across processes the libsql adapter waits
for the lock, while the sqlite-native adapter's deferred BEGIN makes a second
process fail its start with SQLITE_BUSY without writing (restart it). A
populated legacy table on a handle without `transaction()` is refused with
`SystemTableRebuildError` before any DDL. Only the JSON adapter
(`isJsonAdapterHandle`) gets its files rewritten after the rebuild; native
DuckDB's export directory is never written. On the JSON adapter
`LearningMemory` writes go through the adapter API so they persist and honour
read-only stores. An operator who can establish a row's tenant moves it with
an explicit `UPDATE _smrt_contexts SET tenant_id = …`. On PostgreSQL, once
the first upgraded process drops the old constraint, older processes fail
every memory upsert: do not run mixed versions. There is no in-place
rollback: restoring the old constraint lets the old release read and
reinforce tenant rows tenant-blind, and a re-upgrade would not drop it again
under the new system schema stamp. Roll back only by restoring a pre-upgrade backup of
the database.

`semanticSearchIds(query, options)` and `findSimilarIdsToEmbedding(vector, options)`
return `{ id, similarity }` without object hydration. They apply caller `where`,
normal `beforeList` tenancy predicates, and child STI scope **before** exact
cosine top-K (legacy `semanticSearch` applies caller `where` after ranking).
Equal scores sort by object ID. Search scans JSON embedding vectors in keyset
batches of 64, including when native vector storage is enabled (JSON is always
persisted); each batch checks application eligibility using a fixed-size scalar
SQL mask of primary-key `EXISTS` probes. This supports separate system/app
databases without fetching all tenant IDs or application rows. Memory is
O(limit + 64); the exact fallback still scans all matching stored embeddings.
The embedding primary key supports the cursor and application primary keys
support eligibility probes; no new application index is needed. Pagination
callers can request offset + limit scored IDs, then hydrate only their page.

`semanticSearchIds` reports missing embedding configuration/provider failure as
`EmbeddingUnavailableError`; authorization/interceptor and application SQL errors
remain distinct and must not be caught as text-fallback signals. Subclass SQL
readers can compile normal beforeList + STI predicates with the protected
`resolveListReadPredicate()` (ordered values and portable `?` placeholders).
