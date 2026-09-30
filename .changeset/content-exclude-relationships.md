---
'@happyvertical/smrt-content': minor
---

`Content.getAssets(relationship?, { excludeRelationships })` leaves out the
listed relationship types (for example a source document's page renders) so a
picture picker does not offer them. Excluded links are not resolved and stay
in the data.

`Content.getAssetIds(relationship?)` returns the linked asset ids without loading
the asset rows, so a caller can keep the ids a listing left out (an editor saving
`assetIds` must not unlink them).
