import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { SmartObjectManifest } from '@happyvertical/smrt-core/manifest';
import { afterEach, describe, expect, it } from 'vitest';
import { runRuntimeCheck } from '../runtime-check.js';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createExternalPackage(
  projectRoot: string,
  packageName: string,
  manifest: SmartObjectManifest,
): Promise<void> {
  const packageDir = resolve(
    projectRoot,
    'node_modules',
    ...packageName.split('/'),
  );

  await writeJson(resolve(packageDir, 'package.json'), {
    name: packageName,
    version: '0.0.0-test',
    type: 'module',
    exports: {
      '.': './dist/index.js',
      './manifest': './dist/manifest.json',
      './manifest.json': './dist/manifest.json',
    },
    dependencies: {
      '@happyvertical/smrt-core': '0.0.0-test',
    },
  });
  await mkdir(resolve(packageDir, 'dist'), { recursive: true });
  await writeFile(resolve(packageDir, 'dist/index.js'), 'export {};\n');
  await writeJson(resolve(packageDir, 'dist/manifest.json'), manifest);
}

async function createProject(
  projectRoot: string,
  manifest: SmartObjectManifest,
): Promise<void> {
  await writeJson(resolve(projectRoot, 'package.json'), {
    name: 'runtime-check-fixture',
    private: true,
    type: 'module',
    dependencies: {
      '@happyvertical/smrt-core': '0.0.0-test',
    },
  });
  await writeJson(resolve(projectRoot, '.smrt/manifest.json'), manifest);
}

afterEach(async () => {
  process.chdir(originalCwd);
  ObjectRegistry.clear();
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

describe('runRuntimeCheck', () => {
  it('fails when a declared SMRT dependency has no manifest export', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@fixture/missing-smrt-package'],
      objects: {},
    });

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'missing-dependency-manifest',
        }),
      ]),
    );
  });

  it('detects a local shadow class that masks richer external runtime fields', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createExternalPackage(projectRoot, '@happyvertical/smrt-messages', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@happyvertical/smrt-messages',
      objects: {
        '@happyvertical/smrt-messages:EmailAccount': {
          className: 'EmailAccount',
          qualifiedName: '@happyvertical/smrt-messages:EmailAccount',
          packageName: '@happyvertical/smrt-messages',
          collection: 'email_accounts',
          fields: {
            email: { type: 'text', required: true },
            providerType: { type: 'text', required: false },
            isActive: { type: 'boolean', required: false },
          },
        },
      },
    });

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@happyvertical/smrt-messages'],
      objects: {
        '@test/app:EmailAccount': {
          className: 'EmailAccount',
          qualifiedName: '@test/app:EmailAccount',
          packageName: '@test/app',
          collection: 'email_accounts',
          fields: {
            tenantId: { type: 'text', required: false },
          },
        },
      },
    });

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'shadow-class',
        }),
      ]),
    );
  });

  it('passes when external inheritance hydrates through getAllFields()', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createExternalPackage(projectRoot, '@happyvertical/smrt-profiles', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@happyvertical/smrt-profiles',
      objects: {
        '@happyvertical/smrt-profiles:FixtureProfile': {
          className: 'FixtureProfile',
          qualifiedName: '@happyvertical/smrt-profiles:FixtureProfile',
          packageName: '@happyvertical/smrt-profiles',
          collection: 'profiles',
          fields: {
            displayName: { type: 'text', required: false },
            isActive: { type: 'boolean', required: false },
          },
        },
      },
    });

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@happyvertical/smrt-profiles'],
      objects: {
        '@test/app:FixtureStaffProfile': {
          className: 'FixtureStaffProfile',
          qualifiedName: '@test/app:FixtureStaffProfile',
          packageName: '@test/app',
          collection: 'profiles',
          extends: 'FixtureProfile',
          fields: {
            role: { type: 'text', required: false },
          },
        },
      },
    });

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);
    const errorCodes = result.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => finding.code);

    expect(errorCodes).toEqual([]);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'pass',
          code: 'runtime-check-passed',
        }),
      ]),
    );
  });
});
