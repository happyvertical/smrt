---
'@happyvertical/smrt-places': minor
'@happyvertical/smrt-profiles': minor
---

Picture links for places and people.

- `PlaceAsset` and `ProfileAsset` declare `onDelete: 'CASCADE'` on both sides (the
  place/profile and the asset). It was already the implied default for these
  conflict-key columns; now it is explicit. No schema change.
- `Place.addAsset()` and `Profile.addAsset()` refuse an asset of another tenant.
- `Place.getMainAsset()` / `Place.setMainAsset(asset | null)`: the place's one main
  picture, stored as its `hero` link (`PLACE_MAIN_ASSET_RELATIONSHIP`). Setting a new
  one removes the old `hero` link and keeps the asset's other links.
