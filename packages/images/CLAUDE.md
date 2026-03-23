# @happyvertical/smrt-images

Image management with AI categorization, editing, and metadata extraction. Extends Asset via cross-package STI.

## Models

- **Image**: STI subclass of Asset (from smrt-assets) — stored in same `assets` table with `_meta_type='Image'`. Adds `width`, `height`, `alt` text.

## Key Services

- **ImageCollection**: dimension/orientation filters — `getByMinDimensions()`, `getByAspectRatio()`, `getLandscape()`, `getPortrait()`, `getSquare()`, `getHighResolution()`, `getMissingAltText()`
- **ImageMetadataExtractor**: dimensions, format, EXIF from buffers (via `@happyvertical/images`)
- **ImageCategorizer**: AI vision analysis → tags, description, confidence, subjects (via `@happyvertical/ai`)
- **ImageEditor**: resize/crop/convert/thumbnail + AI editing. Creates new Image records with `parentId` linking to source.
- **ImageDeriver**: creates derived images and, when requested, records source provenance through generic `AssetAssociation` links
- **ImageSearch**: text search across name/description/alt with orientation filters
- **UpstreamManager**: import from external providers with provenance tracking

## AI Operations

`generateAltText()` uses `this.do()` for inference. Computed properties: `isLandscape`, `isPortrait`, `aspectRatio`.

## Gotchas

- **Cross-package STI**: Image extends Asset from different package — fragile if Asset schema changes
- **AssetAssociation usage is intentional here**: image derivation uses it for provenance, not for base-model-owned asset storage
- **Editor bypasses collection.create()**: creates Image instances directly (skips collection validation)
- **Derivative creation**: 3 DB calls — `collection.create()` + `store.storeFile()` + `save()`
- **Orientation filtering is in-memory**: queries all images, then filters by dimensions
