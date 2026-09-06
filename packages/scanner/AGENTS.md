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
- `checkAgentSurfaceToolNames(surface, { generatedToolNames, uiToolPrefixes })`
  — report an emitted intent whose derived WebMCP tool name a generated model
  tool or a fixed UI tool already registers (#2725). Takes names, never config.
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

Declaration discovery uses a separate `agentSurfaceInclude` glob (default
`**/*.{ts,tsx,js,jsx}`), independent of the model `include` glob. Skip files
already parsed by the class pass; token-prefilter other files before parsing.

`isAgentSurfaceSourcePath` is the shared authority for both scanner passes and
`dev:knowledge-check` freshness scans. It excludes `.d.ts`, tests/specs, hidden
segments, and `node_modules`, `dist`, `build`, `coverage`, `__tests__`, and
`__typechecks__`. The companion `isPrunedAgentSurfacePath` applies the same
prunes to `.svelte` files. Evaluate paths **relative to the scan root** so a
checkout under an ancestor named `build` or a hidden worktree still scans.
These prunes apply even when caller `exclude` replaces `DEFAULT_EXCLUDE`:
build output can retain declarations and otherwise win duplicate resolution.

### What it refuses, always with a diagnostic

Never a silent omission — every message names `useWebMcpTool`, the escape hatch
for a tool set genuinely derived from computed or fetched data. Every code here
means the declaration was NOT emitted; `tool-name-collision` (below) is the one
exception and is advisory:

| Code | Shape |
|---|---|
| `non-literal-argument` | an identifier reference, a spread (in an object or an array), a call, a conditional, a template literal (interpolated **or not**), a computed or shorthand key, a computed unary, or an argument that is not an object literal |
| `not-module-scope` | declared inside a function, class, conditional, or loop |
| `argument-count` | not exactly one argument |
| `incomplete-declaration` | the literal parsed but lacks `id`/`description`/`target` (intent) or `key`/`title`/`description`/`steps` (playbook) |
| `invalid-identity` | a declaration the runtime helper itself would reject: an intent `id` that is not lowercase and dot-namespaced, over 128 chars, or resolving into the reserved `smrt_ui_` namespace; an unknown declaration, target, or capability key; a malformed `capability` (bad `effect`, non-boolean flag); a `target` outside the closed `control`/`dataSurface` unions or missing a required `controlId`; a playbook with no steps, an empty/non-array/unknown-plane `planes`, an `onStepFailure` outside `abort`/`continue`, a non-boolean `enabled`, or a step whose `model` is not a qualified pair |
| `svelte-declaration` | written inline in a `.svelte` file |
| `duplicate-identity` | two modules declare the same `id`/`key`, or two intent ids derive the same WebMCP tool name |
| `tool-name-collision` | an EMITTED intent whose derived tool name is already registered by a generated model tool or a fixed UI tool (see below) |

Mirror `defineIntent` and `definePlaybook` validation without importing their
packages; update the scanner whenever those runtime rules tighten. Reject
invalid values rather than repairing them: omitted capability gets the
fail-closed default, malformed capability gets a diagnostic, and invalid
`planes` never default to `server`. Playbook keys have no pattern restriction.
WebMCP names replace `.`/`-` with `_`, so distinct intent ids can collide.

Unlike decorator config extraction, agent-surface extraction never resolves
spreads: declarations must be visible in one object literal.

The `.svelte` pass is textual: resolve named/aliased imports and calls (including
whitespace before `(`), then diagnose moving the declaration to a `.ts`
sidecar. Drop caller `*.svelte` class-scan excludes for this pass; otherwise the
diagnostic would be suppressed merely because OXC cannot parse Svelte.

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

### Collisions with names this pass does not own (#2725)

`mergeAgentSurfaces` resolves intent-vs-intent by dropping the loser, because
`defineIntent` REJECTS the second colliding declaration — only one can exist.
Two other sources register into the same document and are invisible to the
declaration scan, so `checkAgentSurfaceToolNames` reports them **without
dropping anything**:

- **generated model tools**, `${className.toLowerCase()}_${action}`, so
  `defineIntent({ id: 'product.list' })` lands on `Product.list`;
- **the six fixed UI tools** under the configured `webmcp.ui.prefix`.

Warnings, not drops, and the asymmetry is the point: `defineIntent` accepts
these ids, so the declarations are real and belong in the artifact; the
document-global tool-name lock (#2613) decides which registration survives,
rejecting the second with a `WebMcpToolNameCollisionError` — a runtime answer to
a question the build can already see coming, which costs whoever loses its tool;
and whether it happens at all turns on runtime values no artifact records (a
WebMCP `namespace`, an `effects` policy, whether a page mounts both). A
build-time drop would guess all three, and the emitted surface would stop
matching the source.

Because those values are unknowable here, the generated-tool message **states
the precondition it assumes** — no `namespace`, action within the `effects`
policy — and says to disregard it when either already separates the pair. A
`namespace` prefixes generated tools and leaves intents alone, so it dissolves
the collision outright; without that sentence a namespaced app would get a
notice that is always wrong where it fires, recommending the remedy it had
already applied. `smrt doctor`'s header is `Tool name also claimed` for the same
reason: it must not assert past what the message says.

**It takes NAMES, never config.** The caller passes the tool names that will
really register; this module never derives a generated name and never applies a
namespace. `namespace` and `ui.prefix` are runtime `<Provider webmcp={…}>`
values that no build artifact records, so a build-time declaration of either
would be a second place to say what the provider already says, free to diverge
silently. Core supplies the names from `buildWebMcpToolDefinitions` — the same
function that emits the runtime `webMcpToolDefinitions`, and therefore already
filtered by the exposure policy. Comparing against every verb a class *could*
expose would invent collisions with tools nobody mounts.

`uiToolPrefixes` is supplied for the same reason, defaulting to the registrar's
`smrt_ui_`. Do NOT replace it with a prefix derived from the name: quantifying
over every prefix an app could have configured has, under the default, no true
positive at all — an id flattening to `smrt_ui_*` is rejected during extraction
— so every diagnostic it emits for a default-configured app is false, persisted
into the artifact and clearable only by renaming a correct intent. There is no
build-time source for `ui.prefix` (a runtime `<Provider>` prop), so this half is
dormant by default and the seam waits for a caller that can fill it.

`RESERVED_TOOL_NAME_PREFIX` is **not** configurable and must not become so — it
mirrors `defineIntent`'s own literal, which rejects the id wherever an app moved
its UI tools, so accepting one here would emit an entry the runtime refuses to
construct.

Consumers: core's Vite plugin runs the check once the manifest exists and
appends the diagnostics to the emitted surface; `dev:knowledge-check` maps the
code to the `agent-surface-tool-name-collision` warning and **excludes it from
the artifact-drift comparison**, which re-derives declarations from source and
has no manifest to produce one from; `smrt doctor` prints it under
`⚠️  Tool name also claimed`, separately from `Not statically emittable`.

The scanner mirrors the #2587 capability vocabulary structurally instead of
importing `@happyvertical/smrt-types`: core depends on this package, so the
reverse edge would close a cycle. Core reconciles the two shapes in exactly one
place, `toKnowledgeAgentSurface` in `vite-plugin/index.ts`.

## Discovery boundaries

- Set `dot: true` so ignore patterns also prune dependencies under hidden
  directories such as `.svelte-kit`.
- Union mandatory `**/node_modules/**`, `**/.*/**`, and `**/.*` prunes with
  caller exclusions; caller `exclude` replaces defaults, never mandatory prunes.
- `followSymbolicLinks` defaults to `false` to bound walks of pnpm's symlink
  graph. It excludes symlinked files as well as directories. Projects with
  linked sources can opt in through `smrtPlugin`/`ManifestBuilderOptions`.
- Rewrite patterns relative to `cwd` before globbing so hidden checkout
  ancestors do not exclude the entire project.

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
  diagnostics, `mergeAgentSurfaces` (#2591), and `checkAgentSurfaceToolNames`
  (#2725).
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
- **A parameter carries type PROVENANCE, a field does not.**
  `RawParameterDefinition.typeUnresolved` marks an annotation the scanner could
  not express (intersection, tuple, conditional, mapped, `typeof`, indexed
  access) — `type` still reads `'any'` for compatibility, so that flag is the
  only thing separating it from an authored `any`. `memberTypes` carries the
  members of an INLINE object literal, which `extractTypeName` otherwise
  flattens to `'object'`; NAMED bags stay unexpanded on purpose. Core's API
  wire-ability gate fails closed on both (#2686). The bare `object` keyword is
  resolved for parameters only — `ManifestAdapter.inferFromAnnotation` gives an
  `object`-typed FIELD a `{}` column default, so naming it in `extractTypeName`
  would silently change DDL.
- **`@method()` config is read with `requireLiteralValues`**, like `@smrt()`: an
  unresolvable value is a scan error, because a dropped `expose: false` restores
  the routing the author was withholding. `decoratorConfig` is `undefined` for
  an undecorated method and `{}` for a bare `@method()`; the two differ.
- **Relationship targets are resolved, not copied**: `@foreignKey`,
  `@oneToMany` and `@manyToMany` arguments arrive as raw source text.
  `'Target'`/`Target` pass through and a forward-reference thunk
  (`() => Target`, including the dotted `() => Target.column` form) is unwrapped
  to its target, matching the runtime decorator, which resolves the thunk by
  invoking it. Any other expression (a call, a computed reference) yields
  `related: undefined` — writing the raw source through produced a garbage FK
  table name and, once FK columns are indexed, a garbage index (#2379).
