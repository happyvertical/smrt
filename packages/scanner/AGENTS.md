# @happyvertical/smrt-scanner

AST-based scanner for discovering SMRT objects in TypeScript source. Uses
oxc-parser (Rust, 2-3x faster than tsc) for syntactic parsing — it never
executes the source.

## Key Exports

- `OxcScanner` — class that globs `.ts` files (`fast-glob`) and parses each into
  raw class/field/method metadata. `scan()` parses; `scanAndResolve()` parses
  then resolves inheritance in one call.
- `InheritanceResolver` — resolves class inheritance chains across files
  (`addClasses()` → `resolveAll()`), merging inherited fields/config into each
  `@smrt()` subclass.
- `ManifestAdapter` — converts resolved classes into the SMRT manifest shape
  (`toManifest()`); owns field-type inference (the `0` vs `0.0` integer/decimal
  heuristic, decorator interpretation, union/alias resolution).
- `parseFile` / `parseSource` — parse a single file or a source string to a
  `FileScanResult` (classes, errors, type aliases, SMRT imports).
- `extractSmrtImports` — pull SMRT-related imports from a parsed file.
- `verifyManifestCompleteness({ packageDir })` — publish guard: re-scans `src/`
  and asserts every `@smrt()` object reached `dist/manifest.json` (issue #1483).
  Returns `ok` / `incomplete` / `missing-manifest` / `scan-error` / `skipped`.
  Driven by `scripts/verify-manifest-completeness.mjs` from `prepack`.
- Types (re-exported from `./types`): `RawClassDefinition`,
  `RawFieldDefinition`, `RawMethodDefinition`, `ResolvedClassDefinition`,
  `ScanResults`, `FileScanResult`, `OxcScannerOptions`, `InferredFieldType`,
  `FieldTypeInference`.

## How It Works

1. `fast-glob` finds `.ts` files matching include/exclude patterns.
2. `oxc-parser` parses each file's AST (TS-ESTree shape).
3. Extracts: `@smrt()` config, class hierarchy, field defaults (0 vs 0.0
   heuristic, including negative initializers via `UnaryExpression` unwrap),
   relationships, static properties (`uiSlots`, `adminRoutes`).
4. `InheritanceResolver` merges inherited members; `ManifestAdapter` emits the
   manifest JSON consumed by code generators, the vitest plugin, and the CLI.

## Key Files

- `src/oxc-parser.ts` — core AST → raw metadata extraction (`parseFile`,
  `parseSource`, `extractSmrtImports`, field/decorator/type extractors).
- `src/scanner.ts` — `OxcScanner`: globbing + multi-file orchestration
  (`scan` / `scanAndResolve`).
- `src/inheritance-resolver.ts` — `InheritanceResolver`: cross-file inheritance
  merging.
- `src/manifest-adapter.ts` — `ManifestAdapter`: raw → manifest conversion and
  field-type inference.
- `src/verify-completeness.ts` — `verifyManifestCompleteness` publish guard.
- `src/types.ts` — shared raw/resolved/result type definitions.
- `src/cli.ts` / `bin/smrt-scan.js` — the `smrt-scan` CLI.

## Gotchas

- **Syntactic only**: the scanner parses, it does not type-check or execute.
  Type aliases are resolved heuristically (bounded depth), not via the TS type
  system.
- **Build-time consumers**: `smrtVitestPlugin()` and the build's vite-plugin run
  the scanner at startup; add a new `@smrt()` class → rebuild/restart so it
  reaches the manifest.
- **`ManifestBuilder` / `discoverBaseClasses` live in `@happyvertical/smrt-core`,
  not here.** This package is the lower-level AST layer; core orchestrates
  manifest generation and base-class discovery on top of it.
- **0 vs 0.0 heuristic**: `count = 0` → integer, `price = 0.0` → decimal; the
  raw initializer text (not the parsed value) decides, and negative defaults are
  unwrapped from their `UnaryExpression` before the check.
- **Static property capture**: captures `uiSlots` and `adminRoutes` for agent
  manifest generation.
