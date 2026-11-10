# smrt-planner: Cookbook, theme, settings and library

Part of the [planner guidance](../AGENTS.md). Paths are relative to `packages/planner/`.

- `src/lib/cookbook/`: the app document, a **cookbook** (smrt#3604's format, first instance; it
  was called a blueprint): one `Cookbook`
  (`{ $schema, version: 1, recipes, features, policies, exposure?, layout?, theme?, overviews? }`, schema
  `https://s-m-r-t.dev/schemas/cookbook/v1.json`; import also accepts the old `.../blueprint/v1.json`)
  holding recipes, options, layout and theme. Optional `name`, `description` and `specs` (free-text
  product requirements beyond the recipes and features, up to 20,000 characters; `store.setSpecs`,
  the `set_name` command and the Specs tab write it, and the agent prompt adds a step telling the
  agent to build them). `store.svelte.ts` is the single
  source of truth (hydrate, debounced save, import/reset), `storage.ts` the
  try/catch document wrapper, using `planner/workspace-storage.ts` for tab-scoped session storage by default and explicit Remember opt-in local storage (key `smrt-planner:cookbook-doc:v1`; a value under the old
  `smrt-planner:blueprint:v1` is read once, written to the new key and kept as a backup until the
  next successful save removes it; `smrt-planner:cookbook` alone is the library selection),
  `file.ts` the `<name>.cookbook.json` export (plus `slugify`, size and `formatSize`),
  `prompt.ts` the Export tab's prompt for a coding agent (the cookbook as minified JSON in a quoted
  heredoc with a collision-checked delimiter, the released CLI's commands, the app directory as a slug
  of the cookbook's name; the CLI version is `src/lib/smrt-version.ts`, generated from the installed
  smrt-core (the workspace's, so the release's) by `pnpm version:smrt`, the first step of `pnpm build`,
  gitignored, and guarded by
  `tests/smrt-version.test.ts`), `describe.ts` the tab's one-line-per-dimension summary, `validate.ts` the strict
  import check, `legacy.ts` the read-only `?r=`/`?o=` migration. Sample records
  are NOT part of it. `layout` is smrt-svelte's published `ShellLayout`: the
  store passes it to `AppShell` (`layout` / `onlayoutchange`) and the Planner's
  Layout tab mounts `ShellLayoutEditor`. Nav sections and items carry stable ids so a
  saved layout survives selection query changes. Nav SECTIONS belong to the app: a recipe only
  suggests one (`recipe.section`, else `group`, else itself; `recipes/sections.ts` `navSectionOf`),
  recipes sharing a suggestion share the section (`section:<id>`), and each recipe's main item
  carries the gear to its own group/recipe options page. `group` is the Planner card + Options/Help
  pages only. `cookbook/migrate.ts` rewrites pre-section layout ids in the loader.
