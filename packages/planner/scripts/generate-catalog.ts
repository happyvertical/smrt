/**
 * Regenerate `src/lib/catalog/catalog.json` from the published
 * `@happyvertical/smrt-*` packages. Run with `pnpm catalog:generate`.
 *
 * The registry is the one `.npmrc` maps the `@happyvertical` scope to (the
 * same one `pnpm install` uses); `SMRT_PLANNER_REGISTRY` overrides it.
 *
 * `CATALOG_SOURCE=<path to a smrt checkout>` reads that checkout's built
 * `packages/*\/dist/manifest.json` instead, to preview unreleased manifests.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from '../src/lib/catalog/generate/build.ts';
import { DEFAULT_REGISTRY } from '../src/lib/catalog/generate/registry.ts';

const root = new URL('../', import.meta.url);

async function registryFromNpmrc(): Promise<string> {
  const npmrc = await readFile(new URL('.npmrc', root), 'utf8');
  const match = npmrc.match(/^@happyvertical:registry=(\S+)$/m);
  return (match?.[1] ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
}

const source = process.env.CATALOG_SOURCE || undefined;
const registry = source
  ? ''
  : (process.env.SMRT_PLANNER_REGISTRY?.replace(/\/+$/, '') ??
    (await registryFromNpmrc()));
const catalog = await buildCatalog({
  registry,
  source,
  log: (message) => console.error(message),
});
const out = fileURLToPath(new URL('src/lib/catalog/catalog.json', root));
await writeFile(out, `${JSON.stringify(catalog, null, 2)}\n`);
console.error(`wrote ${catalog.packages.length} packages to ${out}`);
