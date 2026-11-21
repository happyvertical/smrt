# Decorators, build integration, and knowledge

The public `smrt({ generationSnapshot })` preset passes the same verified snapshot
to consumer and producer plugins. Dependency views retain app replacements for
dependency models alongside original ancestors, preserving inherited fields,
restrictions and independent hosted STI routes. The public consumer-plugin
`separateHostedStiCollections` normalizes the merged manifest before serialization;
genuine collection namespace collisions still fail.

Key options: `tableName`, `tableStrategy` ('cti'|'sti'), `conflictColumns`, `indexes` (declared multi-column indexes; see [schema-paths.md](schema-paths.md)), `api`/`mcp`/`cli` (generation config), `ai` (callable methods), `hooks` (beforeSave/afterSave/beforeDelete/afterDelete), `embeddings` (auto-generate), `tenantScoped`, `agent`, `ui` (`{ icon, label, description }` — nav/help hints round-tripped through the manifest as plain data; `description` is the object-level seed for form-level help, #2046).

Registration sets `SMRT_TABLE_NAME` static property (survives minification).

An explicit `@smrt({ collection: 'domain.records' })` names the route/permission
namespace independently of `tableName`, including standalone non-STI models.
Scanner output preserves it in both `collection` and `decoratorConfig.collection`.
Generated registration reads the merged declaration, so older manifests with a
derived top-level collection still agree with native decorators. Explicit runtime
registration options win; absent declarations retain manifest/STI/default naming.

## What a manifest build reads, and when it fails

Decorator configuration reaches the manifest in full or the build fails. The
scanner reads `@smrt`, `@TenantScoped`, `@report`, `@method`, field decorator
options and the agent static properties statically: literals, same-file
module `const`s, same-file enum members and constant folding. A value it
cannot read (an imported constant, a call, a `let`) is an error-severity scan
diagnostic naming the file, class and option, and both producers
(`smrtPlugin`, `ManifestBuilder`) abort on it. It is never recorded as an
empty config or as the identifier's name. Two model classes of one name in a
package fail the same way. The full table of forms, the constant and mutation
rules, relationship targets and runtime-only options (`validate` callbacks)
are in the scanner's
[static-config.md](../../scanner/agents/static-config.md).

Write decorator config so the scanner can read it:

```typescript
const INTERNAL = { api: false, mcp: false, cli: false } as const; // same file
const MAX_KEY_LENGTH = 64;

@smrt({ tableName: 'vault_keys', ...INTERNAL }) // or @smrt(SOME_CONST)
class VaultKey extends SmrtObject {
  @field({ sensitive: true, maxLength: MAX_KEY_LENGTH })
  secret = '';
}
```

A value imported from another module must be inlined; imports are not
followed.

**Imported parents.** A class whose `extends` is imported from another scoped
package carries that package's identity (`extendsQualified`, #4145) and the
full specifier it is imported from (`extendsImportPath`); the scanner accepts
no alias, barrel or undeclared package (see
[static-config.md](../../scanner/agents/static-config.md)), so a
qualification here always names a declared package's export.
`verifyImportedParents` (`confirmPackageExport`) confirms it before any pass
walks parents: the package's manifest must declare the class under that
qualified name, AND record it at exactly that entry (`importPath`, stamped by
`resolveImportPaths`). Another entry of a package can export a different
class under the same name, so a provider manifest without `importPath`, a
manifest being generated without the specifier, another entry, a package that
only re-exports the class, a package installed without a manifest, or an
`extendsQualified` that is not a qualified name all throw
`CONFIG_UNRESOLVED_IMPORTED_PARENT`, even if this package or a dependency
declares a class of that name. A collection item imported from a package
(`extendsTypeArgQualified`, `extendsTypeArgImportPath`) is confirmed the same
way and `findItemClass` takes it by identity only. A confirmed parent is the
parent for every later pass, including exposure inheritance and the widening
check: `findParentModel` resolves the qualified name, and skips framework base
names only for an unqualified parent (a qualified `SmrtReport` is a package's
model). An ancestor reached through a provider parent is resolved in the
provider's package (`parentRef(obj, manifest)` qualifies its bare `extends`),
so the child's single-table root, table and fields are the provider's, never
an app class of the root's name. A single-table child also receives its
confirmed ancestors' manifest static metadata (`staticProperties`), nearest
first, its own last.

**Package targets.** Right after inheritance, `confirmPackageTargets` confirms
every relationship target (`relatedQualified` + `relatedImportPath`) and report
source (`sourceQualified` + `sourceImportPath`) the same way, inherited fields
included: a field a provider parent contributes that names one of the
provider's own models is given that identity. `related` / `source` become the
declaring class; a column written after the class name (`'Room.code'`) stays,
so the constraint references that column. A confirmed target is pinned to one
declaration, so another class of its simple name (smrt-ledgers and
smrt-messages both declare `Account`) does not make it ambiguous. A report
source or join source written as a bare name is left as written and not
checked, as the base does (an imported one is confirmed by identity above).
A relationship target written as a bare name names a model of the manifest being
built, by its exact class name (`localBareTarget`): the referring class's own
package's model of that name, else the only one. A dependency's model and a
model whose name differs only in letter case are never it: `assertKnownTargets`
throws `CONFIG_UNKNOWN_RELATIONSHIP_TARGET` naming them (a dependency's with its
recorded entry and export name) and pointing to a qualified
`@crossPackageRef` or an imported class; two local exact matches throw
`CONFIG_AMBIGUOUS_RELATIONSHIP_TARGET`. In the generation passes schema
generation takes a bare foreign key's table from the same rule and from
nothing else; only a direct caller of the public `generateSchemas()` keeps the
legacy lookup by name. Foreign-key reconciliation takes a confirmed target's
schema by identity (`qualifiedTargetSchema`), so the constraint keeps the
provider's table, key column and declared `onDelete` (adding it to a deployed
database: [upgrading](../../scanner/agents/static-config.md#upgrading-foreign-keys-to-another-packages-model),
which lists the orphan-row check per constraint). A confirmed target whose
provider manifest records no schema, or not the column the constraint would
reference (the written one, else the primary-key column, else `id`), throws
`CONFIG_UNKNOWN_RELATIONSHIP_TARGET` rather than drop the constraint or emit
one the database refuses (unless the field sets `constraint: false`).
`confirmPackageExport` accepts only an entry declared under exactly the
imported name (class, export or public name), for parents, collection items
and targets alike, and a confirmed parent or item is rewritten to the
identity the provider's manifest keys it by (`InvoiceRecord` exported under
`@smrt({ name: 'Invoice' })` becomes `@pkg:Invoice`); `lookupInManifest`
matches a class name exactly first, and in another case only when no other
class shares it. Web generation takes a collection's item by
`extendsTypeArgQualified` when present. `verifyProviderCopies` walks each
confirmed provider chain to its end: an ancestor, or a `@foreignKey` with a
constraint, that the provider passes on from a third package must come from
the copy of that package the provider loads (two directories with the same
name, version and shipped manifest are one copy), or generation throws
(`CONFIG_UNRESOLVED_IMPORTED_PARENT` / `CONFIG_UNKNOWN_RELATIONSHIP_TARGET`).
A class directly extends a framework collection base only by identity (the
bare name, no `extendsQualified`): a qualified parent named `SmrtCollection`
(from a provider manifest built before the scanner reserved the framework
base names) is a model, and its children inherit its exposure. Generation
refuses an entry published under a framework base name
(`CONFIG_RESERVED_CLASS_NAME`). The route, web, consumer, knowledge and
permission-catalog readers, and `smrt generate-register` (by the same rule
over the public `isSmrtCollectionExtendsName`), classify a manifest entry as a collection by the
same identity (`hasCollectionMarker` in `registry/collection-bases.ts`):
`SmrtCollection` as the bare parent, another framework collection base with
a type argument, or a recorded `collectionOf`, reached through the manifest
ancestry; a type argument beside any other parent (`Ledger extends
RecordBase<Currency>`) marks no collection. The permission catalog reads a
confirmed item through `extendsTypeArgQualified` before the bare name.
A target written as a qualified name (`'@pkg:Class'`) must name, by its
exact class name, a class of the manifest or of that package's loadable
manifest, and a bare name a local model (above), or generation throws
`CONFIG_UNKNOWN_RELATIONSHIP_TARGET` (`assertKnownTargets`; `@crossPackageRef`
is checked at save time). A written qualified target keeps the base schema
generation: a class of the manifest gets its constraint, another package's
class none. Generating without a parent would give a
single-table child its own table and skip the fields and surface limits it
inherits. Build the parent package first and declare it as a dependency.

