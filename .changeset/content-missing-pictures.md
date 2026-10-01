---
'@happyvertical/smrt-content': patch
---

Content tolerates a linked picture that no longer exists. `getAssets()` skips a
`content_assets` link whose asset row is gone and logs a warning naming it;
ContentPictureDrawer and ContentEditor's media list leave out a picture whose
preview cannot be loaded (with a console warning) instead of showing a broken
tile.
