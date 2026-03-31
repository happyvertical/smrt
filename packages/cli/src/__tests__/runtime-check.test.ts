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
  options: { version?: string } = {},
): Promise<void> {
  const packageDir = resolve(
    projectRoot,
    'node_modules',
    ...packageName.split('/'),
  );

  await writeJson(resolve(packageDir, 'package.json'), {
    name: packageName,
    version: options.version || '0.0.0-test',
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

async function createLoosePackage(
  projectRoot: string,
  relativeDir: string,
  packageJson: Record<string, unknown>,
  manifest?: SmartObjectManifest,
): Promise<void> {
  const packageDir = resolve(projectRoot, 'node_modules', relativeDir);

  await writeJson(resolve(packageDir, 'package.json'), packageJson);
  if (manifest) {
    await writeJson(resolve(packageDir, 'manifest.json'), manifest);
  }
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

  it('reports ambiguous short-name parent references instead of picking the first manifest entry', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createExternalPackage(projectRoot, '@fixture/profiles-a', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@fixture/profiles-a',
      objects: {
        '@fixture/profiles-a:FixtureProfile': {
          className: 'FixtureProfile',
          qualifiedName: '@fixture/profiles-a:FixtureProfile',
          packageName: '@fixture/profiles-a',
          collection: 'profiles',
          fields: {
            displayName: { type: 'text', required: false },
          },
        },
      },
    });

    await createExternalPackage(projectRoot, '@fixture/profiles-b', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@fixture/profiles-b',
      objects: {
        '@fixture/profiles-b:FixtureProfile': {
          className: 'FixtureProfile',
          qualifiedName: '@fixture/profiles-b:FixtureProfile',
          packageName: '@fixture/profiles-b',
          collection: 'profiles',
          fields: {
            nickname: { type: 'text', required: false },
          },
        },
      },
    });

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@fixture/profiles-a', '@fixture/profiles-b'],
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

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'ambiguous-extends-reference',
          message: expect.stringContaining(
            '@fixture/profiles-a:FixtureProfile',
          ),
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'ambiguous-extends-reference',
          message: expect.stringContaining(
            '@fixture/profiles-b:FixtureProfile',
          ),
        }),
      ]),
    );
  });

  it('reports runtime discovery failures without crashing the command', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: [],
      objects: {},
    });

    await createLoosePackage(
      projectRoot,
      'conflict-a',
      {
        name: '@happyvertical/smrt-core',
        version: '0.21.27',
        dependencies: { smrt: '^0.21.27' },
      },
      {
        version: '1.0.0',
        timestamp: Date.now(),
        packageName: '@happyvertical/smrt-core',
        objects: {
          '@happyvertical/smrt-core:CoreFixtureA': {
            className: 'CoreFixtureA',
            qualifiedName: '@happyvertical/smrt-core:CoreFixtureA',
            packageName: '@happyvertical/smrt-core',
            collection: 'core_fixtures',
            fields: {},
          },
        },
      },
    );

    await createLoosePackage(
      projectRoot,
      'conflict-b',
      {
        name: '@happyvertical/smrt-core',
        version: '0.21.28',
        dependencies: { smrt: '^0.21.28' },
      },
      {
        version: '1.0.0',
        timestamp: Date.now(),
        packageName: '@happyvertical/smrt-core',
        objects: {
          '@happyvertical/smrt-core:CoreFixtureB': {
            className: 'CoreFixtureB',
            qualifiedName: '@happyvertical/smrt-core:CoreFixtureB',
            packageName: '@happyvertical/smrt-core',
            collection: 'core_fixtures',
            fields: {},
          },
        },
      },
    );

    process.chdir(projectRoot);
    await expect(runRuntimeCheck(projectRoot)).resolves.toEqual(
      expect.objectContaining({
        findings: expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'runtime-discovery-error',
            message: expect.stringContaining('SMRT Version Conflict Detected'),
          }),
        ]),
      }),
    );
  });
});
