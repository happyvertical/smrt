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
Results hydrate through `list({ 'id in': … })`, so normal tenant isolation still
applies. Keep injected search behind the `SmrtCollection.semanticSearch`
boundary.
