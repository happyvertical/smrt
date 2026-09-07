/**
 * Regression coverage for Issue #2223.
 *
 * Test manifests are generated only for core's test runtime. They must not
 * enter the production build graph, where Turbo would hash an artifact that
 * `generate:test` owns and restores.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getCoreEntries } from '../../../vite.config.js';

const packageDir = resolve(import.meta.dirname, '../../..');
const workspaceDir = resolve(packageDir, '../..');
const liveGeneratedPaths = [
  resolve(packageDir, 'src/manifest/test-manifest.json'),
  resolve(packageDir, 'src/manifest/test-manifest-stub.ts'),
  resolve(packageDir, '.smrt/manifest.json'),
  resolve(packageDir, 'dist'),
];

function runPnpm(args: string[]) {
  return runCommand('pnpm', args, workspaceDir);
}

function runCommand(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
  });

  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}

type TurboTask = {
  dependencies: string[];
  hash: string;
  taskId: string;
};

function getCoreBuildTask(cwd: string): TurboTask {
  const output = runCommand(
    resolve(workspaceDir, 'node_modules/.bin/turbo'),
    ['run', 'build', '--filter=@happyvertical/smrt-core', '--dry=json'],
    cwd,
  );
  const jsonStart = output.indexOf('\n{');
  const task = JSON.parse(
    output.slice(jsonStart === -1 ? 0 : jsonStart + 1),
  ).tasks.find(
    (candidate: TurboTask) =>
      candidate.taskId === '@happyvertical/smrt-core#build',
  ) as TurboTask | undefined;

  if (!task)
    throw new Error('Core build task was missing from the Turbo graph');
  return task;
}

function snapshotPath(path: string): string {
  if (!existsSync(path)) return 'missing';

  const entries: string[] = [];
  const visit = (current: string) => {
    const stat = lstatSync(current);
    const name = relative(path, current) || '.';
    if (stat.isDirectory()) {
      entries.push(`dir:${name}`);
      for (const entry of readdirSync(current).sort())
        visit(join(current, entry));
      return;
    }

    entries.push(
      `file:${name}:${createHash('sha256').update(readFileSync(current)).digest('hex')}`,
    );
  };
  visit(path);
  return entries.join('\n');
}

function snapshotLiveGeneratedArtifacts(): string[] {
  return liveGeneratedPaths.map(snapshotPath);
}

function withIsolatedCoreFixture<T>(run: (fixtureDir: string) => T): T {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'smrt-2223-core-build-'));
  const fixtureDir = join(fixtureRoot, 'packages', 'core');

  try {
    cpSync(packageDir, fixtureDir, {
      recursive: true,
      filter: (source) =>
        ![
          resolve(packageDir, 'node_modules'),
          resolve(packageDir, 'dist'),
          resolve(packageDir, '.smrt'),
          resolve(packageDir, 'src/manifest/test-manifest.json'),
          resolve(packageDir, 'src/manifest/test-manifest-stub.ts'),
        ].includes(source),
    });
    symlinkSync(
      resolve(packageDir, 'node_modules'),
      join(fixtureDir, 'node_modules'),
    );
    cpSync(
      resolve(workspaceDir, 'package.json'),
      join(fixtureRoot, 'package.json'),
    );
    cpSync(
      resolve(workspaceDir, 'turbo.json'),
      join(fixtureRoot, 'turbo.json'),
    );
    cpSync(
      resolve(workspaceDir, 'pnpm-workspace.yaml'),
      join(fixtureRoot, 'pnpm-workspace.yaml'),
    );
    cpSync(
      resolve(workspaceDir, 'tsconfig.json'),
      join(fixtureRoot, 'tsconfig.json'),
    );
    cpSync(
      resolve(workspaceDir, 'tsconfig.package-build.json'),
      join(fixtureRoot, 'tsconfig.package-build.json'),
    );
    symlinkSync(
      resolve(workspaceDir, 'node_modules'),
      join(fixtureRoot, 'node_modules'),
    );
    for (const dependency of ['config', 'scanner', 'types']) {
      const source = resolve(workspaceDir, 'packages', dependency);
      const destination = join(fixtureRoot, 'packages', dependency);
      cpSync(source, destination, {
        recursive: true,
        filter: (path) => path !== join(source, 'node_modules'),
      });
      symlinkSync(
        join(source, 'node_modules'),
        join(destination, 'node_modules'),
      );
    }

    return run(fixtureDir);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
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
    const liveBefore = snapshotLiveGeneratedArtifacts();

    withIsolatedCoreFixture((fixtureDir) => {
      const fixtureWorkspace = resolve(fixtureDir, '../..');
      const coldBuild = getCoreBuildTask(fixtureWorkspace);
      expect(coldBuild.dependencies).toContain(
        '@happyvertical/smrt-core#generate',
      );
      runPnpm(['--dir', fixtureDir, 'run', 'generate:test']);
      expect(getCoreBuildTask(fixtureWorkspace).hash).toBe(coldBuild.hash);

      appendFileSync(
        resolve(fixtureDir, 'scripts/generate-manifest.js'),
        '\n// fixture-only generate-task hash input\n',
      );
      expect(getCoreBuildTask(fixtureWorkspace).hash).not.toBe(coldBuild.hash);

      runPnpm(['--dir', fixtureDir, 'run', 'build']);
      expect(
        readFileSync(resolve(fixtureDir, 'dist/index.js')).byteLength,
      ).toBeGreaterThan(0);
      expect(
        existsSync(resolve(fixtureDir, 'dist/manifest/test-manifest-stub.js')),
      ).toBe(false);
      expect(
        existsSync(
          resolve(fixtureDir, 'dist/manifest/test-manifest-stub.d.ts'),
        ),
      ).toBe(false);
      expect(
        existsSync(
          resolve(fixtureDir, 'dist/manifest/test-manifest-stub.d.ts.map'),
        ),
      ).toBe(false);
    });

    expect(snapshotLiveGeneratedArtifacts()).toEqual(liveBefore);
  }, 180_000);

  it('cleans up an isolated fixture when an assertion fails', () => {
    let fixtureDir = '';

    expect(() =>
      withIsolatedCoreFixture((fixture) => {
        fixtureDir = fixture;
        expect(existsSync(fixture)).toBe(false);
      }),
    ).toThrow();

    expect(existsSync(fixtureDir)).toBe(false);
  });
});
