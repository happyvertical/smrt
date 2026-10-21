# smrt-planner: Command set and `./core`

Part of the [planner guidance](../AGENTS.md). Paths are relative to `packages/planner/`.

- `src/lib/planner/commands/`: the planner command set (#22) is **smrt's cookbook command engine**
  (`@happyvertical/smrt-core/cookbook/engine`, smrt#3753) behind the planner's names; the planner is an
  adapter, so every rule of the commands (validation, revisions, command ids, atomic batches, undo,
  receipts, snapshot, `validate`/`export`) lives upstream. Fix a rule there, never here. Planner-side:
  `adapter.ts` (`createPlannerAdapter`, rune-free: `focus`, the planner tab/section cells, keeping the
  engine in step with an app whose UI edits the document between commands, handing the engine's new
  document back through a `PlannerPort`, the planner's strict import check before the engine's, "a
  library cookbook with no theme keeps the person's look"), `catalog.ts` (`engineCatalog()`: the
  planner's recipes, catalog models, library cookbooks, smrt-ui presets, currencies and setting targets
  as an `EngineCatalog`; nothing is bundled in the engine), `schemas.ts` (`commandTools` /
  `commandSchemas` / `buildCommandTools(recipeIds, cookbookIds)` over the engine's, plus the `focus`
  tool), `types.ts` (the engine's types; `PlanSnapshot` adds `focus`; `PlannerCommand` adds `focus`),
  `controller.svelte.ts` (`createPlannerController(store)`: the adapter over `cookbookStore` with
  `$state` cells and one `$effect` that tells subscribers about manual edits; `portFromStore`),
  `slices.ts` (`createSliceController`: the same over a bare recipe/settings/theme store, for hosts and
  tests). Commands are `{ name, input, id?, expectedRevision? }` and return
  `{ ok: true, snapshot, receipt, data?, replayed? } | { ok: false, error }`; `batch({ commands })`
  is all or nothing. A manual edit in the app (a store changed outside a command) is adopted on the next
  call as one revision and a new undo epoch: older undo ids answer `not_found`. Page customisations
  (`overviews`) are edited outside the plan and do not move the revision. Add a command upstream, then
  add its `EXAMPLES` row in `tests/planner-commands.test.ts`; `tests/headless-planner.test.ts` runs one
  script through the browser controller, the headless planner and a bare `createCookbookEngine`.
  `instance.ts` is the app's controller; `plannerRuntime` is how the layout lends it the data-source
  reset and section navigation. `Planner.svelte` is the mountable component (props in `types.ts`; `backLink`
  is a host's way out, a `header.start` slot item; `inference` switches the assistant on, see
  `src/lib/ai/`); the static app's Planner page renders the same one (`layout="shell"`,
  `persistence="host"`). The mount is a `CookbookApp` with `layoutEditing`, `plannerLoaders`,
  `widgetContext` and `resolveExport`, routed by URL fragment (`setBasePath(base, 'hash')` makes
  `appHref` write `#/...`); section pages are the framework's `CookbookSectionPage`
  (the themed card default, a `heading` snippet drawing `SectionHeading`, shared count-free
  overview defaults; remounted on a data reset), packages the planner's `PackagePage`.
  `assistant.ts` builds a chat transport over any controller. The stores (`cookbookStore`,
  `recipeState`) are still module singletons: one planner per page. Still planner-side and NOT yet
  deleted because the UI uses them directly (follow-up: route the UI through commands):
  `recipes/plan-data.ts`, `recipes/resolve.ts`, `settings/app-settings.ts`, `cookbook/assemble.ts`
  and `cookbook/parse.ts` (the import check, which also migrates old ids and checks page
  customisations; smrt-svelte's core widgets import `.svelte`, so a Node host drops `overviews` and
  says so).
- Packaging: `pnpm build` (the CLI version and catalog, `scripts/package-app.ts`,
  `scripts/build-mcp.ts`, then `svelte-package` with `tsconfig.package.json`; `verify:pack` runs
  `publint`) builds
  `dist/` from `src/lib` with exports `.`, `./commands`, `./core` and `./app`, the static app into
  `app/` (kept at the package root: released `smrt kitchen` CLIs resolve `<package>/app/index.html`)
  and the MCP widget `app/mcp.html`. `tsconfig.package.json` sets `declarationMap` (it does not
  extend the shared package chain that sets it for other packages), so every `dist/**/*.d.ts` has a
  `.d.ts.map` whose `sources` name its `src/lib` file; consumers such as s-m-r-t.dev resolve
  component source links through them. Code in `src/lib` imports relatively,
  never through `$lib` (svelte-package does not resolve kit aliases here). The components that import
  `$app/*` (section and model pages, the palette) are app-only: packaged but not reachable from
  either entry, so `@sveltejs/kit` is an optional peer. Everything the entries reach reads its base
  path from `planner/app.svelte.ts` (`setBasePath`), which the layout sets from `$app/paths`. The
  published root app remains available through `appDir`; subpath consumers use the owning-package
  `materializeApp({ outDir, basePath, config })` contract, never rewrite packaged files themselves.
- `src/lib/core/`: the `./core` export, for plain Node servers (no Vite, no runes, no `.svelte`).
  `headless.ts` (`createHeadlessPlanner`: the engine over a plain-object plan, with `focus`),
  `catalog.ts` (recipes, library cookbooks, `defaultCatalog`), `prompt.ts` (`buildHostPrompt`, which
  calls the browser assistant's `buildSystemPrompt` and adds the host-only commands section: never a
  second copy of the prompt), `reply.ts` (`replySchema`, `parseHostReply`), `request.ts`
  (`parseHostRequest`), `app.ts` (`appDir` plus atomic prefix-safe `materializeApp`, the `./app`
  export; the only Node-built-in module here).
  Everything it imports must stay rune-free and import JSON with `with { type: 'json' }`;
  `tests/core-package.test.ts` packages with svelte-package and runs it under bare `node`.
  `theme/theme.ts` reads the preset list from smrt-ui's Node-safe `@happyvertical/smrt-ui/themes/presets`
  (no copy, no drift test).

- Header navigation: `PlannerProps.headerNav` (`'icons'` default | `'labelled'`). Labelled shows Specs/Features/Styles/Build as `HeaderIconLink tone=...` buttons (`planner/header-nav.ts` maps button -> tab group -> href; Features keeps item id `planner-customize`, Build keeps `planner-export`), and `PlannerControls` limits the tab strip to the active tab's group. `'specs'` is a tab id (`SpecsPanel`, `cookbookStore.specs` / `setSpecs`), unlisted in the default icons strip. Forced-colors rules live in `HeaderIconLink`.
- Host export integration: `PlannerProps.exportLabel` optionally gives the native export shortcut visible text and the same accessible/slot label; omitted/blank preserves its icon-only default. `HeaderIconLink.showLabel` is internal and defaults false. Root and Node-safe core barrels re-export the existing `buildAgentPrompt`, `AgentPrompt` and `AgentPromptOptions` from `cookbook/prompt.ts`; no second prompt implementation. Hosts needing a string use the returned `.text`.
