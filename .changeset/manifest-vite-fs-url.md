---
'@happyvertical/smrt-core': patch
---

`ObjectRegistry.registerPackageManifest` reads a manifest named by a Vite dev-server URL (`http://host/@fs/<absolute path>`), which is what a package's register shim's `import.meta.url` is under `vite dev` and vitest's browser-like environments. It no longer fails with `PACKAGE_MANIFEST_READ_FAILED` ("The URL must be of scheme file").
