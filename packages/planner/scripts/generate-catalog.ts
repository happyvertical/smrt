/**
 * Write `src/lib/catalog/catalog.json`, the package catalog the planner ships.
 * `pnpm build` runs this; the file is generated, never committed.
 *
 * By default it reads the smrt workspace this package lives in: every public
 * `@happyvertical/smrt-*` package's built `./manifest.json` export (plus the
 * `smrt-knowledge.json` beside it). Turbo builds those first, because each one
 * is a devDependency of the planner, so the catalog always describes exactly
 * the packages released beside it. A declared but unbuilt manifest fails.
 *
 * `CATALOG_SOURCE=<path>` reads another smrt checkout instead;
 * `CATALOG_SOURCE=registry` reads the published packages from the registry
 * (`SMRT_PLANNER_REGISTRY`, default npm.happyvertical.com), to compare a
 * build against what is released.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from '../src/lib/catalog/generate/build.ts';
import { DEFAULT_REGISTRY } from '../src/lib/catalog/generate/registry.ts';

const root = new URL('../', import.meta.url);
const workspace = fileURLToPath(new URL('../../', root));
const requested = process.env.CATALOG_SOURCE || workspace;
const fromRegistry = requested === 'registry';
const registry =
  process.env.SMRT_PLANNER_REGISTRY?.replace(/\/+$/, '') ?? DEFAULT_REGISTRY;
const catalog = await buildCatalog({
  registry,
  source: fromRegistry ? undefined : requested,
  log: (message) => console.error(message),
});
const out = fileURLToPath(new URL('src/lib/catalog/catalog.json', root));
await writeFile(out, `${JSON.stringify(catalog, null, 2)}\n`);
console.error(
  `wrote ${catalog.packages.length} packages from ${fromRegistry ? registry : requested} to ${out}`,
);
