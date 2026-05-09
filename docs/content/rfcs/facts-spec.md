# @happyvertical/smrt-facts — Specification

## Reconcile Algorithm

The `reconcile()` method is the primary entry point for ingesting new knowledge. It determines whether incoming text represents a new fact, corroborates an existing one, or contradicts it.

### Input

```typescript
interface ReconcileOptions {
  rawInput: string;                    // Text to reconcile
  similarityThreshold?: number;        // Auto-merge threshold (default: 0.85)
  conflictThreshold?: number;          // Minimum similarity to consider (default: 0.60)
  type?: FactType;                     // Classification (default: 'assertion')
  domain?: string;                     // Domain scope
  source?: {                           // Optional provenance
    sourceType?: string;
    sourceUrl?: string;
    sourceTitle?: string;
    credibility?: number;
  };
}
```

### Decision Flow

```
semanticSearch(rawInput, limit=5, minSimilarity=conflictThreshold)
  │
  ├─ No match above conflictThreshold (0.60)
  │  └─ CREATE new fact (status: active)
  │
  ├─ Top match >= similarityThreshold (0.85)
  │  └─ MERGE: increment sourceCount, update textRaw
  │
  └─ Ambiguous zone (0.60 - 0.85)
     └─ AI disambiguation via _disambiguateWithAI()
        ├─ AI says "merge" → MERGE
        └─ AI says "branch" → BRANCH: create child fact, mark parent superseded
```

After the action, if source metadata was provided, a `FactSource` record is created. On merge with a source, `recalculateConfidence()` is called to update the fact's confidence score.

### Output

```typescript
interface ReconcileResult {
  action: 'created' | 'merged' | 'branched';
  fact: Fact;                          // The resulting fact
  source?: FactSource;                 // Created source record
  similarity?: number;                 // Best match similarity
  matchedFact?: Fact;                  // Existing fact that was matched
}
```

## Confidence Formula

Version 1 uses a simple weighted sum clamped to [0, 1]:

```
confidence = base + sourceBoost + credibilityBoost + recencyBoost + corroborationBoost

Where:
  base                = 0.5
  sourceBoost         = min(sourceCount / 10, 0.3)
  credibilityBoost    = avgSourceCredibility * 0.2
  recencyBoost        = max(0, 0.1 - daysSinceLastSource * 0.01)
  corroborationBoost  = corroborationScore * 0.1

Result: max(0, min(1, confidence))
```

**Defaults** (when no sources exist): `avgSourceCredibility = 0.5`, `daysSinceLastSource = 0`, `corroborationScore = 0` — yielding a baseline confidence of 0.7.

The `recalculateConfidence()` method loads all FactSource records, computes averages, and saves the updated confidence and sourceCount to the fact.

## Evolution Semantics

Facts form directed acyclic graphs via `parentId`. Each child has an `evolutionType`:

| Type | Meaning | Parent status change |
|------|---------|---------------------|
| `original` | Root fact, no parent | — |
| `correction` | Fixes an error in parent | Parent → `superseded` |
| `refinement` | Improves wording/precision | No change |
| `contradiction` | Directly contradicts parent | Parent → `superseded` |
| `extension` | Adds new information to parent | No change |
| `merge` | Combines multiple facts | No change |

### Evolution Methods

- **`getEvolutionChain(factId)`**: Walk up via `parentId` to root. Returns `[root, ..., factId]`. Uses visited-ID Set for cycle safety.
- **`getLatestInChain(factId)`**: Walk down children, always picking highest confidence. Returns the leaf. Uses visited-ID Set for cycle safety.
- **`getEvolutionTree(factId)`**: Find root via `getEvolutionChain`, then BFS all descendants. Returns flat array of entire tree.
- **`branch(parentId, data, evolutionType)`**: Create child fact, generate embeddings, and if evolution type is `correction` or `contradiction`, mark parent as `superseded`.

## Entity Briefing

`getEntityBriefing(entityType, entityId)` aggregates all facts linked to an entity via FactSubject:

```typescript
interface EntityBriefing {
  entityType: string;
  entityId: string;
  facts: Fact[];
  totalCount: number;
  byType: Record<string, number>;    // e.g., { assertion: 5, observation: 2 }
  byStatus: Record<string, number>;  // e.g., { active: 6, superseded: 1 }
}
```

## Type Reference

### FactType
`assertion` | `observation` | `measurement` | `definition` | `relationship` | `event` | `opinion` | `prediction`

### FactStatus
`pending` | `active` | `disputed` | `superseded` | `archived` | `retracted`

### EvolutionType
`original` | `correction` | `refinement` | `contradiction` | `extension` | `merge`

### SubjectRole
`subject` | `object` | `source` | `location` | `participant` | `related`

### FactContentRelationship
`extracted_from` | `referenced_in` | `supports` | `contradicts` | `related`

## Future Work

- **DispatchBus events**: Emit `fact.discovered` events from reconcile() for reactive pipelines
- **interesting() integration**: Use confidence + source count + recency to determine if a fact is noteworthy
- **Cross-gnode federation**: Share facts between gnodes with provenance chains
- **Batch reconcile**: Process multiple inputs in a single call with shared semantic search
