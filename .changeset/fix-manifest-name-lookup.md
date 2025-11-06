---
"@happyvertical/smrt-core": patch
---

fix(core): pass manifest object name to ObjectRegistry.register()

Fixes method discovery by ensuring the registry uses the correct manifest key when looking up methods. Previously, `ObjectRegistry.register(Praeco)` used `Praeco.name` ('Praeco' with capital P) to discover manifest, but the manifest stores entries under lowercase keys like 'praeco'. This caused method lookup to fail and prevented custom CLI commands from being generated.

Now the consumer plugin generates: `ObjectRegistry.register(Praeco, { name: 'praeco' })`

This ensures `getMethods('praeco')` succeeds and CLI commands like `npx smrt praeco:research` are generated correctly.
