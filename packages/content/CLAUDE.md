# @happyvertical/smrt-content

STI content management with Article/Document/Mirror types, thumbnail generation, and asset associations.

## Models

- **Content** (STI base): `type`, `variant` (generator:domain:specific format), `status` (published/draft/review/archived/deleted), `state`, `category` (hierarchical path with `/` separator), `metadata` JSON, `tags` array, `thumbnailAssetId`
- **Article**, **ContentDocument**, **Mirror**: STI subclasses — all share `contents` table via `_meta_type`

## Contents Collection

| Method | Purpose |
|--------|---------|
| `mirror({ url })` | Downloads URL content, extracts text, creates `type: 'mirror'`. Idempotent (returns existing if URL already mirrored). |
| `syncContentDir({ contentDir })` | Batch exports articles as markdown with YAML frontmatter |
| `generateMissingThumbnails(options)` | Bulk thumbnail generation for content missing `thumbnailAssetId` |
| `findWithGlobals(tenantId)` | Returns tenant-specific + global (tenantId=null) content |
| `getOrUpsert({ slug, context })` | Upsert by slug+context combination |

## Thumbnail Generation

Three strategies via ThumbnailGenerator:
- **headline-card**: title on branded background (via `@happyvertical/images`)
- **static-map**: requires `metadata.latitude`/`longitude` (via `@happyvertical/geo`)
- **ai-generate**: AI image generation (dynamic import of `@happyvertical/ai`)

## Asset Associations

`content_assets` junction table (lazy-created on first `addAsset()` call):

```typescript
await content.addAsset(image, 'thumbnail', 0);  // relationship, sortOrder
await content.getAssets('attachment');
await content.setThumbnail(image);  // convenience: adds asset + updates thumbnailAssetId
```

## Category Navigation

`getCategorySegments()`, `getParentCategory()`, `getRootCategory()`, `getAncestorPaths()`, `isInCategory(path, includeChildren?)`

## Gotchas

- **content_assets table created on-demand**: doesn't exist until first `addAsset()` call
- **STI discriminator**: qualified names like `@happyvertical/smrt-content:Article`
- **Optional tenancy**: `@TenantScoped({ mode: 'optional' })` — null tenantId = global content
- **Metadata is primary extension pattern**: use JSON `metadata` field, not additional class fields
- **Static map coordinates**: uses unary `+` for strict parsing (rejects "45invalid" unlike parseFloat)
