# SmrtRecipe: declared units of app functionality (#3590)

A **recipe** is a small, named, user-facing unit ("Sales", "Customers"),
smaller than a package. An app or agent adds a recipe and gets that section:
navigation, list and create/edit views, and its prerequisites, without every
model in the owning package. Source: `src/recipe.ts` (authoring base class),
`packages/scanner/src/recipes.ts` (matcher and validation), types in
`@happyvertical/smrt-types` (`RecipeDefinition`).

## Authoring

`SmrtRecipe` is an abstract, **non-persisted, non-`@smrt()`** base class
exported from both core entries (`index.ts` and `browser.ts`). A recipe is a
subclass with static properties, in the package that owns its models:

```ts
export class SalesRecipe extends SmrtRecipe {
  static id = 'commerce.sales';          // dotted lowercase, unique
  static label = 'Sales';
  static summary = 'Take customer orders and track them.';
  static synonyms = ['sales orders', 'orders'];
  static models = [Order];               // class references
  static nav = [{ label: 'Sales Orders', model: Order }];
  static requires = ['commerce.customers']; // recipe ids, any package
  static options = { Order: { fields: { status: { default: 'draft' } } } };
}
```

Statics are read **structurally** (nothing is evaluated), so each must be
spelled literally; `models` and `nav[].model` take identifiers. Write
`static options = { ... } as const` so `visibility` stays a literal type.
The emitted `options` are keyed by qualified model name.

## Host metadata: group, section, nav detail, alternatives (#3604)

Everything a catalog host (an app shell, an agent, a CLI) needs
to present a recipe lives on the recipe, so it reads the manifest or knowledge
artifact instead of importing runtime code. All are optional and additive:

| Static | Shape | Meaning |
| --- | --- | --- |
| `group` | `{ id, label, summary? }` | Recipes with the same `group.id` share one card; the first declaration of an id supplies `label` and `summary`. Declaration order is the sub-switch order. |
| `section` | `{ id, label, icon?, description? }` | Navigation section the recipe suggests for its `nav` entries. The host owns sections and the user may rename them, so keep `id` stable; the same `id` shares a section. |
| `requiresAny` | `string[][]` | At least one id of each inner list must be on (`[['products.simple', 'products.clothing']]`); adding the recipe with none on adds the first. |
| `nav[].icon` / `description` | string | Shell icon name and one friendly line for a business owner. |
| `nav[].noun` | string | What "New" creates when the label is not countable ("Stock levels" -> `stock entry`). |
| `nav[].key` | slug | Fixed key for the layout id `item:<pkg>:<Model>:<key>`. Required for a second entry over the same model and for a `filter`. |
| `nav[].filter` | `{ field, value }` | Narrows the entry to rows where `field` equals `value` (Ingredients over Products: `productType` = `material`). Needs a `key`. |
| `options.<Model>.fields.<f>.required` | boolean | The form refuses to save without a value. |

Child models (line items) are simply listed in `models` without a `nav` entry.
Validation: `group`/`section` take only their keys, slug ids, non-empty
strings; `requiresAny` ids follow the recipe-id format and cannot name the
recipe itself; each (model, key) pair appears once in `nav`; a `filter.field`
must be a field the model declares (checked in core on the merged manifest,
`assertRecipeOptions`).

Not part of the recipe declaration (still host-local): a host's
cross-package `forms` and `extends` (form records spanning profiles, variants
and SKUs).

User-facing field text for the recipes comes from `@field({ description })` on
the models (the glossary seed), so a package that declares a recipe carries the
descriptions of every field the recipe shows.

## Non-model surfaces, providers, runtime, demo seed (#3708)

Many features are not a list of models: a shell widget (assistant dock,
notification bell), a component, a route, a settings panel. All four statics are
optional and additive; a recipe that declares none emits none of the keys. They
are emitted on the recipe entry in `manifest.json` and `smrt-knowledge.json`.
Components are named by `'<package specifier>#<ExportName>'` and never imported
at scan time; a host resolves them. Relative or absolute specifiers are rejected.

