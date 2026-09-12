<!-- Module doc for packages/core/AGENTS.md. Linked from the Modules table there. -->

# Object memory and semantic search

Context memory (`remember`, `recall`, `recallAll`, `forget`, `forgetScope`) is
stored in `_smrt_contexts`, keyed by owner, scope, key, and version. Values have
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
