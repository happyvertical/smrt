# @happyvertical/smrt-images

Image management with AI categorization, editing, and metadata extraction. Extends Asset via cross-package STI.

## Entry points

- Root (`@happyvertical/smrt-images`) is **browser-safe** (bundle-gate enforced, #3628): `Image`, `ImageCollection`, `ImageSearch`, `UpstreamManager`, prompts, media-bundle persistence, and the pure `adjust` helpers. It must not reach sharp, `node:*`, `@happyvertical/images` (resvg), or `@happyvertical/ai`, even through a lazy `import()` (bundlers follow it).
- Node-only services (`src/index.node.ts`) resolve from the root through the `node` export condition and from `@happyvertical/smrt-images/node`: `ImageEditor`, `ImageCategorizer`, `ImageDeriver`, `ImageMetadataExtractor`, `applyImageAdjustments` (`src/adjust-render.ts`), plus the whole root. Browser/bundler resolution gets the safe root, so those names are absent there. Put new sharp/fs/AI-SDK code behind it.

## Models

- **Image**: STI subclass of Asset (from smrt-assets) — stored in same `assets` table with `_meta_type='Image'`. Adds `width`, `height`, `alt` text.

## Key Services

- **ImageCollection**: dimension/orientation filters — `getByMinDimensions()`, `getByAspectRatio()`, `getLandscape()`, `getPortrait()`, `getSquare()`, `getHighResolution()`, `getMissingAltText()`
- **ImageMetadataExtractor**: dimensions, format, EXIF from buffers (via `@happyvertical/images`)
- **ImageCategorizer**: curated metadata categorization → tags, description, confidence, subjects; optional typed decisions constrain offered tag/subject vocabularies, while image bytes remain unsupported
- **ImageEditor**: resize/crop (a real x/y region, clamped to the picture)/convert/thumbnail/adjust + AI editing. Creates new Image records with `sourceAssetId` linking to source.
- **Local adjustments** (`src/adjust.ts`, sharp, no GPU): brightness, contrast, colour, black-and-white, rotate, flip, region crop (zoom) and resize. `imageAdjustVariants(operation)` gives 2–4 versions to offer ("10/20/30% brighter"); `encodeImageAdjustments`/`decodeImageAdjustments` make a short URL-safe spec for preview routes (decode refuses anything it did not write); `applyImageAdjustments(buffer, adjustments, { fit })` renders; `ImageEditor.adjust()` saves one as a derivative. Everything but `applyImageAdjustments` is pure.
- **ImageDeriver**: creates derived images and, when requested, records source provenance through generic `AssetAssociation` links
- **ImageSearch**: text search across name/description/alt with orientation filters
- **UpstreamManager**: import from external providers with provenance tracking

## AI Operations

`generateAltText()` uses the `smrtImages.image.generateAltText` prompt registered via `@happyvertical/smrt-prompts` (resolves tenant overrides via `resolvePrompt()` then dispatches through `getAiClient().message()`). Computed properties: `isLandscape`, `isPortrait`, `aspectRatio`.

## Prompt Registry

`Image.generateAltText()` is registered with `@happyvertical/smrt-prompts` so tenants can override template/model/params at runtime:

```typescript
import { smrtImagesGenerateAltTextPrompt } from '@happyvertical/smrt-images';
// key: 'smrtImages.image.generateAltText'
```

Only non-PII metadata fields are passed to the AI provider: `name`, `description`. Source URIs, internal foreign-key fields (`parentId`, `tenantId`), and the extensible `metadata` blob are intentionally excluded — source URIs may embed signed/private bucket paths and `metadata` may contain EXIF GPS data or tenant-private configuration.

## UI Registry

Svelte components auto-register with `ModuleUIRegistry` on import of `@happyvertical/smrt-images/svelte`. UI slot declarations live in `src/ui.ts` and are exported via `@happyvertical/smrt-images/ui`:

- `assets-gallery` — `AssetsGallery.svelte`
- `image-editor` — `ImageEditor.svelte`
- `image-uploader` — `ImageUploader.svelte`

## Gotchas

- **Cross-package STI**: Image extends Asset from different package — fragile if Asset schema changes
- **AssetAssociation usage is intentional here**: image derivation uses it for provenance, not for base-model-owned asset storage
- **Editor bypasses collection.create()**: creates Image instances directly (skips collection validation)
- **Derivative creation**: 3 DB calls — `collection.create()` + `store.storeFile()` + `save()`
- **Orientation filtering is in-memory**: queries all images, then filters by dimensions
