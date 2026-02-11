# @happyvertical/smrt-assets

Asset management with versioning, type classification, and metadata tracking. Supports images with dimension metadata.

## Architecture

```
src/
  index.ts          # Export barrel
  types.ts          # AssetOptions, ImageOptions, status/type interfaces
  models/
    Asset.ts        # Base asset model with versioning and ownership
    AssetType.ts    # Asset type classification
    AssetStatus.ts  # Asset lifecycle status
    AssetMetafield.ts # Custom metadata fields
    Image.ts        # Image asset with width/height/alt
  collections/      # SmrtCollection subclasses for each model
```

## Key Models

- `Asset` — Base model: sourceUri, mimeType, version, primaryVersionId, typeSlug, statusSlug, ownerProfileId, parentId
- `Image` — Extends Asset with width, height, alt text
- `AssetType` — Classification (e.g., photo, document, video)
- `AssetStatus` — Lifecycle status tracking
- `AssetMetafield` — Custom metadata key-value pairs

## Key Patterns

- **Versioning**: Assets track version number and link to primary version via `primaryVersionId`
- **Multi-tenancy**: Optional tenant scoping via `@TenantScoped`
- **Ownership**: Links to profiles via `ownerProfileId`
- **Hierarchy**: Parent-child relationships via `parentId`

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
- `@happyvertical/ai`, `@happyvertical/files`, `@happyvertical/sql`, `@happyvertical/utils`
