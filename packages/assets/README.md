# @happyvertical/smrt-assets

Provider-agnostic asset management with versioning, type classification, metadata fields, and generic/provenance associations.

`AssetAssociation` is the generic exception path for linking assets to arbitrary
objects when there is not a model-owned noun join table. Base/domain-owned
relationships should use dedicated joins such as `content_assets`,
`profile_assets`, `event_assets`, `place_assets`, and `product_assets`.

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

// Derivatives via sourceAssetId (renamed from `parentId` in R3-D)
const thumb = new Asset({
  name: 'Thumbnail', slug: 'product-photo-001-thumb', sourceAssetId: photo.id,
  sourceUri: 's3://bucket/products/photo-001-thumb.jpg',
  mimeType: 'image/jpeg', typeSlug: 'image', statusSlug: 'published',
});
await thumb.save();

// Generic/provenance association -- link asset to an arbitrary object
const assoc = new AssetAssociation({
  assetId: photo.id,
  metaType: 'Image',
  metaId: 'derived-image-123',
  role: 'derivation-source',
  sortOrder: 0,
});
await assoc.save();

// Base/domain-owned asset relationships should use dedicated noun joins instead:
// content_assets, profile_assets, event_assets, place_assets, product_assets

// Folder organization (its own SmrtHierarchical model, `folders` table)
const folder = new Folder({ name: 'Product Images', slug: 'product-images' });
await folder.save();
// Move an asset into a folder
photo.folderId = folder.id;
await photo.save();

// AssetStore -- provider-agnostic file I/O + record creation
const store = new AssetStore({ collection, filesystem });
await store.store({ buffer, mimeType: 'image/png', name: 'screenshot' });
```

## API

### Models (SmrtObject)

| Export | Description |
|--------|------------|
| `Asset` | Core asset with versioning (`primaryVersionId`, `version`), derivation chain (`sourceAssetId`), `sourceUri`, `mimeType`, `typeSlug`, `statusSlug`, `ownerProfileId` |
| `AssetAssociation` | Generic/provenance polymorphic join: `assetId` + `metaType` + `metaId` + `role` + `sortOrder`; not for base/domain-owned joins that already have noun tables |
| `AssetType` | Lookup table for asset type classification |
| `AssetStatus` | Lookup table for lifecycle status |
| `AssetMetafield` | Custom metadata field definitions with JSON validation rules |
| `Folder` | Hierarchical container for assets; own `folders` table extending `SmrtHierarchical` |

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
