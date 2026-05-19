---
'@happyvertical/smrt-facts': minor
'@happyvertical/smrt-content': minor
---

R3-C — rename `Fact.parentId` → `Fact.previousFactId` to disambiguate
evolution chains from structural hierarchy.

**Why:** R3-A established `parentId` as the canonical name for structural
hierarchy edges on `SmrtHierarchical` (Place, Event, Account, Zone), and
R3-B migrated Tag to the same convention. `Fact.parentId` looked like a
hierarchy edge but actually represented an *evolution chain* —
original → correction → contradiction → refinement → extension. Fact
deliberately does **not** extend `SmrtHierarchical`; the semantics are
different (a chain of versions, not a tree of containment) and the
collection-level traversals already used confidence-weighted leaf
selection rather than the structural BFS that `SmrtHierarchical`
provides.

To stop the next reader from assuming Fact is a `SmrtHierarchical`
sibling, the field and its accessors are renamed to make the evolution
semantics explicit. Going forward in the SMRT framework, `parentId` is
reserved for `SmrtHierarchical` structural hierarchy. Self-references
that mean something else (chain, derivation, lineage) get descriptive
names.

**Breaking — smrt-facts API:**

- `Fact.parentId: string` → `Fact.previousFactId: string`
- `Fact.hasParent()` → `Fact.hasPredecessor()`
- `Fact.getParent()` → `Fact.getPredecessor()`
- `Fact.getChildren()` → `Fact.getSuccessors()`
- `FactCollection.getChildren(parentId)` →
  `FactCollection.getSuccessors(previousFactId)`
- `FactCollection.branch(parentId, ...)` keeps its name (still a
  "branch" semantically), but its first positional argument is now
  `previousFactId`. Error message changes from `Parent fact not found`
  to `Predecessor fact not found`.
- `FactOptions.parentId?` → `FactOptions.previousFactId?`

`FactCollection.getEvolutionChain`, `getLatestInChain`, and
`getEvolutionTree` keep their names — they now query and walk the
`previousFactId` column under the hood (no public API change beyond the
rename of `getChildren` → `getSuccessors`).

**Breaking — smrt-content:**

`Content.issueCorrection()` continues to work unchanged from the
caller's perspective. Internally, `Content.buildReviewFingerprint` now
serializes `fact.previousFactId` (was `parentId`) into the review
fingerprint. **Existing cached review fingerprints will invalidate** on
upgrade — which is the correct behaviour, since the review surface
genuinely changed.

**Schema migration consumers must run alongside this upgrade:**

```sql
ALTER TABLE facts ADD COLUMN previous_fact_id TEXT;
UPDATE facts
   SET previous_fact_id = parent_id
 WHERE parent_id IS NOT NULL
   AND parent_id != '';
ALTER TABLE facts DROP COLUMN parent_id;
```

Fact uses `tableStrategy: 'sti'` — `facts` is the actual table name.
There are no STI subclasses of Fact in the monorepo today, so the
single-table migration is sufficient.

**Phase B (deferred, gated on user signal):** ergot.io and anytown.ai
call sites that reference `Fact.parentId`, `fact.getParent()`,
`fact.getChildren()`, or `collection.branch(parentId, ...)` will need a
codemod when the user signals readiness for the consumer rollout.
Documented in the `relationships-v2` workstream notes.

R3-D (Asset) ships as the next stacked PR on `feat/relationships-v2`.
