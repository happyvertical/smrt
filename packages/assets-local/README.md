# @happyvertical/smrt-assets-local

Lightweight local image processor for `@happyvertical/smrt-assets`.

## Installation

```bash
pnpm add @happyvertical/smrt-assets @happyvertical/smrt-assets-local
```

## Capabilities

- EXIF extraction and orientation normalization.
- Stable captured-time, dimensions, and GPS metadata.
- Deterministic `thumb`, `card`, `preview`, and `publish` variants.
- Derived-asset lineage and cache reuse.

Register this adapter when local processing is suitable for the deployment. Asset identity, tenant policy, and publishing decisions remain in `smrt-assets` and the host application.

## Validation

```bash
pnpm --filter @happyvertical/smrt-assets-local test
pnpm --filter @happyvertical/smrt-assets-local typecheck
```
