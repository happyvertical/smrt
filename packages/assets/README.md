# @happyvertical/smrt-assets

Provider-agnostic asset management with versioning, type classification, metadata fields, and generic/provenance associations.

`AssetAssociation` is the generic exception path for linking assets to arbitrary
objects when there is not a model-owned noun join table. Base/domain-owned
relationships should use dedicated joins such as `content_assets`,
`profile_assets`, `event_assets`, `place_assets`, and `product_assets`.

## Feature recipes

`assets.library` provides the model-backed file and media library: assets,
folders, classifications, statuses, and metadata definitions.
`assets.attachments` adds record attachment provenance and requires the library.
They share the **Files and media** catalog card and the **Assets** navigation
section, and both embed user-facing help in the generated manifest. The recipes
publish browser-safe mock fixture exports from `@happyvertical/smrt-assets/playground`.
`AssetManager` needs host persistence callbacks and `AttachmentPanel` needs
record-scoped authorized attachments, so neither is declared as a standalone
placement. Storage providers remain application-owned, so the recipes declare
no provider.

The package playground is a Mock preview. Its asset grid uses in-memory props
and data-URI thumbnails, and its attachment panel demonstrates supplied native
form data only. It never performs a real network upload or creates public
storage URLs.

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
const store = await new AssetStore(assetRoot, collection).initialize();
await store.store('screenshot', buffer, { mimeType: 'image/png' });
```

## Portable local storage

For a new desktop installation, pass the same portable storage configuration
to each asset runtime, worker, and service that handles its managed files:

```ts
const assets = await createAssetRuntime({
  db,
  storage: { type: 'local', basePath: assetRoot, locatorMode: 'relative' },
});
```

Use an absolute, app-owned `assetRoot`. The store persists
`asset-local:<key>`, for example `asset-local:document/17f6.txt`.
The key is a raw, slash-separated path under the configured root and
contains no URL escaping. Use ASCII letters, digits, underscores, and
hyphens in type slugs and IDs. The store rejects traversal, absolute keys,
Windows device names, links at or below the root, and non-regular files. Keep
the root and its contents under app control; the filesystem checks assume
no concurrent changes by an untrusted local process.

When copying an installation, copy the database and the asset directory
together, keep each file's path within the directory, and set `basePath`
to the copied directory. Read, preserve, and remove assets through the
runtime. A storage resolver may choose a path for a portable write, but
later reads and deletes must use the stored key in the built-in local
filesystem for that runtime.

The option changes new writes only. Existing local options and S3
locators keep their formats. A built-in local store can read portable
locators whether or not it opts in to writing them. In portable mode,
an existing `file://` locator can still be read or removed when it
identifies a valid key inside the configured root; changing the root
does not relocate such records. Start with fresh desktop data or handle
existing absolute locators before moving an installation.

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

## Native private attachments

`AttachmentPanel`, `AttachmentList` and `AttachmentUpload` compose authorized
private links, caller-supplied version history, and native multipart uploads.
They preserve request identity and failed-action metadata without deriving
public storage URLs. See [the attachment contract](agents/attachments.md) for
public types, native payloads, recovery, and server responsibilities.

Pass `onremove(attachment)` and/or `removeAction` (native POST of the
attachment id) to add a confirmed per-attachment Remove button; see
"Removing attachments" in the contract.

### Polymorphic junction collection types

`AssetAssociationCollection` extends `SmrtJunctionBase`, sharing `byRight`,
ordering, positioning, and registration guards with ordinary junctions. Its
`byLeft`, `attach`, `detach`, and `setLinks` methods still require both `metaType`
and `metaId`; they do not implement the single-owner `SmrtJunction` contract.
Use `instanceof SmrtJunctionBase` when recognizing either kind of junction.
Asset associations no longer satisfy `instanceof SmrtJunction`.

After building the workspace, `node scripts/verify-packed-junction-types.mjs`
checks actual core/assets tarballs in the standard Bundler mode with
`skipLibCheck: false`, inherited result types, and negative owner-argument tests.
Full NodeNext declaration portability is tracked separately in #3524.

The consumer fixture installs declared dependencies in a temporary directory
with no ancestor `node_modules`; it never links producer dependencies. It retains
the project’s public registry routing without copying credentials. Set
`SMRT_PACKED_EVIDENCE_DIR` to retain tarballs and the consumer lockfile. For an
explicitly separate upstream-candidate proof, `SMRT_PACKED_OVERRIDES` may name
a JSON file of pnpm overrides; such a proof does not establish that the normal
published dependency graph passes.
