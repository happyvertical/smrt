---
"@happyvertical/smrt-core": patch
---

fix(manifest): complete external package manifest loading

- Check both src/manifest/test-manifest.json and dist/manifest.json for built packages
- Use createRequire(process.cwd()) to resolve packages from calling app's context
- Walk up from package main entry to find package.json and load manifest
- Fixes manifest loading for external dependencies (e.g., @happyvertical/smrt-events)

Resolves #159
