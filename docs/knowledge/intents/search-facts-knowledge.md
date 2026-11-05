---
type: Capability
title: "Search, facts and extracted knowledge"
description: "Reach for core semanticSearch, smrt-facts reconciliation and smrt-ingestion before writing embedding search or a facts table."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-4687
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/facts/src/facts.ts
    path: packages/facts/src/facts.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/facts/src/facts.ts (FactCollection.reconcile)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/collection.ts
    path: packages/core/src/collection.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/collection.ts (SmrtCollection.findSimilarToEmbedding, semanticSearch)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/embeddings/storage.ts
    path: packages/core/src/embeddings/storage.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/embeddings/storage.ts (EmbeddingStorage.searchSimilar)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/ingestion/AGENTS.md
    path: packages/ingestion/AGENTS.md
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/ingestion/AGENTS.md (ingestion invariants)"
---

# Search, facts and extracted knowledge

# Entry point

Search: any SmrtCollection with embeddings configured exposes `semanticSearch(query, options)` (core). Knowledge: `FactCollection.reconcile(options)` from `@happyvertical/smrt-facts` decides whether new text creates, merges into or branches an existing `Fact`, with provenance in `FactSource`, entity links in `FactSubject` and document links in `FactContent` (to smrt-content `Content`). Extraction pipelines: smrt-ingestion owns sources, extraction attempts, proposals, review and execution; server-only services are under its `/server` subpath and generated mutation routes are disabled.

# Why not hand-roll it

`FactCollection.reconcile()` in `facts.ts` serializes under a PostgreSQL advisory lock keyed on the reconciliation identity and applies three zones over embedding similarity: at or above 0.85 merge (add a source, bump `sourceCount`), between 0.60 and 0.85 a typed decision or AI disambiguation, below 0.60 create.[^s1] In core, `findSimilarToEmbedding()` runs the tenant interceptor's list prefilter and ranks only that tenant's ids through `EmbeddingStorage.searchSimilar(..., { objectIds })`, where an empty id set returns no results rather than falling through to an unrestricted search, because `_smrt_embeddings` has no tenant column.[^s2][^s3] The ingestion package requires a tenant and confidentiality scope on every record and keeps analysis input, attempts, proposals and decisions append-only.[^s4] A hand-rolled vector search ranks across tenants first and filters afterwards, which both leaks and truncates.

# Component pages

- [smrt-facts](/components/smrt-facts.md)
- [smrt-content](/components/smrt-content.md)
- [smrt-ingestion](/components/smrt-ingestion.md)
- [smrt-core](/components/smrt-core.md)

# Detection signals

- `import:@pinecone-database/pinecone`
- `import:pgvector`
- `import:minisearch`
- `import:flexsearch`
- `import:lunr`
- `regex:cosine_?[sS]imilarity`

[^s1]: `packages/facts/src/facts.ts` at `478ae36900`: FactCollection.reconcile.
[^s2]: `packages/core/src/collection.ts` at `478ae36900`: SmrtCollection.findSimilarToEmbedding, semanticSearch.
[^s3]: `packages/core/src/embeddings/storage.ts` at `478ae36900`: EmbeddingStorage.searchSimilar.
[^s4]: `packages/ingestion/AGENTS.md` at `478ae36900`: ingestion invariants.
