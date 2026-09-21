/**
 * Consumer-shaped fixture for issue #2970.
 *
 * Reproduces a downstream app's real build/test shape rather than a hand-made
 * registry state:
 *
 * 1. `smrtConsumer()` runs first and writes this fixture's `.smrt/manifest.json`
 *    and `.smrt/register.js` by resolving `@happyvertical/smrt-core`'s manifest
 *    through its own `package.json#exports` map — the multi-candidate discovery
 *    #2923 introduced, which is what pulls core's framework base classes
 *    (`SmrtHierarchical` among them) into a consumer's aggregate.
 * 2. `smrtVitestPlugin()` then scans this package's own source into the same
 *    aggregated manifest and loads it into `ObjectRegistry` — passing THIS
 *    package's name for every entry in the file, including core's.
 * 3. `src/registry-probe.spec.ts` dynamically imports the generated
 *    `.smrt/register.js`, exactly as a downstream integration test does, and
 *    then calls `ObjectRegistry.getAllSchemasAsDefinitions()`.
 *
 * Before the fix, step 2's attribution plus step 3's registration produced
 * `@happyvertical/smrt-core:SmrtHierarchical` and
 * `@smrt-fixtures/issue-2970-consumer:SmrtHierarchical` side by side and step 3
 * threw `ConfigurationError: Ambiguous class name "SmrtHierarchical"`.
 *
 * Imports the plugin and setup file from workspace *source* so the fixture
 * exercises whatever fix is on the current branch, like the #2750 fixture.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../../../index.ts';

const fixtureRoot = fileURLToPath(new URL('.', import.meta.url));

// `smrtConsumer()`'s generation lives in `buildStart`, which Vitest does not
// run for a plain `vitest run`. Drive it explicitly so the generated
// aggregate exists before `smrtVitestPlugin()`'s `configResolved()` loads it —
// the same ordering a real app gets from its Vite build.
// `smrtPlugin()`'s local write lands first in a real app build and is what
// sets the file's top-level `packageName`; `smrtConsumer()` then merges the
// external entries into that same file, preserving it (see
// `saveAggregatedManifest`, issues #963/#1760). Reproduce that ordering
// explicitly — it is the reason `loadAndRegisterLocalManifest()` later passes
// the CONSUMER's package name for entries that belong to smrt-core.
mkdirSync(join(fixtureRoot, '.smrt'), { recursive: true });
writeFileSync(
  join(fixtureRoot, '.smrt', 'manifest.json'),
  JSON.stringify(
    {
      version: '1.0.0',
      timestamp: 0,
      packageName: '@smrt-fixtures/issue-2970-consumer',
      objects: {},
    },
    null,
    2,
  ),
);

const consumer = smrtConsumer({
  packages: ['@happyvertical/smrt-core'],
  generateTypes: false,
  projectRoot: fixtureRoot,
  disableScanning: true,
});
await consumer.buildStart?.call({} as never);

export default defineConfig({
  plugins: [
    smrtVitestPlugin({
      verbose: true,
      root: fixtureRoot,
      // A consumer whose manifest is produced by its build, not regenerated
      // per test run — the supported shape in which the AGGREGATED manifest
      // (external entries included) is what `loadAndRegisterLocalManifest()`
      // reads. Regenerating here would rewrite the file with a local-only
      // scan and hide the very entries this regression is about.
      generateManifest: false,
      setupFile: fileURLToPath(new URL('../../../setup.ts', import.meta.url)),
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 30000,
    pool: 'forks',
    fileParallelism: false,
  },
});
