# @happyvertical/smrt-facts

Knowledge base with semantic deduplication, provenance tracking, and confidence scoring for the SMRT framework. Facts evolve through parent-child chains, are linked to sources and subjects, and undergo 3-zone reconciliation to prevent duplicates.

## Installation

```bash
pnpm add @happyvertical/smrt-facts
```

## Usage

```typescript
import {
  Fact, FactCollection,
  FactSource, FactSourceCollection,
  FactSubject, FactSubjectCollection,
  FactContent, FactContentCollection,
  FactTag, FactTagCollection,
  calculateConfidence, normalizeText,
} from '@happyvertical/smrt-facts';

// Create a fact with provenance
const facts = new FactCollection(db);
const fact = await facts.create({
  textRefined: 'The Eiffel Tower is 330 meters tall',
  type: 'measurement',
  domain: 'landmarks',
  status: 'active',
});

// Attach a source with credibility score
const sources = new FactSourceCollection(db);
await sources.create({
  factId: fact.id,
  sourceUrl: 'https://example.com/eiffel-tower',
  sourceTitle: 'Tourism Board',
  credibility: 0.9,
});

// Recalculate confidence from all sources
await facts.recalculateConfidence(fact.id);

// 3-zone semantic reconciliation
// >= 0.85 similarity: auto-merge (same fact, update metadata)
// 0.60-0.85: AI disambiguation (asks model to decide merge vs branch)
// < 0.60: create new fact
const result = await facts.reconcile({
  rawInput: 'The Eiffel Tower stands 330m tall',
  type: 'measurement',
  domain: 'landmarks',
  source: { sourceUrl: 'https://another-source.com', credibility: 0.8 },
});
// result.action: 'created' | 'merged' | 'branched'

// Evolution chains: branch creates a successor fact linked via previousFactId
const successor = await facts.branch(fact.id, {
  textRefined: 'The Eiffel Tower is 330 meters tall including the antenna',
}, 'correction');
// 'correction' and 'contradiction' mark the predecessor as superseded

// Walk evolution: root -> current (via previousFactId)
const chain = await facts.getEvolutionChain(successor.id);
// Find highest-confidence leaf (via getSuccessors)
const latest = await facts.getLatestInChain(fact.id);
// Full tree (BFS with cycle detection)
const tree = await facts.getEvolutionTree(fact.id);

// Per-fact navigation: getPredecessor / getSuccessors / hasPredecessor
const previous = await successor.getPredecessor();
const successors = await fact.getSuccessors();
if (successor.hasPredecessor()) {
  // ...
}

// Entity briefing: all facts for a given entity
const briefing = await facts.getEntityBriefing('Place', placeId);
// { facts, totalCount, byType, byStatus }
```

## API

### Models

| Export | Description |
|--------|------------|
| `Fact` | Knowledge unit with `textRefined`, `type`, `status`, `confidence`, `previousFactId` for evolution chains (predecessor pointer; not a structural hierarchy edge), and auto-generated embeddings |
| `FactSource` | Provenance record with `sourceUrl`, `sourceType`, `credibility` (0-1), `extractedAt` |
| `FactSubject` | Polymorphic entity link (`entityType` + `entityId`), `conflictColumns: ['fact_id', 'entity_type', 'entity_id']` |
| `FactContent` | Join table linking facts to Content, `conflictColumns: ['fact_id', 'content_id', 'relationship']` |
| `FactTag` | Tag association for a fact |

### Collections

| Export | Description |
|--------|------------|
| `FactCollection` | Query by status/type/domain, `reconcile()`, `branch()`, evolution traversal, `recalculateConfidence()`, `getEntityBriefing()`, `findWithGlobals(tenantId)` |
| `FactSourceCollection` | Source management with `getForFact()` |
| `FactSubjectCollection` | Subject links with `getForFact()`, `getForEntity()` |
| `FactContentCollection` | Fact-to-content relationships |
| `FactTagCollection` | Fact tag management |

### Functions

| Export | Description |
|--------|------------|
| `calculateConfidence` | Weighted formula: base 0.5 + source volume (max 0.3) + credibility (0.2) + recency (0.1, decays over 10 days) + corroboration (0.1), clamped to [0, 1] |
| `normalizeText` | Trim, collapse whitespace, lowercase -- used for dedup comparison |

### Key Types

`FactType` (assertion/observation/measurement/definition/relationship/event/opinion/prediction), `FactStatus` (pending/active/disputed/superseded/archived/retracted), `EvolutionType` (original/correction/refinement/contradiction/extension/merge), `SubjectRole`, `ReconcileAction`, `ReconcileOptions`, `ReconcileResult`, `FactContentRelationship`, `EntityBriefing`

## Dependencies

- `@happyvertical/smrt-core` -- ORM, code generation, and semantic search
- `@happyvertical/smrt-tenancy` -- optional multi-tenant scoping with `findWithGlobals()`
- `@happyvertical/ai` -- AI disambiguation in reconciliation
