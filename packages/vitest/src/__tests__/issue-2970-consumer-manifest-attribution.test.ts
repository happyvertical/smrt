/**
 * Consumer-shaped regression test for #2970.
 *
 * The unit-level regression lives in
 * `packages/core/src/registry/__tests__/issue-2970-aggregated-manifest-attribution.test.ts`.
 * This one exists because #2970 escaped CI entirely: every test for #2923
 * asserted which manifest FILE gets resolved for a package, and no test ran a
 * real consumer whose aggregated manifest is then loaded into `ObjectRegistry`
 * and re-registered from its own generated `.smrt/register.js`. That is the
 * path a downstream app's integration tests take, and it is the path this
 * fixture runs end to end:
 *
 * 1. `ManifestBuilder` scans the fixture's own source into
 *    `.smrt/manifest.json` and sets its `packageName` (what `smrtPlugin()`
 *    does in an app build);
 * 2. `smrtConsumer()` merges `@happyvertical/smrt-core`'s manifest — resolved
 *    through its `package.json#exports` map, the #2923 discovery path — into
 *    that same file and generates `.smrt/register.js`, making it a mixed
 *    aggregate: the fixture's own `TreeNode` beside smrt-core's bases;
 * 3. `smrtVitestPlugin()` loads the merged file, passing the CONSUMER's package
 *    name for every entry in it;
 * 4. the fixture's spec dynamically imports the generated `.smrt/register.js`,
 *    which registers the same classes under their declaring package, and then
 *    reads the registry.
 *
 * Before the fix, step 3 produced `@smrt-fixtures/issue-2970-consumer:SmrtHierarchical`
 * next to step 4's `@happyvertical/smrt-core:SmrtHierarchical`, and simple-name
 * resolution went ambiguous. The fixture spec fails on the pre-fix revision
 * with exactly that pair, and also pins the other direction: the fixture's own
 * `TreeNode` stays registered once, under the fixture's package.
 *
 * Structure mirrors `issue-2750-registry-shared-across-worker.test.ts`: a
 * nested, real `vitest run` against a fixture package, asserted on its JSON
 * report.
 *
 * @see https://github.com/happyvertical/smrt/issues/2970
 * @see https://github.com/happyvertical/smrt/issues/2923
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fixtureRoot = fileURLToPath(
  new URL('./fixtures/issue-2970-consumer-fixture', import.meta.url),
);
const corePackageRoot = fileURLToPath(
  new URL('../../../core', import.meta.url),
);
const vitestBin = fileURLToPath(
  new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
);
const jsonReportPath = join(fixtureRoot, 'vitest-report.json');

interface VitestJsonReport {
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  success: boolean;
}

const SPAWN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 30_000;

function cleanGeneratedArtifacts(): void {
  for (const dir of ['.smrt', 'dist', 'node_modules']) {
    rmSync(join(fixtureRoot, dir), { recursive: true, force: true });
  }
  rmSync(jsonReportPath, { force: true });
}

/**
 * `smrtConsumer()` resolves a consumed package under `<projectRoot>/node_modules`,
 * so the fixture needs `@happyvertical/smrt-core` installed the way a real
 * consumer has it. Link the workspace package rather than committing a
 * `node_modules` tree; the link is relative so it survives a moved checkout,
 * and it is removed again with the rest of the generated artifacts.
 */
function linkCoreIntoFixture(): void {
  const scopeDir = join(fixtureRoot, 'node_modules', '@happyvertical');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(
    relative(scopeDir, corePackageRoot),
    join(scopeDir, 'smrt-core'),
    'dir',
  );
}

describe('issue #2970: a consumer aggregate does not re-attribute foreign classes', () => {
  beforeEach(() => {
    cleanGeneratedArtifacts();
    linkCoreIntoFixture();
  });

  afterEach(() => {
    cleanGeneratedArtifacts();
  });

  it(
    'a consumer-shaped fixture resolves SmrtHierarchical unambiguously after importing its own register.js',
    () => {
      expect(existsSync(vitestBin)).toBe(true);
      expect(existsSync(join(corePackageRoot, 'dist', 'manifest.json'))).toBe(
        true,
      );

      let stdout = '';
      let stderr = '';
      let failed = false;

      // Same CI-only retry as the #2750 fixture: a nested `vitest run` spawn
      // can transiently fail with ENOENT under heavy parallel load. Retrying
      // locally would mask a genuine regression (packages/vitest/AGENTS.md).
      const maxAttempts = process.env.CI ? 3 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        failed = false;
        try {
          stdout = execFileSync(
            process.execPath,
            [
              vitestBin,
              'run',
              '--reporter=json',
              `--outputFile=${jsonReportPath}`,
            ],
            {
              cwd: fixtureRoot,
              encoding: 'utf-8',
              env: { ...process.env },
              timeout: SPAWN_TIMEOUT_MS,
              killSignal: 'SIGKILL',
            },
          );
          break;
        } catch (error) {
          failed = true;
          const err = error as {
            stdout?: string;
            stderr?: string;
            code?: string;
          };
          stdout =
            err.stdout ??
            (error instanceof Error ? error.message : String(error));
          stderr = err.stderr ?? '';
          if (err.code !== 'ENOENT' || attempt === maxAttempts) break;
          console.warn(
            `[issue-2970 fixture] retrying nested vitest spawn after ENOENT (attempt ${attempt}/${maxAttempts})`,
          );
        }
      }

      expect(
        failed,
        `nested vitest run failed:\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ).toBe(false);
      expect(
        existsSync(jsonReportPath),
        `nested vitest run produced no JSON report; stdout:\n${stdout}\nstderr:\n${stderr}`,
      ).toBe(true);

      const report = JSON.parse(
        readFileSync(jsonReportPath, 'utf-8'),
      ) as VitestJsonReport;
      expect(report.success, `nested vitest run report:\n${stdout}`).toBe(true);
      expect(report.numTotalTestSuites).toBeGreaterThan(0);
      expect(report.numPassedTestSuites).toBe(report.numTotalTestSuites);
      expect(report.numTotalTests).toBeGreaterThan(0);
      expect(report.numPassedTests).toBe(report.numTotalTests);
    },
    TEST_TIMEOUT_MS,
  );
});
