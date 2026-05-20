# @happyvertical/smrt-facts

Distributed knowledge base with semantic deduplication, provenance tracking, and evolution chains.

## Models

- **Fact**: atomic knowledge unit with `textRefined`, auto-generated embeddings, status (active/pending/superseded), confidence score. Evolution via `previousFactId` (predecessor→successor with corrections/contradictions/refinements). NOT a structural hierarchy — Fact deliberately does not extend `SmrtHierarchical`; `parentId` is reserved for true structural parents elsewhere in the framework.
- **FactSource**: provenance — URL, type, `credibility` (0-1), extraction timestamp.
- **FactSubject**: polymorphic entity linking — `entityType` + `entityId` (no FK, string-based). `conflictColumns: ['fact_id', 'entity_type', 'entity_id']`.
- **FactContent**: join table linking facts to Content. `conflictColumns: ['fact_id', 'content_id', 'relationship']`.

## Semantic Reconciliation

`reconcile()` uses three zones:
- **≥0.85 similarity**: auto-merge (same fact, update metadata)
- **0.60–0.85**: AI disambiguation — asks model to decide create/merge/branch
- **<0.60**: new fact (no match)

## Evolution Chains

`getEvolutionChain()` (root→current), `getLatestInChain()` (highest confidence leaf), `getEvolutionTree()` (BFS all descendants). All traversals use `visited` Set for cycle detection.

## Confidence Scoring

`recalculateConfidence()`: weighted formula from `sourceCount`, `avgSourceCredibility`, `daysSinceLastSource`, `corroborationScore`.

## Gotchas

- **Embedding failures non-fatal**: try/catch with silent fail — doesn't block fact creation
- **Metadata auto-stringify**: constructor `JSON.stringify`s objects; getters return parsed objects
- **AI disambiguation fallback**: if AI fails, defaults to branch (safer than merge)
- **Embeddings config**: `fields: ['textRefined'], autoGenerate: true, combinedField: {...}`
- **Optional tenancy** with nullable tenantId. `findWithGlobals(tenantId)` for tenant + global facts
