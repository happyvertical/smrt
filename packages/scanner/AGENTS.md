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
- `lintNumericPrecision(classes, sourceText?)` — flags persisted `number` fields
  whose declared precision contradicts their name (#2361), returning a `kind`
  per finding. **Money is exact** and stored as integer minor units, so
  `subtotal = 0.0` is a `money` finding; **rates are fractional**, so
  `taxRate = 0` is a `rate` finding. `classifyNumericFieldName` does head-noun
  matching and lets a rate word win outright, so `taxRate` is a rate even though
  `tax` is money, while `amountCents` and `totalTokensUsed` classify as neither.
  `weight`/`score`/`factor`/`percent` are deliberately unclassified — they are
  commonly whole numbers. Explicit `@field({ type })`, `@meta`/`Meta<T>`,
  transient, relationship, and static fields are exempt.
  `sourceMayContainNumericPrecisionIssue(source)` is the cheap pre-filter
  callers use to avoid parsing every file; `dev:knowledge-check` drives both.
- `verifyManifestCompleteness({ packageDir })` — publish guard: re-scans `src/`
  and asserts every `@smrt()` object reached `dist/manifest.json` (issue #1483).
  Returns `ok` / `incomplete` / `missing-manifest` / `scan-error` / `skipped`.
  Driven by `scripts/verify-manifest-completeness.mjs` from `prepack`.
- `discoverSourceFiles(options)` — shared bounded source-discovery policy used
  by `OxcScanner` and the core manifest preflight.
- Types (re-exported from `./types`): `RawClassDefinition`,
  `RawFieldDefinition`, `RawMethodDefinition`, `ResolvedClassDefinition`,
  `ScanResults`, `FileScanResult`, `OxcScannerOptions`, `InferredFieldType`,
  `FieldTypeInference`.

## Discovery boundaries

File discovery is the difference between a scan that finishes and one that
exhausts the heap when the scanner is pointed at an application root (#2275):

- `dot: true` is set so ignore patterns apply beneath dot directories. Without
  it a `**` cannot cross a dot segment, so `**/node_modules/**` pruned the root
  `node_modules` but nothing under `.svelte-kit/`, `.vercel/`, or `.turbo/`.
- Mandatory excludes (`**/node_modules/**`, `**/.*/**`, `**/.*`) are unioned
  with the caller's `exclude` and cannot be overridden. `exclude` REPLACES the
  defaults, so every caller that narrowed it had silently reopened
  `node_modules`.
- `followSymbolicLinks` defaults to `false`. A pnpm `node_modules` is a symlink
  graph with cycles, not a tree, so a link-following walk reaches the same real
  directory once per path leading to it. This drops symlinked *files* as well as
  directories, so pass `followSymbolicLinks: true` for a project that genuinely
  keeps sources behind a link — it is threaded through `smrtPlugin` and
  `ManifestBuilderOptions` for the build path.
- Patterns are rewritten relative to `cwd` before globbing. Globs match as text,
  so an absolute pattern would hand `**/.*/**` the project's own ancestors and a
  checkout under `~/.worktrees` or `~/.cache` would match nothing at all.
- `dot: true` would otherwise widen the result to hidden files, so `**/.*` is in
  the mandatory prunes too: hidden files stay out, exactly as before.

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
- `src/discovery.ts` — shared bounded glob policy for every scanner entry point.
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
- **0 vs 0.0 heuristic**: `count = 0` → integer, `ratio = 0.0` → decimal; the
  raw initializer text (not the parsed value) decides, and negative defaults are
  unwrapped from their `UnaryExpression` before the check. The rule is silent
  and SQLite's affinity masks the consequence, so money- and rate-shaped fields
  are gated by `lintNumericPrecision` rather than left to review (#2361).
- **`RawFieldDefinition.line` is `0`**: the OXC AST nodes reaching this package
  carry no `loc`. Pass the source text to a consumer that needs a real line.
- **Static property capture**: captures `uiSlots` and `adminRoutes` for agent
  manifest generation.
- **`@smrt()` config spreads resolve only against unescaped same-file `const`s** (issue
  #2100). `@smrt({ ...INTERNAL_SURFACE })` works when `INTERNAL_SURFACE` is a
  module-scope `const` object literal in the same file (`as const` and
  `export const` included); a constant may spread an earlier constant. Anything
  else — an imported constant, a `let`, a function call, a computed non-literal
  key, shorthand or non-literal value, mutation/alias/escape, or a spread inside
  an include array — is reported as a `severity: 'error'` scan diagnostic,
  never silently dropped. `const` prevents rebinding but not property mutation,
  and object spread is shallow, so only binding-aware spread references whose
  shared nested values remain safe through the decorator use are trusted.
  Silence would be unsafe: a dropped spread can remove `api`/`mcp`/`cli`, and an
  ABSENT surface key means default-open full CRUD, so a quiet drop turns a
  deliberate lockdown into a published surface.
  A constant whose own initializer holds an unresolvable spread
  (`const CFG = { ...IMPORTED }`) is tracked as **tainted**: it still resolves,
  but its taint replays into the diagnostics of every decorator that spreads
  it, transitively through constant chains. Without that the silent drop simply
  moves one level up. An unused tainted constant reports nothing.
