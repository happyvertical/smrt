---
'@happyvertical/smrt-assets': minor
---

**Behaviour change: a new asset's default slug is its id, not its file name.**
Two pictures with the same file name (`photo.jpg`,
`generated-content-image-001.jpg`) shared a name-derived slug, so saving the
second adopted the first row through the `(tenant_id, slug, context)` natural
key and overwrote its bytes and metadata. An explicitly set slug is still kept.
This applies to every `Asset` subclass (smrt-images `Image`, the smrt-video
assets, …), and `createNewVersion()` now produces `<uuid>-v2`-style slugs.
Existing rows keep their slugs; code that looked assets up by a file-name slug
must look them up by id (or set the slug explicitly when creating).
