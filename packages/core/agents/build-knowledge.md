# Decorators, build integration, and knowledge

Key options: `tableName`, `tableStrategy` ('cti'|'sti'), `conflictColumns`, `indexes` (declared multi-column indexes; see [schema-paths.md](schema-paths.md)), `api`/`mcp`/`cli` (generation config), `ai` (callable methods), `hooks` (beforeSave/afterSave/beforeDelete/afterDelete), `embeddings` (auto-generate), `tenantScoped`, `agent`, `ui` (`{ icon, label, description }` — nav/help hints round-tripped through the manifest as plain data; `description` is the object-level seed for form-level help, #2046).

Registration sets `SMRT_TABLE_NAME` static property (survives minification).

An explicit `@smrt({ collection: 'domain.records' })` names the route/permission
namespace independently of `tableName`, including standalone non-STI models.
Scanner output preserves it in both `collection` and `decoratorConfig.collection`.
Generated registration reads the merged declaration, so older manifests with a
derived top-level collection still agree with native decorators. Explicit runtime
registration options win; absent declarations retain manifest/STI/default naming.

## @field() UI hints (#2046)

`@field({ ui: { basic, group, order, locked } })` — a static, presentation-only
seed for the field-policy rail (epic #2045). Carried in the manifest under the
field's `_meta.ui` (never a top-level `FieldDefinition` key), readable at
runtime via `getAllFields()` at `field._meta.ui`, and emitted (sanitized) with
`description` into generated web-collection definitions and browser MCP tool
schemas. No schema/persistence/security effect — `sensitive`/`readPermission`
stay the security rail, and `sensitive`/`transient` fields never emit to the
client at all.

`ui.widget` (#3599) adds a presentation widget hint:
`'textarea' | 'currency' | 'email' | 'url' | 'phone'`. It rides the same
`_meta.ui` channel and is also emitted (sanitized) into web-collection
definitions. The manifest generator validates it against the field type and
fails the build otherwise: every widget needs a `text` field (`currency` is a
currency-CODE picker for an ISO 4217 string such as `currency = 'USD'`, not a
money amount; amounts are integer minor units and take no widget); an unknown
value or a non-text field is an error. `ui.widget` is a hint only — it never changes
the column type or validation.

## Presentation metadata (#3599)

Pure helpers live in `src/ui-metadata.ts`, published browser-safe as
`@happyvertical/smrt-core/ui-metadata` (also re-exported from the package
root). `ManifestGenerator.applyUiMetadata()` runs in `applyGenerationPasses`
after inheritance, so every producer (Vite plugin, `ManifestBuilder`,
`generateManifest`) validates the same way.

- **Display label.** `@smrt({ display: { label: '<field>' } })` names the own
  field generic pickers and assistants use to label a record. Own fields only —
  no paths into other packages; a model whose label lives elsewhere ships a
  selector. Undeclared, it defaults to the first of `name`, `title`, `label`,
  `code` that is a usable own field. Build fails when the declared field is
  missing, `sensitive`, `transient`, or a relationship/json field. The resolved
  field is emitted as `displayLabelField` on the manifest object and in the
  knowledge artifact, and generated MCP/WebMCP `list`/`get`/`update`/`delete`
  descriptions end with ``Records are identified by their `<field>` field.``
  (`describeAction` in `generators/tool-schema.ts`; nothing is added when the
  model has no label field).
- **Selector slots.** `ModuleUISlot.selects: '@scope/pkg:Model'`
  (`@happyvertical/smrt-types`) marks a package component as THE selector for a
  model. The scanner reads such slots statically from `src/**/ui.ts`
  (`parseUiSelectorsFile`, independent of the class glob) and the manifest
  carries them as `uiSelectors` keyed by slot id. `selects` must be a string
  literal; a duplicate slot id, two selectors for one model, or an own-package
  target that does not exist fails the build. Hosts call
  `findSelectorFor(manifests, qualifiedName)`; generic forms use the selector
  for any `@foreignKey`/`@crossPackageRef` field targeting that model and fall
  back to a generic picker labelled by `displayLabelField`. `display` is read
  per class: an STI subclass that declares none uses the default lookup rather
  than its base's declaration, and a CTI child cannot name a parent's field.

## Worker registration artifact (#3117)

With `svelteKit.enabled`, a production `vite build` compiles the generated
`smrt-register.ts` into `.smrt/runtime/register.js` after the server build
(`src/vite-plugin/worker-registration.ts`, called once from `closeBundle`).
adapter-node re-bundles the server from its own entries, so the web bundle is
never importable by a separate Node process; this artifact is how a deployed
task/schedule worker registers the app's local objects (and, through the
`.smrt/register.js` it imports, consumed packages' objects) with the same
qualified identities and isolated manifests as the web server. It is a nested
SSR build with no consumer plugins: only aliases pointing into the project
sources (e.g. `$lib`) apply, and every other bare import stays external so the
worker shares the installed `@happyvertical/smrt-core` registry. SvelteKit
virtual modules (`$env/*`, `$app/*`) are not available to a worker; an object
importing one fails at worker startup. A failure fails the build.

## Lightweight discovery

Filesystem-only discovery, module-doc parsing, and graph freshness are owned by
`@happyvertical/smrt-scanner/knowledge`. Core's knowledge exports remain compatible
reexports. Runtime manifest projection and custom-action semantics stay in core.

`src/knowledge-discovery.ts`, exported through `smrt-core/knowledge`, enumerates
installed scope directories and reads canonical AGENTS/legacy CLAUDE docs without
loading package code, artifacts, or scanning objects. CLI snapshots and MCP share
these primitives. Callers retain selection policy: snapshots resolve links and
fall back to `packages/*` only when no installed SMRT package loads; MCP preserves
node_modules paths, deduplicates realpaths, excludes authored workspace links,
and then enriches the selected packages. Workspace-root/glob discovery remains
owned by each consumer.

## Domain Knowledge Artifacts

`smrtPlugin()` writes runtime manifests and agent/developer knowledge artifacts:

- local dev/build: `.smrt/manifest.json` and `.smrt/smrt-knowledge.json`
- package build: `dist/manifest.json` and `dist/smrt-knowledge.json`

Keep `manifest.json` runtime-focused. `smrt-knowledge.json` is the deterministic
agent contract for downstream review and architecture tools.

The CLI's schema-command gate reads that same merged file: a pure-consumer
project (0 local objects) qualifies on the consumed packages its manifest
records, so a clobbered `objects` map is what made `smrt db:migrate` report
`missing_local_manifest` (#2925).

`.smrt/manifest.json` has two writers and neither owns all of it: `smrtPlugin()`
contributes the project's scanned objects and `smrtConsumer()` the consumed
packages' entries. Both writes are merge-preserving, keyed on each entry's
recorded `packageName` — a plain overwrite in either direction silently drops
the other's objects, and the last pass of a multi-environment build is not
reliably the aggregating one (#1760, #2925). `dist/manifest.json` stays
local-only: a published package must not carry its dependencies' objects.

The schema-version-1 object projection is additive and high-signal: it retains
normalized tenant mode/field, explicit `cti`/`sti` strategy, conflict columns,
method signatures, and field defaults/constraints/readonly/transient flags.
Sensitive fields are removed before both `fields` and `relationships` are
derived, including legacy flags stored under `_meta`; matching field and
snake-case column names are also removed from projected conflict columns, and a
sensitive custom tenant field is omitted while retaining scope and mode.
Generated artifacts assert this boundary with `sensitiveFieldsExcluded: true`;
the optional marker keeps schema version 1 additive while letting readers
identify older artifacts that require raw-manifest corroboration.

Config precedence for knowledge is defaults → top-level `knowledge` in
`smrt.config.ts` → `packages[packageName].knowledge` → plugin option →
object-level `@smrt({ knowledge })`.

Test generation uses that same effective configuration and publishes knowledge
matching the manifest it generated. Disabling knowledge removes a previous local
knowledge artifact, so consumers cannot mistake it for current enabled output.
`new ManifestBuilder(projectRoot)` keeps discovery, package identity, and output
at that explicit root, including installed providers and external base classes;
omitting the argument retains the current-working-directory
behavior. Both manifest writers retain declared package dependencies when merging
their local and consumed-object projections.

Test manifests carry optional `artifactPurpose: 'test'`; dependency discovery
skips those artifacts, including `.smrt` fallbacks. Unmarked runtime manifests,
empty published providers, and source-only development providers remain eligible.
`ManifestBuilder` accepts explicit `outputMode: 'dev' | 'build'`; omitted mode
retains legacy filename inference. Vitest selects dev mode explicitly, so tests
never replace a production `dist/manifest.json`. Relative output directories are
resolved against the builder's project root.

With `svelteKit.enabled`, `smrtPlugin()`'s transform prepends
`import './smrt-register.js';` to the configured config module
(`<configPath>/<configFileName>`, `src/vite-plugin/sveltekit-register-injection.ts`)
once the register module exists, on the same first line so line numbers hold.
Apps therefore never hand-write the guarded registration import (#3416); a
config module that still has it imports the same module twice, harmlessly.

Tracked `src/lib/server/smrt-register.ts` belongs to SvelteKit config/type
generation. Generic library builds consume it but do not cache or restore it
as an output; otherwise a concurrent config producer's bytes can be replayed
over a newer registration after dependency eligibility changes.

Object-level `knowledge: false` excludes an object from authored context only;
it must not change runtime manifest registration. Use
`knowledge: { tags, summary, risks }` for review-sensitive domain objects.

HTTP knowledge routes are disabled by default. If `knowledge.api.enabled` is
true, generated SvelteKit routes must stay GET-only and guarded by dev mode or
admin auth.


## Vite Plugin

`src/vite-preset/` (`@happyvertical/smrt-core/vite`, `smrt()`) composes the Oxc
decorator block, `smrtConsumer`, then `smrtPlugin` with the template path
conventions. Its package list comes only from the `smrt({ packages })` option, or
`smrt.config` `consumer.packages` (smrt-config schema); it never sniffs
`package.json`, and a missing or malformed list throws. Keep its output
byte-identical to the two-plugin form (`src/vite-preset/index.test.ts`). It
also dedupes `@sveltejs/kit` (`smrt:shared-runtime`): SvelteKit matches
`redirect()`/`fail()` by class, and a linked/workspace SMRT SvelteKit entry
would otherwise import its own copy and turn redirects into 500s.

```typescript
// vite.config.ts — required for @smrt() decorators (Vite 8+, oxc transform)
export default defineConfig({
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
});
```

Under Vite 8 the oxc transform does not honor the pre-Vite-8 `esbuild.tsconfigRaw`
recipe (or tsconfig `experimentalDecorators` reached through SvelteKit's
`extends "./.svelte-kit/tsconfig.json"` chain), so that recipe throws
`SyntaxError: Invalid or unexpected token` on the first SSR request. Configure
decorators through `oxc.decorator` instead. Consumers still pinned on vite<8 need
the legacy `esbuild.tsconfigRaw` form with `experimentalDecorators: true,
emitDecoratorMetadata: true`.

For independent CI invocations, both `smrtPlugin()` and `smrtConsumer()` accept
the same `generationSnapshot: { path, sha256, provenance, sourceRoot }`. The
schema-v1 snapshot produced by `serializeSmrtGenerationSnapshot()` contains the
merged project/dependency manifest, portable source paths, and source-file
digests; each plugin selects its own view. Reuse mode fails closed on
byte/provenance/path/content drift, skips scans and manifest writes, and still
generates routes, types, registration, and virtual modules. Omit it for normal
local development and watch mode.

## Clean consumer type checks (TypeScript 6)

The consumer config hook writes `.smrt/register.js` alongside generated types
after route preflight succeeds. Generated SvelteKit registration imports that
module, so it must exist during `svelte-kit sync`, before Vite's `buildStart`.
Both hosted routes and the legacy `svelteKit: true` mode follow this order.
The clean-consumer regression fixture ships real provider declarations and
checks the generated imports with `svelte-check`.
Core's `generate:test` task depends on its own `build`: both publish the local
`.smrt` manifest/knowledge pair, so Turbo must serialize production before test
generation instead of caching an interleaved pair.

## Model descriptions

Each manifest object and knowledge `objects[]` entry may carry a user-facing
`description` (for the planner Features tab and similar). The scanner
(`extractClassJsDocDescription` in `packages/scanner/src/oxc-parser.ts`) reads it
from the parsed source, in priority order: explicit `@smrt({ description })`,
else the first paragraph of the class JSDoc (the JSDoc may sit above `export`
and decorators), minus a leading `ClassName - ` / `ClassName: `, tags
(`{@link}`, backticks, HTML) and later paragraphs, capped at 200 chars on a
sentence boundary. `@internal` classes and classes without docs emit no key. It
is not inherited from a parent class. Generated MCP tool descriptions are
unchanged (they stay generic).
