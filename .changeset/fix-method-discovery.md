---
"@happyvertical/smrt-cli": patch
---

fix(cli): load manifest before importing register.js to enable method discovery

**CRITICAL FIX for Phase 3 - Custom Method Commands**

Custom method commands like `npx smrt praeco:research` were not appearing because the manifest wasn't loaded when `ObjectRegistry.register()` was called during module initialization.

**The Problem:**
1. CLI imports `.smrt/register.js`
2. `register.js` executes: `ObjectRegistry.register(Praeco, { name: 'praeco' })`
3. `ObjectRegistry.register()` calls `discoverManifestSync('praeco')` to load methods
4. BUT manifest not loaded yet → returns `undefined` → no methods discovered!

**The Solution:**
Now `loadLocalTestManifestSync()` is called BEFORE importing `register.js`, ensuring the manifest is in memory when registration happens. This allows `ObjectRegistry.register()` to find the manifest entry and load method definitions.

**Impact:**
Commands like `npx smrt praeco:research <id> --query "..."` should now work after consumers rebuild with this version.
