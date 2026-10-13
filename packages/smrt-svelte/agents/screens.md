# smrt-svelte/screens

Module semantics for `src/components/screens/` (`./screens`). Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## Manifest-derived record screens (`./screens`, #3718)

`RecipeScreens` is the default screen set for a package that ships models but no
consumer UI (tags, facts, secrets, profiles, reports, prompts). It composes
`ListScreen`, `RecordScreen` (the record view, which itself composes
`DetailScreen`, `OverviewGrid` and `EditForm`) and `EditForm` (create), each of
which can also be used on its own. Every screen takes a generated web `definition`
(`ScreenCollectionDefinition`, structurally a `SmrtWebCollectionDefinition`) and
an optional resolved `policy` (`ScreenPolicy`, structurally smrt-fields'
`ResolvedObjectFieldPolicy`). The module imports neither package: smrt-svelte
stays below the domain layer, and the app passes both in as props.

- **Field selection is `fields.ts`, pure and node-testable.** `deriveScreenFields`
  is the single rule for list / view / edit. A field renders only when it is in
  BOTH the definition and the policy, so sensitive, transient and
  read-permission-gated fields (which the policy resolver omits) can never appear
  on a generated screen. Hidden fields are dropped; system fields (`id`,
  `tenantId`, `createdBy`, `updatedBy`, `createdAt`, `updatedAt`) are never
  editable, and the two timestamps appear on a view as read-only advanced meta.
  Do not add a second selection rule in a component.
- **Without a policy the code seed applies**: `ui.basic` / `ui.group` / `ui.order`
  hints and the cold-start rule (no `basic` markers => everything basic; any
  marker => unmarked fields advanced). Order is `order`, then declaration order.
- **Tiers**: list shows basic scalar columns only (no long text, JSON or raw
  reference columns; capped at `DEFAULT_MAX_LIST_COLUMNS`, an explicit `columns`
  list is never capped); view and edit show advanced fields behind a disclosure
  (the edit one opens itself when an advanced field has a problem). Policy
  `label`, `help` and `required` win over the manifest; on create, a resolved
  policy default (an explicit `null` included) beats the manifest default.
  `locked` governs who may change the POLICY, never the record value, so it is
  not applied here.
- **Values are `values.ts`**: money (`ui.widget: 'currency'` on an INTEGER field
  only) is integer minor units end to end. Editing shows major units but converts
  with exact string math (`majorStringToMinorUnits`), never `* 100`; integers are
  rejected unless JavaScript-safe; datetimes go out as ISO strings (an unchanged datetime keeps the
  loaded record's full precision via `parseDraft`'s `record` context; the control
  only shows minutes); JSON as parsed values. Empty optional text becomes `null` when the field is nullable and `''`
  otherwise (unset text persists as `''`); every other empty optional field is
  `null`. Errors are codes, mapped to messages by the component via `useI18n`.
- **Reference fields link (`relations`, `hrefFor`, `labels`).** `DetailScreen`
  renders a `foreignKey` / `crossPackageRef` value as `<a href={hrefFor(field,
  id)}>{labels[model](id)}</a>`; without an href the label alone, without a
  label the raw id in `<code>`. `labels` is keyed by the **target model id**,
  which the screen finds through the `reference` relations (below), so pass
  `relations` whenever you pass `labels`.
- **Transport-neutral.** `RecipeScreens` drives a `RecipeScreensSource`
  (`list` / `get` / `create` / `update` / `delete`); an operation the source lacks
  (or `can` turns off) is simply not offered, so a read-only source is a
  read-only screen set. `view` and `recordId` are bindable and `onnavigate`
  fires on every user navigation, so an app can mirror them into its router.
  `EditForm.onsubmit` throws to report a failed save or returns `{ fieldErrors }`.
  Remount `EditForm` with `{#key}` when switching records (`RecipeScreens` does).
- **`view` and `edit` are `RecordScreen`** (below); `create` stays the bare
  `EditForm`. `onnavigate` is unchanged (`edit` is still a view of its own, so
  a router maps it to `.../<id>/edit`). Pass `definitions` (every exposed
  collection, keyed by name) for the related-records panels and `record`
  (loaders, widget context, overview override and its `onoverviewchange`,
  `hrefFor`, `labels`, `viewAllHref`) for the rest of the record view; without
  `definitions` there are no relations and the view is the detail alone.
