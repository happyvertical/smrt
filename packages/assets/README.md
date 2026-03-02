# @happyvertical/smrt-assets

Provider-agnostic asset management with versioning, type classification, metadata fields, and polymorphic associations.

## Installation

```bash
pnpm add @happyvertical/smrt-assets
```

## Usage

```typescript
import {
  Asset, AssetCollection,
  AssetType, AssetStatus, AssetMetafield,
  AssetAssociation, AssetAssociationCollection,
  Folder, FolderCollection,
  AssetStore,
} from '@happyvertical/smrt-assets';

// Create lookup records
const imageType = new AssetType({ slug: 'image', name: 'Image' });
await imageType.save();

const published = new AssetStatus({ slug: 'published', name: 'Published' });
await published.save();

// Create an asset
const photo = new Asset({
  name: 'Product Photo',
  slug: 'product-photo-001',
  sourceUri: 's3://bucket/products/photo-001.jpg',
  mimeType: 'image/jpeg',
  typeSlug: 'image',
  statusSlug: 'published',
  version: 1,
});
await photo.save();

// Versioning -- chain via primaryVersionId, increment version number
const v2 = new Asset({
  ...photo, slug: 'product-photo-002', version: 2, primaryVersionId: photo.id,
  sourceUri: 's3://bucket/products/photo-002.jpg',
});
await v2.save();

// Derivatives via parentId
const thumb = new Asset({
  name: 'Thumbnail', slug: 'product-photo-001-thumb', parentId: photo.id,
  sourceUri: 's3://bucket/products/photo-001-thumb.jpg',
  mimeType: 'image/jpeg', typeSlug: 'image', statusSlug: 'published',
});
await thumb.save();

// Polymorphic association -- link asset to any SmrtObject
const assoc = new AssetAssociation({
  assetId: photo.id,
  metaType: '@happyvertical/smrt-content:Article',
  metaId: 'article-123',
  role: 'hero',
  sortOrder: 0,
});
await assoc.save();

// Folder organization (STI subclass of Asset with typeSlug='folder')
const folder = new Folder({ name: 'Product Images', slug: 'product-images' });
await folder.save();

// AssetStore -- provider-agnostic file I/O + record creation
const store = new AssetStore({ collection, filesystem });
await store.store({ buffer, mimeType: 'image/png', name: 'screenshot' });
```

## API

### Models (SmrtObject)

| Export | Description |
|--------|------------|
| `Asset` | Core asset with versioning (`primaryVersionId`, `version`), hierarchy (`parentId`), `sourceUri`, `mimeType`, `typeSlug`, `statusSlug`, `ownerProfileId` |
| `AssetAssociation` | Polymorphic join: `assetId` + `metaType` + `metaId` + `role` + `sortOrder` |
| `AssetType` | Lookup table for asset type classification |
| `AssetStatus` | Lookup table for lifecycle status |
| `AssetMetafield` | Custom metadata field definitions with JSON validation rules |
| `Folder` | STI subclass of Asset (`typeSlug='folder'`) for hierarchical organization |

### Collections (SmrtCollection)

| Export | Description |
|--------|------------|
| `AssetCollection` | Collection for Asset |
| `AssetAssociationCollection` | Collection for AssetAssociation |
| `AssetTypeCollection` | Collection for AssetType |
| `AssetStatusCollection` | Collection for AssetStatus |
| `AssetMetafieldCollection` | Collection for AssetMetafield |
| `FolderCollection` | Collection for Folder |

### Utilities

| Export | Description |
|--------|------------|
| `AssetStore` | Provider-agnostic file I/O that writes buffers to storage and creates Asset records |

### Types

| Export | Description |
|--------|------------|
| `AssetOptions` | Options for `Asset` constructor |
| `AssetAssociationOptions` | Options for `AssetAssociation` constructor |
| `AssetTypeOptions` | Options for `AssetType` constructor |
| `AssetStatusOptions` | Options for `AssetStatus` constructor |
| `AssetMetafieldOptions` | Options for `AssetMetafield` constructor |
| `FolderOptions` | Options for `Folder` constructor |
| `StoreOptions` | Options for `AssetStore.store()` |
| `ProviderOptions` | Provider configuration for `AssetStore` |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@happyvertical/smrt-core` | ORM base (SmrtObject, SmrtCollection) |
| `@happyvertical/smrt-tags` | Tag integration (`addTag`/`removeTag` on assets) |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/files` | Provider-agnostic filesystem for AssetStore |
