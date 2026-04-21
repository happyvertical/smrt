---
'@happyvertical/smrt-core': patch
---

**Release B — consolidate ObjectRegistry manifest discovery (#1133)**

Internal refactor. Public `ObjectRegistry.*` API unchanged; no consumer impact.

- Extract `packages/core/src/manifest/store.ts` — leaf module holding globalThis cache accessors and pure fs/URL helpers with no `ObjectRegistry` dependency. Breaks the historical `registry.ts → class-registration.ts → manifest-loader.ts → registry.ts` cycle.
- Introduce `ManifestSource` interface with six implementations (`LocalTestManifestSource`, `TestManifestSource`, `StaticManifestSource`, `EmbeddedManifestSource`, `NodeModulesFallbackSource`, `ExplicitPathsManifestSource`) and a `CompositeManifestSource` that queries them in the same priority order as the historical `discoverCachedManifestSync`.
- `ManifestLookupQuery` carries optional `packageName` / `qualifiedName` context so multi-package same-simple-name scenarios (issue #951) resolve to the right manifest when the caller has package identity available.
- `discoverManifestSync` and `loadAllManifests({ manifestPaths })` now delegate through `CompositeManifestSource` / `ExplicitPathsManifestSource`. Test-env gating moved into the sources themselves.
- Drop the eagerly-maintained `__smrtRegistryClassNameMap` index; case-insensitive lookups iterate the `classes` Map with object-identity de-duplication. Removes a class of cache-sync bugs (#584, #847, #951) at negligible runtime cost in realistic SMRT apps (low-hundreds of classes).
- Consolidate manifest-cache getters across `manifest-loader.ts` onto the `store.ts` leaf.