**Resolution root.** Dependency manifests are resolved from the project being
built, not from `process.cwd()`: `applyGenerationPasses(manifest, {
projectRoot })` loads each dependency, once per run, from the manifest
package discovery selected for that root, else from the package's
`./manifest` export as seen from the root, else from the conventional
locations the consumer plugin reads (`conventionalManifestCandidates`:
`dist/manifest.json`, then `manifest.json`). Both producers pass their root; a
new producer must too. `loadExternalManifestSync(name, { baseDir })` is the
root-anchored form of the loader: it neither reads nor writes the
process-wide cache, and keeps its own cache keyed by root and package, so a
build for another project never changes what this process's default-root
lookups return. Every `applyGenerationPasses` run is scoped to a root: the explicit
`projectRoot`, else the working directory. Generation reads dependency manifests uncached
(`loadManifestFromPathSync(path, { cache: false })`,
`loadExternalManifestSync(name, { baseDir, cache: false })`) and holds them
for one run only, so a rebuild in the same process (a dev server) reads a
provider that changed between builds.
The runtime loader stays anchored to the app process's working directory and
to the `./manifest` export.

A confirmed parent is then loaded from its own package by every pass
(`parentPackages`), whether or not that package is in `smrtDependencies`: the
list comes from package discovery, and an app can extend a class of a package
it names only in its consumer configuration.

**Scan scope.** The shared package build excludes `**/__tests__/**` from the
production scan. A test manifest scans tests too, so a fixture that stands in
for another package under a package model's class name must be excluded from
that scan (`smrtVitestPlugin({ exclude })`).

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

`ui.format` (#3718) says how a value is presented: `money` (an `integer` of
minor units — the amount hint record pages format and total), `date` (a
business date on a `datetime`, shown without a time), `datetime`, `percent`
(a rate on a `decimal`/`integer`). Same channel, same emission, same build-time
check against the field type. `@foreignKey(Target, { role: 'items' })` (or on
`@crossPackageRef`) marks the declaring model as the target's line items; the
scanner keeps it at `_meta.role`, the build rejects it on a non-reference or
an unknown value, and the generated web relationship edge carries
`role: 'items'` (edges without a role stay byte-stable). Both are hints: no
schema, persistence or security effect.

## Presentation metadata (#3599)

