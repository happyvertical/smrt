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
stays below the domain layer. The app passes them as props, or `CookbookApp` supplies resolved policies through context.

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
- **Tiers**: list shows basic scalar and named reference columns (no long text or JSON; capped at `DEFAULT_MAX_LIST_COLUMNS`, an explicit `columns`
  list is never capped); view and edit show advanced fields behind a disclosure
  (the edit one opens itself when an advanced field has a problem). Policy
  `label`, `help` and `required` win over the manifest; on create, a resolved
  policy default (an explicit `null` included) beats the manifest default.
  `locked` governs who may change the POLICY, never the record value, so it is
  not applied here.
- **Values are `values.ts`**: money (an INTEGER field with the `money` role —
  `ui.format: 'money'`, the legacy `ui.widget: 'currency'`, an explicit role,
  or a money name; see "Field roles") is integer minor units end to end. Editing shows major units but converts
  with exact string math (`majorStringToMinorUnits`), never `* 100`; integers are
  rejected unless JavaScript-safe; datetimes go out as ISO strings (an unchanged datetime keeps the
  loaded record's full precision via `parseDraft`'s `record` context; the control
  only shows minutes); JSON as parsed values. For display an empty JSON
  object/array (or one whose values are all blank) formats as `''`, the
  "Not set" placeholder, and `DetailScreen` lists a non-empty object as
  key/value rows (`jsonScreenEntries`). Empty optional text becomes `null` when the field is nullable and `''`
  otherwise (unset text persists as `''`); every other empty optional field is
  `null`. Errors are codes, mapped to messages by the component via `useI18n`.
- **Named references use `references: ScreenReferenceSources`.** Each entry holds
  the exposed target's definition, the same `RecipeScreensSource` used for its
  screen, and an optional `href(id)` for its record route. Edges resolve by
  `relationships[].relatedCollection`; names read only the owning manifest's
  `displayLabelField`, never per-screen guesses. `ListScreen` includes basic
  foreign-key and cross-package columns, resolves repeated IDs once per source
  and snapshot, and sorts/filters their displayed names. `DetailScreen` and the
  record header link names when the target supplies a route. Failed, deleted,
  unnamed or unavailable targets show “Linked record unavailable”; a late answer
  from a previous snapshot cannot replace the current name. The legacy
  `relations` / `labels` / `hrefFor` props remain supported.
- **Create/edit references use smrt-ui `RelationInput`.** It calls the target's
  `source.search({ query, offset, limit })` with 25-row pages, resolves the
  initial selection through `get`, and submits the ID. Search never downloads
  the collection through `list`. Arrow keys / Enter select, Escape restores the
  committed label, Tab reaches “Load more records”, and optional references
  have a named Clear button. Search errors and empty results are announced.
  A missing target or searchable display label disables the picker with an
  explanation while preserving the stored ID on unrelated edits. All picker
  messages use `strings.screens.ts`.
- **REST adapters.** REST-only `endpoint` / `actions` metadata belongs to the
  adapter parameter types, composed from smrt-web; the transport-neutral
  `ScreenCollectionDefinition` omits it so consumer definitions can extend
  both their REST contract and the screen contract.
  `createRecipeScreensSource(definition, fetchers)` uses
  smrt-web's envelope/error handling and exposes only permitted mutations.
  `search` requests `limit + 1` rows, `offset`, a display-field `like` filter,
  and stable display-field/ID ordering. `createRecipeScreenReferences(definitions,
  { basePath, fetch, hrefFor })` builds the map for the exposed definitions;
  `basePath` defaults to `/api`. Pass the app's record-route resolver as
  `hrefFor(definition, id)`; no route is guessed for a model with data only.
  `RecipeScreens` forwards the map to every mode; absent an explicit map it
  builds REST sources from `definitions` (routes still belong to the host).
- **Transport-neutral.** `RecipeScreens` drives a `RecipeScreensSource`
  (`list` / `search` / `get` / `create` / `update` / `delete`); an operation the source lacks
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
  default and does not replace it. Recipe surfaces receive the same resolved screen policy.
- Component props live in `types.ts`, not in the `.svelte` files, so the barrel
  never re-exports types from a component.
