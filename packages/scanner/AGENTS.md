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
- `extractAgentSurface` / `scanSvelteAgentSurface` / `mergeAgentSurfaces` —
  the agent-surface matcher (#2591). See below.
- Types (re-exported from `./types`): `RawClassDefinition`,
  `RawFieldDefinition`, `RawMethodDefinition`, `ResolvedClassDefinition`,
  `ScanResults`, `FileScanResult`, `OxcScannerOptions`, `InferredFieldType`,
  `FieldTypeInference`, `AgentSurface`, `AgentSurfaceIntent`,
  `AgentSurfacePlaybook`, `AgentSurfaceDiagnostic`.

## The agent-surface matcher (#2591)

`@smrt()` classes are found by matching DECORATORS. A view intent (#2588) and a
playbook (#2589) are not classes, so `agent-surface.ts` adds the second shape
the framework emits from: a **module-scope call with one object-literal
argument**. `ScanResults.agentSurface` carries the merged result.

### What it accepts

| Requirement | Why |
|---|---|
| A `.ts` / `.tsx` / `.js` / `.jsx` module | the scanner never reads `.svelte` |
| Callee bound by an import from exactly one specifier — `defineIntent` from `@happyvertical/smrt-web/intents`, `definePlaybook` from `@happyvertical/smrt-playbooks` | a local function of the same name is not a declaration. `defineIntent` ships solely from the `/intents` subpath so a sidecar drags in no client-data engine; matching the package root would invent a specifier |
| The call directly at module scope — `const x = f({…})`, `export const x = f({…})`, `f({…});`, `export default f({…})`, or an element of a module-scope array initializer | anything deeper is conditional on control flow; an array literal is not |
| Exactly one argument, an `ObjectExpression` whose values are literals, literal objects, or literal arrays | there is nothing to read otherwise |

Named imports (aliased or not) and namespace imports (`intents.defineIntent`)
both resolve; a default import does not, since neither package has one.

**Declaration discovery is NOT bound to the class-scan `include` glob.** A model
scan is routinely narrowed to where models live — the shipped SvelteKit template
uses `src/lib/objects/**/*.ts` — but an intent sidecar lives beside the component
that uses it. So `agentSurfaceInclude` (default `**/*.{ts,tsx,js,jsx}`, the
extensions the Vite plugin's own default accepts) is globbed separately, files
the class pass already parsed are skipped so nothing is counted twice, and the
token pre-filter keeps a non-declaring file at one read. Binding the two globs
together made sidecars vanish from every artifact with no diagnostic at all —
the exact silent omission this matcher exists to prevent.

### What it refuses, always with a diagnostic

Never a silent omission — every message names `useWebMcpTool`, the escape hatch
for a tool set genuinely derived from computed or fetched data:

| Code | Shape |
|---|---|
| `non-literal-argument` | an identifier reference, a spread (in an object or an array), a call, a conditional, a template literal (interpolated **or not**), a computed or shorthand key, a computed unary, or an argument that is not an object literal |
| `not-module-scope` | declared inside a function, class, conditional, or loop |
| `argument-count` | not exactly one argument |
| `incomplete-declaration` | the literal parsed but lacks `id`/`description`/`target` (intent) or `key`/`title`/`description`/`steps` (playbook) |
| `invalid-identity` | a declaration the runtime helper itself would reject: an intent `id` that is not lowercase and dot-namespaced, over 128 chars, or resolving into the reserved `smrt_ui_` namespace; an unknown declaration, target, or capability key; a malformed `capability` (bad `effect`, non-boolean flag); a `target` outside the closed `control`/`dataSurface` unions or missing a required `controlId`; a playbook with no steps, an empty/non-array/unknown-plane `planes`, an `onStepFailure` outside `abort`/`continue`, a non-boolean `enabled`, or a step whose `model` is not a qualified pair |
| `svelte-declaration` | written inline in a `.svelte` file |
| `duplicate-identity` | two modules declare the same `id`/`key`, or two intent ids derive the same WebMCP tool name |

These rules are mirrored from `defineIntent` and `definePlaybook` (this package
cannot depend on `smrt-web` or `smrt-playbooks`), and keeping them in step is
load-bearing: the declaration types `id` as `string`, so `id: 'Orders.Bad'`
type-checks and fails only at page load. An entry the runtime would reject is
worse than no entry, because the artifact and `smrt doctor` would then advertise
an operation that can never register. The same applies to the tool name, which
is `id` with `.`/`-` replaced by `_` and is therefore **not injective** —
`orders.foo_bar` and `orders.foo.bar` collide, and `defineIntent` rejects the
second registration.

Invalid values are **rejected, never repaired**. That matters most for a
playbook's `planes`: `definePlaybook` throws on an empty or unknown-plane list,
so defaulting it here would emit an entry asserting `server` validity the author
never declared — the exact fail-open the plane rule exists to prevent. The same
holds for `capability`: the fail-closed default is for an OMITTED capability,
not a typo'd one, so `{ effect: 'reed' }` is a diagnostic rather than a silent
`destructive`. Playbook *keys* get no pattern check, because `definePlaybook`
imposes none; only uniqueness applies. **If either runtime tightens its rules,
tighten these too.**

This is deliberately narrower than the decorator-config extractor, which
RESOLVES spreads against module-scope constants. That one must, because a
dropped `@smrt({ ...CFG })` key silently reopens an exposure surface. Here the
requirement runs the other way: an emitted entry has to be exactly what an
author can see in one object literal, so a partial resolution would be worse
than a refusal.

The `.svelte` pass is textual, not a Svelte parse: it requires the import
specifier plus a call, and it exists only to say "move this to a `.ts` sidecar"
— which is the answer regardless of what the declaration contains. It resolves
the local names the file's own import binds, so `defineIntent as declare`
followed by `declare({…})` is caught, and it tolerates whitespace before the
parenthesis; requiring the literal token `defineIntent(` would let exactly the
case this pass exists for slip through unremarked. Any `*.svelte` exclude a
caller passes for the class scan is dropped here, since callers routinely
exclude Svelte because OXC cannot parse it, and honouring that would silence the
one thing the pass is for.

### Deterministic identity

`mergeAgentSurfaces` makes emission independent of file order, so a
cross-profile parity snapshot does not churn on directory order:

- an intent is identified by `id`, a playbook by `key`;
- entries sort by identity, then by source path;
- on a duplicate identity the **lexicographically smaller path wins** and the
  other becomes a `duplicate-identity` diagnostic. "First one scanned wins"
  would give different answers for different input orders;
- diagnostics sort by path, line, column, code, message;
- paths are recorded `cwd`-relative and POSIX-separated, so a checked-in
  artifact is neither machine- nor platform-specific.

The scanner mirrors the #2587 capability vocabulary structurally instead of
importing `@happyvertical/smrt-types`: core depends on this package, so the
reverse edge would close a cycle. Core reconciles the two shapes in exactly one
place, `toKnowledgeAgentSurface` in `vite-plugin/index.ts`.

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
- `src/agent-surface.ts` — the `defineIntent` / `definePlaybook` matcher, its
  diagnostics, and `mergeAgentSurfaces` (#2591).
- `src/source-location.ts` — `getLineColumn`, split out so `agent-surface.ts`
  can resolve a diagnostic's position without importing `oxc-parser.ts`, which
  imports it back.
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
- **A non-static `defineIntent`/`definePlaybook` warns, it does not fail the
  build** — unlike an unresolved `@smrt()` spread, which errors. The asymmetry
  is deliberate: a dropped decorator spread reopens an exposure surface, while a
  computed tool set is a legitimate choice with a supported path
  (`useWebMcpTool`). What is never acceptable is the declaration disappearing
  unremarked, so it is recorded in `ScanResults.agentSurface.diagnostics`,
  printed by the Vite plugin, carried into `smrt-knowledge.json`, reported by
  `smrt doctor`, and surfaced by `dev:knowledge-check` as
  `agent-surface-not-static`.
- **Relationship targets are resolved, not copied**: `@foreignKey`,
  `@oneToMany` and `@manyToMany` arguments arrive as raw source text.
  `'Target'`/`Target` pass through and a forward-reference thunk
  (`() => Target`, including the dotted `() => Target.column` form) is unwrapped
  to its target, matching the runtime decorator, which resolves the thunk by
  invoking it. Any other expression (a call, a computed reference) yields
  `related: undefined` — writing the raw source through produced a garbage FK
  table name and, once FK columns are indexed, a garbage index (#2379).