Pure helpers live in `src/ui-metadata.ts`, published browser-safe as
`@happyvertical/smrt-core/ui-metadata` (also re-exported from the package
root). `ManifestGenerator.applyUiMetadata()` runs in `applyGenerationPasses`
after inheritance, so every producer (Vite plugin, `ManifestBuilder`,
`generateManifest`) validates the same way.

- **Display label.** `@smrt({ display: { label: '<field>' } })` names the own
  field generic pickers and assistants use to label a record. A linked name
  uses `label: { via: 'profileId', field: 'name', fallback: 'Unnamed customer' }`
  through one declared reference; see [collection reads](collection-reads.md#linked-display-names).
  Undeclared, it defaults to the first of `name`, `title`, `label`,
  `code` that is a usable own field. Build fails when the declared field is
  missing, `sensitive`, `transient`, or a relationship/json field. The resolved
  field is emitted as `displayLabelField` on the manifest object, on generated
  web collection definitions (for record names and paged pickers), and in the
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
  per class (same-name app replacements inherit it): an STI subclass that declares none uses the default lookup rather
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
sources (e.g. `$lib`) apply, and bare imports stay external so the worker
shares the installed `@happyvertical/smrt-core` registry. The sole exception is
`@oxc-project/runtime` and its helper subpaths: Vite injects them when lowering
decorators, but applications do not declare that compiler support dependency,
so the artifact bundles them. SvelteKit
virtual modules (`$env/*`, `$app/*`) are not available to a worker; an object
importing one fails at worker startup. A failure fails the build.

**Register imports stay Node-loadable (#4219).** `.smrt/register.js`
(`generateRegistrationFile` in `src/consumer-plugin/index.ts`) is evaluated by
plain Node — `smrt db:migrate`, every CLI, and the worker artifact above — as
well as by Vite SSR, so it may only import modules Node can load. Each object
is imported from its manifest `importPath` (the scanner's export-subpath match,
e.g. `@happyvertical/smrt-products/models`). Each configured provider in
`smrtDependencies` is also imported once so it is evaluated in Node's installed
package context (#4187): the package root, unless the package declares that
root as a Svelte entry (`isComponentBearingRoot`: a `svelte` field, or a `.`
export with a `svelte` condition or a `.svelte`/`.css` target — e.g.
`@happyvertical/smrt-products`, whose root re-exports its components and so
reaches `@happyvertical/smrt-ui`'s `.svelte` files). Such a root is never
imported and no subpath is substituted for it (`resolveProviderContextImport`
returns `undefined`): its already-imported object entries establish the
context, a provider contributing only nested objects needs none because the
transitive loader uses only `import.meta.resolve(provider)`, and a substitute
`./models` whose JS reached `.svelte` would re-create the failure. A package that publishes Svelte
only under subpaths keeps its root import; the broader `isComponentBearingPackage`
test (any Svelte export) only selects `ssr.noExternal` packages. A `svelte`
condition counts even with a plain `.js` target — that is what svelte-package
and Vite library builds emit for a root that re-exports components, and every
Svelte root in this workspace (`smrt-products`, `smrt-ui`, `smrt-svelte`,
`smrt-planner`) has that shape and fails under plain Node; a Node-safe root
that declares `svelte` anyway only loses an optional context import.
Transitive-only object modules are loaded through `importSmrtDependency()`
from their provider's context, which needs no root import.

**TypeScript-source providers are Vite-only (#3092).** A workspace package
linked into the consumer may export TypeScript source (`"import":
"./src/index.ts"`). Plain Node cannot evaluate it as a provider (no `./x.js` →
`./x.ts` rewriting, no type stripping under `node_modules`, no decorator
stripping), so any register import whose target resolves to `.ts`/`.mts`/
`.cts`/`.tsx` (`resolvesToTypeScriptSource`, ESM `import` conditions from the
consumer, or from the provider for transitive modules) is emitted as
`SMRT_VITE_RUNTIME ? await import(...) : {}` with `SMRT_VITE_RUNTIME =
Boolean(import.meta.env)`, and its export/collection consistency throws are
gated the same way. Vite SSR therefore registers those constructors exactly as
before, while `smrt db:migrate` and CLIs load the register, warn once on
stderr, and rely on `.smrt/manifest.json` for those objects. Generation warns
too. Not covered: the compiled worker artifact (`.smrt/runtime/register.js`) is
a Vite build, so `import.meta.env` is constant there and the externalized
TypeScript import still fails when a plain-Node worker starts. Publish a
compiled JS export to register such objects outside Vite.
Regression: the `#3092` tests in `index.test.ts` (plain-Node and real Vite
`ssrLoadModule` loads of one generated register, and the transitive gating).

Selective SSR compilation compares a JavaScript barrel's `svelte` export target
against the package instance visible from its actual importer. pnpm may install
the same version in multiple peer contexts; the app-root package directory is
not the identity of a transitive import. Read that importer's installed export
map and root together, preserving exact target matching. Plain server entries
remain external; do not fix peer-context resolution by deduplicating app
packages or bundling every server export (#4318).

The same server/component split applies to consumer development SSR (#4475).
Vite's dev import analysis ignores a resolver's `external` flag, so broad
`noExternal` alone creates another module instance even when native Node and
Vite resolve the identical file. That duplicates module-local enablement and
interceptors while an AsyncLocalStorage singleton can still appear shared.
The consumer resolver records only exact server entry files selected through
the importer's installed export map. Its dev SSR environment `fetchModule`
transport returns those files as native external modules; component barrels,
Svelte and CSS continue through Vite. Production keeps bare external imports.
`vite-plugin/native-ssr.ts` owns this shared exact-entry boundary: one transport
interceptor per SSR environment composes the consumer and preset registrations
and delegates unknown modules to the original bound transport. Canonical
filenames stay separate from aliases, so repeated server setup cannot strip
the root from an alias again and capture an unrelated module. The preset also
uses it for the exact `smrt-app-runtime` root in dev. Its Kit-facing `/sveltekit`
wrapper compiles against the app's deduped Kit in both modes, while the native
root and `/sveltekit-runtime` backend stay in Node. Different pnpm Kit peer
contexts must not turn owner setup's committed 303 redirect into a 500.
The shared-runtime config hook runs last and removes only the literal runtime
root from the merged `ssr.external` list. Svelte's dependency crawler otherwise
adds that root for component-package dependencies, overriding the wrapper's
`noExternal` exception. Other externals and explicit subpaths remain unchanged.
`ssr.external: true` cannot express this split and fails with a remedy: use an
explicit package list; the preset keeps the exact native entries external.
Never externalize the complete component-bearing package or switch its mutable
runtime flags to globals to mask duplicate execution. The real `createServer` /
`ssrLoadModule` regression in `selective-ssr-dev.test.ts` initializes native
server state and verifies root/subpath reads plus direct and transitive peer
Svelte/CSS compilation in one dev request.
The app-runtime `sveltekit-production.test.ts` fixture explicitly separates the
app/runtime Kit peers, declares a Svelte host depending on the runtime to trigger
the real dependency crawler, and proves the final root exclusion plus development
GET/POST redirects and action failures before its adapter-node production checks.

Not covered by contract: a package whose root is a Svelte entry AND whose
`@smrt()` objects are exported only from that root. The object loop must then
import the root (it is the only module exporting the constructors) — statically
when the app resolves the package, or through `importSmrtDependency()` when it
is reached only through its provider — so Vite SSR works but plain Node can
load the register only if that root happens to be Node-safe. Generation keeps
the import and warns once per package (`declares a Svelte root entry`), asking
to verify the root under plain Node or publish the objects from `./models` or
`./objects`. The declaration is a heuristic: a Node-safe root that declares
`svelte` only by convention gets the same warning (a false positive, harmless —
the import is kept) and, when its objects come from subpaths, loses only its
optional provider-context import. Regression: the `#4219` tests in
`index.test.ts` (unit cases for `isComponentBearingRoot` /
`resolveProviderContextImport`, a child-Node load of the generated register,
the nested-only provider that gets no import, and the root-only and transitive
warnings).

**Gate: `pnpm check:node-roots`** (root script; run after `pnpm build`). It
runs `scripts/survey-node-root-load.mjs --strict --allow=<packages>`, which
spawns `node --input-type=module -e "await import('<name>')"` from every
built workspace package whose manifest declares `@smrt()` objects and fails on
any root plain Node cannot evaluate that is not allow-listed. The allow-list
is explicit and lives in the root `package.json` script: currently only
`@happyvertical/smrt-products`, whose root re-exports its Svelte components by
documented contract. A new entry needs the same justification; a model root
that merely starts importing `@happyvertical/smrt-ui` must be fixed, not
allowed. `--strict` also fails when nothing was surveyed (run before
`pnpm build`) and when an allow-listed package was not surveyed or now loads,
so the list cannot go stale. `--all` surveys every published package,
including those without objects, as a report.

CI runs the gate in both Knowledge Freshness jobs of
`.github/workflows/test-suite.yml`. In full mode (the merge queue, and every PR
while `vars.CI_MERGE_QUEUE_ENABLED` is not `true`) it always runs. In affected
mode it runs only when the `knowledge` paths filter matches, which covers
`package.json` files and docs but not `packages/*/src/**`; a same-repo PR that
makes a model root import smrt-ui only through source is therefore first
caught in the merge queue, which still blocks the merge. The filter is not
widened for this, because that would run the knowledge job on every PR. Run
`pnpm check:node-roots` locally when changing a model package's root imports.

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
Core's canonical generator excludes temporary `__test-*` source roots as well
as test files and `__tests__`; prepack verifies fresh and reused manifests
contain no test-artifact marker or fixture source provenance (#4190).

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

Test generation writes no knowledge and never touches the production pair:
`smrtVitestPlugin()` writes a per-run snapshot, and core's own `generate:test`
writes only `src/manifest/test-manifest.json` (`outputMode: 'explicit'`; its
Turbo outputs exclude `.smrt/`). Disabling knowledge in a production build
removes a previous local knowledge artifact, so consumers cannot mistake it for
current enabled output.
Installed-package discovery (`manifest/discover-smrt-packages.ts`) caches its
answer in `.smrt/discovery-cache.json`, keyed on the nearest lockfile at or
above the project (a workspace app has none of its own), the project's
`package.json`, each selected manifest, and a stat signature (mtime, ctime,
size, device and inode) of the manifest candidates of every installed
directory of a dependency that had no manifest yet, together with where that
name resolves now (a repointed workspace link invalidates it); selected
providers' manifests and package.json use the same full stat marker, so building
a linked workspace package invalidates the cache in this process and the
next. A discovery that throws is never cached. Repeat calls in one process
reuse the answer while a stat-only fingerprint of those inputs holds, without
re-reading or re-hashing the lockfile (module-private, no new export).
`new ManifestBuilder(projectRoot)` keeps discovery, package identity, and output
at that explicit root, including installed providers and external base classes;
omitting the argument retains the current-working-directory
behavior. Both manifest writers retain declared package dependencies when merging
their local and consumed-object projections. A consumed package's entry carried
forward from the previous `.smrt/manifest.json` is kept only while its provider
is installed (nearest `node_modules` at or above the project), its installed
manifest declares it, and the installed version is the one it records
(`retainInstalledCarriedEntries`, `manifest/installed-package-manifest.ts`,
#5035). When the consumer's write has just aggregated a provider, that
provider's declarations decide alone, including an empty set and an
executable-only (`static-manifest.js`) provider whose manifest the JSON check
cannot read; that module is imported at its current file revision, so a
provider rebuilt in place between two builds in one process is re-read; otherwise a model removed from a consumed package stays in the file
schema commands read.

Test manifests carry `artifactPurpose: 'test'` and are valid only as the active
test manifest of the run that registered them. Every other reader refuses them
(`isRefusedTestArtifact`, #2760): `LocalManifestReader`, the runtime loader's
local, workspace-source, external and explicit-path loads, dependency
discovery (including `.smrt` fallbacks), CLI project/package discovery (the
`db:*` schema gate), CLI data portability, and smrt-dev-mcp's runtime boot and
knowledge reads. A test manifest left at `.smrt/manifest.json` by an older
runner therefore fails closed (`missing_local_manifest`) instead of surfacing
inline fixtures as phantom objects; regression
`packages/vitest/src/__tests__/issue-2760-test-then-cli-parity.test.ts`. Unmarked runtime manifests,
empty published providers, and source-only development providers remain eligible.
`ManifestBuilder` accepts explicit `outputMode: 'dev' | 'build' | 'explicit'`;
omitted mode retains legacy filename inference. `'explicit'` writes only
`outputDir/outputName`, never the unified `.smrt`/`dist` location. Vitest uses
it for its per-run snapshot `.smrt/test-runs/<run>/manifest.json`, published
per root in `__SMRT_TEST_MANIFEST_PATHS__` (`manifest/test-artifacts.ts`).
`LocalManifestReader.loadLocal()` (and so the runtime loader and manifest test
databases) reads that active snapshot before `.smrt/manifest.json` for the
registered root only; `loadForExternalPackage()` never reads it, and a process
outside the run never sees it (#4128). Core's own Vitest config registers `src/manifest/test-manifest.json`
the same way. Relative output directories are resolved against the builder's
project root.

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

Every generated file gated on a consumer dependency (`_resources` →
`@happyvertical/smrt-users/sveltekit`, application-runtime config →
`@happyvertical/smrt-app-runtime/sveltekit`, `_dev` →
`@happyvertical/smrt-dev-mcp/dev-plane`) detects it through
`consumerResolvesImport` (`src/vite-plugin/consumer-import.ts`, #3913): ESM
import conditions anchored to the consumer package URL, using
`import-meta-resolve`. A `types`/`import`-only export is valid; a CommonJS
`createRequire.resolve` probe would falsely skip it, so new gated routes use
the shared resolver. `generated-route-dependencies-packed-consumer.test.ts`
proves all three against a real packed Core tarball plus minimal packages
carrying the dependencies' real published export maps (direct, hoisted,
absent); it does not exercise those packages' runtime graphs.
Verify the selected target is an existing file because import-meta resolution
can return URLs for missing files/directories. Missing/unexported dependencies
remain skipped, ancestor-hoisted installs resolve normally, and handwritten
`+server.ts`/`+server.js` ownership and explicit disablement remain unchanged.
Do not change a package's export map to accommodate a mismatched detector.

Dev-server rescans (`smrtPlugin` `watch`/`hmr`): Vite's watcher reports
absolute paths, so `shouldRescan` matches the project-relative POSIX path
against `include`/`exclude` (an absolute pattern under the root is made
relative). It ignores the plugin's own outputs (`+server.*` under `routesDir`,
`smrt-register.ts`, `virtual-modules.d.ts`, the knowledge route
(`knowledgeRoutePath` as the last generation resolved it, outside `routesDir`;
the watcher never evaluates the project config itself), any file whose source
the generated-route predicate accepts (`isGeneratedRouteSource`)), or each
regeneration would trigger the next. After a rescan, change,
add and unlink alike invalidate every loaded virtual module by its resolved
`\0smrt:*` id in each Vite environment's module graph and send that
environment's hot channel a full reload; `server.reloadModule` cannot be used
because it skips modules without a file. `watcher-dev-server.test.ts` drives a
real Vite dev server; a handler test with a relative path cannot see either
defect. Rescans are serialized: one runs and at most one waits; events that
arrive meanwhile join the waiting one, which scans the latest sources once the
running one finishes, so an older scan never publishes over a newer one.

Route generation validates every object's routes
(`assertSvelteKitObjectRoutesValid`, `vite-plugin/generated-route-preflight.ts`:
the generator's own claim pass per object) before `generateSvelteKitRoutes()`
sweeps the route tree, on the producer's direct path and the coordinator path
alike, so a duplicate or mixed-host custom route fails with the previous
routes still on disk. It checks only what rendering already enforced: two
claims on one handler file (`Conflicting SvelteKit route`, within an object or
across objects) stay a hosted-consumer (`rejectRouteCollisions`) rule, so a
producer-only app still generates STI siblings that share a collection or a
static action whose path is `[id]` beside CRUD, exactly as before. A model
route at the sync-apply path (a `sync` collection with an `apply` action, when
a syncable model generates `sync/apply`) fails during rendering, below.

Route generation never replaces or shadows an application route file (#5437,
`vite-plugin/generated-route-files.ts`). A route file is generated only when
it is a regular `+server.ts` at the unresolved path whose first bytes, after
at most one byte-order mark, are the route header (`isGeneratedRouteFile`);
any `+server.js` and any other `+server.ts` (hand-written, empty, unreadable,
symlinked, or a directory) is application code. Every reader of the header
(the sweep, the knowledge clear, `findGeneratedRouteFiles`, the `_resources`
reservation, `sync/apply`, the watcher fallback) uses this predicate.
`generateSvelteKitRoutes()` renders every route writer (CRUD, custom actions,
knowledge, `sync/apply`, `_changes`, `_events`, `_dev`, `_resources`) into an
in-memory `RouteFilePlan` (writers import no mutating `node:fs` call; a source
guard enforces it), then runs a read-only preflight over every lexical spelling
of every planned path. A conflict throws `ApplicationRouteConflictError`
(`code: 'SMRT_ROUTE_OWNERSHIP_CONFLICT'`, `phase: 'preflight'`, `files`,
`routes`; not a package export) naming every conflict before `beforeCleanup`,
the sweep, the config and registration writes, any route file, `.gitignore` or
any directory creation. The preflight walks each existing path component from
the routes root (for a knowledge `basePath` that climbs out with `..`, from
the deepest directory the root and the destination share): a symlinked
component whose target is missing, a non-directory component, or one that
cannot be inspected refuses; only a genuinely missing component counts as
absent. Every directory the sweep will walk must be listable, or the
preflight refuses. Case behaviour is probed read-only inside the nearest
existing directory of the destination (`destinationCaseBehaviour`): on a
case-insensitive volume, planned paths that differ only by case are one path;
when it cannot be determined (nothing to probe), case-only claims refuse. The
hosted claim pass and the plan use the same key (`physicalRouteFileKey`). The
knowledge clear skips a path another producer in the build owns
(`protectedRoutePaths`), compared the way emission compares it. The sweep and the commit re-run
the predicate immediately before each unlink or replacement; the commit
creates an absent leaf with an exclusive open and stops with `phase: 'commit'`
(listing the files already written) instead of overwriting an application
file found there. `_resources` and `sync/apply` yield (leave an application
`+server.ts`/`+server.js` in place and write nothing) only as the sole
claimant of their path, and name the application file they keep; a yield
route refuses when the occupying `+server.ts` carries the header after its
first line terminator (LF, CR, U+2028 or U+2029), is empty, or holds only
part of the header (an interrupted
generated write). A header mention on the first line of a hand-written
handler still yields. `_resources` is a fallback, emitted
only when no other route claims its path. A `refuse` and a `yield` emit on one
path, or an emit to a coordinator `protectedRoutePaths` entry, throw
`Conflicting SvelteKit route` during rendering; two `refuse` emits keep the
later one. A `configFileName` whose resolved name (after dot segments)
starts with `+` is rejected. `smrt generate`
keeps the refusal as `cause` and copies its `code`.
Scope: `+server.ts`/`+server.js` files under the routes root and at the
knowledge route path that exist when the invocation starts. The guarantee
constrains the route writers, the commit and the sweeps only: the plugin's
other outputs (registration module, declarations, build-schema module,
`.gitignore`, config file, artifact staging) keep their own writers, so such an
output aliased to an existing application handler (for example a symlinked
`smrt-register.ts`) can still overwrite it (#5469). A refusal leaves that
invocation's outputs untouched; on a coordinated hosting move the new root is
committed before the former root is reconciled, so a nested refusal fails the
build after the new root changed. Concurrent generation, editor races and
hard links are #5460. An interrupted write is replaced next run only if its
complete header survived; an empty or partial-header file refuses until the
operator removes or restores it. Dev publication order is unchanged: a refused
rescan may already have published the scan's declarations, manifest and
knowledge.

The generated API client (`generateClientModule`, behind both
`@happyvertical/smrt-virt-client` and `@smrt/client`) sends every
caller-supplied path value (an item `id`, a named route parameter) as exactly
one `encodeURIComponent` segment (`__smrtPathSegment`). An empty, `.` or `..`
value cannot be one segment, and a lone UTF-16 surrogate cannot be encoded, so
its request promise rejects (nothing is sent) instead of the request resolving
onto another route. Every fetcher is `async`, so any bad argument (a missing
named route parameter, or one that cannot be encoded, which rejects with its
`URIError`) rejects like a failed request. A named route parameter is read
once and only as the caller's own property; an inherited one (`toString`) is
missing. Static collection and route segments are emitted as JSON string
literals.

`list(params)` writes the one query grammar both list routes read
(`parseRestListWhere`, `src/query-access.ts`, shared by runtime REST list and
count and the emitted SvelteKit list route): `limit`, `offset`, `orderBy` (a
string, or a list of terms comma-joined), `field=value` and `field[op]=value`
with `op` one of `gt`, `gte`, `lt`, `lte`, `ne`, `in`, `like`. An `[in]`
operand is a non-empty list sent as one comma-joined value; comma-joining is
the form every deployed list route already splits, so a new client stays
correct against an older server. `params.where` (`{ field: value }`,
`{ field: { op, value } }` or `{ 'field op': value }`, the WebMCP list-tool
shape) flattens into the same parameters; `params` and `where` must be plain
records (`list(null)`, a `Map`, `URLSearchParams` or `Date` rejects; only
`undefined` omits them). A value is a string, number, boolean, bigint or
`Date` (its ISO string); a query name or value that is not a well-formed
string (a lone surrogate) rejects, and an explicit `op` in a structured
condition must be a supported operator string (`null`, `false`, `''` reject).
An empty or scalar `[in]`
operand (in every form, `{ op: 'in', value }` included), `null`, an `[in]`
member holding a comma, an object value, a list without `[in]`, an unsupported
operator or one parameter given twice rejects before any request. The routes
refuse a repeated query parameter, and two parameters naming one predicate
(`price[gte]` and `price >=`), with 400 `REPEATED_QUERY_PARAMETER` instead of
keeping one value. They refuse a key the caller may not filter (unknown or
unreadable field, `__proto__` included, since the parsed record has no
prototype, and a non-field option such as `cache`) with 400
`QUERY_FIELD_NOT_ALLOWED`; the emitted SvelteKit route keeps the code in its
public error body. Decoding follows the operator the collection applies (the
bracket token, or the one written in a whitespace-form key, so `featured like`
keeps its string pattern). A value compared against a `boolean` field
(`true`/`false`/`1`/`0`) becomes a boolean. One compared against a `datetime`
field (including `created_at`, `updated_at`) that is an ISO-8601 instant with
`Z` or an offset, or a date alone (UTC midnight), becomes its UTC ISO string
with every fractional digit kept, never a millisecond `Date`, so PostgreSQL
microsecond comparisons stay exact. Anything else, an offset-less date-time
included, passes through unchanged, as does a column whose declarations
disagree on its type. An already-emitted SvelteKit route must be regenerated
to get the 400s and the decoding. GET custom actions keep their own
serialization (arrays repeat the key with `String(member)`, objects
JSON-encode), except that a `Date` is sent as its ISO string, the form their
routes decode for a `Date` parameter. A named route parameter must be the
caller's own property and is read once; that value is the one the query or
the JSON body carries, and a body otherwise follows the options' own
`toJSON()`. The list
response shape is unchanged here.


`src/vite-preset/` (`@happyvertical/smrt-core/vite`, `smrt()`) composes the Oxc
decorator block, `smrtConsumer`, then `smrtPlugin` with the template path
conventions. Its package list comes only from the `smrt({ packages })` option, or
`smrt.config` `consumer.packages` (smrt-config schema); it never sniffs
`package.json`, and a missing or malformed list throws. Keep its output
byte-identical to the two-plugin form (`src/vite-preset/index.test.ts`). It
also dedupes `@sveltejs/kit` (`smrt:shared-runtime`): SvelteKit matches
`redirect()`/`fail()` by class, and a linked/workspace SMRT SvelteKit entry
would otherwise import its own copy and turn redirects into 500s. The preset
also keeps the thin `@happyvertical/smrt-app-runtime/sveltekit` entry inside
the SSR bundle: adapter-node bundles Kit itself, and an external runtime
would load a separate class through Node even at the same installed version.
Vite matches `ssr.noExternal` by package name, so a pre-resolver keeps the
exact runtime root external and `ssr.external` keeps `./sveltekit-runtime`
external. That implementation subpath is an internal composition boundary;
apps keep importing `./sveltekit`. This avoids bundling native SQL dependencies.
This split applies only to builds; development keeps normal SSR externalization
and Kit dedupe because Vite's dev module runner ignores resolver external flags.
Other runtime dependencies retain their normal externalization. Do not explicitly
externalize app-runtime in an app config. The production regression in
`packages/app-runtime/src/sveltekit-production.test.ts` exercises the final
adapter-node HTTP handler using an installed copy of the published dist entry.

**Package models over REST (#3749).** `consumer.packages` registers a package's
models and gives `@smrt/web` (the consumer's `collectionDefinitions`, one per
list-capable model, endpoint `/<collection>`) their definitions, but a package
model gets generated REST routes only when it is on the consumer's hosting
allowlist (`smrtConsumer({ svelteKit: { objects } })`, #2850: an HTTP exposure
boundary, each model's own `api` config still applies, so `api: false` and
empty-include models stay closed, tenancy comes with the generated route). The
preset fills that allowlist: with `smrt.cookbook.json` present it is the models
of the cookbook's recipes plus `features`, minus models the cookbook `exposure`
turns off for `api` or a recipe's `options[model].exposure.api === false`
(`vite-preset/cookbook-exposure.ts`; recipe `{ exclude }` narrowing is not
applied by the build yet). Each consumed package's manifest is read from the
nearest `node_modules` at or above the project, as the consumer plugin does,
so hoisted and workspace installs host too; a package without a readable JSON
manifest is named in a warning rather than silently hosting nothing. `smrt({ expose })` replaces the derived list. No
cookbook and no `expose` keeps `svelteKit: true` (nothing hosted). The producer's
`@happyvertical/smrt-virt-web` still covers only the app's own models; read
package models from `@smrt/web`. `smrt({ objectsDir })` is passed to the hosting
contribution too: the producer and consumer share one `routesDir`, and the
generator refuses it when their settings differ.

**STI siblings (#3749).** Package STI subclasses share their base's table, and
the manifest gives them the base's `collection` unless they declare one
(`consumer-plugin/hosted-sti-collections.ts`). Two hosted siblings would both
claim `/<base collection>`, so each hosted subclass that inherits its
collection gets its class-derived one (`Order` -> `orders`,
`defaultCollectionName` in the scanner), in every manifest view the consumer
derives: routes, `@smrt/web`, the generated client and registration. This is the
convention the framework already has for an independent route collection
(`@smrt({ collection })`), applied by default for hosted subclasses; an explicit
collection wins. The route therefore reads through the subclass's own
collection (rows scoped to its `_meta_type`) and the definition for that model
advertises that route (`objectRef` = the model, `endpoint` = `/orders`). A hosted
base keeps the shared name and the base-collection semantics (every row of the
table, any subtype). A subclass left off the allowlist keeps the shared
collection and folds into the base's definition, as before. A collection class
that inherits another's item type (`MaterialCollection extends
ProductCollection`) resolves to the same item and collection, so only one of
them is hosted (the class named for the item, else the first). Subclasses that
declare no `api` config get the omitted-config default (full CRUD), not the
base's `include`; narrow them on the subclass if the base is meant to restrict
them.

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
It also builds `smrt-approvals` and `smrt-web` for the cookbook app-tools
integration tests, which exercise app-runtime's durable owner approval store
and smrt-svelte's screen source adapter. These test-only prerequisites belong
in core's task graph, avoiding a production dependency cycle.

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

## AGENTS.md discovery in a monorepo (#3476)

`buildDomainKnowledgeManifest()` takes the agent doc from the project root, else from the nearest ancestor `AGENTS.md` up to the workspace root (the nearest directory with `pnpm-workspace.yaml`, else the git root, a directory containing `.git`). It never walks past that boundary, and with no boundary above the project root it checks only the root. `agentDocPath` stays relative to the project root (so an inherited doc reads `../../AGENTS.md`), and `agentDoc` and `sourceHashes.agents` are populated from it. Module docs linked from the doc (`moduleDocs`) are only followed when `AGENTS.md` sits at the project root, since their links resolve against that directory.

## Host tool-name collisions (#4520)

`smrtPlugin({ hostToolNames })` (or `smrt({ hostToolNames })` in `vite.config.ts`, which forwards it unchanged) takes `{ name, surface: 'workflow' | 'bespoke' | 'mcp', declaredBy }`
declarations (`src/vite-plugin/host-tool-names.ts`). Host-vs-host duplicates fail at plugin
construction; a host name shadowing a generated model tool fails after the scan. The same
`declaredBy` on several surfaces is one operation and is allowed. Unlike the advisory
intent-vs-generated check, these throw and fail the build.

## Generated recipe surfaces

The consumer aggregator retains installed `recipes` alongside model declarations
and rejects conflicting declarations for the same recipe id. The existing
`web-collections.ts` emitter adds `recipeSurfaces` and `resolveExport` to the web
virtual module, with literal dynamic imports and per-recipe typed tuples.
Producer declarations and the consumer's additive
`smrt-recipe-surfaces.d.ts` use the same renderer. Recipe-only providers are
supported. Component declarations use the Svelte component contract and literal
metadata, not `typeof import(package/svelte)`, which would pull browser source
into Node-only declaration builds. Vite's optional load-hook `ssr` flag controls
server widget loader imports: browser output excludes them.

Regression gate: `consumer-plugin/load-resolve.test.ts` verifies installed
manifest aggregation, typed output, SSR/client separation and a real Vite bundle
whose initial chunk excludes the lazy component marker. The cookbook fixture in
smrt-svelte exercises rendering and generic fallback without a host export map.

## Cookbook policies with app replacements

`buildWebCollectionDefinition` includes optional `replacedQualifiedNames`, using
existing `modelReplacements` provenance. The same definition feeds runtime emission
and cache hashing; producer and consumer declarations retain this optional metadata.
Screen policy and recipe entry lookups accept only those proven provider identities,
never a same-name guess. Canonical app policy rows override provider rows sparsely.
The small declaration mirror in `src/prebuild/index.ts` changes with the producer
interface; the runtime exposure/REST generators are unchanged.

## Lazy recipe-surface imports

Both web emitters pass `lazyActivation` into the existing surface generator. With
it enabled, `recipeSurfaces[id][n].load(context)` and `resolveExport(specifier,
exportName, context)` refuse before invoking any literal dynamic import unless the
current `context.recipes` contains that export's owning recipe. Per-surface loaders
bind the owner id; an unrelated enabled recipe cannot unlock a different export.
No context means generic fallback. Eager hosts retain the previous optional-context
behavior. Shared type: `smrt-types.RecipeSurfaceLoadContext`.

SSR additionally requires the installed live runtime exposure gate (the host wraps
it with `activation.gate(...)`) and trusted `context.tenantId` where tenancy applies.
The generated module imports only the browser-safe gate leaf, not constructors or
the Node activation coordinator. Readiness without published recipe membership is
insufficient; unavailable gate/store and stale disabled contexts refuse.

Browsers consume the host's current screen-visible cookbook projection. They cannot
inspect server SQLite readiness; the host publishes recipe ids after activation and
refreshes the projection on exposure changes, as in the runtime exposure contract.
`CookbookApp` supplies that cookbook's recipe ids automatically through its existing
resolver, without a component mapping or a host-resolved policy map. This UI projection
is not an authorization token: REST, tools and SSR retain their live server gates.

The installed fixture consumer runs in lazy mode. A separate generated-module test
boots a real SQLite coordinator, proves map evaluation/disabled calls never evaluate
the surface package, activates its model and publishes the recipe, then uses the SAME
server/client modules to load the surface. Disabling and missing server gates refuse.
The existing bundle test still proves component bytes stay out of the initial chunk.

## Default development UI source

`getDefaultUIModule()` reads the shipped `templates/default-ui.ts` and uses the
existing on-demand `oxc-transform` seam to return JavaScript. Package builds copy
the browser template as source; a nonexistent `.js` path must not silently select
the fallback. Native compiler loading remains inside this build/dev operation,
not at public-root import time. The load-hook test requires the real dashboard,
rejects the fallback text and parses the result as JavaScript.
