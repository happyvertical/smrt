import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearManifestCache,
  discoverManifestSync,
} from '../manifest-loader.js';

function writeScopedPackage(
  appDir: string,
  packageName: string,
  packageJson: Record<string, unknown>,
  manifest: Record<string, unknown>,
): void {
  const [, scope, pkg] = packageName.match(/^@([^/]+)\/(.+)$/) || [];
  const packageDir = join(appDir, 'node_modules', `@${scope}`, pkg);
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(packageJson, null, 2),
  );
  writeFileSync(
    join(packageDir, 'dist', 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
}

describe('Manifest loader contract', () => {
  const originalCwd = process.cwd();
  let tempRoot: string;
  let appDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'smrt-manifest-loader-'));
    appDir = join(tempRoot, 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'manifest-loader-test-app', version: '1.0.0' }),
    );
    clearManifestCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    clearManifestCache();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('clearManifestCache resets cached manifest state instead of keeping stale test/dev values', () => {
    globalThis.__smrtManifestStatic = {
      version: '1.0.0',
      timestamp: 1,
      packageName: '@happyvertical/smrt-core',
      objects: {
        StaticOnly: {
          className: 'StaticOnly',
        },
      },
    } as any;
    globalThis.__smrtManifestStaticLoadAttempted = true;
    globalThis.__smrtManifestTest = null;
    globalThis.__smrtManifestTestLoadAttempted = true;
    globalThis.__smrtManifestLocalTest = {
      version: '1.0.0',
      timestamp: 1,
      packageName: '@local/test',
      objects: {
        StaleOnly: {
          className: 'StaleOnly',
        },
      },
      smrtDependencies: [],
    } as any;
    globalThis.__smrtManifestCache = new Map([
      [
        '@happyvertical/smrt-stale',
        {
          version: '1.0.0',
          timestamp: 1,
          packageName: '@happyvertical/smrt-stale',
          objects: {},
        } as any,
      ],
    ]);
    globalThis.__smrtManifestCollisions = new Map([
      ['StaleOnly', [{ packageName: '@happyvertical/smrt-stale' } as any]],
    ]);
    globalThis.__smrtSTISiblingCache = new Map([['stale_table', []]]);

    expect(discoverManifestSync('StaleOnly')?.className).toBe('StaleOnly');

    clearManifestCache();

    expect(globalThis.__smrtManifestStatic).toBeUndefined();
    expect(globalThis.__smrtManifestStaticLoadAttempted).toBe(false);
    expect(globalThis.__smrtManifestTest).toBeUndefined();
    expect(globalThis.__smrtManifestTestLoadAttempted).toBe(false);
    expect(globalThis.__smrtManifestLocalTest).toBeUndefined();
    expect(globalThis.__smrtManifestCache?.size).toBe(0);
    expect(globalThis.__smrtManifestCollisions?.size).toBe(0);
    expect(globalThis.__smrtSTISiblingCache?.size).toBe(0);
    expect(discoverManifestSync('StaleOnly')).toBeUndefined();
  });

  it('discovers external classes through declared smrtDependencies and explicit manifest exports', () => {
    const packageName = '@happyvertical/smrt-contract-exported';
    writeScopedPackage(
      appDir,
      packageName,
      {
        name: packageName,
        version: '1.0.0',
        exports: {
          './manifest.json': './dist/manifest.json',
        },
      },
      {
        version: '1.0.0',
        timestamp: Date.now(),
        moduleType: 'smrt',
        packageName,
        objects: {
          [`${packageName}:ContractExported`]: {
            className: 'ContractExported',
            fields: {
              title: { type: 'text' },
            },
          },
        },
      },
    );

    process.chdir(appDir);
    globalThis.__smrtManifestLocalTest = {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@local/test-app',
      objects: {},
      smrtDependencies: [packageName],
    } as any;

    const entry = discoverManifestSync('ContractExported');

    expect(entry).toBeDefined();
    expect(entry?.className).toBe('ContractExported');
  });

  it('does not fall back to implicit filesystem probing when a package omits manifest exports', () => {
    const packageName = '@happyvertical/smrt-contract-hidden';
    writeScopedPackage(
      appDir,
      packageName,
      {
        name: packageName,
        version: '1.0.0',
      },
      {
        version: '1.0.0',
        timestamp: Date.now(),
        moduleType: 'smrt',
        packageName,
        objects: {
          [`${packageName}:HiddenContractClass`]: {
            className: 'HiddenContractClass',
            fields: {
              title: { type: 'text' },
            },
          },
        },
      },
    );

    process.chdir(appDir);
    globalThis.__smrtManifestLocalTest = {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@local/test-app',
      objects: {},
      smrtDependencies: [packageName],
    } as any;

    expect(discoverManifestSync('HiddenContractClass')).toBeUndefined();
  });
});
