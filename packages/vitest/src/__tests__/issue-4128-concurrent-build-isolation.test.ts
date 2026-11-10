/**
 * Regression test for #4128: a production build or typecheck running while a
 * test suite runs must not change the suite's manifest inputs, and a test run
 * must not change production manifests.
 *
 * Runs a real consumer-shaped Vitest process (plugin + setup + `pool:
 * 'forks'`) against `fixtures/issue-4128-concurrent-build-fixture`, whose
 * global setup rewrites `.smrt/manifest.json` with a production manifest
 * after test generation and before any worker reads it — the window in which
 * the reported `pnpm typecheck` rebuild replaced the test manifest. The spec
 * asserts that the run's own snapshot (with its inline `Gadget` fixture) is
 * what every manifest read resolves. On the pre-fix code, local manifest
 * loading in the worker returned the rewritten production file without
 * `Gadget`.
 *
 * @see https://github.com/happyvertical/smrt/issues/4128
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fixtureRoot = fileURLToPath(
  new URL('./fixtures/issue-4128-concurrent-build-fixture', import.meta.url),
);
const vitestBin = fileURLToPath(
  new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
);
const jsonReportPath = join(fixtureRoot, 'vitest-report.json');
const SPAWN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 30_000;

function clean(): void {
  for (const dir of ['.smrt', 'dist']) {
    rmSync(join(fixtureRoot, dir), { recursive: true, force: true });
  }
  rmSync(jsonReportPath, { force: true });
}

function runFixture(env: NodeJS.ProcessEnv = {}): {
  success: boolean;
  numPassedTests: number;
  numTotalTests: number;
} {
  try {
    execFileSync(
      process.execPath,
      [vitestBin, 'run', '--reporter=json', `--outputFile=${jsonReportPath}`],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, ...env },
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
  return JSON.parse(readFileSync(jsonReportPath, 'utf8'));
}

describe('issue #4128: test manifests are isolated from concurrent production generation', () => {
  beforeEach(clean);
  afterEach(clean);

  it(
    'keeps inline fixture metadata visible to forked workers after a production rewrite of .smrt/manifest.json',
    () => {
      const report = runFixture();
      expect(report.success).toBe(true);
      expect(report.numTotalTests).toBeGreaterThan(0);
      expect(report.numPassedTests).toBe(report.numTotalTests);

      // The test run never wrote over the production working copy...
      const production = JSON.parse(
        readFileSync(join(fixtureRoot, '.smrt/manifest.json'), 'utf8'),
      );
      expect(production.producedBy).toBe('issue-4128-concurrent-build');
      expect(JSON.stringify(production)).not.toContain('Gadget');
      expect(production.artifactPurpose).toBeUndefined();
      // ...and removed its own snapshot when the run ended.
      const runsDir = join(fixtureRoot, '.smrt/test-runs');
      expect(existsSync(runsDir) ? readdirSync(runsDir) : []).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves existing production manifests and their paired knowledge byte-identical across a test run (#3205)',
    () => {
      const smrtDir = join(fixtureRoot, '.smrt');
      const distDir = join(fixtureRoot, 'dist');
      mkdirSync(smrtDir, { recursive: true });
      mkdirSync(distDir, { recursive: true });
      const productionFiles = {
        [join(smrtDir, 'manifest.json')]: JSON.stringify({
          producedBy: 'issue-4128-concurrent-build',
          objects: {},
        }),
        [join(smrtDir, 'smrt-knowledge.json')]: JSON.stringify({
          sourceHashes: { manifest: 'sha256:production' },
        }),
        [join(distDir, 'manifest.json')]: JSON.stringify({
          version: 'production-sentinel',
          objects: {},
        }),
      };
      for (const [path, content] of Object.entries(productionFiles)) {
        writeFileSync(path, content);
      }

      // Without the simulated build, only the test run touches the package;
      // the seeded working copy already satisfies the probe's production
      // assertions, so the nested run still passes.
      const report = runFixture({ SMRT_FIXTURE_SKIP_CONCURRENT_BUILD: '1' });
      expect(report.success).toBe(true);

      for (const [path, content] of Object.entries(productionFiles)) {
        expect(readFileSync(path, 'utf8'), path).toBe(content);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
