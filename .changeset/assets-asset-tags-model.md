---
'@happyvertical/smrt-assets': minor
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

Migration: `smrt db:migrate` creates `asset_tags`. There is no data to move (the
table never existed). `TagCollection.mergeTag()` deletes the merged tag, which now
removes its asset links; re-point them first when merging.
