# @happyvertical/smrt-images

Image asset management with AI-powered categorization, search, editing, and metadata extraction. Image extends Asset via cross-package STI.

## Architecture

```
src/
  index.ts          # Export barrel
  types.ts          # ImageOptions, CategoryResult, ImageSearchOptions, DeriveOptions
  image.ts          # Image model (STI subclass of Asset from smrt-assets)
  images.ts         # ImageCollection with dimension/orientation queries
  metadata.ts       # ImageMetadataExtractor (uses @happyvertical/images)
  categorizer.ts    # AI-powered image categorization
  search.ts         # AI-powered image search
  editor.ts         # Standard + AI image editing (creates derivatives)
  deriver.ts        # Derived image creation from sources + prompt
  upstream.ts       # Upstream source manager for importing images
```

## Key Models

- `Image` — Extends Asset with width, height, alt text (stored in assets table via STI)
- `ImageCollection` — Dimension queries, orientation filters, accessibility checks

## Key Patterns

- **Cross-package STI**: Image extends Asset from smrt-assets, stored in same `assets` table
- **Derivative creation**: Editor operations create new assets with parentId linking to original
- **AI integration**: Categorizer, editor, deriver use @happyvertical/ai
- **Upstream sources**: UpstreamManager imports from external providers with provenance tracking

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-assets`, `@happyvertical/smrt-tenancy`
- `@happyvertical/ai` (AI operations), `@happyvertical/images` (image processing)
