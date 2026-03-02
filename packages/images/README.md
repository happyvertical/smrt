# @happyvertical/smrt-images

Image asset management with AI-powered categorization, search, editing, and metadata extraction for the SMRT framework. Extends the `Asset` class via STI.

## Installation

```bash
pnpm add @happyvertical/smrt-images
```

## Usage

```typescript
import {
  Image, ImageCollection,
  ImageCategorizer, ImageEditor, ImageSearch,
  ImageMetadataExtractor, UpstreamManager
} from '@happyvertical/smrt-images';

// Create an image
const images = new ImageCollection(db);
const image = await images.create({
  name: 'product-hero.jpg',
  url: 'https://cdn.example.com/product-hero.jpg',
  mimeType: 'image/jpeg',
});
await image.save();

// AI-powered categorization
const categorizer = new ImageCategorizer(aiConfig);
const categories = await categorizer.categorize(image);

// Metadata extraction
const extractor = new ImageMetadataExtractor();
const metadata = await extractor.extract(image);

// Semantic search
const search = new ImageSearch(db, aiConfig);
const results = await search.find({ query: 'sunset landscape' });
```

## API

### Models

| Export | Description |
|--------|------------|
| `Image` | STI subclass of `Asset` with image-specific fields |

### Collections

| Export | Description |
|--------|------------|
| `ImageCollection` | Collection for managing Image objects |

### Services

| Export | Description |
|--------|------------|
| `ImageCategorizer` | AI-powered image categorization |
| `ImageDeriver` | Derive new images (resize, crop, transform) |
| `ImageEditor` | AI-powered image editing operations |
| `ImageMetadataExtractor` | Extract EXIF and other metadata |
| `ImageSearch` | Semantic image search |
| `UpstreamManager` | Manage upstream image sources |

### Key Types

`ImageOptions`, `CategoryResult`, `DeriveOptions`, `ImageMetadataResult`, `ImageSearchOptions`, `AssetSourceAdapter`, `SourceAsset`, `SourceAssetMetadata`

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-assets` — base Asset model
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
