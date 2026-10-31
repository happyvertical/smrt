/**
 * Issue #4128: the active test manifest snapshot is resolved per project root
 * from the environment, precedes local production paths only inside a test
 * run, and is never consulted for dependency (external) loads.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManifestBuilder } from '../generator.js';
import { ManifestManager } from '../manager.js';
import {
  registerActiveTestManifestPath,
  resolveActiveTestManifestPath,
  SMRT_TEST_MANIFEST_PATHS_ENV_KEY,
} from '../test-artifacts.js';

const roots: string[] = [];
let savedEnv: string | undefined;

function root(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-4128-')));
  roots.push(dir);
  return dir;
}

function writeManifest(path: string, objects: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: '1.0.0', objects }));
}

beforeEach(() => {
  savedEnv = process.env[SMRT_TEST_MANIFEST_PATHS_ENV_KEY];
  delete process.env[SMRT_TEST_MANIFEST_PATHS_ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined)
    delete process.env[SMRT_TEST_MANIFEST_PATHS_ENV_KEY];
  else process.env[SMRT_TEST_MANIFEST_PATHS_ENV_KEY] = savedEnv;
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('active test manifest resolution', () => {
  it('is absent outside a registered test run and for malformed values', () => {
    const dir = root();
    expect(resolveActiveTestManifestPath(dir)).toBeNull();
    process.env[SMRT_TEST_MANIFEST_PATHS_ENV_KEY] = '[1,2]';
    expect(resolveActiveTestManifestPath(dir)).toBeNull();
    process.env[SMRT_TEST_MANIFEST_PATHS_ENV_KEY] = '{not json';
    expect(resolveActiveTestManifestPath(dir)).toBeNull();
  });

  it('matches the registered root as given, with a trailing separator, and through a symlink', () => {
    const dir = root();
    const link = join(root(), 'linked');
    symlinkSync(dir, link);
    const snapshot = join(dir, '.smrt/test-runs/run/manifest.json');
    registerActiveTestManifestPath(dir, snapshot);
    expect(resolveActiveTestManifestPath(dir)).toBe(snapshot);
    expect(resolveActiveTestManifestPath(`${dir}/`)).toBe(snapshot);
    expect(resolveActiveTestManifestPath(link)).toBe(snapshot);
  });

  it('keeps other roots registered in the same process', () => {
    const first = root();
    const second = root();
    registerActiveTestManifestPath(first, '/snapshots/first.json');
    registerActiveTestManifestPath(second, '/snapshots/second.json');
    expect(resolveActiveTestManifestPath(first)).toBe('/snapshots/first.json');
    expect(resolveActiveTestManifestPath(second)).toBe(
      '/snapshots/second.json',
    );
    expect(resolveActiveTestManifestPath(root())).toBeNull();
  });
});

describe('local manifest loading inside a test run', () => {
  it('prefers the run snapshot over a production .smrt/manifest.json for its own root only', () => {
    const dir = root();
    const other = root();
    writeManifest(join(dir, '.smrt/manifest.json'), { Production: {} });
    writeManifest(join(other, '.smrt/manifest.json'), { OtherProduction: {} });
    const snapshot = join(dir, '.smrt/test-runs/run/manifest.json');
    writeManifest(snapshot, { Production: {}, InlineFixture: {} });

    expect(Object.keys(new ManifestManager(dir).loadLocal()!.objects)).toEqual([
      'Production',
    ]);
    registerActiveTestManifestPath(dir, snapshot);
    const manager = new ManifestManager(dir);
    expect(manager.getLocalCandidatePaths()[0]).toBe(snapshot);
    expect(Object.keys(manager.loadLocal()!.objects)).toEqual([
      'Production',
      'InlineFixture',
    ]);
    // A dependency load never reads a test snapshot.
    expect(Object.keys(manager.loadForExternalPackage()!.objects)).toEqual([
      'Production',
    ]);
    expect(
      Object.keys(new ManifestManager(other).loadLocal()!.objects),
    ).toEqual(['OtherProduction']);
  });

  it('falls back to the production chain when the registered snapshot is missing', () => {
    const dir = root();
    writeManifest(join(dir, '.smrt/manifest.json'), { Production: {} });
    registerActiveTestManifestPath(dir, join(dir, 'missing/manifest.json'));
    expect(Object.keys(new ManifestManager(dir).loadLocal()!.objects)).toEqual([
      'Production',
    ]);
  });
});

describe('ManifestBuilder explicit output mode', () => {
  it('writes only the explicit output path, never a unified production location', async () => {
    const dir = root();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@t/x' }));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/plain.ts'), 'export const plain = 1;');
    const outputDir = join(dir, '.smrt/test-runs/run');
    await new ManifestBuilder(dir).generate({
      outputMode: 'explicit',
      artifactPurpose: 'test',
      outputDir,
      outputName: 'manifest.json',
      generateTypeStub: false,
    });
    expect(existsSync(join(outputDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(dir, '.smrt/manifest.json'))).toBe(false);
    expect(existsSync(join(dir, 'dist/manifest.json'))).toBe(false);
  });
});
