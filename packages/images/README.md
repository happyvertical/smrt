# @happyvertical/smrt-images

Image asset management with AI-powered categorization, editing, and metadata extraction for the SMRT framework. Extends `Asset` from smrt-assets via cross-package STI -- stored in the same `assets` table with a distinct `_meta_type`.

## Installation

```bash
pnpm add @happyvertical/smrt-images
```

## Usage

```typescript
import {
  Image, ImageCollection,
  ImageCategorizer, ImageEditor, ImageDeriver,
  ImageMetadataExtractor, ImageSearch, UpstreamManager,
} from '@happyvertical/smrt-images';

// Create and query images
const images = new ImageCollection(db);
const image = await images.create({
  name: 'hero.jpg',
  url: 'https://cdn.example.com/hero.jpg',
  mimeType: 'image/jpeg',
  width: 1920,
  height: 1080,
});
await image.save();

// Computed properties from dimensions
image.isLandscape;  // true
image.aspectRatio;  // 1.778
image.isHighResolution();  // false (below 4K)

// AI-powered categorization (returns tags, description, confidence, subjects)
const categorizer = new ImageCategorizer({ ai: aiConfig });
const result = await categorizer.categorize(image);
// Auto-tag: applies tags and sets description/alt text
await categorizer.autoTag(image, assetCollection);

// AI alt text generation via this.do()
const altText = await image.generateAltText();

// Standard editing (resize, crop, convert, thumbnail)
// Each operation creates a new derivative Image linked via parentId
const editor = new ImageEditor(store, images, { ai: aiConfig });
const thumb = await editor.thumbnail(image, 256);
const resized = await editor.resize(image, 800, 600);
const webp = await editor.convert(image, 'webp');

// AI-powered editing and variation generation
const edited = await editor.edit(image, 'add warm sunset tones');
const variations = await editor.generateVariation(image, 'winter theme', { count: 3 });
```

## API

### Models

| Export | Description |
|--------|------------|
| `Image` | STI subclass of `Asset` with `width`, `height`, `alt`, and computed `aspectRatio`/`isLandscape`/`isPortrait`/`isSquare` |

### Collections

| Export | Description |
|--------|------------|
| `ImageCollection` | Dimension/orientation filters: `getByMinDimensions()`, `getByAspectRatio()`, `getLandscape()`, `getPortrait()`, `getSquare()`, `getHighResolution()`, `getMissingAltText()` |

### Services

| Export | Description |
|--------|------------|
| `ImageCategorizer` | AI vision analysis returning tags, description, confidence, subjects. `autoTag()` applies results to the image. |
| `ImageDeriver` | Derive new images from sources + AI prompts with generic provenance links via `AssetAssociation` |
| `ImageEditor` | Resize, crop, convert, thumbnail (via `@happyvertical/images`) + AI editing. Creates derivative Image records linked via `parentId`. |
| `ImageMetadataExtractor` | Extract dimensions, format, EXIF from image buffers |
| `ImageSearch` | Text search across name/description/alt with orientation filters |
| `UpstreamManager` | Import from external providers with provenance tracking |

### Key Types

`ImageOptions`, `CategoryResult`, `DeriveOptions`, `ImageMetadataResult`, `ImageSearchOptions`, `AssetSourceAdapter`, `SourceAsset`, `SourceAssetMetadata`

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-assets` -- base `Asset` model and `AssetStore`
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/ai` -- AI categorization and image generation
- `@happyvertical/images` -- resize, crop, convert, thumbnail operations
