# @happyvertical/smrt-assets-local

Local image processing for the s-m-r-t asset runtime. It extracts normalized image
metadata and generates deterministic WebP variants with Sharp, while asset
identity, storage, tenancy, and publishing policy remain owned by
[`@happyvertical/smrt-assets`](../assets/README.md).

Choose this adapter for local development, single-node deployments, and apps
that need practical image handling without a media-asset-management service.

## Installation

```bash
pnpm add @happyvertical/smrt-assets @happyvertical/smrt-assets-local
```

`sharp` is installed by this adapter and is not pulled into core s-m-r-t asset
consumers.

## Quick start

```ts
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { createLocalAssetProcessor } from '@happyvertical/smrt-assets-local';

const runtime = await createAssetRuntime({
  db: 'assets.db',
  storage: './data/assets',
  capabilityProviders: [createLocalAssetProcessor()],
});

const source = await runtime.storeSourceAsset(
  'photo.png',
  imageBytes,
  { mimeType: 'image/png', typeSlug: 'image' },
);

const processed = await runtime.processAsset(source, {
  variants: [{ variant: 'thumb' }, { variant: 'card' }],
});

console.log(processed.metadata, processed.variants);
```

The processor saves normalized metadata onto the source asset and creates
derived assets linked back to that source.

## Standard variants

| Name | Size | Fit |
| --- | --- | --- |
| `thumb` | 160×160 | `cover` |
| `card` | 480×270 | `cover` |
| `preview` | 960×960 | `inside` |
| `publish` | 1200×630 | `cover` |

Override presets or output quality when creating the processor:

```ts
const processor = createLocalAssetProcessor({
  quality: 85,
  variants: {
    card: { width: 640, height: 360, fit: 'cover' },
  },
});
```

Unknown variant names must provide explicit `width` and `height`. Repeated
requests reuse a matching derived asset when the source version and parameters
have not changed.

## Metadata

`extractAssetImageMetadataFromBuffer()` normalizes orientation before reporting
dimensions and returns stable metadata for MIME type, dimensions, captured time,
and GPS coordinates when available. GPS values retain enough precision for
nearby-photo search.

Non-image assets are explicitly skipped so a later registered provider can
handle them.

## Public API

| Export | Purpose |
| --- | --- |
| `createLocalAssetProcessor()` | Create an asset capability provider |
| `extractAssetImageMetadataFromBuffer()` | Extract normalized image metadata |
| `normalizeAssetImageMetadata()` | Normalize raw Sharp/EXIF metadata |
| `LocalAssetProcessorOptions` | Configure variant presets and quality |

## Development

```bash
pnpm --filter @happyvertical/smrt-assets-local test
pnpm --filter @happyvertical/smrt-assets-local typecheck
pnpm --filter @happyvertical/smrt-assets-local build
```

See [`AGENTS.md`](./AGENTS.md) for determinism, metadata, and provider-boundary
requirements.