- **Where a package model's definition and data come from (#3749).** A cookbook
  app's `smrt()` preset hosts the cookbook's package models; the definition is
  `collectionDefinitions[<collection>]` from `@smrt/web` and the source is the
  model's `/api/<collection>` route (see [cookbook-shell.md](cookbook-shell.md)).
  A model the API does not expose has neither, so the entry page shows its notice.

## Field roles (`roles.ts`)

`deriveFieldRoles(definition)` is the pure, Node-tested rule for what a field
MEANS on a record page: `FieldRole` = `title | identifier | status | money |
quantity | date | party | subtotal | tax | discount | total`, several per field
(`totalAmount` -> `['money', 'total']`), one key per declared field. Sources in
order:

1. Explicit metadata on `ScreenFieldDefinition`: `role` (authoritative — name
   heuristics never add to it), `format` (`money | date | datetime | percent`,
   wins over `ui.format`), `display: true` (the `title`), `enum`.
2. Manifest hints: `ui.format`, and `ui.widget: 'currency'` on an INTEGER (on
   a text field it is the currency-code picker, never money;
   `currencyCodeField` finds it, and `RecordScreen` formats amounts in the
   record's own currency).
3. Name heuristics: `*Amount|*Total|price|cost` -> money on integers only;
   `subtotal|tax|discount|total` (not `*Rate`); `status|state` WITH an enum;
   `number|reference|code` but not `phoneNumber` / `postalCode` /
   `currencyCode`; `*At|*Date|*On|*Until` datetimes; `quantity|qty`; an FK
   whose name or target collection is party-like (customer, vendor, profile,
   ...). Without a `display` field the first text `name|title|label|
   displayName` is the title.

`deriveScreenFields` uses them: a text field with an `enum` is kind `select`
(`options`), money comes from the roles, and every `ScreenField` carries
`roles`. `formatScreenValue` shows `format: 'date'` without a time and
`format: 'percent'` as a percentage. Helpers: `fieldsWithRole`,
`fieldWithRole`, `isDocumentLike` (identifier plus party or total),
`hasLineItemRoles` (quantity plus money). Columns by role are
`screens/columns.ts`: `relatedColumns` (identifier or title, status, lead
date, party, amount) and `lineItemColumns` (item, quantity, unit price —
`summarize: false` —, amount).

## Relations (`relations.ts`)

`deriveScreenRelations(definitions, model)` is the pure, Node-tested rule for
what a record view shows around a record. `definitions` is every exposed
collection definition keyed by collection name (`collectionDefinitions` from
`@smrt/web`); `model` is a qualified `objectRef` (or a key of the map). It
reads the generated `relationships` edges (`ScreenRelationshipDefinition`:
`field`, `kind`, `relatedCollection` — a collection **name**, resolved by map
key, then by `name`), so a definition without `relationships` has no
relations. A `ScreenRelation` is `{ model, field, label, kind, columns?, sort? }`
(`relationKey(relation)` = `Order-customerId`):

| `kind` | Meaning | `model` | `field` | `label` |
|---|---|---|---|---|
| `children` | another collection with a `foreignKey` / `crossPackageRef` edge targeting this model | the child's `objectRef` | the FK on the child | the child's plural title; two FKs to the same parent disambiguate as `Orders (Approver)` |
| `items` | a `children` edge marked `relationships[].role: 'items'` (core `@foreignKey(T, { role: 'items' })`), or a child with line-item roles and one FK here | as `children` | as `children` | as `children` |
| `reference` | one of this model's own FK edges | the target's `objectRef` | the FK on this model | the field label (`ownerId` -> `Owner`) |

`items` come first, then `children`, each sorted by label, then `reference`
in declaration order. `children` carry `relatedColumns`, `items`
`lineItemColumns` and a line `sort` (`sortOrder`, `position`, `lineNumber`,
`sequence`, else `createdAt`).
Edges whose target or source is not in `definitions` are skipped (an unexposed
model has no route to link to), as are `oneToMany` / `manyToMany` edges and
edges whose field the definition does not carry.

## RecordScreen (`RecordScreen.svelte`, `./screens`)

The record page: a header, a details card, a customizable `OverviewGrid`
below, and the edit form as a **mode** of the same screen. Props are
`RecordScreenProps` in `types.ts`.

- **Header anatomy (`RecordHeader.svelte`, model `deriveRecordHeader` in
  `record-header.ts`).** A small back link above the title; the heading is
  `title`, else a document's kind and identifier ("Order GRA-3159",
  identifier monospace — never the party), else the title-role field, else
  the identifier, else the class name; a non-document's identifier shows as
  a monospace chip; the status is a `Badge` toned by value (`statusTones`,
  else `DEFAULT_STATUS_TONES`, else neutral); two to four key facts by role
  (party link, lead date shown date-only, total money, then email / phone).
  It reads only the view fields, so a field the policy omits never reaches
  the header. Actions: Edit is the one primary button (hidden while
  editing); a "More actions" popover holds `extraActions` and Delete, which
  still confirms.
