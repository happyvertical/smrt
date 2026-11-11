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
| `./cookbook` | Everything above that is browser-safe, plus `CookbookApp`, `CookbookSectionPage`, `CookbookSectionOverview`, `applyCookbookTheme`, `createCookbookRegistry`, `createSectionOverview`. |

## Pure core (no DOM, Node-testable)

- **`catalogFromManifests(manifests)`** turns package `manifest.json` objects
  into a `CookbookCatalog` (`recipes` trimmed to what the shell reads, `models`
  with package id, description and `exposed`). Recipe order is manifest order;
  a repeated id keeps the first. `narrowCatalog(catalog, cookbook)` keeps only
  the selected recipes and the models they or the cookbook's `features` name, so
  a load serializes a few KB instead of the whole workspace.
- **`buildCookbookShell({ cookbook, catalog, ... })`** returns a `CookbookShell`:
  `navGroups` for `AppShell` (one group per suggested
  section, icon and section-page `href`), `layout` (the cookbook's, passed to
  the shell, which applies order/hidden/labels itself), `sections` and `entries`
  (every entry by stable id), `theme`, `overviews`, recipe surfaces
  (`shellWidgets`, `routes`, `settingsPanels`, `widgets`), `policies`, and
  `issues`. It never throws for cookbook content: an unknown recipe, a nav model
  the catalog lacks or a feature that is not exposed becomes an `issues` entry
  and is left out.
- `CookbookApp` uses `navMode: 'sections-with-items'` by default: the open
  drawer shows section pages and their entries, while the rail keeps section
  icons. Hosts can choose `navMode: 'sections'` for headings only.
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
- **Item icons**: `layout.items[id].icon` overrides the recipe icon in the
  drawer, section menu and overview shortcuts. It is a 1–64 character identifier
  (ASCII letter first, then letters, digits, `_` or `-`); unknown safe names
  are retained for host renderers and otherwise use the shell's fallback glyph.
  Absent overrides keep existing recipe icons and `fileText` defaults. Layout
  parsing, moves and item renames preserve the override.
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
  `borderRadius`, `density` and `contrast` pass through (also leniently: an
  unknown value is dropped) to `AppShell`'s props of the same names, which hand
  them to `ThemeProvider`. As with `preset` and `colorScheme`, a user's persisted
  `ThemeProvider` preference wins after mount. The brand colour is
  `createThemeFromColor` and replaces the preset; it is not `ThemeProvider`'s
  `primaryColor`, which tints the current preset and which the cookbook never sets.
  A top-level `fontFamily` keeps the built-in preset's palette, spacing and
  shape while replacing its typography. It takes precedence over the legacy
  `custom.fontFamily` when both are present.
- **Recipe surfaces**: `shell-widget` surfaces are returned with their slot (a
  smrt-svelte `ShellSlot`; the equality with `RecipeShellSlot` is a typechecked
  assertion), `route` and `settings-panel` as data, `widget` surfaces grouped by
  recipe for `registerRecipeWidgets`. The builder never imports a component.

## `CookbookApp`

`assistant` accepts a host-supplied `{ component, transport, registry, label? }`
(the template host's `createCookbookAssistant()`). CookbookApp mounts it in the
shell panel, shares the registry with Provider, and owns the desktop/phone toggle.
`embed` hides in-app chat by omitting the assistant component. A host without
`assistant` retains the existing explicit panel/dock snippet API.

`AppShell` with the builder's output. Props: `cookbook`, `catalog`, any
`AppShell` prop (title, logo, `storageKey`, `user`, `permissions`, `dock`,
`slotItems`, `settingsHref`, ...), and:

- `loaders` (`metric` / `records` / `chart` data loaders; with `metric` and
  `records` the section pages add the count and latest records; `shortcuts`
  is a `CookbookShortcutsLoader`, below),
- `widgetContext` (host capabilities for browser-side widget loads),
- `resolveExport` (optional override of the installed-manifest generated resolver
  for shell widgets, recipe widgets and route surfaces),
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

## Host shortcuts loader (#3888)

`CookbookApp loaders.shortcuts` is `(ctx, defaults: ShortcutEntry[]) =>
Promise<ShortcutEntry[]>` (`ShortcutEntry = { href, label, icon?, description?,
count? }`, exported from `./cookbook` and `./overview`).
`createCookbookRegistry` computes the default entries from the shell's resolved
sections, then, when the host supplies `shortcuts`, passes them through it
(`composeShortcutsLoader`); with no host loader the registry's loader is
unchanged. The host returns the entries to show (add `count`, reorder, add or
drop). If it throws, that load keeps the defaults (the page never empties
because a count query failed) unless the load itself was aborted. The shortcuts
widget renders `count` as "N records" (plural-aware i18n, tabular figures).

## `CookbookSectionPage`

A section's own page: title, icon and description (the user's renames win over
the suggestion), the overview grid, and, in the shell's layout edit mode, the
section's entries as a sortable menu. A section without an overview (a custom id
outside the overview id pattern) shows its menu as cards. Mount it from one
route: `s/[slug]/+page.svelte` renders
`<CookbookSectionPage slug={page.params.slug} />`. It must be inside
`CookbookApp`.

