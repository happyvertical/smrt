import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import {
  clearManifestCache,
  discoverManifestEntry,
  discoverManifestSync,
} from '../manifest-loader.js';

function writeScopedPackage(
  appDir: string,
  packageName: string,
  packageJson: Record<string, unknown>,
  manifest?: Record<string, unknown>,
): void {
  const [, scope, pkg] = packageName.match(/^@([^/]+)\/(.+)$/) || [];
  const packageDir = join(appDir, 'node_modules', `@${scope}`, pkg);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(packageJson, null, 2),
  );
  if (manifest) {
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(
      join(packageDir, 'dist', 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
  }
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
    ObjectRegistry.clear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    clearManifestCache();
    ObjectRegistry.clear();
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

  it('supports import-only manifest exports under the JSON manifest contract', () => {
    const packageName = '@happyvertical/smrt-contract-import-only';
    writeScopedPackage(
      appDir,
      packageName,
      {
        name: packageName,
        version: '1.0.0',
        exports: {
          './manifest.json': {
            import: './dist/manifest.json',
          },
        },
      },
      {
        version: '1.0.0',
        timestamp: Date.now(),
        moduleType: 'smrt',
        packageName,
        objects: {
          [`${packageName}:ImportOnlyManifest`]: {
            className: 'ImportOnlyManifest',
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

    const entry = discoverManifestSync('ImportOnlyManifest');

    expect(entry).toBeDefined();
    expect(entry?.className).toBe('ImportOnlyManifest');
  });

  it('resolves installed package manifests through parent node_modules directories', () => {
    const packageName = '@happyvertical/smrt-contract-parent-chain';
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
          [`${packageName}:ParentChainManifest`]: {
            className: 'ParentChainManifest',
            fields: {
              title: { type: 'text' },
            },
          },
        },
      },
    );

    const nestedAppDir = join(appDir, 'apps', 'dashboard');
    mkdirSync(nestedAppDir, { recursive: true });

    process.chdir(nestedAppDir);
    globalThis.__smrtManifestLocalTest = {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@local/test-app',
      objects: {},
      smrtDependencies: [packageName],
    } as any;

    const entry = discoverManifestSync('ParentChainManifest');

    expect(entry).toBeDefined();
    expect(entry?.className).toBe('ParentChainManifest');
  });

  it('loads transitive declared dependencies during a single discovery pass', () => {
    const parentPackage = '@happyvertical/smrt-contract-parent';
    const childPackage = '@happyvertical/smrt-contract-child';

    writeScopedPackage(
      appDir,
      parentPackage,
      {
        name: parentPackage,
        version: '1.0.0',
        exports: {
          './manifest.json': './dist/manifest.json',
        },
      },
      {
        version: '1.0.0',
        timestamp: Date.now(),
        moduleType: 'smrt',
        packageName: parentPackage,
        smrtDependencies: [childPackage],
        objects: {},
      },
    );

    writeScopedPackage(
      appDir,
      childPackage,
      {
        name: childPackage,
        version: '1.0.0',
        exports: {
          './manifest.json': './dist/manifest.json',
        },
      },
      {
        version: '1.0.0',
        timestamp: Date.now(),
        moduleType: 'smrt',
        packageName: childPackage,
        objects: {
          [`${childPackage}:TransitiveContractClass`]: {
            className: 'TransitiveContractClass',
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
      smrtDependencies: [parentPackage],
    } as any;

    const entry = discoverManifestSync('TransitiveContractClass');

    expect(entry).toBeDefined();
    expect(entry?.className).toBe('TransitiveContractClass');
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

  it('silently skips partial source-class probes when a manifest export file is missing', async () => {
    const packageName = '@happyvertical/smrt-contract-missing-manifest';
    writeScopedPackage(appDir, packageName, {
      name: packageName,
      version: '1.0.0',
      exports: {
        './manifest.json': './dist/manifest.json',
      },
    });

    process.chdir(appDir);

    class MissingManifestContractClass extends SmrtObject {}

    ObjectRegistry.register(MissingManifestContractClass as any, {
      packageName,
      tableStrategy: 'sti',
    });

    const registered = ObjectRegistry.findClass('MissingManifestContractClass');
    expect(registered).toBeDefined();
    registered?.fields.set('tenantId', { type: 'text', _meta: {} });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const entry = await discoverManifestEntry(
        MissingManifestContractClass as any,
        'MissingManifestContractClass',
      );

      expect(entry).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
