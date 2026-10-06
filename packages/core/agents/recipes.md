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

## How the scanner collects it

The scanner class pass finds classes by decorator, which a recipe lacks, so
`recipes.ts` is a second matcher in the style of the agent-surface one: a class
whose `extends` resolves to the `SmrtRecipe` import binding from
`@happyvertical/smrt-core` (named, aliased `SmrtRecipe as R`, or namespace
`Core.SmrtRecipe`; any core subpath such as `/browser`). A same-named local
class or an import from another library is not a recipe.

Class references resolve to qualified names (`@scope/pkg:Class`) through the
import binding: a relative specifier picks the scanned class by file, then by
class name (barrel re-exports keep the name); an aliased import follows the
*imported* name; `Ns.Class` namespace members and same-file classes work; a
bare package specifier is rejected (models must belong to this package). This
was chosen over qualified-name strings because it type-checks and survives
renames; strings were not needed.

Recipe discovery is independent of the model `include` glob (like intents), and
`ScanResults.recipes` is populated by `resolve()`. Every error is a scan error,
so every producer (`smrtPlugin`, `ManifestBuilder`, `generateManifest`) fails
the build. The adapter qualifies names and emits a top-level `recipes` array in
`manifest.json`; `buildDomainKnowledgeManifest` projects the same array into
`smrt-knowledge.json`. A package with no recipe emits no key.

## Build-time validation

Ids are dotted lowercase and unique; `models` is non-empty, resolvable, and
duplicate-free; every `nav` model is in `models`; `requires` are well-formed,
not self-referential or duplicated, and acyclic within the package (ids in other
packages cannot be checked at scan time); `options` name only listed models and
fields the model already declares, and only the keys below.

## options: curation hints, never a second schema

Keyed by model class name. `fields.<name>` accepts the smrt-fields policy
vocabulary: `default`, `label`, `help`, `order`, `visibility`
(`basic | advanced | hidden`), `locked`; applying a recipe produces
field-policy rows. `exposure.<api|mcp|cli>` accepts only `false` or
`{ exclude: string[] }`: `true` and `include` are rejected because they can
widen what the model already declares. Custom fields are out of scope.