Props (also on `CookbookSectionOverview`, #3888): `presentation?: 'plain' | 'card'`
(default `'card'`) is passed to `OverviewGrid`, so section widgets and shortcuts
use the current theme's existing framed styles. Explicit `'plain'` remains
available for unframed entries on the panel surface; editing keeps its frame.
`heading?: Snippet<[{ section: CookbookSectionHeadingInfo }]>` replaces the
default title block (`{ id, title, description?, icon }`) on the page; on a
standalone `CookbookSectionOverview` it renders above the grid and needs the
`section` prop.

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

- **Policy editing settings** remain host-owned; pass `settingsHref`. The shell
  automatically resolves raw `cookbook.policies` for its record screens.
- **Entry pages** (`/m/<package>/<Model>/`) are the app's routes; `./screens`
  (`RecipeScreens`) is the default content for them. Their data comes from the
  package model's generated REST route and its `@smrt/web` definition (#3749).
  The app does nothing beyond listing the package in `smrt.config.ts`
  `consumer.packages`: the `smrt()` Vite preset hosts the models of the
  cookbook's recipes and `features` (core
  [build-knowledge.md](../../core/agents/build-knowledge.md), "Package models
  over REST"), skipping `api: false` models and any the cookbook's `exposure`
  turns off for `api`. In the entry route, take
  `collectionDefinitions[<collection>]` from `@smrt/web` (not
  `@happyvertical/smrt-virt-web`, which holds only the app's own models) as the
  `definition`, and build the `RecipeScreensSource` over
  `GET /api/<collection>` and `/api/<collection>/<id>` (offer writes only when
  the definition's `actions` include them). A model with no definition is not
  exposed over the API; show the notice.
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

## Named reference screens

The host's model page mounts `RecipeScreens` from `./screens`. Pass all exposed
`collectionDefinitions` as `definitions` to enable the default REST reference
sources. For linked record navigation, build the sources once with
`createRecipeScreenReferences(collectionDefinitions, { hrefFor })` and pass them
as `references`; `hrefFor(definition, id)` maps the qualified model to the app's
record URL. Use the cookbook shell's model entries to determine which models
have pages; omit a URL for a model with no page. A custom data source supplies
its own `search({ query, offset, limit })` and `get(id)` in the same map. See
[screens](screens.md) for label metadata, pagination and unavailable-target
behavior. This shell does not own a model-page router or infer one from an API
endpoint.

## Shared record-screen vocabulary and policy context

`CookbookApp` passes raw cookbook rows to the browser-safe smrt-fields resolver
and shares the result with generated/standalone screens and definition-driven
import/export. Hosts no longer provide `fieldPolicies`; that prop remains an
explicit compatibility override for server-resolved tenant/user policies.
Collection renames reach titles, create/edit actions, back links and overview
model choices without changing API identities. Use `RecipeScreens.entryId` for a
keyed collection entry. See [screens.md](screens.md#cookbook-policy-and-vocabulary-context).

## Installed recipe surface imports

The existing core producer/consumer web-module emitter now exports
`recipeSurfaces` and `resolveExport` from `@smrt/web` (producer alias:
`@happyvertical/smrt-virt-web`). `recipeSurfaces[recipeId]` is a typed tuple of
`{ surface, load }`; `load()` returns the component or undefined. Recipe ids and
surface metadata are literal types. Declarations use Svelte's component type
rather than importing every package's Svelte source into a Node-only typecheck.

`CookbookApp` uses `./cookbook/surfaces` by default; the consumer plugin replaces
that optional port with the generated web module. Without a plugin, its empty
resolver preserves generic screens and explicit host resolvers remain usable.
The shell uses the generated resolver for widget/shell-widget surfaces and
shares it with `RecipeScreens` for declared route surfaces. Explicit
`resolveExport` remains an override. Hosts need the normal SMRT consumer plugin,
not a handwritten export map. Imports are literal dynamic imports, one per
export reference; reading a manifest or map imports no recipe component. Missing
route exports and rejected imports retain generic screens. Server widget data
loaders are emitted only in the SSR projection; the browser map never imports
those server modules. Hosts still supply authenticated server widget data and
any capabilities a package component requires, not component import mappings.

The installed fixture package under `__tests__/surface-package/` exercises this
through the real consumer plugin and an ordinary cookbook harness. Its consumer
project root is a disposable temporary directory: fixture manifests and knowledge
must never be written into the real package's `.smrt` directory. Core's
`consumer-plugin/load-resolve.test.ts` separately builds an installed fixture and
proves its marker exists in a dynamic chunk and not the initial chunk, and its
server loader is absent from the browser import graph.

## Reuse inventory for policy/surface integration

MCP `review-smrt-project` ran on fields/core/types/smrt-svelte; architecture
context queried field policy resolution, raw rows, generated surfaces and
`resolveExport`. The intent index and owning packages were searched by symbol
and purpose (`resolveFieldPolicy`, `buildCodeSeedVisibility`, `rowToDelta`,
`applyDelta`, `parseRecipeExportRef`, `generateWebModule`, surface maps and lazy
imports). Existing owning code was extended rather than duplicated:

- `fields/src/policy.ts`: moves the existing pure seed/merge helpers and exposes
  the same kernel to server resolution and cookbook consumers. The registry,
  authorization, database reads and cache stay in the original server resolver.
- `core/src/cookbook/export-ref.ts`: moves the existing export-reference parser
  from overview recipe widgets; the emitter and UI now reuse it.
- `surfaces.ts`: an empty optional integration port; the consumer plugin resolves
  it to its existing emitter rather than requiring a virtual module in plain
  Svelte hosts. No parallel surface registry is implemented.
- `__tests__/surface-package/Surface.svelte`: a test-only package route composing
  the existing `EditForm`; its `index.js` is only a re-export and its manifest and
  package.json are fixture data. No new production component/model is introduced.

## Integration contract after the shared train

Client policy code imports only the browser-safe `smrt-fields/policy` and
`smrt-core/cookbook` entries, never the fields server resolver/root. Installed
provider recipes keep their entry ids, labels and surface paths after a same-name
app replacement. Generated `replacedQualifiedNames` is the only alias authority;
canonical app rows override provider contributions without erasing sparse metadata.

Live exposure remains host-owned: subscribe to exposure changes, refresh navigation
with `filterRuntimeCookbookSnapshot`, filter definitions with `filterRuntimeExposure`,
and check direct URLs before mounting a screen. An installed lazy surface map is an
AOT superset, not authorization. The component integration case closes the host
preference, removes the projected screen/navigation, then reopens it without a build.

Read-only reference fields compose the existing disabled `ReferencePicker`, retaining
its manifest display label. Hidden references never mount a picker or issue a target
lookup. Save payloads preserve existing IDs and use valid raw defaults only on create.

Core's scanned app/STI fixture drives the existing screen field/draft functions into
REST create and verifies the effective app discriminator and hidden default in SQLite.
The existing durable cookbook-tool fixture proves policy metadata is unchanged while
a replacement is held, is published after owner decision/consumption, and cannot replay.
UI read-only metadata does not grant permission or approve assistant tools.

Reuse audit repeated MCP reviews for core/fields/smrt-svelte and intent-index/name/purpose
searches across core, fields, smrt-ui, smrt-svelte and chat. `cookbookPolicyLayers` factors
the two existing raw-row selectors; it uses existing registry/manifest replacement
provenance and the original sparse merge kernel. No new component/model is introduced.

## Lazy activation and virtual names

With the consumer plugin's `lazyActivation`, the generated resolver requires current
visible recipe ids. `CookbookApp` passes `cookbook.recipes` automatically. Supply the
host's filtered cookbook snapshot and update it after successful activation/persistence
and exposure changes (including store failure); do not render an AOT installed catalog
as a live cookbook. SSR callers additionally pass a trusted tenant and install the
combined readiness/exposure gate. A refused import returns undefined for generic
fallback and is retried on the next current projection, with no rebuild.

The shared Fields resolver enumerates validated virtual display labels for stored
and raw policies. They keep the linked Profile name, can be relabelled/hidden, and
remain excluded from forms, create defaults and CSV imports. Visible names can be
exported; policy-hidden names cannot. The screen field selector retains the projected
`Name` fallback as well as cookbook labels/read-only metadata.

This rebase's reuse check repeated MCP package reviews and architecture context,
the intent index and `rg` searches for projection/readonly/activation/surface helpers
across core, fields, smrt-ui, smrt-svelte and chat. It extends existing policy field
enumeration and the web emitter, reuses public registry/UI validators and the existing
activation/exposure gates, and adds only the shared load-context type. No production
component, model, route or file is added.

## Recipe screen import boundary

`context.ts` and `types.ts` are shared by standalone recipe screens. Keep these
contracts independent of shell components, including type-only imports: downstream
`svelte-check` follows them into the shell's theme CSS. `CookbookAppProps` lives in
`app-props.ts` and keeps its public exports from `./cookbook` and
`./cookbook/server`; standalone screens never import the app props or `AppShell`. Legitimate app hosts use Vite's CSS types (or the package's existing
ambient CSS declaration), which standalone recipe packages should not need.
`recipe-screen-boundary.test.mjs` traverses screen imports, including types, to
prevent the shell dependency from returning.

Reuse check: MCP `review-smrt-project` for smrt-svelte, the intent index, and
name/purpose searches for `AppShellProps`, `CookbookAppProps`, shell props and
import-boundary tests in smrt-ui/smrt-svelte/chat/core found the existing
`CookbookAppProps` in `types.ts`. `app-props.ts` moves that contract unchanged;
no parallel props type or runtime component is introduced.