| Static | Shape | Meaning |
| --- | --- | --- |
| `surfaces` | `RecipeSurface[]` | `{ kind: 'shell-widget', slot, export, label, icon? }`, `{ kind: 'route', path, export, label }`, `{ kind: 'settings-panel', export, label }`, `{ kind: 'playground', export, label? }`. `slot` is a smrt-svelte `ShellSlot`; `path` starts with `/` and has no whitespace, `?`, `#` or `..`. |
| `providers` | `RecipeProvider[]` | `{ id, kind, options, required, secrets? }`: lowercase slugs, `options` non-empty and distinct, `required` always written, `secrets` distinct `UPPER_SNAKE` names (never values). Ids are unique per recipe. |
| `runtime` | `'browser' \| 'server' \| 'both'` | Where the recipe's runtime pieces can run. Omitted means `both`; the value is emitted as authored. |
| `demoSeed` | `{ export } \| { data }` | A fixture export reference, or inline JSON of at most 8 KB, for demo hosts. Exactly one key. |

Write `surfaces` with `as const` (like `options`) so `kind` and `slot` stay
literal types. The slot list is `RECIPE_SHELL_SLOTS` in smrt-types, a literal
copy of smrt-svelte's `SHELL_SLOTS` (a smrt-svelte test keeps them equal), so
the scanner has no runtime dependency on smrt-svelte. Every violation (unknown
kind or slot, extra key, duplicate route path or provider id, malformed
reference) is a scan error. Example: `events.calendar` in
`packages/events/src/recipes.ts`.

## How the scanner collects it

The scanner class pass finds classes by decorator, which a recipe lacks, so
`recipes.ts` is a second matcher in the style of the agent-surface one: a class
whose `extends` resolves to the `SmrtRecipe` import binding from
`@happyvertical/smrt-core` (named, aliased `SmrtRecipe as R`, or namespace
`Core.SmrtRecipe`; any core subpath such as `/browser`). A same-named local
class or an import from another library is not a recipe. A recipe must extend
`SmrtRecipe` **directly**. Within one file, extending another recipe or declaring
one as a class expression or inside a block is a scan error rather than a silent
drop. Across files it is not detected: a module that never names `SmrtRecipe`
is not read, so a recipe extending a recipe or intermediate base imported from
another module is unsupported and would be missing from the artifacts.

Class references resolve to qualified names (`@scope/pkg:Class`) through the
import binding: a relative specifier picks the scanned class by file, then by
class name (barrel re-exports keep the name); an aliased import follows the
*imported* name; `Ns.Class` namespace members and same-file classes work; a
bare package specifier is rejected (models must belong to this package). When
the imported file declares no such class, the barrel fallback binds a same-named
scanned class, so keep model class names unique within a package. This
was chosen over qualified-name strings because it type-checks and survives
renames; strings were not needed.

Recipe discovery is independent of the model `include` glob (like intents; it is
not gated by the `agentSurface` option), and
`ScanResults.recipes` is populated by `resolve()`. Every error is a scan error,
so every producer that reads `scanAndResolve()` (`smrtPlugin`, `ManifestBuilder`)
fails the build. (The legacy `ManifestGenerator.generateManifest()` path takes
pre-scanned results and never sees recipes.) The adapter qualifies names and emits a top-level `recipes` array in
`manifest.json`; `buildDomainKnowledgeManifest` projects the same array into
`smrt-knowledge.json`. A package with no recipe emits no key.

## Build-time validation

Ids are dotted lowercase and unique; `models` is non-empty, resolvable, and
duplicate-free; every `nav` model is in `models`; `requires` are well-formed,
not self-referential or duplicated, and acyclic within the package (ids in other
packages cannot be checked at scan time); `options` name only listed models and
and only the keys below. Field names are checked in core
(`ManifestGenerator.assertRecipeOptions`, after inherited fields merge) against
the merged manifest, so STI-merged, tenant, and framework-base fields such as
`parentId` are accepted along with the universal `id`, `slug`, `context`,
`created_at`, `updated_at`; anything else fails the build.

