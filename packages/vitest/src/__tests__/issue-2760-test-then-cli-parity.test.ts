/**
 * Regression test for #2760: after a package's test suite runs, readers
 * outside the run — CLI project discovery (the `db:status --parity` /
 * `db:migrate` schema gate), local manifest loading used by CLI generation,
 * and explicit-path loads used by generated servers — never see the test
 * run's inline fixtures as domain objects, while those fixtures keep working
 * inside the run (manifest test databases).
 *
 * Sequence: production build output → real nested `vitest run` of
 * `fixtures/issue-2760-test-then-cli-fixture` (inline full-CRUD `ConvNote`)
 * → readers in this process, which is outside that run. A second case plants
 * the run's captured test manifest at `.smrt/manifest.json`, the state an
 * older test runner left behind, and proves every reader refuses it.
 *
 * @see https://github.com/happyvertical/smrt/issues/2760
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateSchemaContract } from '../../../cli/src/commands/schema-contract.js';
import { discoverManifests } from '../../../cli/src/discovery/manifest-discovery.js';
import { ManifestBuilder } from '../../../core/src/manifest/generator.js';
import { ManifestManager } from '../../../core/src/manifest/manager.js';
import {
  clearManifestCache,
  loadLocalTestManifestSync,
  loadManifestFromPathSync,
} from '../../../core/src/manifest/manifest-loader.js';
import { resolveActiveTestManifestPath } from '../../../core/src/manifest/test-artifacts.js';

const fixtureRoot = fileURLToPath(
  new URL('./fixtures/issue-2760-test-then-cli-fixture', import.meta.url),
);
const vitestBin = fileURLToPath(
  new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
);
const jsonReportPath = join(fixtureRoot, 'vitest-report.json');
const productionPath = join(fixtureRoot, '.smrt/manifest.json');
const capturedPath = join(fixtureRoot, '.smrt/captured-test-manifest.json');
const SPAWN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 60_000;

function clean(): void {
  for (const dir of ['.smrt', 'dist']) {
    rmSync(join(fixtureRoot, dir), { recursive: true, force: true });
  }
  rmSync(jsonReportPath, { force: true });
}

/** The production write `smrtPlugin()` performs: test files excluded. */
async function buildProductionManifest(): Promise<void> {
  await new ManifestBuilder(fixtureRoot).generate({
    include: ['src/**/*.ts'],
    exclude: ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**'],
    outputMode: 'dev',
    outputDir: '.smrt',
    outputName: 'manifest.json',
    generateTypeStub: false,
    injectPackageInfo: true,
    moduleType: 'smrt',
  });
}

function runFixtureSuite(): void {
  try {
    execFileSync(
      process.execPath,
      [vitestBin, 'run', '--reporter=json', `--outputFile=${jsonReportPath}`],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: SPAWN_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    throw new Error(
      `nested vitest run failed:\nstdout:\n${err.stdout}\nstderr:\n${err.stderr}`,
    );
  }
  const report = JSON.parse(readFileSync(jsonReportPath, 'utf8'));
  expect(report.success).toBe(true);
  expect(report.numPassedTests).toBe(report.numTotalTests);
  expect(report.numTotalTests).toBeGreaterThan(0);
}

const names = (keys: Iterable<string> = []) =>
  [...keys].map((key) => key.split(':').pop());

/** Local manifest reads the CLI generator makes, from the package directory. */
function cliLocalManifestObjects(): Array<string | undefined> {
  const cwd = process.cwd();
  clearManifestCache();
  process.chdir(fixtureRoot);
  try {
    return names(Object.keys(loadLocalTestManifestSync()?.objects ?? {}));
  } finally {
    process.chdir(cwd);
    clearManifestCache();
  }
}

describe('issue #2760: test-run fixtures never reach production manifest consumers', () => {
  beforeEach(clean);
  afterEach(clean);

  it(
    'a test run leaves CLI discovery, the schema gate and local loads on the production manifest',
    async () => {
      await buildProductionManifest();
      const productionBytes = readFileSync(productionPath, 'utf8');
      runFixtureSuite();

      // This process is outside the fixture's test run.
      expect(resolveActiveTestManifestPath(fixtureRoot)).toBeNull();
      expect(readFileSync(productionPath, 'utf8')).toBe(productionBytes);

      const discovered = await discoverManifests(fixtureRoot);
      const project = discovered.filter((m) => m.source === 'project');
      expect(project).toHaveLength(1);
      expect(names(project[0]?.objectNames)).toContain('Note');
      expect(names(project[0]?.objectNames)).not.toContain('ConvNote');

      const report = await evaluateSchemaContract({ discovered });
      expect(report.failures.map((failure) => failure.code)).not.toContain(
        'missing_local_manifest',
      );

      expect(
        names(
          Object.keys(new ManifestManager(fixtureRoot).loadLocal()!.objects),
        ),
      ).not.toContain('ConvNote');
      expect(cliLocalManifestObjects()).toEqual(['Note']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a test manifest left at .smrt/manifest.json by an older test runner',
    async () => {
      runFixtureSuite();
      expect(existsSync(capturedPath)).toBe(true);
      // Reproduce the pre-#4128 state: the test-inclusive manifest sits at
      // the production path and no build output exists.
      copyFileSync(capturedPath, productionPath);
      expect(readFileSync(productionPath, 'utf8')).toContain('ConvNote');

      const discovered = await discoverManifests(fixtureRoot);
      expect(discovered.filter((m) => m.source === 'project')).toEqual([]);
      const report = await evaluateSchemaContract({ discovered });
      // The schema gate fails closed instead of reporting phantom tables.
      expect(report.failures.map((failure) => failure.code)).toContain(
        'missing_local_manifest',
      );
      expect(new ManifestManager(fixtureRoot).loadLocal()).toBeNull();
      expect(cliLocalManifestObjects()).toEqual([]);
      expect(loadManifestFromPathSync(productionPath)).toBeNull();

      // A production build output behind it is used instead.
      mkdirSync(join(fixtureRoot, 'dist'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'dist/manifest.json'),
        JSON.stringify({
          moduleType: 'smrt',
          packageName: '@fixture/smrt-issue-2760-test-then-cli',
          objects: { '@fixture/smrt-issue-2760-test-then-cli:Note': {} },
        }),
      );
      expect(
        names(
          Object.keys(new ManifestManager(fixtureRoot).loadLocal()!.objects),
        ),
      ).toEqual(['Note']);
    },
    TEST_TIMEOUT_MS,
  );
});
