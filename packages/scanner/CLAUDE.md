# @happyvertical/smrt-scanner

AST-based scanner for discovering SMRT objects in TypeScript source files. Uses oxc-parser for fast, accurate parsing of decorators, class hierarchies, and field definitions.

## Architecture

```
src/
  index.ts              # Export barrel
  scanner.ts            # Main scanner entry point
  oxc-scanner.ts        # OXC-based AST scanner implementation
  manifest-builder.ts   # Builds SmartObjectManifest from scan results
  base-class-discovery.ts # Discovers base classes in node_modules
  types.ts              # SmartObjectDefinition, FieldDefinition, etc.
```

## Key Exports

- `ManifestBuilder` — Builds manifest from source files (`.generate()`)
- `discoverBaseClasses()` — Finds SMRT base classes in node_modules
- `SmartObjectDefinition` — Scanned class metadata (fields, relationships, config)

## Key Patterns

- **OXC parser**: Uses `oxc-parser` for fast TypeScript AST parsing (not tsc)
- **CWD-relative**: `ManifestBuilder.generate()` resolves paths relative to `process.cwd()`
- **Base class discovery**: `discoverBaseClasses({ cwd })` resolves node_modules relative to given directory
- **Static property capture**: Captures `uiSlots` and `adminRoutes` for agent manifests
- **Field heuristics**: Detects INTEGER (0) vs DECIMAL (0.0) from default values

## Dependencies

- `oxc-parser`, `oxc-resolver` (AST parsing)
- `fast-glob`, `minimatch` (file discovery)
