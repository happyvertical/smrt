# smrt-planner

A static demo of [s-m-r-t](https://github.com/happyvertical/smrt). Add recipes
(Customers, Sales, Purchases, ...) or whole packages and an app mock-up assembles around them: a
shell with navigation, a list view and create/edit form per model with sample
data, and a "What you get" panel listing the REST routes, MCP tools, CLI
commands and AI-callable methods s-m-r-t generates from each model's decorator.

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
   delete them. The generated views and the "What you get" panel follow the
   options. Money fields are stored as integer minor units (cents).
4. Recipes and options live in the URL (`?r=commerce.sales,...&o=...`); copy it
   to share the mock-up.

The Assistant dock tool is a placeholder; the in-browser chat that picks
packages for you is tracked in #3, and live s-m-r-t objects in #4.

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
4. Writes, per package: description, models, each model's fields and types, the
   generated REST routes, MCP tools and CLI commands (from the knowledge
   artifact's `surfaces`), public methods and which are AI-callable (have an MCP
   tool), and dependencies (the manifest's `smrtDependencies` plus models'
   foreign keys and cross-package references, limited to catalog packages).

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
| `pnpm lint` | Biome |

## License

MIT © Happy Vertical Corporation
