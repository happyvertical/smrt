/**
 * Regression coverage for Issue #2223.
 *
 * Test manifests are generated only for core's test runtime. They must not
 * enter the production build graph, where Turbo would hash an artifact that
 * `generate:test` owns and restores.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getCoreEntries } from '../../../vite.config.js';

const packageDir = resolve(import.meta.dirname, '../../..');
const workspaceDir = resolve(packageDir, '../..');
const testManifestPaths = [
  resolve(packageDir, 'src/manifest/test-manifest.json'),
  resolve(packageDir, 'src/manifest/test-manifest-stub.ts'),
  resolve(packageDir, '.smrt/manifest.json'),
];
const productionTestStubPaths = [
  resolve(packageDir, 'dist/manifest/test-manifest-stub.js'),
  resolve(packageDir, 'dist/manifest/test-manifest-stub.d.ts'),
  resolve(packageDir, 'dist/manifest/test-manifest-stub.d.ts.map'),
];

function runPnpm(args: string[]) {
  const result = spawnSync('pnpm', args, {
    cwd: workspaceDir,
    encoding: 'utf8',
    timeout: 120_000,
  });

  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}

function getCoreBuildHash(): string {
  const output = runPnpm([
    'turbo',
    'run',
    'build',
    '--filter=@happyvertical/smrt-core',
    '--dry=json',
  ]);
  const jsonStart = output.indexOf('\n{');
  const task = JSON.parse(
    output.slice(jsonStart === -1 ? 0 : jsonStart + 1),
  ).tasks.find(
    (candidate: { taskId: string }) =>
      candidate.taskId === '@happyvertical/smrt-core#build',
  );

  expect(task).toBeDefined();
  return task.hash;
}

describe('Issue #2223 - test manifest task ownership', () => {
  it('keeps the generated test stub out of production Vite entries', () => {
    expect(getCoreEntries()).not.toHaveProperty('manifest/test-manifest-stub');
  });

  it('keeps core build independent of generated test manifests', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(packageDir, 'package.json'), 'utf8'),
    );
    const turbo = JSON.parse(
      readFileSync(resolve(workspaceDir, 'turbo.json'), 'utf8'),
    );

    expect(packageJson.scripts.build).not.toContain('generate-test-manifest');
    expect(turbo.tasks['generate:test'].outputs).toEqual(
      expect.arrayContaining([
        'src/manifest/test-manifest.json',
        'src/manifest/test-manifest-stub.ts',
      ]),
    );
    expect(turbo.tasks.build.inputs).toEqual(
      expect.arrayContaining([
        '!src/manifest/test-manifest.json',
        '!src/manifest/test-manifest-stub.ts',
      ]),
    );
  });

  it('keeps a cold build hash and production output independent of test artifacts', () => {
    const backupDir = join(
      tmpdir(),
      `smrt-2223-test-manifests-${process.pid}-${Date.now()}`,
    );
    mkdirSync(backupDir, { recursive: true });

    try {
      for (const path of [...testManifestPaths, ...productionTestStubPaths]) {
        if (existsSync(path)) renameSync(path, join(backupDir, basename(path)));
      }

      const coldBuildHash = getCoreBuildHash();
      runPnpm(['--dir', packageDir, 'run', 'generate:test']);
      expect(getCoreBuildHash()).toBe(coldBuildHash);

      runPnpm(['--dir', packageDir, 'run', 'build']);
      expect(
        existsSync(resolve(packageDir, 'dist/manifest/test-manifest-stub.js')),
      ).toBe(false);
      expect(
        existsSync(
          resolve(packageDir, 'dist/manifest/test-manifest-stub.d.ts'),
        ),
      ).toBe(false);
      expect(
        existsSync(
          resolve(packageDir, 'dist/manifest/test-manifest-stub.d.ts.map'),
        ),
      ).toBe(false);
    } finally {
      for (const path of [...testManifestPaths, ...productionTestStubPaths]) {
        if (existsSync(path)) {
          renameSync(path, join(backupDir, `generated-${basename(path)}`));
        }
        const backup = join(backupDir, basename(path));
        if (existsSync(backup)) renameSync(backup, path);
      }
      rmSync(backupDir, { force: true, recursive: true });
    }
  });
});
