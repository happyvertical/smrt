# smrt-planner

`@happyvertical/smrt-planner` lives in the
[smrt monorepo](https://github.com/happyvertical/smrt) at `packages/planner`
and releases in lockstep with every other `@happyvertical/smrt-*` package.
(It used to live in `happyvertical/smrt-planner`, on its own 0.1.x line; that
repository is archived.)

A static demo of [s-m-r-t](https://github.com/happyvertical/smrt). Add recipes
(Customers, Sales, Purchases, ...) or whole packages and an app mock-up assembles around them: a
shell with navigation, a list view and create/edit form per model with sample
data, and a plain-language Help page per recipe that follows the app's options,
with a collapsed "Connect other tools" section listing the REST routes, MCP
tools and CLI commands s-m-r-t generates from each model's decorator.

It is a purely static site (SvelteKit + `adapter-static`). Nothing is
installed or stored on a server; sample data lives in memory and resets on
reload. The layout comes from the canonical starter,
[smrt-start](https://github.com/happyvertical/smrt-start), minus everything
server-side.

## Run it

From the root of an smrt checkout (Node.js 26+, pnpm from the root
`packageManager`). The planner's catalog is generated from the workspace's
built manifests, so build the workspace once first:

```bash
pnpm install
pnpm turbo run build --filter=@happyvertical/smrt-planner...
pnpm --filter @happyvertical/smrt-planner dev    # http://localhost:5173
```

The build writes the static site to `./build` (servable from any static host,
or `pnpm --filter @happyvertical/smrt-planner preview`) and copies it into
`./app` for the package.

Hosting under a sub-path (for example GitHub Pages)? Build with
`BASE_PATH=/smrt-planner pnpm build`.

## Use it

1. On the Planner page, add recipes: small units like Customers, Vendors,
   Sales (needs Customers) and Purchases (needs Vendors). Adding one also adds
   what it requires. The whole package catalog is still there under "All
   packages".
2. A recipe opens an options form built from its models' own parameters:
   switch fields on or off (required ones stay on), set label, help text,
   default value and order, and narrow REST, MCP and CLI exposure. Saving writes
   field policies in the `@happyvertical/smrt-fields` shape, held in memory for
   now.
3. The left navigation grows a group per recipe with its entries (Customers,
   Sales Orders, ...). Open one to browse sample rows and create, edit or
   delete them. The generated views and each recipe's Help page (overview,
   tasks and a field glossary) follow the options: hide a field and its
   glossary entry and any task step about it disappear. Money fields are stored as integer minor units (cents).
4. Recipes and options live in the URL (`?r=commerce.sales,...&o=...`); copy it
   to share the mock-up.

Short on time? The **Cookbooks** tab (where a first visit lands) offers ready-made
starting points for a bakery, a mechanic, a welder and a yoga studio: pick one,
read what it adds (recipes, menu, default payment terms, currency and tax), and
use it to replace your recipes and menu. Your records stay.

The Assistant runs a small model on your device. The chat icon at the end of
the header opens it once a model is ready; before that it opens the AI models
page (`/ai/`), so a first click sets inference up instead of showing an empty
chat. Three icons in the left sidebar footer show **Think** (the language
model), **Hear** (voice typing) and **Speak** (read replies aloud); each opens
the same page, where you choose and download them. A first visit with nothing built starts there; "I don't
need AI, let's just build" skips it for good. Live s-m-r-t objects are tracked in #4.

Generated record forms use the Planner's own responsive, open form layout.
Generated record lists let you sort any data column by selecting its heading;
select it again to reverse the order. Sorting changes only the current view.
The left sidebar starts open, with inference controls above the user menu in
its footer. The Theme tab offers palette previews, large appearance choices,
a brand colour wheel and font selection. **Advanced Styles** opens a dedicated
CSS editor with syntax highlighting. CSS applies to the Planner as it changes
and travels with the cookbook when saved, exported or imported.

## Install the package

The primary package registry is `npm.happyvertical.com`. Configure the scope
once, then install the planner:

```bash
pnpm config set @happyvertical:registry https://npm.happyvertical.com/
pnpm add @happyvertical/smrt-planner
```

The same version is mirrored to npmjs on a best-effort basis. Install the
planner at the same version as the rest of your smrt packages: they release
together as one line. `Planner` mounts
the cookbook-driven app shell and its customization controls. A host can drive
it with the typed command set:

```svelte
<script lang="ts">
import { Planner, createPlannerController } from '@happyvertical/smrt-planner';

const controller = createPlannerController();
</script>

<Planner {controller} basePath="/planner" />
```

`Planner` props, all optional: `controller`, `basePath` (where its pages are
served from), `persistence` (`'self'` reads and saves the cookbook in this
browser, `'host'` leaves both to you), `themeControls`, `defaultTitle` (the shell title when no cookbook name or
library cookbook applies; defaults to `'Planner'`), `tabs`, `onready`, and:

The mounted planner is the framework's cookbook-driven app shell with its
customizable overviews switched on: the pencil at the start of the header
edits the menu and every section page in place (add, move, resize, configure
and remove widgets), and each edit lands in the cookbook's `layout` and
`overviews`, so it is saved, exported and imported with the rest of the plan.
The `metric`, `records` and `chart` widgets read the in-browser sample data;
the chart groups the seeded rows itself (by a field, or a date field bucketed
over the widget's period) as the stand-in for the runtime report a generated
app's chart loader would compile. Its pages are fragment routes (`#/s/...`,
`#/m/...`, `#/packages/...`), so the mount needs nothing from the host's
router and every in-planner link stays inside it.

- `backLink: { href, label }` renders a link out of the planner at the start
  of its header, beside the brand (a docs site's "Back to documentation").
- `inference` gives the planner's assistant a model and switches the assistant
  on: the chat icon at the end of the header opens the chat dock once a model
  is ready, and the AI models page (`#/ai/`) before, where a visitor downloads
  a browser model or connects their own endpoint. Pass the same object as
  `planner.config.json`'s `inference` (`{ mode, alternatives?,
  credentialPersistence?, host?, byo? }`, see `docs/inference-host.md`) or
  `{ chat }` with a model of your own. For a public site where visitors bring
  their own endpoint: `inference={{ mode: 'byo', alternatives: ['browser'],
  credentialPersistence: 'memory' }}`. Without `inference` the planner has no
  assistant and no chat icon.

```svelte
<Planner
  basePath="/planner"
  backLink={{ href: '/', label: 'Back to documentation' }}
  inference={{ mode: 'byo', credentialPersistence: 'memory' }}
/>
```

Hosts that already own an `AppShell` can mount `PlannerControls` inside it.
The controls are the reusable part; `Planner` remains the complete shell.
Use the exported shell defaults to start navigation open, with inference
controls above the user menu in its footer. The bottom panel starts hidden.

```svelte
<script lang="ts">
  import { AppShell } from '@happyvertical/smrt-svelte/app';
  import {
    PLANNER_SHELL_EDGE_TOGGLES,
    PLANNER_SHELL_PANEL_DEFAULTS,
    PlannerControls,
  } from '@happyvertical/smrt-planner';
</script>

<AppShell
  edgeToggles={PLANNER_SHELL_EDGE_TOGGLES}
  config={PLANNER_SHELL_PANEL_DEFAULTS}
  layoutEditing
>
  <PlannerControls layout="shell" persistence="host" />
</AppShell>
```

```ts
import { commandTools, createPlannerController } from '@happyvertical/smrt-planner/commands';

const controller = createPlannerController();
const result = controller.run({
  name: 'add_recipes',
  input: { ids: ['commerce.sales'] },
});
// { ok: true, snapshot, receipt } | { ok: false, error: { code, message } }
controller.subscribe((snapshot) => render(snapshot));
```

`commandTools` is every command as `{ name, description, inputSchema }`: pass it
straight to an LLM or an MCP server as tool definitions. `controller.snapshot()`
is a compact read-only plan (a few KB) fit for a model prompt. Commands:
`add_recipes`, `remove_recipes`, `add_features`, `remove_features`,
`add_cookbook`, `remove_cookbook`, `apply_cookbook`, `import_cookbook`,
`set_settings`, `set_policy`, `set_theme`, `reset_theme`, `rename_section`,
`rename_item`, `hide`, `show`, `focus`, `export_cookbook`, `undo`.

`@happyvertical/smrt-planner` and `@happyvertical/smrt-planner/commands` are Svelte source (runes) and JSON,
so consume them through Vite or another Svelte-compiling bundler. A plain Node
server uses `@happyvertical/smrt-planner/core` instead (command schemas, the assistant prompt,
reply validation, the library catalog) and can serve the prebuilt app from
`@happyvertical/smrt-planner/app`; see `docs/inference-host.md`.

## How the catalog is generated

`src/lib/catalog/catalog.json` is the only thing the app reads. It is
**generated by `pnpm build` and never committed**, from the same workspace the
release publishes, so a released planner always describes exactly the packages
released beside it:

```bash
pnpm --filter @happyvertical/smrt-planner catalog:generate
```

The script (`scripts/generate-catalog.ts`):

1. Reads every public `@happyvertical/smrt-*` package in the workspace that
   exports `./manifest.json`, from its built manifest and the
   `smrt-knowledge.json` beside it. Each of those packages is a devDependency
   of the planner, so Turbo builds them first; a declared but unbuilt manifest
   fails the build rather than silently shrinking the catalog. Packages
   without a manifest export (cli, svelte, ui, ...) or without models are
   skipped.
2. Drops the infrastructure packages in
   `src/lib/catalog/generate/exclusions.ts` (core, tenancy, jobs, prompts,
   ...); that list is the only hand-maintained part, and each entry says why.
   A listed package that declares recipes stays (`smrt-chat` brings the
   assistant, `smrt-fields` form customization): a recipe is a feature.
3. Writes, per package: description, models, each model's fields and types, the
   generated REST routes, MCP tools and CLI commands (from the knowledge
   artifact's `surfaces`), public methods and which are AI-callable (have an MCP
   tool), the recipes it declares with their surfaces, providers (secret
   names only), runtime, demo seed and browser-demo mode (`demo`, plus the
   package's `browser` capability; smrt#3708/#3709), and dependencies (the
   manifest's `smrtDependencies` plus models' foreign keys and cross-package
   references, limited to catalog packages).

Output is sorted and has no timestamps or checkout paths, so a build of the
same tree is byte-identical anywhere. `CATALOG_SOURCE=registry` reads the
published packages from the registry instead (`SMRT_PLANNER_REGISTRY`
overrides it), and `CATALOG_SOURCE=<path>` another smrt checkout, to compare.

Because the library cookbooks are validated against this catalog in the
planner's tests, a framework change that breaks a cookbook (a field moved out
of a model, a recipe renamed) fails the pull request that makes it.

## Scripts

Run with `pnpm --filter @happyvertical/smrt-planner <script>`.

| Script | Does |
| --- | --- |
| `dev` | Vite dev server |
| `build` | Catalog and CLI version from the workspace, the static app into `build/` and `app/`, the MCP widget `app/mcp.html`, then `svelte-package` into `dist/` |
| `verify:pack` | `publint` and the monorepo's packed-exports check |
| `catalog:generate` | Regenerate the catalog alone |
| `typecheck` | `svelte-kit sync`, `tsc`, `svelte-check` |
| `test` | Vitest, including every library cookbook validated against the workspace catalog |
| `test:mcp-browser` | Rebuild `app/mcp.html` and drive it in Chromium |
| `test:live-preview-browser` | Drive the live preview against the dev server in Chromium |
| `test:package -- <tarball>` | Install and exercise an already packed tarball as an isolated consumer |

Lint and formatting are the monorepo's root `pnpm lint`. The package is
released by the monorepo's batched release with every other smrt package (see
the root `CHANGESETS.md`); it is never published on its own.

## License

MIT © Happy Vertical Corporation