- **Details card.** `DetailScreen` with `variant="card"`, `hideEmpty` (empty
  fields behind "Show empty fields (n)") and `exclude`: what the header
  shows, the currency-code field, and — when the model has an `items`
  relation — the subtotal / discount / tax / total role fields, which the
  line-items totals block shows instead. `children` render inside the card.
- **Body = `recordOverview(definition, relations)`** unless an `overview` is
  passed: the summary strip, `line-items`, then `related` (see
  [overview-surfaces.md](overview-surfaces.md#record-overviews-recordts)),
  persisted **per model kind** under `recordOverviewId(objectRef)`
  (`detail:acme.shop.Customer`). The grid renders `presentation="plain"`,
  follows the shell's layout editor unless `layoutEditing` is passed, and
  offers the child models in its add dialog. `override` / `onoverviewchange`
  are the host-owned persistence pair of `createOverview`
  (`@happyvertical/smrt-preferences`, kind `overview`, in production); omit
  `override` to keep edits in memory. With `loaders.records` the screen also
  registers `related` and `line-items` (`registerRecordWidgets`) with the
  record's totals (`recordTotals`) and currency.
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
- **Edit form.** `EditForm` edits a `select` field with a smrt-ui `Select`
  (humanized choices, "Not set" unless required, an out-of-list stored value
  kept). `derivedFields` render read-only and formatted with "Worked out
  from the line items." and are never in the payload; `RecordScreen` passes
  its `derivedFields` prop, else the totals role fields when an `items`
  relation exists. `items?: Snippet` (the host's line-items editor) renders
  under the form, in the edit column on desktop and inside the edit sheet on
  phones.
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
- Strings: `ui.screens.view_all`, `ui.screens.related`, `more_actions`,
  `details`, `show_empty`, `derived_hint`, `select_none`, `items`, and the
  existing `ui.screens.edit_title` for the aside and sheet heading.
- Tests: `__tests__/roles.test.ts`, `__tests__/record-header.test.ts`,
  `__tests__/relations.test.ts`, `__tests__/RecordScreen.test.ts` (header
  anatomy, overflow Delete, details exclusions, line items and the mismatch
  flag, derived fields and the items slot on both layouts, axe
  in view and both edit layouts, the record context reaching every loader,
  "View all" hrefs, host-owned override edits, record change reload) and the
  link cases in `__tests__/DetailScreen.test.ts`; `overview/__tests__/record.test.ts`
  and the parent-context case in `overview/__tests__/load.test.ts`.

## Reference validation and remaining projection requirement

`__tests__/references.test.ts` uses mock data sources and an injected REST
fetcher; `smrt-ui`'s `RelationInput.behavior.test.ts` covers the pagination
primitive. Run `pnpm --filter @happyvertical/smrt-svelte test` and
`pnpm --filter @happyvertical/smrt-ui test`.

| Behavior / trigger | Positive case | Failure / invariant | Evidence |
| --- | --- | --- | --- |
| List mounts with FK/cross-package IDs | Both columns show names; name search retains row | Repeated IDs share lookup; late/deleted targets cannot show old names | Component mock-source test |
| Record/detail opens | Name links through target route in detail and party header | Missing name shows unavailable notice; legacy callbacks still work | Component tests and axe |
| Create/edit opens and searches | Initial label; bounded name search; next page; keyboard select posts ID | Empty/offline search preserves selection; no full-list call | Component mock-source test |
| Clear/save | Optional clear submits null | Required empty blocks save; unavailable target keeps stored ID | Component tests |
| REST search | Declared label, limit/offset, stable ordering | No search without label; disallowed mutations absent; transport errors propagate | Injected-fetch test |
| Pagination action | Tab reaches action, appends unique results, returns focus | Old page discarded on new query; failed page retains prior results | smrt-ui component tests and axe |

Actor: browser user; data executor: mock source or injected REST fetch, no
persistence/transaction changes. Runtime: Svelte 5 / jsdom / Node 26; SQL dialect
coverage is N/A because transport-neutral screens do not execute SQL. Existing
field-policy exclusion tests remain mandatory. The new default-column assertion
was also executed against isolated copies of the base and head derivation modules:
the base failed the reference-column assertion and the head passed.

**Linked display names.** Core supports `display.label: { via, field,
fallback }`; generated definitions carry `displayLabelField: 'displayLabel'`,
`displayLabelProjection`, and a public text field with `readonly: true`.
The server resolves the related name before filtering, sorting and pagination.
Reference sources use the same bounded name query as an own-field label; screens
never load the Profile collection themselves. Commerce Customer declares this
for `profileId` → Profile.name, with `Unnamed customer` for a missing target.

`deriveScreenFields` keeps readonly fields out of edit inputs and submitted
payloads, even with explicit `fields`. Their values remain available in the
record header/view and list name column. The display field leads default columns
when no explicit order overrides it. A resolved policy still owns visibility
and labels: hidden or omitted fields never reach the header/list, a custom label
wins, and policy inclusion cannot make a server-computed field writable. This
uses the existing field intersection and title role, with no new policy resolver.

B1b interaction tests extend existing `fields.test.ts` and `references.test.ts`:
manifest-readonly cannot be overridden by explicit edit fields; policy label,
hidden and omitted cases; rendered record heading/list column; and submitted
payload exclusion. The commerce canary exercises the actual REST-to-reference
source path; core tests check SQL query bounds and live exposure before reads.

Registry-based `smrt-fields.resolveFieldPolicy` currently enumerates registered
model fields and does not enumerate the virtual `displayLabel`. Such a policy
omits the name, and screens continue to exclude omitted fields. The owning
policy resolver must expose the validated readonly projection as an addressable
presentation field for cookbook policies to label/hide it; defaulting around a
missing policy entry in screens would weaken the existing exclusion rule. The
B1b screen tests use explicit structural policies and do not claim that resolver
integration is implemented here.

Reuse check: repeated MCP `review_smrt_project` on smrt-svelte; read the intent
index and searched readonly/readOnly/derivedFields/displayLabel/ScreenFieldPolicy
in screens, smrt-ui, chat, core and smrt-fields. Reused `deriveScreenFields`, the
existing title-role/header and source implementations, and the existing test
fixtures. No production file, helper or component was added. Structural types
mirror core/web projection and readonly metadata; `ScreenFieldPolicy` is unchanged.

## Reuse audit (B1)

Audited the five B1 commits against base `06c0b64fe3`, using Node 26.12.1.
The added production files are `ReferencePicker.svelte`, `references.ts`,
`reference-labels.svelte.ts`, and `source.ts`; the fifth added file,
`__tests__/references.test.ts`, is test-only. New public types in the existing
`types.ts` are `ScreenSearchRequest`, `ScreenSearchPage`,
`ScreenReferenceSource`, and `ScreenReferenceSources`; `ReferencePicker.Props`
is component-local. `RelationInput.more` extends the existing primitive.
No model, route, or tool was introduced.

The configured smrt-dev-mcp server was available. Ran
`review-smrt-project` with duplicate detection and source evidence on core,
smrt-ui, smrt-web, and smrt-svelte; its findings do not identify these additions.
Used `build-context` architecture queries for the exact names plus their
purposes (reference picker; display-name/target resolution; bounded REST
source; search/reference types), `build-package-specialist-context` for
smrt-ui, smrt-svelte, smrt-web, core, chat, and commerce, and
`introspect-project` for the commerce model inventory. This server exposes
context/introspection tools rather than a separate component-search tool.
Read `docs/knowledge/intents/index.md`. Verified candidates with `rg` by both
symbol and purpose across those packages, profiles, types, and planner, plus a
workspace-wide search for record-label/display-label helpers.

| Addition | Searches and existing candidate | Decision |
| --- | --- | --- |
| `ReferencePicker.svelte` (including its options/page/search/resolve handlers and Props) | MCP picker context; `rg` ReferencePicker/RelationInput/selector/picker/search/hasMore. Read smrt-ui RelationInput/Combobox, commerce PartySelect/CustomerSelect/VendorSelect, planner RelationField, chat ModelPicker. | Keep the manifest/source adapter over RelationInput. PartySelect requires commerce DTOs; planner RelationField requires its catalog, recipe state, preview source, and nested forms; ModelPicker selects inference models. No other live, metadata-driven paged adapter exists. |
| `references.ts` (screenReferenceTarget, screenRecordLabel, screenReferenceId) | MCP naming context; `rg` targetOf/relatedCollection/displayLabelField/recordLabel/displayLabel/idOf. Read screens relations.ts, core ui-metadata.ts, planner display.ts/labels.ts, and palette rowTitle. | Reuse the existing targetOf resolver, extended to reference-source maps. Keep the strict resolved-metadata value reader and scalar ID guard: planner/palette helpers guess fallback fields or IDs; core resolves field metadata, not row values; RecipeScreens.idOf is component-bound and accepts broader values. |
| `reference-labels.svelte.ts` (useScreenReferenceLabels) | MCP naming/source contexts; `rg` relationLabels/cache/dedup/stale/resolveLabel. Read planner relationLabels, smrt-web createSmrtWebQuery/createSmrtWebClient, and Svelte remoteQuery. | Keep snapshot binding to arbitrary source.get. Planner traverses its sample catalog recursively; remoteQuery needs a collection and the canonical query protocol. Neither binds per-field labels to this transport-neutral source. Coalescing lasts only for the current snapshot. |
| `source.ts` (createRecipeScreensSource, createRecipeScreenReferences) | MCP source context; `rg` createDefinitionFetchers/unwrapListResult/createCollectionImportExport/defaultSearchRows/paging. | Already reuses smrt-web fetchers and envelope/error helpers. Import/export accumulates entire exports; palette search returns ranked navigation items without paging. Keep the small screen-source adapter. |
| `types.ts` additions | MCP type context; `rg` DataQueryOffsetPage/SmrtWebQueryPage/RelationOption/SearchRequest/ReferenceSource. | Derive ScreenSearchRequest bounds from DataQueryOffsetPage. Keep the source map and minimal page contracts; full query results require protocol metadata, while RelationOption is the existing control's ID/label DTO. |
| `__tests__/references.test.ts` (mockReferences) | Existing screen fixtures and smrt-ui test-support setup/a11y; `rg` mockReferences and component golden tests. | Reuse the golden-test harness; the new mock is a local fixture for this source contract. |

The planner's Profile-name lookup is preview application code and scans the
whole Customer/Vendor collection. It cannot provide the missing owning-package
projection or bounded REST filtering described above; it was not copied.

## Cookbook policy and vocabulary context

`CookbookApp` resolves its raw `cookbook.policies` automatically through
`@happyvertical/smrt-fields/policy.resolveCookbookFieldPolicy`. That is the pure
kernel extracted from the existing server resolver: code seeds, sparse encoded
app rows, required-field safety and policy locks have one implementation.
`RecipeScreens`, standalone list/record/detail/edit screens and definition-driven
`ImportExport` consume the context. A host supplies its cookbook, catalog and
normal definitions/sources; it never needs to pre-resolve field policies.
Explicit screen policies and the older `CookbookApp.fieldPolicies` override
remain supported for hosts that already resolve tenant/user layers on the server.

Collection vocabulary comes from the active shell entry, including
`layout.items[id].label`. `RecipeScreens.entryId` disambiguates keyed entries for
the same model. A layout rename is used as written for both collection and
record-kind labels; otherwise the recipe's explicit `noun` wins. There is no
singularization guess. Explicit definition `label` / `singularLabel` wins over
the shell. Navigation Reset still restores the recipe label because `navGroups`
retain their originals.

`ScreenFieldPolicy.readOnly` controls the record value; `locked` controls policy
customization. Read-only controls show the formatted value and never enter edit
payloads. Hidden fields never become controls, columns, search values or exports.
Edits omit hidden/read-only values, preserving existing data under patch updates.
Creates include resolved defaults for hidden/read-only fields, explicit null
included. Changing the policy re-seeds a mounted form. Raw default values are
validated by the owning field resolver against the generated field type. The
resolved currency default also controls minor-unit conversion (KWD uses three
decimals); edits format and preserve the record's own currency.

`RecipeScreens` loads a recipe-owned `route` surface when its declared path
exactly matches the selected entry path. `surfacePath` selects another declared
route, including a record route managed by a host router. The component receives
`definition`, resolved `policy`, `source`, `view`, `recordId` and optional
`surfaceProps`. No declared match, unavailable export or failed import uses the
generic screens. Components load through the shell's generated resolver; no host
component map is needed. This is client-side lazy replacement; SSR retains the
generic screen until the selected component loads.

Regression evidence uses the existing cookbook harness and an installed fixture
package in `screens/__tests__/RecipeScreens.test.ts`:

| Behavior / trigger | Positive | Negative / invariant | Context and executor | Runtime / edge | Level / command |
| --- | --- | --- | --- | --- | --- |
| Navigate list/create/view/edit | Cookbook collection/field labels reach navigation, titles, actions and back links | Original model vocabulary absent from renamed navigation | Cookbook context; memory source, no SQL transaction | Svelte browser; resolved-policy input | Component; package `pnpm test` |
| Create with raw hidden/read-only defaults | Defaults reach create payload | Hidden control absent; read-only value cannot edit | Raw cookbook; same source create spy | Svelte browser; wire payload | Installed-package fixture; package `pnpm test` |
| Edit a visible value | Visible edit saved | Hidden/read-only stored values preserved | Cookbook context; patch update spy | Svelte browser; wire payload | Component; package `pnpm test` |
| Search/export | Visible fields remain searchable/exportable | Hidden value cannot match a row, become a column or reach CSV | Raw cookbook; memory rows and download spy | Svelte browser; DataTable/ImportExport | Component; package `pnpm test` |
| Select a recipe route | Installed manifest component renders with raw policies | Recipe without a surface or with a missing export retains generic screens | Actual consumer plugin, fixture package; no host mapping | Svelte browser; generated dynamic import | Fixture; package `pnpm test` |

The four original context regression tests were also run against the original
product sources: all four fail there and pass with the context implementation.

The installed fixture's nine new regression cases fail against the previous
committed screen implementation; all twenty screen cases pass on the integrated
implementation.

Integration cases in `RecipeScreens.test.ts` cover manifest-proven app aliases,
live host exposure projection, and read-only/hidden reference pickers under raw
cookbook policies. The read-only picker remains disabled and resolves a display name;
the hidden picker never loads its target. Existing source and reference-label APIs
are reused unchanged.

## Q1 shared-screen defaults

Generated `listFields` comes from the owning model's `display.list`; the display
label leads. Internal hash/JSON/authority/provenance and plain id columns are never
defaults. Explicit policy exclusions remain authoritative. Required and primary
edit fields render in the basic tier; if no basic field remains, the first allowed
input is promoted. An empty editable set renders a notice instead of an empty form.

Virtual inputs carry `writeThrough: '<link field>'`. Selecting a different existing
record omits those inputs from the payload, preserving that contact's own values.
The server still owns linked writes and transaction/tenant enforcement; see
[core's contract](../../core/agents/write-through.md). Cookbook item `singularLabel`
overrides the derived singular label. Reference labels use the target cookbook
entry; explicit field policy labels win. CookbookApp renders `chat.assistant`
through its authenticated, host-bound assistant panel and never separately mounts
the raw recipe component without its transport and registry.

Save failures from `SmrtWebRequestError` display its safe typed `publicMessage`
for 4xx responses. Unexpected failures display the generic save message with
the server-created `requestId`; arbitrary server exception text stays hidden.


### Inline prerequisite fields (Q1 follow-up)

`deriveScreenFields` accepts the app's available reference sources. If a link
owns inline `writeThrough` inputs but its target has no available list, view and
edit omit that prerequisite link and retain the inline fields. Ordinary
references keep named links and selectors when the target is available. Cookbook
vocabulary labels an available existing-record selector with the cookbook's
singular noun. The same existing vocabulary substitution applies to implicit
field labels (for example Member type), explicit labels and help. RecipeScreens refreshes the current detail snapshot after saving
an unchanged record id, as well as refreshing the list. Regression tests exercise
all three contact values, clearing, client search/sort, prerequisite omission and
preservation of an available named link; no new component/helper file was added.
