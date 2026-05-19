---
'@happyvertical/smrt-tags': minor
---

R3-B — `Tag` migrates to `SmrtHierarchical`. Parent FK flips from
`parentSlug` (slug-based) to `parentId` (UUID, inherited from
`SmrtHierarchical`).

**Public API surface unchanged.** `TagCollection.moveTag(slug,
newParentSlug)` / `mergeTag(fromSlug, toSlug)` / `getChildren(parentSlug)`
/ `listByContext(context, parentSlug?)` keep their slug-string parameters
and resolve to UUIDs internally. Code calling these methods continues to
work without modification.

**Direct field access on `Tag` changes.** Code that read or wrote
`tag.parentSlug` must switch to `tag.parentId` (UUID). Declarative tag
trees that built rows with `new Tag({ parentSlug: '…' })` must look the
parent up first:

```typescript
// Before
const child = await tags.create({ slug: 'web', parentSlug: 'tech' });

// After
const parent = await tags.get({ slug: 'tech', context: 'blog' });
const child = await tags.create({
  slug: 'web',
  parentId: parent!.id,
  level: 1,
});
```

**Hierarchy traversal methods (`getParent`/`getChildren`/`getAncestors`/
`getDescendants`/`getHierarchy`/`moveTo`) are now provided by
`SmrtHierarchical`** — no longer hand-rolled on Tag. Same signatures.
`getDescendants` switches to BFS with one `IN` query per depth level
(was recursive per-child N+1).

**Schema migration consumers MUST run alongside this upgrade:**

```sql
ALTER TABLE tags ADD COLUMN parent_id TEXT;
UPDATE tags
   SET parent_id = (
     SELECT id FROM tags AS p
     WHERE p.slug = tags.parent_slug
       AND p.context = tags.context
     LIMIT 1
   )
 WHERE parent_slug IS NOT NULL AND parent_slug != '';
ALTER TABLE tags DROP COLUMN parent_slug;
```

This assumes parents share their child's `context` (the normal case). If
your data has cross-context parent slugs, audit before running.

**`TagAlias.tagSlug` is unchanged.** Aliases reference tags by slug — a
different relationship kind from hierarchy. Out of scope for R3-B.

Phase B (ergot.io / anytown.ai consumers) gated on user signal, per
relationships-v2 plan.
