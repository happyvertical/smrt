/**
 * Consumer-shaped fixture for issue #2970.
 *
 * Reproduces a downstream app's real build/test shape rather than a hand-made
 * registry state:
 *
 * 1. `ManifestBuilder` scans this package's own source into
 *    `.smrt/manifest.json` and sets its `packageName`, the way `smrtPlugin()`
 *    writes an app's local manifest; `smrtConsumer()` then MERGES
 *    `@happyvertical/smrt-core`'s manifest into that same file — resolved
 *    through core's own `package.json#exports` map, the multi-candidate
 *    discovery #2923 introduced, which is what pulls core's framework base
 *    classes (`SmrtHierarchical` among them) into a consumer's aggregate —
 *    and generates `.smrt/register.js`. The result is a genuine MIXED
 *    aggregate: this package's `TreeNode` beside smrt-core's bases.
 * 2. `smrtVitestPlugin()` loads that merged file into `ObjectRegistry` —
 *    passing THIS package's name for every entry in it, including core's.
 * 3. `src/registry-probe.spec.ts` dynamically imports the generated
 *    `.smrt/register.js`, exactly as a downstream integration test does, and
 *    then calls `ObjectRegistry.getAllSchemasAsDefinitions()`.
 *
 * Before the fix, step 2's attribution plus step 3's registration produced
 * `@happyvertical/smrt-core:SmrtHierarchical` and
 * `@smrt-fixtures/issue-2970-consumer:SmrtHierarchical` side by side, while
 * `TreeNode` — the entry that genuinely belongs to this package — was the only
 * one the caller's value happened to get right. The probe pins both
 * directions.
 *
 * Imports the plugin and setup file from workspace *source* so the fixture
 * exercises whatever fix is on the current branch, like the #2750 fixture.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';
import { ManifestBuilder } from '@happyvertical/smrt-core/manifest';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../../../index.ts';

const fixtureRoot = fileURLToPath(new URL('.', import.meta.url));

// `smrtConsumer()`'s generation lives in `buildStart`, which Vitest does not
// run for a plain `vitest run`. Drive it explicitly so the generated
// aggregate exists before `smrtVitestPlugin()`'s `configResolved()` loads it —
// the same ordering a real app gets from its Vite build.
// `smrtPlugin()`'s local write lands first in a real app build: it scans this
// package's own sources into `.smrt/manifest.json` and sets the file's
// top-level `packageName`. `smrtConsumer()` then merges the external entries
// into that same file, preserving both (`saveAggregatedManifest`, issues
// #963/#1760). Reproduce that ordering with the real builder rather than a
// hand-written stub, so the file this fixture registers is a genuine MIXED
// aggregate — this package's own `TreeNode` beside smrt-core's framework
// bases — which is the shape `loadAndRegisterLocalManifest()` then attributes
// wholesale to this package.
await new ManifestBuilder().generate({
  outputDir: join(fixtureRoot, '.smrt'),
  outputName: 'manifest.json',
  injectPackageInfo: true,
  discoverExternalPackages: false,
  includeExternalBaseClasses: false,
  baseClasses: [
    'SmrtObject',
    'SmrtClass',
    'SmrtCollection',
    'SmrtHierarchical',
  ],
});

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
