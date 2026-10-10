# smrt-svelte/cookbook

Module semantics for `src/components/cookbook/` (`./cookbook` and
`./cookbook/server`, #3749). Package orientation and cross-module invariants are
in [../AGENTS.md](../AGENTS.md); the document it reads is the cookbook v1
contract ([core cookbook.md](../../core/agents/cookbook.md)).

A **cookbook-driven app shell**: given `smrt.cookbook.json` and the installed
packages' recipes, render the navigation sections, recipe entries, layout, theme
and section overview pages that smrt-planner showed, so a generated app and the
planner preview draw the same shell. Logic ported from smrt-planner
(`+layout.svelte`, `recipes/sections.ts`, `sections/*`, `overviews/*`,
`theme/*`); the planner-only editor, option/help pages, package browser and
sample data source are not part of it.

## Entries

| Entry | Contents |
|---|---|
| `./cookbook/server` | Svelte-free and Node-safe. `loadCookbookApp` (file + manifests + validation), `readInstalledManifests`, `hasCookbook`, and the pure builder/catalog/theme functions and types. Use it in `+layout.server.ts`. |
| `./cookbook` | Everything above that is browser-safe, plus `CookbookApp`, `CookbookSectionPage`, `applyCookbookTheme`, `createCookbookRegistry`, `createSectionOverview`. |

## Pure core (no DOM, Node-testable)

- **`catalogFromManifests(manifests)`** turns package `manifest.json` objects
  into a `CookbookCatalog` (`recipes` trimmed to what the shell reads, `models`
  with package id, description and `exposed`). Recipe order is manifest order;
  a repeated id keeps the first. `narrowCatalog(catalog, cookbook)` keeps only
  the selected recipes and the models they or the cookbook's `features` name, so
  a load serializes a few KB instead of the whole workspace.
- **`buildCookbookShell({ cookbook, catalog, ... })`** returns a `CookbookShell`:
  `navGroups` for `AppShell` (`navMode: 'sections'`, one group per suggested
  section, icon and section-page `href`), `layout` (the cookbook's, passed to
  the shell, which applies order/hidden/labels itself), `sections` and `entries`
  (every entry by stable id), `theme`, `overviews`, recipe surfaces
  (`shellWidgets`, `routes`, `settingsPanels`, `widgets`), `policies`, and
  `issues`. It never throws for cookbook content: an unknown recipe, a nav model
  the catalog lacks or a feature that is not exposed becomes an `issues` entry
  and is left out.
- **Ids are the contract.** Section layout ids are `section:<id>` (a recipe's
  `section`, else its `group`, else the recipe) or `custom:<slug>` (the layout's
  own); entries are `item:<package>:<Model>[:<key>]`. They never name labels or
  hrefs, so renames and route changes keep a saved layout valid. Do not change
  `navItemId`/`buildNavSections` without the planner: both read the same
  cookbooks.
- **Section order** follows the first recipe of each section in **catalog
  order** (not the cookbook's sorted list), then the cookbook layout's
  `sectionOrder`. Pass `recipeOrder` to pin it (the planner's overlay order).
- **Entries**: label, icon (`fileText` when the recipe names none), description
  (recipe text, else the model description, else a plain fallback), `noun` and
  `filter` carried through. Feature models share the `More` section after the
  recipes' sections.
- **Paths** are options: `entryPath` (default `/m/<package>/<Model>/[<key>/]`),
  `sectionPath` (default `/s/<slug>/`, slug = layout id with the first `:`
  turned into `-`), and `href` (a prefix or query helper applied to both).
- **Overviews**: one definition per suggested section and per layout custom
  section (`defineOverview`), id = the section's layout id, so a cookbook's
  `overviews` key survives a section rename. Defaults are a `shortcuts` widget;
  with `dataWidgets: true` they add a `metric` count and `records` list of the
  section's lead model (first nav model of its first recipe), which need the
  host's loaders. The cookbook's stored override is carried untouched
  (untrusted JSON, `null` when absent or empty) for `resolveOverview` /
  `createOverview` to validate; an override for an unknown page, or a malformed
  one, is an `issues` entry.
- **Theme**: `resolveCookbookTheme` is lenient (a bad colour or font is ignored;
  `validateCookbook` is where it is rejected). A brand colour becomes the preset
  id `cookbook-brand-<hex>[-<font>]`; the colour/font pair is encoded in the id
  because `ThemeProvider` looks a registered theme up once per id.
- **Recipe surfaces**: `shell-widget` surfaces are returned with their slot (a
  smrt-svelte `ShellSlot`; the equality with `RecipeShellSlot` is a typechecked
  assertion), `route` and `settings-panel` as data, `widget` surfaces grouped by
  recipe for `registerRecipeWidgets`. The builder never imports a component.

## `CookbookApp`

`AppShell` with the builder's output. Props: `cookbook`, `catalog`, any
`AppShell` prop (title, logo, `storageKey`, `user`, `permissions`, `dock`,
`slotItems`, `settingsHref`, ...), and:

- `loaders` (`metric` / `records` / `chart` data loaders; with `metric` and
  `records` the section pages add the count and latest records),
- `widgetContext` (host capabilities for browser-side widget loads),
- `resolveExport` (a static map of dynamic imports; turns a recipe export
  reference into a component, used for `shell-widget` slot items and recipe
  `widget` registration; without it those surfaces are ignored),
- `oncookbookchange(cookbook)` called with the full cookbook after a layout or
  overview edit (layout edits come from the shell's pencil toggle, enabled with
  `layoutEditing`). Without it edits live in memory. Persisting them is the
  host's job; feeding the result back as `cookbook` is safe.

Layout and overview edits are kept in local `$state.raw` copies that follow the
`cookbook` prop whenever it changes. The widget registry is rebuilt only when
the recipes' widget surfaces change by content, not on every edit.

Theme: `applyCookbookTheme` registers a brand colour with smrt-ui
(`createThemeFromColor` + `registerTheme`) and returns the preset for
`ThemeProvider`; an unknown preset name falls back to `smrt`.

**SSR**: the shell, nav, title and theme render on the server. The widget
registry, recipe widgets and slot items are resolved in effects (a bundled
`resolveExport` is async), so a section page's overview appears after hydration,
not in the server HTML.

## `CookbookSectionPage`

A section's own page: title, icon and description (the user's renames win over
the suggestion), the overview grid, and, in the shell's layout edit mode, the
section's entries as a sortable menu. A section without an overview (a custom id
outside the overview id pattern) shows its menu as cards. Mount it from one
route: `s/[slug]/+page.svelte` renders
`<CookbookSectionPage slug={page.params.slug} />`. It must be inside
`CookbookApp`.

## Using it in an app

```ts
// +layout.server.ts
import { loadCookbookApp } from '@happyvertical/smrt-svelte/cookbook/server';
export const load = async () => loadCookbookApp(); // { cookbook, catalog, warnings }
```

```svelte
<!-- +layout.svelte -->
<script lang="ts">
import { CookbookApp } from '@happyvertical/smrt-svelte/cookbook';
let { data, children } = $props();
</script>
<CookbookApp cookbook={data.cookbook} catalog={data.catalog} layoutEditing>
  {@render children()}
</CookbookApp>
```

`loadCookbookApp` reads `smrt.cookbook.json`, reads the `manifest.json` of the
project's dependencies that export one, validates with `validateCookbook` from
`@happyvertical/smrt-core/cookbook` (resolved at call time: the app depends on
core; smrt-svelte does not, `validate` can be injected), and throws one error
listing every problem, including a recipe no installed package declares.

## Not done here

- **Field policies** (`cookbook.policies`) are returned as `policies` but not
  applied; applying them to the runtime is `smrt cookbook apply` and the
  runtime's job. The shell does not render a settings page; pass `settingsHref`.
- **Entry pages** (`/m/<package>/<Model>/`) are the app's routes; `./screens`
  (`RecipeScreens`) is the default content for them.
- **Options/Help gear** on a recipe's first entry (the planner's `action`) is
  planner-only and not emitted.
- **Legacy id migrations** (`migrateLegacySections`/`NavItemIds`) stay in the
  planner; they depend on its recipe catalog.

## Tests

`src/components/cookbook/__tests__/`: `build.test.ts` builds the four fixture
cookbooks in `packages/core/src/cookbook/__fixtures__/` against the real
workspace recipes (every package that declares a `SmrtRecipe`, scanned and
converted to manifests the way the build does, in `workspace-catalog.ts`, so no
sibling `dist/` is needed), asserts no issues, that every layout id resolves,
and the exact bakery sections and labels. `contract-types.ts` (not a `*.test.ts`:
tsc excludes test files) holds the type assertions that smrt-types'
`CookbookLayout`/`CookbookOverviewOverride` equal `ShellLayout`/
`OverviewOverride`. `CookbookApp.test.ts` mounts the shell with the bakery
cookbook (nav, section page, brand theme, edit callback); `server.test.ts` runs
the loader over a temp project with a fake installed package.
