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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
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

function getCoreTask(
  cwd: string,
  taskName: 'build' | 'generate:test',
): TurboTask {
  const output = runCommand(
    resolve(workspaceDir, 'node_modules/.bin/turbo'),
    ['run', taskName, '--filter=@happyvertical/smrt-core', '--dry=json'],
    cwd,
  );
  const jsonStart = output.indexOf('\n{');
  const task = JSON.parse(
    output.slice(jsonStart === -1 ? 0 : jsonStart + 1),
  ).tasks.find(
    (candidate: TurboTask) =>
      candidate.taskId === `@happyvertical/smrt-core#${taskName}`,
  ) as TurboTask | undefined;

  if (!task)
    throw new Error(`Core ${taskName} task was missing from the Turbo graph`);
  return task;
}

function getCoreBuildTask(cwd: string): TurboTask {
  return getCoreTask(cwd, 'build');
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
    cpSync(
      resolve(workspaceDir, 'vite.config.base.ts'),
      join(fixtureRoot, 'vite.config.base.ts'),
    );
    mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true });
    cpSync(
      resolve(workspaceDir, 'scripts/declarations.ts'),
      join(fixtureRoot, 'scripts/declarations.ts'),
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
    expect(turbo.tasks.build.outputs).not.toEqual(
      expect.arrayContaining([
        '.smrt/manifest.json',
        '.smrt/smrt-knowledge.json',
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

  it('invalidates cached test knowledge when its supported config changes', () => {
    withIsolatedCoreFixture((fixtureDir) => {
      const fixtureWorkspace = resolve(fixtureDir, '../..');
      const configPath = resolve(fixtureDir, 'smrt.config.json');
      const turbo = resolve(workspaceDir, 'node_modules/.bin/turbo');
      const knowledgePath = resolve(fixtureDir, '.smrt/smrt-knowledge.json');

      writeFileSync(
        configPath,
        JSON.stringify({ knowledge: { includeDocs: false } }),
      );
      const withoutDocs = getCoreTask(fixtureWorkspace, 'generate:test');
      runCommand(
        turbo,
        ['run', 'generate:test', '--filter=@happyvertical/smrt-core'],
        fixtureWorkspace,
      );
      expect(
        JSON.parse(readFileSync(knowledgePath, 'utf8')).agentDoc,
      ).toBeUndefined();

      writeFileSync(
        configPath,
        JSON.stringify({ knowledge: { includeDocs: true } }),
      );
      const withDocs = getCoreTask(fixtureWorkspace, 'generate:test');
      expect(withDocs.hash).not.toBe(withoutDocs.hash);
      runCommand(
        turbo,
        ['run', 'generate:test', '--filter=@happyvertical/smrt-core'],
        fixtureWorkspace,
      );

      expect(
        JSON.parse(readFileSync(knowledgePath, 'utf8')).agentDoc,
      ).toContain('# @happyvertical/smrt-core');

      appendFileSync(
        resolve(fixtureDir, 'AGENTS.md'),
        '\nfixture cache sentinel\n',
      );
      const withChangedInstructions = getCoreTask(
        fixtureWorkspace,
        'generate:test',
      );
      expect(withChangedInstructions.hash).not.toBe(withDocs.hash);
      runCommand(
        turbo,
        ['run', 'generate:test', '--filter=@happyvertical/smrt-core'],
        fixtureWorkspace,
      );
      expect(
        JSON.parse(readFileSync(knowledgePath, 'utf8')).agentDoc,
      ).toContain('fixture cache sentinel');
    });
  }, 180_000);

  it('does not restore a nonproducer package manifest over test knowledge', () => {
    withIsolatedCoreFixture((fixtureDir) => {
      const workspace = resolve(fixtureDir, '../..');
      const turboPath = resolve(workspace, 'turbo.json');
      const packagePath = resolve(fixtureDir, 'package.json');
      const smrtDir = resolve(fixtureDir, '.smrt');
      const manifestPath = resolve(smrtDir, 'manifest.json');
      const knowledgePath = resolve(smrtDir, 'smrt-knowledge.json');
      const turbo = JSON.parse(readFileSync(turboPath, 'utf8'));
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
      turbo.tasks.build.dependsOn = [];
      turbo.tasks.build.inputs = ['package.json'];
      packageJson.scripts.build = 'node -e ""';
      writeFileSync(turboPath, JSON.stringify(turbo));
      writeFileSync(packagePath, JSON.stringify(packageJson));
      mkdirSync(smrtDir, { recursive: true });
      writeFileSync(manifestPath, JSON.stringify({ version: 'old' }));
      runCommand(
        resolve(workspaceDir, 'node_modules/.bin/turbo'),
        ['run', 'build', '--filter=@happyvertical/smrt-core'],
        workspace,
      );
      writeFileSync(manifestPath, JSON.stringify({ version: 'test-current' }));
      writeFileSync(
        knowledgePath,
        JSON.stringify({ sourceHashes: { manifest: 'current' } }),
      );
      runCommand(
        resolve(workspaceDir, 'node_modules/.bin/turbo'),
        ['run', 'build', '--filter=@happyvertical/smrt-core'],
        workspace,
      );
      expect(JSON.parse(readFileSync(manifestPath, 'utf8')).version).toBe(
        'test-current',
      );
      expect(
        JSON.parse(readFileSync(knowledgePath, 'utf8')).sourceHashes.manifest,
      ).toBe('current');
    });
  }, 180_000);

  it('removes stale local knowledge when production config disables it', () => {
    withIsolatedCoreFixture((fixtureDir) => {
      const localKnowledge = resolve(fixtureDir, '.smrt/smrt-knowledge.json');
      mkdirSync(resolve(fixtureDir, '.smrt'), { recursive: true });
      writeFileSync(localKnowledge, '{"stale":true}');
      writeFileSync(
        resolve(fixtureDir, 'smrt.config.json'),
        JSON.stringify({ knowledge: { enabled: false } }),
      );
      runPnpm(['--dir', fixtureDir, 'run', 'generate']);
      expect(existsSync(localKnowledge)).toBe(false);
    });
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
