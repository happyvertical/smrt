# smrt-svelte/overview

Module semantics for `src/components/overview/` (`./overview` and
`./overview/server`, #3727). Package orientation and cross-module invariants are
in [../AGENTS.md](../AGENTS.md); the shell edit mode it joins is in
[workspace.md](workspace.md#editing-the-layout-in-place).

An overview is a **customizable surface**: a flow grid of registered widgets,
each with an options object. A page declares which widget types it allows and
its default arrangement; admins (or users, per role) add, reorder, resize,
configure and remove widgets inside that confined set, and reset returns to the
default. Phase 1 (this module) is the surface, the registry, the data model, the
server load contract and five core widgets; phase 2 adds package widgets from
recipes ("Recipe widgets"); phase 3 is production persistence in
`@happyvertical/smrt-preferences` ("Production persistence"). Assistant
operations are phase 4 (see "Extension points").

## Two entries

| Entry | Contents |
|---|---|
| `./overview/server` (`server.ts`) | Svelte-free: types, `validateWidgetOptions`, the model (`resolveOverview`, `checkOverviewOverride`, `applyOverviewOverride`, `diffOverview`, `sanitizeOverview`, ...), `WidgetRegistry` / `registerWidget`, `loadOverview`. Safe in a `+page.server.ts` or a save endpoint. |
| `./overview` (`index.ts`) | Everything above plus `OverviewGrid`, `createOverview` (controller), `WidgetOptionsForm`, the core widgets and `registerCoreWidgets`, `shortcutsFromNav`, `formatWidgetValue`, `parseMarkdown` / `safeHref`. |

## Data model (`types.ts`, `model.ts`)

A saved overview is data, never code:
`{ widgets: [{ id, type, span, options, version? }] }`. `span` is 1 to 4 (a widget
type may narrow its own range); `options` is a flat object of JSON primitives;
`version` is the widget's option-schema version the options were written
against (absent means 1).

- **`OverviewDefinition`** (what a page declares): `id` (dotted ids allowed,
  `events.home`), `defaults`, `allowed` (widget types; omit for every registered
  type), `models` (confines `model` options, including a substituted default: a
  default outside the list fails validation, so its loader never runs),
  `maxWidgets` (default 24).
  `defineOverview` validates ids.
- **`OverviewOverride`** is the sparse, versioned (`version: 1`) delta a host
  stores: `order`, `removed`, `added`, `changed[id] = { span?, options?, version? }`.
  `applyOverviewOverride(base, override)` is total: ids the base no longer has
  are ignored, an added widget colliding with a base id is skipped, and widgets
  the order does not list keep their slots (a default shipped later still
  appears). `diffOverview(base, next)` is its inverse (round-trip tested), so
  every client edit is "mutate the document, store the diff"; an edit that
  returns to the defaults stores `null`.
- **Ids are stable.** `nextWidgetId` yields `w<n>` and reserves the ids of
  removed defaults, so a new widget never takes a removed default's id (the
  override would delete it). It is total for any stored ids: numeric suffixes
  beyond `Number.MAX_SAFE_INTEGER` are ignored when picking the next number
  (they would stop incrementing), and an exhausted high end restarts at `w1`.
- **Tiers.** `resolveOverview` merges one override. A host with tenant defaults
  and user overrides merges the tenant tier into the definition's `defaults`
  first; the user override then applies to that (smrt-preferences'
  `withTenantDefaults`).
- **Reset** is `controller.reset()` (store `null`) or `resetWidget(id)`.

## Validation: what keeps a stored overview from running anything

Options are validated against the widget's versioned schema on **save**
(`checkOverviewOverride`, strict: any issue rejects, and the returned override is
re-derived from the sanitized result, so persist that) and on **load**
(`sanitizeOverview`, lenient: the bad widget is dropped and reported as an
`OverviewIssue`, the rest render). Nothing here calls a widget's `load` for a
widget that failed validation.

- `schema.ts` field types: `text`, `markdown`, `identifier`, `model`, `integer`,
  `number`, `boolean`, `enum`. There is **no free-form query, filter expression,
  URL or SQL field**. "Which data" is a `model` (a bare `Class`, `pkg:Class` or
  `@scope/pkg:Class`, optionally confined to the page's `models`), an
  `identifier` (a field or named-filter id, `[A-Za-z_][A-Za-z0-9_.-]{0,63}`) or a
  closed `enum`. The loader maps those to queries it owns and authorizes.
- Strict: unknown keys, wrong types, out-of-range numbers, values outside a closed
  set and missing required fields fail the whole options object. Missing optional
  fields take their default; `null` counts as missing.
- `sanitizeOverview` also drops: unknown types, types outside the page's
  `allowed` set or a widget's `allowedIn`, duplicate ids, widgets over the cap,
  newer-than-known versions, and older versions without a working `migrate`.
  Spans are clamped to the widget's range. It is idempotent.
- `migrate(options, fromVersion)` upgrades stored options to the current version
  (return `null` to drop). It runs on untrusted input inside a try/catch, and its
  result is validated like any other options.
- A widget id removed by the user and a type removed by a release both degrade to
  "dropped and reported", never an error page.

## Registry (`registry.ts`)

`registerWidget({ type, title, options, component | loadComponent, load, allowedIn,
version, migrate, defaultSpan, minSpan, maxSpan })` on the shared
`defaultWidgetRegistry`, or `createWidgetRegistry()` for an isolated one (tests,
several surfaces). Registration is code, at module scope; registering a type
twice throws unless `{ replace: true }`. `title`, `description` and option
`label` / `help` / `choices[].label` are text **or i18n keys** (the UI runs them
through `t`, which returns an unregistered string unchanged); the core widgets
use `ui.overview.*` keys from `i18n/strings.overview.ts` (registered in
`i18n/server.ts`).

`component` renders synchronously. `loadComponent` is the lazy form (dynamic import
by export ref): resolve it **before** render with `resolveWidgetComponents(types)`
in a universal load and pass the map to `OverviewGrid components`, so server and
client render the same tree. A type that cannot resolve renders as unavailable.

## Server load contract (`load.ts`)

```ts
// +page.server.ts
const resolved = resolveOverview(definition, await storedOverride(event), registry);
const overview = await loadOverview(resolved.document, definition, registry, {
  locale, tenantId, db /* the request's permission-checked capabilities */,
});
return { overview };   // LoadedOverview: JSON, serializable
```

- A widget's `load(options, ctx)` receives **validated options only** and a
  `WidgetLoadContext` the host built from the request principal: `overviewId`, an
  abort `signal`, `locale`, and any host capabilities (index keys). It must
  authorize through `ctx` (the user's permissions and tenant filters), never
  through option values. Reports-backed chart loaders call the runtime-report
  compiler with this context; this package does not depend on it.
- Loads run in parallel with a per-widget timeout (default 8 s; the signal
  aborts). A thrown error, a timeout or non-serializable / oversized data
  (default 256 KB of JSON) becomes a per-widget error tile
  (`error.code`: `load_failed | timeout | invalid_data`); the real error goes only
  to `onError` for server logs, never to the client. One bad widget never fails
  the page.
- `LoadedOverview` is what the page returns and `createOverview({ loaded })` seeds
  the controller from, so the grid renders every widget at first paint with no
  client-only fetching and **no hydration mismatch** (the grid has no
  effect-dependent content; the only `$effect` requests data for widgets the
  seeded entries do not cover, which never happens on first render).
  `scripts/overview-ssr.test.mjs` renders the grid through Vite SSR.
- Formatting is deterministic per locale (`Intl` with the i18n store's locale), and
  no widget formats dates or reads the clock; loaders send preformatted meta.

## Controller (`controller.svelte.ts`)

`createOverview({ definition, registry?, override?, onchange?, canCustomize?,
loaded?, loadWidget? })`, the `ShellLayout` pattern: **persistence is host-owned**.
With an `override` getter the host is the source of truth and feeds each edit back
(`onchange(override | null)`); without it the value is kept in memory. Reactive
reads: `document`, `base`, `override`, `issues`, `customized`, `canCustomize`,
`addable`, `full`, `entry(widget)`. Operations, each returning
`{ ok: true, id } | { ok: false, reason, issues? }` and refused with
`not_allowed` when `canCustomize()` is false (the role gate; the server must check
the same on save): `add(type, options?)`, `remove`, `move(id, toIndex)` (index
after removal), `resize(id, span)`, `setOptions`, `resetWidget`, `reset`,
`restore(override)` (the Undo hook), `reload(id)`.

`loadWidget(widget, signal)` is how a client edit gets data for an added or
reconfigured widget: the host runs the widget's `load` where its data lives (a
remote function in production, the in-browser source in smrt-planner). The
controller drops results for stale option keys and aborts superseded loads.
Call `destroy()` when the owner unmounts.

## Grid and edit mode (`OverviewGrid.svelte`)

Props in `grid-types.ts`. `editing` defaults to the shell's layout editor
(`tryUseShellLayout()?.editing`), so the same pencil edits the grid under an
`AppShell` with `layoutEditing`; pass `editing` to drive it without a shell. It is
off whenever `controller.canCustomize` is false.

- **Flow grid.** CSS grid of 4 columns, 2 below 40rem and 1 below 22rem of the
  grid's own width (container queries); `data-span` / `--span` carry the span. Gaps
  are tile padding, not grid gap, so a drag never crosses a dead zone.
- **Reorder** uses the headless `createSortable` engine in its `flow` mode (a
  single wrapping list): the handle is the existing grip (Space picks up, any
  arrow steps along reading order, mirrored in RTL, Enter drops, Escape cancels;
  pointer and native drag use the horizontal midpoint for tiles sharing a row).
- **Resize** is an end-edge `role="slider"` (arrows, Home, End; pointer drag snaps
  to a column boundary via the pure `spanFromPointer`, committed on release).
- **Chrome** is icon-only `ShellIconButton`s (configure, remove) plus the toolbar
  (add, reset). Widgets render as on the site inside an `inert` wrapper. Add and
  configure open `Modal`s; `WidgetOptionsForm` is generated from the option field
  descriptors with smrt-ui `Form` / `FormGroup` / `Input` / `Select` / `Textarea` /
  `Checkbox` (the descriptors mirror the generated screens' field shape) and shows
  each schema issue beside its field. A widget with a required option and no
  default opens the form before it is added.
- A polite live region announces moves, resizes, adds, removals and resets.
  `OverviewGrid.test.ts` runs axe in view and edit mode.

## Core widgets (`widgets/`)

`registerCoreWidgets(registry, loaders)` registers `note` always and each
data-backed widget only when its loader is given (structural injection: this
package depends on no data package). Widgets render only when the grid has
`ready` data (it draws loading and error tiles) and treat `data` as untrusted
shape. Data shapes are in `widgets/data.ts`.

| Type | Options | Data |
|---|---|---|
| `metric` | `title`, `model`*, `measure`, `field`, `filter` | `{ value, format?, currency?, label?, change?, href? }` (money = integer minor units) |
| `chart` | `title`, `model`*, `groupBy`, `measure`, `field`, `period`, `style` (bar/line), `filter` | `{ points: [{ label, value }], format?, currency?, href? }`, one measure of a runtime report |
| `records` | `title`, `model`*, `sort`, `direction`, `limit`, `filter` | `{ rows: [{ id, title, subtitle?, meta?, href? }], total?, href? }`; the loader chooses the title field and the visible records |
| `shortcuts` | `title`, `section` | `{ items: [{ id, label, href, icon?, description? }] }`; `shortcutsFromNav(sections, sectionId)` maps `resolveShellNavModel` / `useShellLayout().sections` (visible entries, user renames) |
| `note` | `title`, `body` (Markdown) | none |

`note` renders `parseMarkdown` output as elements (headings, paragraphs, lists,
quotes, fenced code, bold/italic/code/links). There is no `{@html}`; raw HTML is
literal text and `safeHref` limits links to http(s), mailto, same-site paths and
fragments. Record and shortcut hrefs pass `safeHref` too. Charts carry their
numbers as text (inline for bars, a visually hidden table for the line).

## Recipe widgets (`recipe-widgets.ts`)

A package contributes a widget with a `widget` surface on a recipe
([core recipes.md](../../core/agents/recipes.md#widget-surfaces-3727) has the
declaration and its scan-time rules). `registerRecipeWidgets(registry, recipes,
resolveExport, { replace?, enabled? })` (async, Svelte-free, on both entries)
turns the manifest's widget surfaces into `registry.register(...)` calls:

| Surface field | Registration |
|---|---|
| `type`, `label`, `description`, `icon`, `version` | `type`, `title`, `description`, `icon`, `version` |
| `options` | `options` (plain JSON; `registry.register` re-validates the schema) |
| `export` | `loadComponent` (lazy; the export may be a component or a `{ default }` module) |
| `data.load` | `load` (resolved on first use; a missing or non-function loader is that widget's error tile) |
| `migrate` | `migrate`, **resolved eagerly** because the registry's `migrate` is synchronous |
| `allowedIn`, `defaultSpan`, `minSpan`, `maxSpan` | same names |
| `data.models` | not registered: documentation of what the loader reads; confine with the page's `models` |

- **The module resolver is injected.** `resolveExport(specifier, exportName)` is
  the host's: a static map of dynamic imports in a bundled app, a stub in tests.
  Nothing is imported when the manifest is read, and the registration itself
  imports nothing except `migrate` exports. Relative or absolute specifiers
  are refused.
- **Never throws for a bad surface.** The result is `{ registered, skipped,
  dispose }`; a skip carries `reason` `duplicate_type` (a core widget or another
  recipe owns the type; `replace` overrides), `invalid` (the registry refused the
  definition) or `unresolved` (a `migrate` export is missing). One broken package
  cannot take down the overview.
- **`enabled(recipeId)`** keeps widgets of recipes that are off out of the add
  list. Call the helper again (after `dispose()`) when the set changes.
- Widget types share one registry namespace with the core widgets
  (`metric`, `chart`, `records`, `shortcuts`, `note`). Pages still confine what
  can appear with `defineOverview({ allowed })`, and a widget with `allowedIn`
  only validates inside those overview ids.
- `src/components/overview/__tests__/recipe-widgets.test.ts` covers lazy
  resolution, the loader and migrate paths, allowed placements and the skip
  reasons. The scanner's copy of the option vocabulary and patterns is checked
  against `types.ts` / `schema.ts` by `packages/scanner/src/__tests__/recipe-widgets.test.ts`,
  and a type-level assertion here keeps `RecipeWidgetOptionType` equal to
  `WidgetOptionType`.

## Production persistence (phase 3, `@happyvertical/smrt-preferences`)

Overrides are stored as the `overview` kind of the generic user-interface
preference table `_smrt_ui_preferences` in
[smrt-preferences](../../preferences/AGENTS.md) (one row per tenant, kind,
surface id = `OverviewDefinition.id`, and tier; the kind contract is in its
[preference-kinds.md](../../preferences/agents/preference-kinds.md)). This
package stays free of database code: its overview entries import nothing from
core, tenancy or users. The `overview` kind validates with this package's
`checkOverviewOverride` on save (only the canonical override is stored) and
`resolveOverview` on load (bad entries dropped and reported per tier).
`createOverviewStore({ db })` is the overview-shaped layer over the generic
store and acts as the ambient principal:

| Call | Does |
| --- | --- |
| `load(definition, registry)` | Both tiers resolved page defaults < tenant < user; each tier's `override`, `revision`, `issues`, the merged `document` and `canCustomize: { tenant, user }` |
| `save(definition, registry, { scope, override, revision })` | Strict validation against the tier's definition (user: tenant-merged); `invalid` / `conflict` / `not_allowed` otherwise |
| `reset(definition, { scope, revision? })` | Deletes that tier's row |
| `loadPage(definition, registry, ctx, { scope? })` | `load` plus `loadOverview` of the tier's document, for `+page.server.ts` |
| `loadWidget(definition, registry, widget, ctx)` | One widget's data for the controller's `loadWidget` remote function (throw on `ok: false`) |

Host wiring for the personal layer: `createOverview({ definition:
withTenantDefaults(definition, data.overview.tenant.document), override: () =>
data.overview.user?.override ?? null, onchange: (next) => save({ scope:
'user', override: next, revision }), canCustomize: () =>
data.overview.canCustomize.user, loaded: data.overview.loaded, loadWidget })`;
the organization layer uses the page definition, `tenant.override` and
`canCustomize.tenant`. Keep the returned `revision` for the next save; on
`conflict` reload the page data. Permissions are `overviews.customize` (tenant
default) and `overviews.personalize` (own layout).

Known model limit: a tenant default that later adds a widget whose id equals
an id a user override already added hides the user's widget (an added widget
colliding with a base id is skipped). `nextWidgetId` avoids it within one tier
only.

## Extension points left for later phases

- **Phase 2, package widgets (#3727, done).** See "Recipe widgets" above.
- **Phase 3, production persistence (#3727, done).** See "Production
  persistence" above.
- **Phase 4, assistant.** The controller methods are the structured operations;
  `restore(override)` plus the `override` getter give Undo (snapshot before,
  restore after). `OverviewOpResult.issues` is the validation feedback to return.
- **Not built:** the activity widget (Track B, #3710) and agenda.
