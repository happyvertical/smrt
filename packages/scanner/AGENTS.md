# @happyvertical/smrt-scanner

AST-based scanner for discovering SMRT objects in TypeScript source. Uses oxc-parser (Rust, 2-3x faster than tsc).

## Key Exports

- `ManifestBuilder` — scans source files, builds `SmartObjectManifest` (`.generate()`)
- `discoverBaseClasses({ cwd })` — finds SMRT base classes in node_modules
- `SmartObjectDefinition`, `FieldDefinition` — scanned class metadata types

## How It Works

1. `fast-glob` finds `.ts` files matching include/exclude patterns
2. `oxc-parser` parses each file's AST
3. Extracts: `@smrt()` config, class hierarchy, field defaults (0 vs 0.0 heuristic), relationships, static properties (`uiSlots`, `adminRoutes`)
4. Outputs manifest JSON consumed by code generators, vitest plugin, and CLI

## Key Files

- `src/oxc-scanner.ts` — core AST scanning logic
- `src/manifest-builder.ts` — orchestrates scanning → manifest
- `src/base-class-discovery.ts` — resolves base classes from node_modules

## Gotchas

- **CWD-relative**: `ManifestBuilder.generate()` resolves all paths relative to `process.cwd()`
- **Used by vitest plugin**: `smrtVitestPlugin()` calls ManifestBuilder at startup
- **Static property capture**: captures `uiSlots` and `adminRoutes` for agent manifest generation
