# @happyvertical/smrt-facts

Distributed memory and knowledge management with provenance tracking, semantic deduplication, and evolution chains.

## Architecture

```
src/
  index.ts                  # Export barrel
  types.ts                  # FactType, FactStatus, EvolutionType, SubjectRole, options interfaces
  utils.ts                  # calculateConfidence(), normalizeText()
  fact.ts                   # Fact model (STI base, embeddings)
  fact-source.ts            # FactSource model (provenance)
  fact-subject.ts           # FactSubject model (polymorphic entity linking)
  fact-content.ts           # FactContent model (content join table)
  fact-tag.ts               # FactTag model (tag join table)
  facts.ts                  # FactCollection (reconcile, evolution, confidence)
  fact-sources.ts           # FactSourceCollection
  fact-subjects.ts          # FactSubjectCollection
  fact-contents.ts          # FactContentCollection
  fact-tags.ts              # FactTagCollection
```

## Models

### Fact

STI base model with embedding support. Represents an atomic unit of knowledge.

**Properties**: `textRefined`, `textRaw`, `type` (FactType), `status` (FactStatus), `domain`, `parentId`, `evolutionType`, `sourceCount`, `confidence`, `metadata` (JSON)

**Embeddings**: Auto-generated on `textRefined` with combined field template `{textRefined}\n\nType: {type}\nDomain: {domain}`

**Methods**:
- Status: `isActive()`, `isSuperseded()`
- Hierarchy: `hasParent()`, `getParent()`, `getChildren()`
- Metadata: `getMetadata()`, `setMetadata()`, `updateMetadata()`

### FactSource

Provenance tracking for facts. Links a fact to its information source.

**Properties**: `factId`, `sourceType`, `sourceUrl`, `sourceTitle`, `credibility` (0-1), `extractedAt`, `metadata`

**Conflict columns**: none (multiple sources per fact allowed)

### FactSubject

Polymorphic entity linking. Links any entity to a fact with a role.

**Properties**: `factId`, `entityType`, `entityId`, `role` (SubjectRole), `metadata`

**Conflict columns**: `['fact_id', 'entity_type', 'entity_id']` — one link per entity-fact pair

### FactContent

Join table between facts and content items.

**Properties**: `factId`, `contentId`, `relationship` (FactContentRelationship), `metadata`

**Conflict columns**: `['fact_id', 'content_id', 'relationship']` — allows multiple relationship types per pair

### FactTag

Join table between facts and tags.

**Properties**: `factId`, `tagSlug`, `metadata`

**Conflict columns**: `['fact_id', 'tag_slug']`

## Collections

### FactCollection

Core collection with reconcile, evolution, and confidence methods.

**Query methods**: `getActive()`, `getPending()`, `getByType()`, `getByDomain()`, `getByStatus()`, `getChildren()`

**Reconcile**: `reconcile(options)` — Semantic search + AI disambiguation to create, merge, or branch facts

**Evolution**: `branch()`, `getEvolutionChain()`, `getLatestInChain()`, `getEvolutionTree()`

**Confidence**: `recalculateConfidence(factId)` — Weighted formula from source count, credibility, recency, corroboration

**Entity**: `getEntityBriefing(entityType, entityId)` — Summary of all facts about an entity

### FactSourceCollection

`getForFact()`, `countForFact()`, `getByType()`, `getHighCredibility()`, `getAverageCredibility()`

### FactSubjectCollection

`linkEntity()`, `unlinkEntity()`, `getForFact()`, `getForEntity()`, `getByRole()`, `countForFact()`

### FactContentCollection

`link()`, `unlink()`, `getForFact()`, `getForContent()`, `getByRelationship()`

### FactTagCollection

`addTag()`, `removeTag()`, `getForFact()`, `getForTag()`, `getTagSlugs()`

## Key Patterns

- **Metadata as JSON string**: All models store metadata as `string = ''`, with `getMetadata()`/`setMetadata()`/`updateMetadata()` helpers that handle JSON parsing. The `getMetadata()` method handles both string and object inputs (objects may arrive from `create()` without going through the constructor's JSON.stringify).
- **Cycle detection**: Evolution chain/tree traversals use visited-ID Sets to prevent infinite loops from circular parentId references.
- **Tenancy optional**: All models use `@TenantScoped({ mode: 'optional' })` with `@tenantId({ nullable: true })`.
- **STI**: All models use `tableStrategy: 'sti'` for single-table inheritance.

## Key Exports

`Fact`, `FactCollection`, `FactSource`, `FactSourceCollection`, `FactSubject`, `FactSubjectCollection`, `FactContent`, `FactContentCollection`, `FactTag`, `FactTagCollection`, `calculateConfidence`, `normalizeText`

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
- `@happyvertical/ai`, `@happyvertical/sql`, `@happyvertical/files`, `@happyvertical/utils`, `@happyvertical/logger`
