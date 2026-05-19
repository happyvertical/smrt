---
'@happyvertical/smrt-core': minor
'@happyvertical/smrt-scanner': minor
'@happyvertical/smrt-places': minor
'@happyvertical/smrt-events': minor
'@happyvertical/smrt-ledgers': minor
'@happyvertical/smrt-properties': minor
---

R3-A — `SmrtHierarchical` base class + Place/Event/Account/Zone migrations.

Replaces five hand-rolled copies of `getParent` / `getChildren` /
`getAncestors` / `getDescendants` / `getHierarchy` with one batched
implementation in core. `getDescendants` is now BFS with one `IN` query
per depth level — eliminates the recursive-per-child N+1 across Place,
Event, Account, and Zone.

**Breaking — schema field renames (Phase A, smrt only):**

- `Event.parentEventId` → `Event.parentId` (column `parent_event_id` →
  `parent_id`). The `EventCollection.getByParent(parentEventId)` argument
  is renamed to `parentId` accordingly.
- Place's `parentId` default changes from `''` to `null`. Type is now
  `string | null`. Code that asserted empty-string parents will need to
  use `=== null` or `!parent.parentId`.

Account, Zone, Place, Event no longer declare their own hierarchy
traversal methods — they're inherited. Account keeps its `createChild`
(propagates `type`), `getFullPath`, `getBalance`, `toTreeNode`. Zone
keeps its `getFullPath`, `getDepth`, `createChild`, `toTreeNode`, plus
the depth-cached `ZoneCollection.getAncestors`/`getDescendants` which
remain available for callers that prefer the collection-level cache.

**Scanner change:** `FRAMEWORK_BASE_CLASSES` in
`packages/scanner/src/inheritance-resolver.ts` extended to recognize
`SmrtHierarchical` so undecorated subclass detection keeps working
across packages. The manifest generator gains a narrow non-STI
field-merge path for framework abstract bases so that CTI subclasses of
`SmrtHierarchical` (Account, Zone) correctly register the inherited
`parentId` field in their manifest entry — without this, downstream
WHERE-clause validation rejected queries against the inherited column.

**Phase B (deferred, gated on user signal):** ergot and anytown call
sites that reference `parentEventId` or `place.parentId === ''` will
need codemod once the user signals readiness. Documented in
`relationships-v2` workstream notes.

R3-B (Tag), R3-C (Fact), and R3-D (Asset) ship as separate stacked PRs
on `feat/relationships-v2`.
