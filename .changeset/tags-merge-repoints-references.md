---
'@happyvertical/smrt-tags': minor
'@happyvertical/smrt-core': minor
---

`TagCollection.mergeTag()` re-points every row that references the merged tag
(`asset_tags` links, and any other `@foreignKey` / `@crossPackageRef` to Tag)
at the target tag before deleting it. Before, the delete cascaded and silently
stripped the tag from every picture that carried it. A row that would become a
duplicate (a picture tagged with both tags) is removed instead.

New in `@happyvertical/smrt-core`: `ObjectRegistry.getIncomingReferences(className)`
lists the typed references that point at a class (referencing class, table,
column and resolved `onDelete`), resolved the same way `delete()` resolves
cascades.
