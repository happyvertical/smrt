---
'@happyvertical/smrt-assets': minor
'@happyvertical/smrt-images': minor
---

Asset tags are real now. `asset_tags` is backed by a new `AssetTag` model
(`AssetTagCollection` junction): `assetId` → Asset and `tagId` →
`@happyvertical/smrt-tags` Tag, both `onDelete: 'CASCADE'`, conflict key
`(asset_id, tag_id)`, rows carry the asset's tenant. Before, `addTag()` and
friends wrote raw rows to an `asset_tags` table that no manifest declared, so
`smrt db:migrate` never created it and every call failed.

- `AssetCollection.addTag(assetId, tag, { name?, context? })` takes a slug or a
  label (`Town hall` → `town-hall`), finds or creates the Tag in the asset's own
  tenant (context `ASSET_TAG_CONTEXT` = `'asset'` by default) and returns it. A tag
  of another tenant is never reused.
- New: `setTags(assetId, tags)`, `getTagsForAssets(assetIds)` (batched, for lists),
  `assetTagSlug(label)`.
- `removeTag`, `getByTag`, `Asset.getTags()` and `Asset.hasTag(slug, context?)` go
  through the join. `hasTag` takes an optional context.
- `ASSET_ROLES.DEPICTS` (`'depicts'`): the asset shows its owner (a photo of a place
  or a person) on `place_assets` / `profile_assets`.

- `@happyvertical/smrt-images`: `ImageCategorizer.autoTag()` stores the AI's
  labels through `addTag()`, so they become slugified Tags (`Golden hour` →
  `golden-hour`) in context `asset`, linked by `asset_tags.tag_id`.

Migration: `smrt db:migrate` creates `asset_tags`. No manifest ever declared the
table, so no framework-built database has one and there is no data to move
(checked: Anytown's production snapshot and QA databases had none before this
release). A database that created `asset_tags` by hand in the old
`(asset_id, tag_slug)` shape must drop or rename that table before migrating:
its `tag_slug` column and `(asset_id, tag_slug)` key do not converge onto the
model, and its rows would need mapping to Tag ids. `TagCollection.mergeTag()`
deletes the merged tag, which now removes its asset links; re-point them first
when merging.
