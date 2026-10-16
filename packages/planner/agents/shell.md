# smrt-planner: Shell, pages, data and components

Part of the [planner guidance](../AGENTS.md). Paths are relative to `packages/planner/`.

- `src/lib/sections/` and `src/routes/s/[section]/`: the sidebar is `navMode="sections-with-items"`: sections
  (icon + name) with their entries beneath when expanded, icons only in the rail; each section opens its own page at `/s/<slug>/` (`path.ts`: `section:sales` ->
  `section-sales`; `entries()` prerenders recipe sections, More and the cookbooks' custom sections, the
  static fallback serves the rest, e.g. visitor-made ones). `components/SectionPage.svelte` shows the
  icon, title (the layout's rename wins), description (`info.ts`: recipe `section.icon/description`,
  `FEATURE_SECTION`, cookbook `sectionDescriptions`), Help/Options icons (`entries.ts` `optionGroups`),
  and the section's editable overview (`SectionOverview.svelte`, see `src/lib/overviews/`; its
  `shortcuts` widget replaces the menu cards; the grid is `presentation="plain"`, page sections rather
  than cards in a card); in edit mode the entries follow as smrt-svelte's `ShellSectionMenu` list.
  `SectionView.svelte` is the route page's body (the static shell is a plain `AppShell`, so it cannot
  use `CookbookSectionPage`); `SectionHeading.svelte` is the icon/title/description heading it shares
  with the mount. A section id outside the overview id pattern keeps the `ShellSectionMenu`
  cards with "N records" and "New <noun>". New asks the entry page to open its create form through `planner/create.ts` (a
  one-shot, page-named, expiring request; the URL carries only the shareable state). In edit mode the
  rows get the grip/rename/hide chrome, so `PlannerEditBridge` does not leave a section page. Every
  recipe `section` and every cookbook custom section (`layout.sections[id].icon`) must have an icon from
  smrt-svelte's shell icon set (tests/section-pages.test.ts); visitor sections get `folder`.
- `src/lib/overviews/`: section pages as customisable overviews (smrt-svelte `./overview`, smrt#3727).
  `definitions.ts`: one `defineOverview` per section, id = the section's layout id, static (never
  depends on which recipes are on): `shortcuts` (the section's entries with record counts: the framework's entries through
  `composeShortcutsLoader(loadShortcutCounts)`, counting rows in each entry's scope from the
  `entryIndex` in the load context) then the
  section's lead model as a `metric` count and a `records` list; `allowed` = the core types the planner
  loads plus recipe `widget` surfaces, `models` = the catalog. `isOverviewId` is what a cookbook may
  key: recipe sections, More, and the document's own `layout.customSections`. `registry.ts`: the one
  registry, core widgets with loaders over the in-browser `DataSource` (capabilities in the load
  context, never in options; a named `filter` is an error tile, the sample data has none; `chart`
  groups the sample rows itself, the in-browser stand-in for a runtime report, for every chart style:
  bar, line, table, pie and stat read the same points), `plannerLoaders` (metric, records, chart, and
  `shortcuts` = `loadShortcutCounts`) for the mounted `Planner`'s `CookbookApp`, and
  `registerRecipeWidgets` with a static, currently empty, module map. `models.ts`: the option
  editor's model choices, shared by the page and the mount. `validate.ts`: the cookbook's
  `overviews` field; every override goes through `checkOverviewOverride` on load and import, bad
  widgets and unknown ids are dropped and reported (`CookbookResult.dropped`), only canonical
  non-empty overrides are kept. `page.ts`: the controller wiring (`override` reads
  `cookbookStore.overview(id)`, `onchange` writes `setOverview`), shared by the page and the tests.
- `src/lib/planner/`: the package selection (`?p=a,b`, the only URL state;
  `app.svelte.ts` `appHref` carries it; `selection.svelte.ts`
  is the one store the control panel, navigation and a future chat assistant
  all drive).
- `src/lib/forms/`: LOCAL recipe `forms` / `extends` (not in `SmrtRecipe` yet):
  field-map and variant-grid forms that save several related models at once.
  Planners are pure (`planFieldMapSave`, `planGridSave` return `RecordWrite[]`),
  `DataSource.apply` runs them all or nothing. `cards.ts` in `recipes/` builds
  the Planner cards from `group` (sub-switches).
