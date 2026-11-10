---
type: Capability
title: "File and asset upload and storage"
description: "Reach for smrt-assets AssetStore and the serving contract before writing an upload handler or file-serving route."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-4687
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/assets/src/asset-serving.ts
    path: packages/assets/src/asset-serving.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/assets/src/asset-serving.ts (resolveAssetForServing, AssetServeError, remoteMode)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/assets/src/owned-asset-helpers.ts
    path: packages/assets/src/owned-asset-helpers.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/assets/src/owned-asset-helpers.ts (assertAssetLinkable)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/assets/src/asset-store.ts
    path: packages/assets/src/asset-store.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/assets/src/asset-store.ts (AssetStore.store)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/assets-local/src/index.ts
    path: packages/assets-local/src/index.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/assets-local/src/index.ts (createLocalAssetProcessor)"
  - id: s5
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/assets-ergot/src/index.ts
    path: packages/assets-ergot/src/index.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/assets-ergot/src/index.ts (createErgotAssetProcessor)"
---

# File and asset upload and storage

# Entry point

Import from `@happyvertical/smrt-assets`. `AssetStore` (`store()`, `read()`, `remove()`, `storeVersion()`) writes bytes through the @happyvertical/files provider layer (loaded lazily, so the storage backend is a configuration choice) and creates the matching `Asset` row. `createAssetRuntime()` bundles the store and collection; `serveAsset()` and `resolveAssetForServing()` are the serving contract; `addOwnedAssetFromCollection()` attaches assets to an owner through noun-specific joins. Correction to the expected home: `smrt-assets-local` and `smrt-assets-ergot` are not storage backends. They are `AssetCapabilityProvider` processors: `createLocalAssetProcessor()` (sharp image variants and metadata) and `createErgotAssetProcessor()` (Ergot workflow and external-source sync).[^s3][^s4][^s5]

# Why not hand-roll it

`resolveAssetForServing()` in `asset-serving.ts` returns 403 when an asset's `tenantId` is set and differs from the caller's, runs the host's `canAccess` hook, and defaults `remoteMode` to `'error'` because `sourceUri` is attacker-settable and proxying it is an SSRF vector (the proxy mode requires a public-IP host, re-validates redirects and caps bytes) (S5 #1396).[^s1] `assertAssetLinkable()` in `owned-asset-helpers.ts` refuses to associate an asset with an owner of another tenant, and refuses a tenant's asset on a shared owner.[^s2] A hand-rolled upload route typically serves `sourceUri` or a path directly and checks neither.

# Component pages

- [smrt-assets](/components/smrt-assets.md)
- [smrt-assets-local](/components/smrt-assets-local.md)
- [smrt-assets-ergot](/components/smrt-assets-ergot.md)

# Detection signals

- `import:multer`
- `import:busboy`
- `import:formidable`
- `import:@aws-sdk/client-s3`

[^s1]: `packages/assets/src/asset-serving.ts` at `478ae36900`: resolveAssetForServing, AssetServeError, remoteMode.
[^s2]: `packages/assets/src/owned-asset-helpers.ts` at `478ae36900`: assertAssetLinkable.
[^s3]: `packages/assets/src/asset-store.ts` at `478ae36900`: AssetStore.store.
[^s4]: `packages/assets-local/src/index.ts` at `478ae36900`: createLocalAssetProcessor.
[^s5]: `packages/assets-ergot/src/index.ts` at `478ae36900`: createErgotAssetProcessor.