## options: curation hints, never a second schema

Keyed by model class name. `fields.<name>` accepts the smrt-fields policy
vocabulary: `default`, `label`, `help`, `order`, `visibility`
(`basic | advanced | hidden`), `locked`; applying a recipe produces
field-policy rows. `exposure.<api|mcp|cli>` accepts only `false` or
non-empty `{ exclude: [...] }` naming a CRUD verb (`list`, `get`, `create`,
`update`, `delete`) or a public instance method the model declares or inherits: `true` and `include` are
rejected because they can widen what the model already declares. Custom fields are out of scope.

## User-facing help (#3591)

Help is documentation for the people using the app, not developers. It lives
beside the recipe as Markdown and is pointed to by `static help`:

```ts
export class SalesRecipe extends SmrtRecipe {
  // ...
  static help = './sales.recipe.md'; // relative to the recipe file, .md only
}
```

The file holds an **Overview** and **Tasks** (short how-tos). A step names a
field as `{field:<fieldName>}` or `{field:<Model>.<fieldName>}`; the Markdown
block (heading, paragraph, or list item) containing a reference is **tied to
that field**. Keep prose in the separate file rather than the recipe class.
Field text itself comes from `@field({ description })`, the user-facing seed
smrt-fields uses for form help; every field a recipe shows should carry one.

**Emission.** The scanner reads the file (a missing, empty, non-`.md`, absolute
or `..`-climbing path is a scan error) and emits
`help: { markdown, fieldRefs }` on the recipe entry in `manifest.json` and
`smrt-knowledge.json`, so a static host needs no further request.
`fieldRefs` (distinct references as written, sorted) is **derived**, never
authored. Knowledge fields also carry `description` (sensitive fields stay
excluded). `ManifestGenerator.assertRecipeHelp` fails the build on a reference
to a field the recipe's models do not declare, and on a `fieldRefs` list that
disagrees with the Markdown. The scanner has its own copy of the reference
grammar (`deriveHelpFieldRefs`; it cannot import core), so that comparison also
keeps the two from drifting. A reference to a **sensitive** or universal (`id`,
`slug`, ...) field also fails the build: neither reaches the knowledge artifact,
so a host building its field list from it would silently drop the step naming
one; describe such a field in prose without a reference.

Known limitation: the help file is a generator input, but editing only it does
not trigger a dev-server rescan (the watch matches source globs) and generation
snapshots do not digest it, so rebuild (or touch a `.ts` source) after editing.

**Rendering.** `src/recipe-help.ts` is pure and browser-safe (exported from
both core entries). `renderHelp(help, models, options?)` takes the recipe's
help plus the app's effective field policies (`HelpModel[]`; label, help,
visibility, disabled in smrt-fields vocabulary, with `@field` descriptions) and
returns `{ blocks, glossary, connect? }`:

- `{field:x}` becomes the effective label;
- a block tied to a hidden, disabled, undeclared, or **advanced** field (unless
  `showAdvanced`) is dropped; a list item drops alone; a heading whose section
  had content that was all dropped is pruned (a heading that never had content
  stays);
- the glossary lists each shown field with its effective help, else its
  description. A shown field with neither is **skipped**, not listed blank;
- `connect` is the collapsed "Connect other tools" section: the recipe's
  generated REST routes, MCP tools and CLI commands (`options.surfaces`, from
  the knowledge artifact), minus the recipe's `exposure` narrowing
  (`options.exposure`). Hosts render it last.

The result is an AST of text nodes (`text`, `code`, `strong`, `em`), never HTML,
so authored markup stays inert text and nothing needs sanitizing. Only
`##`-`####` headings, paragraphs, flat lists and bold/italic/code are
understood. `helpToMarkdown(rendered)` flattens it for hosts with their own
renderer; render that with raw HTML disabled. `validateHelp(help, models)`
returns the build-failure problems for hand-built entries.