- `src/lib/data/`: `DataSource` (async, `apply` for related multi-model saves), the seeded in-memory fakes, money and
  value formatting. Sample packs (`packs.ts`) keep a vocabulary per field kind: `notes` (documents), `customerNotes`/`vendorNotes`, `descriptions` by model, `instructors` (staff Profiles that organise events), `quantity` ranges on lines. Never reuse one list for another kind of field. Views only talk to `DataSource` via context; live
  collections later replace `createMemoryDataSource()` in `+layout.svelte`.
- `src/lib/upstream/`: LOCAL stand-ins for s-m-r-t work the published 0.55.3
  manifests do not carry yet (`_meta.ui.widget` and `uiSelectors` from smrt#3611,
  the commerce `CustomerSelect`/`VendorSelect` from smrt#3602, undeclared
  `@foreignKey` relations), each file headed with what it replaces.
  `overlay.ts` applies the widget and relation hints to the catalog on load so
  consumers read `field.ui.widget` and `field.related` where the manifest will
  put them, and lends an STI leaf the enumeration its ancestor declares
  (smrt 0.56's Contract leaves lost `contractType`'s, smrt#4005); published
  values always win. Enum values, `displayLabelField`
  (`model.display`) and `RelationInput` (`@happyvertical/smrt-svelte/forms`) are
  published and read directly. Delete a stand-in when its issue ships.
- `src/lib/fields/`: `renderer.ts` picks the input per field (pure, tested);
  `FieldInput.svelte` renders it and `RelationField.svelte` the selectors.
  `data/labels.ts` (with `data/display.ts`) labels related records (Customer/Vendor via their Profile).
- `src/lib/components/`: generated list/form (`ModelWorkspace`; a row opens its record page), the
  record page (`RecordView`), the collapsed "Connect other tools"
  list (`ConnectTools`), the Help view (`HelpView`), `BrowserAssistant` (the dock slot: consent, progress, then smrt-chat's `AssistantDock`).
- Record pages (smrt#3718 record view): `/m/<pkg>/<Model>/<id>/` shows one sample row through
  smrt-svelte's `RecordScreen` (a header by field role: a document's kind and monospace identifier,
  "Order GRA-3159", else the record's name; status badge, key facts, Edit with Delete in the overflow;
  a details card; then the record's own editable overview) and `/<id>/edit/` is the same page in edit
  mode (the form beside the header on desktop, a sheet on phones; `ChildRecords`, the line-items
  editor, is RecordScreen's `items` snippet, so it is inside the sheet too). Nothing is hand-written
  per model: `src/lib/screens/` turns a catalog model into the framework's `ScreenCollectionDefinition` /
  `ScreenPolicy` (`definition.ts`: `enum`, `format` `money` by `isMoneyField` / `date` for business dates,
  `display` on a named model's label field, `relationships[].role: 'items'` on a line's edge to its
  document) and its relations (`relations.ts`: `reverseLinks` / `forwardLinks` from
  `recipes/plumbing.ts`; `items` for `itemModels`, the priced children named after the model, else
  `children`; each with the framework's role-chosen `columns`; children confined to the models in the
  app, references to every catalog target so `data/labels.ts` names them, e.g. a customer's Profile,
  while `RecordView`'s `hrefFor` links only targets in the app); derived here rather than through
  `deriveScreenRelations` because the catalog knows STI parents. `totals.ts` is the line-items totals block's
  data: an issued document's stored totals, else a draft's own subtotal / tax / total by role. The
  overview is `detail:<pkg>.<Model>` (`overviews/definitions.ts` `detailOverview`: the framework's
  `recordOverview` over the whole catalog's relations, every relation's metric tiles, so widget ids
  are stable whichever recipes are on; `detailOverviewFor` narrows the defaults to the app: the first
  four tiles, `line-items`, the tabbed `related`), saved in the cookbook's `overviews` like a
  section's (the framework's own `recordOverviewId` key, `detail:happyvertical.smrt-commerce.Customer`,
  is accepted for the same model). `related` and `line-items` are registered once on
  `overviewRegistry` and read `relations` / `totals` / `currency` / `viewAllHref` from the load
  context; each tab is one `records` load with `filter: 'parent'` + `field` (a metric's
  `parentField` when its `field` is measured) and a `columns` option, and `loadRecords` returns
  `cells`, `columns` and `summaries` summed over every matching row. Record names (`data/display.ts`):
  a document is its identifier (the framework's `identifier` role), a party its Profile name.
  "View all" is the list page with `?<fk>=<id>` (`planner/routes.ts`; the layout keeps that
  query, `ModelPage` / the mount's hash router turn it into the list's scope). The ids are sample
  data made in the browser, so the record routes are served by the static fallback
  (`[view]/+page.ts` treats a segment that is not a nav key as an id; `edit` is `prerender = false`).
  Sample foreign keys spread over every row of their target (`fakes.ts` `relatedIndex`), so each
  record has related rows; a customer-linked model (a FK to Customer) gets 3-6 rows per customer
  (`customerSlots`, seeded by the customer's index), so related lists hold several records. Sample
  lines are on smrt-commerce's money model (the only one since smrt 0.57.0): `data/money.ts` maps rows to
  `@happyvertical/smrt-commerce/money`'s own `calculateMoneyDocument` / `resolveLineTaxCode` (pure and
  browser-safe; never copy its arithmetic). A line's `amount` is quantity x unit price less its discount
  (`discountType` none / percent with `discountRate` as percent text / amount in `discount`): the net
  when prices exclude tax, the gross when they include it (net = amount - `taxAmount`). Tax is stored
  apart (`taxAmount`, `taxComponentsJson` per component, `taxRate` their sum), from the line's code:
  override, exempt customer, product, customer, app default. The document: subtotal = the lines' net,
  total = subtotal + tax, `discountTotal` informational (never subtracted again). Sample documents are
  priced the app's way (`lineAmountType`, `taxRoundingScope` from `getSamplePricing`); the app default
  code is exactly smrt's cookbook activation (`Default <rate>%`, out-of-scope at 0), so the planner
  prices what an exported cookbook will. About a third of documents discount their first line
  (percent or amount by document; percent where the app hides `discount`), about one line in seven
  chooses its own code (the example pack's code for the app's country, such as BC GST + PST for CAD,
  else exempt or zero-rated), and one customer in eight is tax exempt. `TaxCode` / `TaxComponent` /
  `TaxSettings` sample rows come from the same set (`planner-source.ts`), and lines resolve against
  those tables, so a code the visitor adds or edits applies. Only a document's own key makes it the
  document its lines settle in (a Product or TaxCode is not). Once the app states any setting, samples
  use its tax rate, 0 included; a fresh app keeps the pack's. The record page's `line-items` widget gets an issued
  document's frozen money as `storedTotals` (`screens/totals.ts`: header figures plus the lines'
  snapshots summed per component, e.g. GST and PST apart); a draft passes its live subtotal / discount / tax /
  total / `lineAmountType` and the widget checks them against the lines (net lines, `discountTotal`
  shown as included and never subtracted, an inclusive draft's gross lines less tax: smrt#4014, 0.56.2). The third Order and
  Invoice are drafts with a stale subtotal and total (`children.ts` `MISMATCH_*`) so the mismatch flag
  shows. A write the model refuses (a discount above the price, a code switched off, any line change on an
  issued document, whose money is frozen as smrt freezes it) throws `MoneyValidationError` and is undone,
  deletes and moves out of an issued document included, and the list and line editors show the reason;
  the current rate's default code is always available (smrt's activation creates it when the rate is set); a draft resolves the app's current tax defaults on every save, as smrt's does.
  Stored sample rows live under `smrt-planner:data:v6:`; bump it (never migrate) when line amounts change meaning.
- `src/routes/`: `/` Planner with `?tab=cookbooks|recipes|features|layout|export` tabs (`planner/tab.svelte.ts`; a visitor with nothing built lands on Cookbooks; smrt-ui `Tabs`: Cookbooks cards + preview, Recipes cards with switches only, Features the browsable catalogue of every recipe with its demo label, providers and what it adds, Layout `ShellLayoutEditor`, Export in `ExportPanel`: the cookbook summary, Copy prompt for a coding agent / Send to kitchen / Download with the file's name, size, apply command and JSON preview, then Import and Reset apart under "Replace or start over"), `/ai/` the AI models page (Set up your assistant), `/cookbook/` a client-side redirect to `/?tab=export`, `/recipes/[id]/` Options and `/recipes/[id]/help/` Help, where `id` is a section id (`recipes/sections.ts`: the group id, or the recipe id when ungrouped) so recipes of one group share one page each, reached by the `SectionIcons` help and settings icons in page headers (no Options/Help nav items),
  `/packages/` and `/packages/[id]/` the package browser, `/m/[package]/[model]/` (and `/[view]/`:
  a keyed nav entry, else a record's view page; `/[view]/edit/` its edit page).
  All prerendered but the record pages; `entries()` come from the catalog.