- `src/lib/theme/`: the app's look, stored in the cookbook as `theme?: { preset?, colorScheme?,
  borderRadius?, density?, contrast?, fontFamily?, custom?: { primary, fontFamily? }, customCss? }`
  (absent = default `glass`/`system`, the preset's own radius, comfortable, contrast following the
  device). `theme.ts` validates known presets, hex colours, the radius/density/contrast enums (smrt-core's
  cookbook schema, the same names as `set_theme`'s inputs and `AppShell`'s props), allowed font keys and
  CSS text length.
  `runtime.ts` registers a brand-colour theme or a font variant of a built-in preset; ids include
  the colour/font because `ThemeProvider` looks each preset up once. The top-level font keeps the
  preset palette; the nested font remains readable for older cookbooks. `ThemeBridge.svelte` (in the
  layout, and inside `Planner`'s `CookbookApp` so hosted controls reach the plan; `deferInitial`
  lets the plan theme win over AppShell's browser-stored one) applies the cookbook theme and custom
  CSS to the shell, and radius, density and contrast through the provider's `updateConfig` (the mount's
  `CookbookApp` also passes them to `AppShell`; the static layout passes them as props).
  `ThemeSection.svelte` shows visual preset and appearance choices, corner radius / density / contrast
  selects (choosing the default removes the field), a colour picker and font control; `AdvancedStyles.svelte` edits the CSS on
  its own page. Cookbook CSS is untrusted (`theme/custom-css.svelte.ts`): it applies only once the
  visitor approves that exact text (SHA-256; typing it counts), is re-serialized by the browser
  inside an `@scope` rooted at this Planner's own shell (`data-smrt-planner-scope`), keeping only style,
  `@media`, `@supports` and `@container` rules (global at-rules like `@font-face`, `@keyframes`,
  `@property` are dropped) and dropping any rule whose declarations hold an escape or a load other
  than a literal `data:` URL, and `?styles=off` turns
  it off, drafts included. The assistant's token-based theme changes have an Undo. A library cookbook with
  no theme keeps the visitor's current look.
- `src/lib/settings/app-settings.ts`: app settings (currency, default tax rate, default payment terms,
  `pricesIncludeTax` and `taxRounding`, the last two Invoice/Contract `lineAmountType` /
  `taxRoundingScope` as in smrt-core's `COMMERCE_SETTING_TARGETS`) belong to the visitor's app, never to a cookbook. They are the same app-scope `defaultValue`
  policy rows a cookbook writes (no cookbook field); `SETTING_TARGETS` is the one list of which
  model fields each setting covers, `readSettings`/`writeSettings` read and upsert/remove the rows
  (a row only where the value differs from the model's own default). The cookbook preview and the
  Settings tab (`AppSettings.svelte`, `SettingsPanel.svelte`) both edit them; a cookbook only
  supplies starting values, and settings apply to new records only. Sample money follows the settings
  on the next reseed (`setSampleTaxRate`, `setSamplePricing`). The Settings tab also lists the sample
  tenant's tax codes (`data/money.ts`): the default from the rate, the seeded ones and smrt's example pack.
- `src/lib/library/`: the curated library of ready-made cookbooks (`LibraryCookbook`; not to be
  confused with the `Cookbook` document). `library.json` holds each entry
  (`{ id, name, icon, summary, keywords, settings, document }`); `document` is the
  same `Cookbook` the Export tab saves and must pass `parseCookbook` and the planner's own
  `validate` command, so every policy names a field its model has (tests check it,
  its layout ids against the nav the app generates, and that `settings` are what new
  records default to). Menu words come from `layout.customSections` (sections) and
  `layout.items[<navItemId>].label` (entries; smrt-svelte renders it once its build
  carries `items`, `CookbookLayout` in `types.ts` is the local type until then);
  nav item ids are `navItemId` (`item:<pkg>:<Model>`, recipes and features alike; a model
  that appears twice in the nav gives the extra `nav` entry a fixed `key` -> `item:<pkg>:<Model>:<key>`,
  never derived from the label). Ids never name a section or label, so renames and
  suggested-section moves keep saved layouts and cookbooks valid; `migrateNavItemIds`
  (`cookbook/migrate.ts`, run by `parseCookbook`) rewrites the old `section:...` item
  ids; `tests/nav-ids.test.ts` fails on duplicate ids. Defaults are app-scope `defaultValue` policy rows
  (`terms`, `paymentTerms`, `currency`, line-item `taxRate`, Invoice/Contract `lineAmountType` and
  `taxRoundingScope`), written only where the catalog default differs, plus `terms` and `paymentTerms`
  always. Salon prices include tax; mechanic and equipment rental round tax per document; the rest
  are exclusive, per line. `pending.json` holds cookbooks waiting on unreleased recipes (empty since
  Agency moved in with smrt 0.56.1). `menu.ts` previews
  a library cookbook's menu (same `applyShellLayout`), `apply.ts` replaces the document
  (confirm exactly when work would be lost: never when empty or still as the last applied cookbook
  left it, `document.ts` `wouldLoseWork`; the colour scheme is kept, so it never counts),
  `state.svelte.ts` remembers the last applied id and that document's `workFingerprint` in
  localStorage (not in the document). The Cookbooks tab shows the grid or one cookbook's detail in
  its place (`view.svelte.ts` `cookbookView`, a view-transition swap, instant under reduced motion,
  with a back control and Escape); the host keeps it in the address through a `CookbookNavigator`:
  the static layout pushes a shallow `?cookbook=<id>` entry, the mount a `#/configure/cookbooks/<id>/`
  route, so browser Back returns to the grid and a link opens the detail. Applying regenerates the sample records from the cookbook's pack (the panel says so). Add a
  library cookbook by adding an entry; use only existing recipe ids.

Workspace persistence retains the plan, library selection, sample context and rows in the current tab by default. Remember toggles move only those project values after destination writes succeed. Raw native conversation, seed markers, and host contact/frozen-lead drafts always remain session-only, including when Remember is enabled. A new tab restores the remembered plan with a fresh conversation and draft. Earlier durable raw thread/draft copies move safely into the current session and are excluded from durable legacy archives; conflicting old lead identifiers are retained in a session-only recovery value. Legacy local data is archived once for visible recovery before its live keys move to the current tab; explicit Remember OFF, discard recovery, and confirmed reset delete that archive. Reset preserves saved theme preferences and unrelated identity keys, invalidates native inference, and clears controller undo/replay history.
