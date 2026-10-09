# @happyvertical/smrt-images

Image asset management with AI-powered categorization, editing, and metadata extraction for the s-m-r-t framework. Extends `Asset` from smrt-assets via cross-package STI -- stored in the same `assets` table with a distinct `_meta_type`.

## Photographic character setup

The staged setup surface keeps uploaded pixels local during head isolation.
The optional SDK browser segmenter runs its pinned CPU model on the device,
selects hair and face-skin confidence masks, and exports a tightly cropped
transparent PNG while preserving the original RGB bytes. After the user reviews
the head and explicitly continues, the vision request receives only that crop
and returns mouth corners and chin. The s-m-r-t package derives the Canadian
horizontal split rig deterministically, while the animation package owns
contour validation and motion. This is semantic segmentation, not fine-hair
matting; future motion styles are separate.
The split has no artificial mouth-interior fill: opening it reveals the host's
transparent background through the actual photograph seam.

The expressive preview keeps the neutral rig unchanged. While an approved
speech envelope is playing, the host maps it through a bounded gain to the jaw
gap and small head/jaw tilts; silence, cancellation, replacement, completion,
and reduced-motion all restore the neutral pose. The Canadian split's vertical
travel is derived from the measured mouth-to-chin span and the canvas receives
matching transparent bottom padding, so a larger opening never clips the PNG.

The mouth split is derived locally from MediaPipe FaceLandmarker lip-corner and
chin landmarks on the isolated browser image. The pinned model is integrity
checked before CPU inference; one clear face is required, cancellation is
honored between loading and detection, and no image bytes are sent to a vision
provider for this stage.

`PhotoCutoutProfileStore` is the persistence seam. A consuming server supplies
its authenticated profile, tenant, `AssetRuntime`, profile resolver, and
authorization callback; the store saves PNG bytes as an owner-bound canonical
asset, links it to the profile as `character_cutout`, and stores a versioned
rig manifest that refers to the stable `character_cutout` asset key. The host
maps that key to returned durable bytes; UUIDs and expiring URLs are never
baked into the rig. It rejects another tenant, declined authorization, malformed
or unsupported selected manifests, invalid PNG dimensions, and missing saved
bytes. The store compensates only the just-created owned asset if an unlinked
profile write fails. Authorized readers can list stable saved-setup summaries
without loading PNG bytes; malformed linked manifests are omitted from that
gallery so valid offerings remain recoverable. Readers can then select only an
existing owner- and tenant-bound
`character_cutout` asset; an omitted asset id still loads the latest setup.
`PhotoCutoutSetup` accepts host-provided save/load callbacks and never
uses browser storage as an asset catalog. The chat workbench's local callback
bridge is deliberately loopback-only and fixed to an externally provisioned
temporary profile; it demonstrates canonical AssetRuntime/Profile storage but
is not a production authorization mechanism.

Persistence test design: focused unit coverage exercises authorized and denied
actor cases, tenant mismatch, PNG/frame rejection, malformed/versioned manifest
omission from galleries and rejection on selection, selected/latest gallery
loads, failed-link compensation, and an adapter that links before throwing.
The SQLite integration test creates the `AssetRuntime`, Profile, and
`ProfileAsset` link inside one transaction executor, then reloads after commit.
The service is adapter-neutral; PostgreSQL execution belongs to the consuming
application's database suite because this package owns no deployment database.

For mouth landmark analysis, configure a vision-capable model through the
server-only AI configuration (for example `SMRT_CHAT_DEV_MODEL`). Review the
result against the actual crop: valid geometry does not guarantee accurate
mouth placement. The UI never exposes provider credentials or model selection.

The helper release consumes the published SDK family through the workspace catalog.
SMRT keeps the SDK catalog and overrides aligned atomically; the
`bash scripts/check-sdk-versions.sh` release gate enforces that boundary.

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
const images = await ImageCollection.create({ db });
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

// Metadata categorization (returns tags, description, confidence, subjects)
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
| `ImageCategorizer` | Metadata categorization returning tags, description, confidence, subjects. `autoTag()` applies results to the image. |
| `ImageDeriver` | Derive new images from sources + AI prompts with generic provenance links via `AssetAssociation` |
| `ImageEditor` | Resize, crop, convert, thumbnail (via `@happyvertical/images`) + AI editing. Creates derivative Image records linked via `parentId`. |
| `ImageMetadataExtractor` | Extract dimensions, format, EXIF from image buffers |
| `ImageSearch` | Text search across name/description/alt with orientation filters |
| `UpstreamManager` | Import from external providers with provenance tracking |

### Key Types

`ImageOptions`, `CategoryResult`, `DeriveOptions`, `ImageMetadataResult`, `ImageSearchOptions`, `AssetSourceAdapter`, `SourceAsset`, `SourceAssetMetadata`

### Optional vocabulary decisions

`ImageCategorizer` remains generative unless both `decisions` and a tag or
subject vocabulary are supplied. A vocabulary is a readonly array of
`{ name, description? }` entries or an image resolver. Offered tag and subject
labels are independent predicates: names are exact and case-sensitive, and only
probabilities above `0.5` are selected. Tags and subjects can be constrained
independently; an absent vocabulary keeps that generated field, while an
explicit empty vocabulary returns no labels for that field without a decision
provider call. Vocabulary entries are limited to 64 entries, 128-character
names, and 512-character descriptions. Resolver and configured-provider errors
propagate.

Use `categorizeDetailed()` for selected-label probabilities and decision
provenance. The existing `CategoryResult.confidence` remains the generative
categorizer's confidence and is not a calibrated decision certainty.

This path classifies only curated metadata: image name, description, MIME type,
and dimensions. `categorize(image, buffer)` still ignores `buffer`; it does not
send image bytes, EXIF, source URLs, or the metadata blob to either provider.
A supported pixel/vision feature requires a separately scoped API.

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-assets` -- base `Asset` model and `AssetStore`
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/ai` -- AI categorization and image generation
- `@happyvertical/images` -- resize, crop, convert, thumbnail operations

## Contributor guide

See [`AGENTS.md`](./AGENTS.md) for package architecture, invariants, validation,
and contributor guidance.


### Local photographic head isolation

`PhotoCutoutSetup` isolates hair and facial skin on the user's device through the optional SDK `@happyvertical/images/segmentation` entry point. Original RGB values are preserved in the transparent PNG; alpha derives from a semantic pixel mask rather than a model-authored polygon. The component accepts `segmentationAssets` for a same-origin prepared asset directory (default `/api/dev-image-segmentation`). Prepare pinned runtime/model assets with SDK images `prepare:segmentation`; the chat workbench has a dev-only allowlisted asset route. Hair/face policy and review/retry live in s-m-r-t, generic inference and PNG encoding in SDK. Photographs are not uploaded during isolation. Mouth analysis remains the separately requested next stage.

The setup flow presents four explicit stages: choose a photo, isolate the head, set the mouth from local face landmarks, then save. Each stage exposes one next action; redo and saved-character loading remain secondary actions. On wide screens the isolated head and animated preview share a compact row, and they stack on narrow screens. Loading, cancellation, and failures preserve the recoverable prior stage.

Saving adds the reviewed character to the authorized saved gallery. It does not select or activate a helper; the consuming surface handles that explicit follow-up. The 256×256 model can soften fine strands and low-confidence boundaries. Users review the head before continuing; loading errors and cancellation retain the selected photo. Local development uses the explicitly authorized SDK #1370 sibling link, to be replaced by released family pins at coordinated delivery.