- **Not the policy-editing surface.** The policy gear, field-usage telemetry and
  the per-field renderer registry live in `ObjectForm`
  (`@happyvertical/smrt-fields/svelte`); `EditForm` is the dependency-light
  default and does not replace it. Not wired into recipe surfaces yet (#3708).
- Component props live in `types.ts`, not in the `.svelte` files, so the barrel
  never re-exports types from a component.
- **Where a package model's definition and data come from (#3749).** A cookbook
  app's `smrt()` preset hosts the cookbook's package models; the definition is
  `collectionDefinitions[<collection>]` from `@smrt/web` and the source is the
  model's `/api/<collection>` route (see [cookbook-shell.md](cookbook-shell.md)).
  A model the API does not expose has neither, so the entry page shows its notice.

## Relations (`relations.ts`)

`deriveScreenRelations(definitions, model)` is the pure, Node-tested rule for
what a record view shows around a record. `definitions` is every exposed
collection definition keyed by collection name (`collectionDefinitions` from
`@smrt/web`); `model` is a qualified `objectRef` (or a key of the map). It
reads the generated `relationships` edges (`ScreenRelationshipDefinition`:
`field`, `kind`, `relatedCollection` — a collection **name**, resolved by map
key, then by `name`), so a definition without `relationships` has no
relations. A `ScreenRelation` is `{ model, field, label, kind }`:

| `kind` | Meaning | `model` | `field` | `label` |
|---|---|---|---|---|
| `children` | another collection with a `foreignKey` / `crossPackageRef` edge targeting this model | the child's `objectRef` | the FK on the child | the child's plural title; two FKs to the same parent disambiguate as `Orders (Approver)` |
| `reference` | one of this model's own FK edges | the target's `objectRef` | the FK on this model | the field label (`ownerId` -> `Owner`) |

`children` come first, sorted by label, then `reference` in declaration order.
Edges whose target or source is not in `definitions` are skipped (an unexposed
model has no route to link to), as are `oneToMany` / `manyToMany` edges and
edges whose field the definition does not carry.

## RecordScreen (`RecordScreen.svelte`, `./screens`)

The record view: `DetailScreen` (header and fields) at the top, a
customizable `OverviewGrid` of related records below, and the edit form as a
**mode** of the same screen. Props are `RecordScreenProps` in `types.ts`.

- **Body = `recordOverview(definition, relations)`** unless an `overview` is
  passed: one `records` panel (newest five, span 2) per `children` relation
  (`{ metrics: true }` pairs a `metric` count with each), persisted **per model kind** under
  `recordOverviewId(objectRef)` (`detail:acme.shop.Customer`) — see
  [overview-surfaces.md](overview-surfaces.md#record-overviews-recordts). The
  grid renders `presentation="plain"`, follows the shell's layout editor
  unless `layoutEditing` is passed, and offers the child models in its add
  dialog. `override` / `onoverviewchange` are the host-owned persistence pair
  of `createOverview` (`@happyvertical/smrt-preferences`, kind `overview`, in
  production); omit `override` to keep edits in memory.
- **Loaders run in the browser with the record context.** `loaders`
  (`CoreWidgetLoaders`) are registered on a registry of the screen's own
  (or pass `registry` with recipe widgets on it); each `load` receives
  `widgetContext` extended with `overviewId`, the `signal`, `locale` and
  `record: { model: definition.objectRef, id }`, and honours `filter:
  'parent'` + `field` as overview-surfaces.md describes. A widget without a
  loader is not registered, so a default needing it is dropped (reported,
  never an error); without `loaders` the grid is empty. A record change
  reloads every panel; the registry and overview are fixed at mount, so
  remount (`{#key}`) to change the model kind — `RecipeScreens` keys on
  `definition.objectRef`.
- **One heading per related panel.** A `records` widget whose `model` +
  `field` + `filter: 'parent'` match a `children` relation (user-added ones
  included) is headed `Orders · 3` (the loader's `total`, else its row count)
  with the panel's only "View all": `viewAllHref(relation)`, else the loaded
  `href`. The screen strips `total` / `href` from that widget's data, so the
  body never repeats them. A `metric` widget keeps the plain title and no
  link (its number links when its data has an `href`).
- **`mode: 'edit'`** keeps the detail rendered and adds `EditForm`
  (`showHeader={false}`, keyed by record id, `fieldErrors` / `error` /
  `submitting` / `onsave` as `EditFormProps`): on desktop (`min-width: 48rem`,
  a `matchMedia` the screen watches; the server renders desktop) a sticky
  `<aside>` in a `minmax(0, 1fr) minmax(20rem, 28rem)` grid beside the header,
  sliding in with `--smrt-duration-medium1` / `--smrt-easing-standard` and
  still under `prefers-reduced-motion`; on phones a `PhoneSheet
  variant="page"` in a fixed full-screen `<section>` the screen owns (an
  `AdminShell`'s `overlays` snippet is a shell prop a screen cannot reach, so
  the screen stacks its own at `--smrt-z-index-modal`). The sheet stays
  mounted while closed so it animates open; the form inside mounts only in
  edit mode, so Cancel never keeps a stale draft. Cancel, the sheet's close
  button and Escape all call `oncancel`; the detail's Edit action hides while
  editing. `RecipeScreens` maps `onedit` to `navigate('edit', id)` and
  `oncancel` / a saved `onsave` back to `view`.
- Strings: `ui.screens.view_all`, `ui.screens.related`, and the existing
  `ui.screens.edit_title` for the aside and sheet heading.
- Tests: `__tests__/relations.test.ts`, `__tests__/RecordScreen.test.ts` (axe
  in view and both edit layouts, the record context reaching every loader,
  "View all" hrefs, host-owned override edits, record change reload) and the
  link cases in `__tests__/DetailScreen.test.ts`; `overview/__tests__/record.test.ts`
  and the parent-context case in `overview/__tests__/load.test.ts`.
