# smrt-planner

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

Requirements: Node.js 26+ and pnpm 11.25 (`packageManager` pins it).

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

Static build, servable from any static host:

```bash
pnpm build        # writes ./build
pnpm preview      # or: npx sirv-cli build
```

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

The Assistant runs a small model on your device. Three icons in the left
sidebar footer show **Think** (the language model), **Hear** (voice typing) and
**Speak** (read replies aloud); each opens the AI models page (`/ai/`), where you
choose and download them. A first visit with nothing built starts there; "I don't
need AI, let's just build" skips it for good. Live s-m-r-t objects are tracked in #4.

## Install the package

The primary package registry is `npm.happyvertical.com`. Configure the scope
once, then install the planner:

```bash
pnpm config set @happyvertical:registry https://npm.happyvertical.com/
pnpm add @happyvertical/smrt-planner
```

The same version is mirrored to npmjs on a best-effort basis. The planner is a
Svelte package; a host page mounts it in its own layout and drives it with a
typed command set:

```svelte
<script lang="ts">
import { Planner, createPlannerController } from '@happyvertical/smrt-planner';

const controller = createPlannerController();
</script>

<Planner {controller} basePath="/planner" />
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

`src/lib/catalog/catalog.json` is **committed** and is the only thing the app
reads; `pnpm build` needs no network. Regenerate it with:

```bash
pnpm catalog:generate
```

The script (`scripts/generate-catalog.ts`):

1. Lists every `@happyvertical/smrt-*` package through the registry's search
   (the registry `.npmrc` maps the `@happyvertical` scope to; override with
   `SMRT_PLANNER_REGISTRY`).
2. Downloads each package's latest published tarball, reads the
   `./manifest.json` export and the `smrt-knowledge.json` beside it. Packages
   without a manifest export (cli, svelte, ui, ...) or without models are
   skipped.
3. Drops the infrastructure packages in
   `src/lib/catalog/generate/exclusions.ts` (core, tenancy, jobs, prompts,
   ...); that list is the only hand-maintained part, and each entry says why.
   A listed package that declares recipes stays (`smrt-chat` brings the
   assistant, `smrt-fields` form customization): a recipe is a feature.
4. Writes, per package: description, models, each model's fields and types, the
   generated REST routes, MCP tools and CLI commands (from the knowledge
   artifact's `surfaces`), public methods and which are AI-callable (have an MCP
   tool), the recipes it declares with their surfaces, providers (secret
   names only), runtime, demo seed and browser-demo mode (`demo`, plus the
   package's `browser` capability; smrt#3708/#3709), and dependencies (the
   manifest's `smrtDependencies` plus models' foreign keys and cross-package
   references, limited to catalog packages).

Output is sorted and has no timestamps, so a run against the same published
versions is byte-identical. It tracks each package's `latest` dist-tag, so
rerunning later may change the file; commit the result when it does.

## Scripts

| Script | Does |
| --- | --- |
| `pnpm dev` | Vite dev server |
| `pnpm build` | Static build into `build/` |
| `pnpm catalog:generate` | Regenerate the committed catalog |
| `pnpm typecheck` | `svelte-kit sync`, `tsc`, `svelte-check` |
| `pnpm test` | Vitest |
| `pnpm test:package -- <tarball>` | Install and exercise an already packed tarball as an isolated consumer |
| `pnpm test:release-workflow` | Check the protected publication workflow contract |
| `pnpm lint` | Biome |
| `pnpm package` | `svelte-package` into `dist/`, then `publint` |

Maintainers publish only through the protected GitHub Actions workflow. See
[the release procedure](docs/releasing.md); never publish this package from a
workstation.

## License

MIT © Happy Vertical Corporation
