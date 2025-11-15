# Function: loadLocalTestManifestSync()

> **loadLocalTestManifestSync**(): [`SmartObjectManifest`](../interfaces/SmartObjectManifest.md) \| `null` \| `undefined`

Defined in: [packages/core/src/manifest/manifest-loader.ts:93](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/manifest/manifest-loader.ts#L93)

Load local test manifest from current package (synchronous)

During test runs, packages can have manifests in two locations:
1. src/manifest/test-manifest.json - Domain packages during development
2. dist/manifest.json - Built packages (consuming apps like praeco)

This function attempts to load the manifest from either location.

## Returns

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md) \| `null` \| `undefined`

Loaded manifest or null if not found or undefined if not yet attempted
