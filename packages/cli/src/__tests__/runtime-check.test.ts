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
  options: {
    version?: string;
    baseDir?: string;
    exports?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const packageDir = resolve(
    options.baseDir || resolve(projectRoot, 'node_modules'),
    ...packageName.split('/'),
  );

  await writeJson(resolve(packageDir, 'package.json'), {
    name: packageName,
    version: options.version || '0.0.0-test',
    type: 'module',
    exports: options.exports || {
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

async function createBrokenManifestPackage(
  projectRoot: string,
  packageName: string,
  options: {
    exports?: Record<string, string>;
    manifestContents?: string;
  } = {},
): Promise<void> {
  const packageDir = resolve(
    projectRoot,
    'node_modules',
    ...packageName.split('/'),
  );
  const manifestContents = options.manifestContents || '{ not valid json }\n';

  await writeJson(resolve(packageDir, 'package.json'), {
    name: packageName,
    version: '0.0.0-test',
    type: 'module',
    exports: {
      '.': './dist/index.js',
      './manifest': './dist/manifest.json',
      './manifest.json': './dist/manifest.json',
      ...options.exports,
    },
    dependencies: {
      '@happyvertical/smrt-core': '0.0.0-test',
    },
  });
  await mkdir(resolve(packageDir, 'dist'), { recursive: true });
  await writeFile(resolve(packageDir, 'dist/index.js'), 'export {};\n');
  await writeFile(resolve(packageDir, 'dist/manifest.json'), manifestContents);
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
  packageName = 'runtime-check-fixture',
): Promise<void> {
  await writeJson(resolve(projectRoot, 'package.json'), {
    name: packageName,
    private: true,
    type: 'module',
    dependencies: {
      '@happyvertical/smrt-core': '0.0.0-test',
    },
  });
  await writeJson(resolve(projectRoot, '.smrt/manifest.json'), manifest);
}

async function createRegisterFile(projectRoot: string): Promise<void> {
  await mkdir(resolve(projectRoot, '.smrt'), { recursive: true });
  await writeFile(
    resolve(projectRoot, '.smrt/register.js'),
    'export function registerAll() {}\n',
  );
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
  it('fails when a consumer project declares SMRT dependencies without generated registrations', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createExternalPackage(projectRoot, '@fixture/messages', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@fixture/messages',
      objects: {
        '@fixture/messages:EmailAccount': {
          className: 'EmailAccount',
          qualifiedName: '@fixture/messages:EmailAccount',
          packageName: '@fixture/messages',
          collection: 'email_accounts',
          fields: {
            email: { type: 'text', required: true },
          },
        },
      },
    });

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@fixture/messages'],
      objects: {},
    });

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'missing-consumer-register',
          message: expect.stringContaining('.smrt/register.js'),
        }),
      ]),
    );
  });

  it('accepts consumer projects once generated registrations exist', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createExternalPackage(projectRoot, '@fixture/messages', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@fixture/messages',
      objects: {
        '@fixture/messages:EmailAccount': {
          className: 'EmailAccount',
          qualifiedName: '@fixture/messages:EmailAccount',
          packageName: '@fixture/messages',
          collection: 'email_accounts',
          fields: {
            email: { type: 'text', required: true },
          },
        },
      },
    });

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@fixture/messages'],
      objects: {},
    });
    await createRegisterFile(projectRoot);

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);

    expect(
      result.findings.some(
        (finding) => finding.code === 'missing-consumer-register',
      ),
    ).toBe(false);
  });

  it('accepts aggregated consumer manifests without treating dependency entries as local', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    const externalDefinition = {
      className: 'FixtureProfile',
      qualifiedName: '@fixture/profiles:FixtureProfile',
      packageName: '@fixture/profiles',
      collection: 'profiles',
      fields: {
        displayName: { type: 'text', required: false },
        isActive: { type: 'boolean', required: false },
      },
    } as const;

    await createExternalPackage(projectRoot, '@fixture/profiles', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@fixture/profiles',
      objects: {
        '@fixture/profiles:FixtureProfile': externalDefinition,
      },
    });

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@fixture/profiles'],
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
        '@fixture/profiles:FixtureProfile': externalDefinition,
      },
    });
    await createRegisterFile(projectRoot);

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);
    const errors = result.findings.filter(
      (finding) => finding.severity === 'error',
    );

    expect(errors, errors.map((finding) => finding.message).join('\n')).toEqual(
      [],
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'pass',
          code: 'runtime-check-passed',
        }),
      ]),
    );
  });

  it('accepts external-only aggregate manifests without hydrating dependency entries as local', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    const family = (packageName: string, childName: string) => ({
      [`${packageName}:FixtureProfile`]: {
        className: 'FixtureProfile',
        qualifiedName: `${packageName}:FixtureProfile`,
        packageName,
        collection: 'profiles',
        fields: { displayName: { type: 'text' as const, required: false } },
      },
      [`${packageName}:${childName}`]: {
        className: childName,
        qualifiedName: `${packageName}:${childName}`,
        packageName,
        collection: 'profiles',
        extends: 'FixtureProfile',
        fields: { role: { type: 'text' as const, required: false } },
      },
    });
    const familyA = family('@fixture/profiles-a', 'FixtureStaffProfile');
    const familyB = family('@fixture/profiles-b', 'FixtureMemberProfile');

    await createExternalPackage(projectRoot, '@fixture/profiles-a', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@fixture/profiles-a',
      objects: familyA,
    });
    await createExternalPackage(projectRoot, '@fixture/profiles-b', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@fixture/profiles-b',
      objects: familyB,
    });

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      smrtDependencies: ['@fixture/profiles-a', '@fixture/profiles-b'],
      objects: { ...familyA, ...familyB },
    });
    await createRegisterFile(projectRoot);

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);
    const errors = result.findings.filter(
      (finding) => finding.severity === 'error',
    );

    expect(errors, errors.map((finding) => finding.message).join('\n')).toEqual(
      [],
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'pass',
          code: 'runtime-check-passed',
        }),
      ]),
    );
  });

  it('retains containerless local entries identified by the project package name', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createExternalPackage(projectRoot, '@fixture/widgets', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@fixture/widgets',
      objects: {
        '@fixture/widgets:Widget': {
          className: 'Widget',
          qualifiedName: '@fixture/widgets:Widget',
          packageName: '@fixture/widgets',
          collection: 'widgets',
          fields: { externalName: { type: 'text', required: false } },
        },
      },
    });

    await createProject(
      projectRoot,
      {
        version: '1.0.0',
        timestamp: Date.now(),
        smrtDependencies: ['@fixture/widgets'],
        objects: {
          '@test/app:Widget': {
            className: 'Widget',
            qualifiedName: '@test/app:Widget',
            packageName: '@test/app',
            collection: 'widgets',
            fields: { localName: { type: 'text', required: false } },
          },
        },
      },
      '@test/app',
    );
    await createRegisterFile(projectRoot);

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);

    expect(result.projectPackageName).toBe('@test/app');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'duplicate-short-name',
        }),
      ]),
    );
  });

  it('hydrates unqualified local entries with the inferred project package owner', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createProject(
      projectRoot,
      {
        version: '1.0.0',
        timestamp: Date.now(),
        objects: {
          Widget: {
            className: 'Widget',
            collection: 'widgets',
            fields: { title: { type: 'text', required: true } },
          },
        },
      },
      '@test/app',
    );

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);
    const errors = result.findings.filter(
      (finding) => finding.severity === 'error',
    );

    expect(result.projectPackageName).toBe('@test/app');
    expect(errors, errors.map((finding) => finding.message).join('\n')).toEqual(
      [],
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'pass',
          code: 'runtime-check-passed',
        }),
      ]),
    );
  });

  it('does not require generated registrations for empty dependency manifests', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createExternalPackage(projectRoot, '@fixture/empty-manifest', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@fixture/empty-manifest',
      objects: {},
    });

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@fixture/empty-manifest'],
      objects: {},
    });

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);

    expect(
      result.findings.some(
        (finding) => finding.code === 'missing-consumer-register',
      ),
    ).toBe(false);
  });

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

  it('warns and skips missing nested SMRT dependency manifests', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createExternalPackage(projectRoot, '@fixture/users', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@fixture/users',
      smrtDependencies: ['@fixture/mobile-contract'],
      objects: {
        '@fixture/users:User': {
          className: 'User',
          qualifiedName: '@fixture/users:User',
          packageName: '@fixture/users',
          collection: 'users',
          fields: {
            email: { type: 'text', required: true },
          },
        },
      },
    });

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@fixture/users'],
      objects: {},
    });
    await createRegisterFile(projectRoot);

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);

    expect(
      result.findings.some(
        (finding) => finding.code === 'missing-dependency-manifest',
      ),
    ).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'missing-nested-dependency-manifest',
          message: expect.stringContaining('@fixture/mobile-contract'),
        }),
      ]),
    );
  });

  it('loads nested import-only packages from their manifest file', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createExternalPackage(
      projectRoot,
      '@fixture/mobile-contract',
      {
        version: '1.0.0',
        timestamp: Date.now(),
        packageName: '@fixture/mobile-contract',
        objects: {},
      },
      {
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
          },
        },
      },
    );
    await createExternalPackage(projectRoot, '@fixture/users', {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@fixture/users',
      smrtDependencies: ['@fixture/mobile-contract'],
      objects: {
        '@fixture/users:User': {
          className: 'User',
          qualifiedName: '@fixture/users:User',
          packageName: '@fixture/users',
          collection: 'users',
          fields: {
            email: { type: 'text', required: true },
          },
        },
      },
    });

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@fixture/users'],
      objects: {},
    });
    await createRegisterFile(projectRoot);

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);

    expect(
      result.findings.filter((finding) =>
        finding.code.includes('dependency-manifest'),
      ),
    ).toEqual([]);
  });

  it('reports malformed dependency manifests as missing findings instead of crashing', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createBrokenManifestPackage(projectRoot, '@fixture/broken-manifest');
    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@fixture/broken-manifest'],
      objects: {},
    });

    process.chdir(projectRoot);
    await expect(runRuntimeCheck(projectRoot)).resolves.toEqual(
      expect.objectContaining({
        findings: expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'missing-dependency-manifest',
            message: expect.stringContaining('@fixture/broken-manifest'),
          }),
        ]),
      }),
    );
  });

  it('ignores unsafe exported manifest targets instead of reading them directly', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createBrokenManifestPackage(projectRoot, '@fixture/unsafe-export', {
      exports: {
        './manifest': './dist/manifest.js',
        './manifest.json': './dist/manifest.js',
      },
    });
    await writeFile(
      resolve(
        projectRoot,
        'node_modules',
        '@fixture',
        'unsafe-export',
        'dist',
        'manifest.js',
      ),
      'export default {};\n',
    );

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@fixture/unsafe-export'],
      objects: {},
    });

    process.chdir(projectRoot);
    await expect(runRuntimeCheck(projectRoot)).resolves.toEqual(
      expect.objectContaining({
        findings: expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'missing-dependency-manifest',
            message: expect.stringContaining('@fixture/unsafe-export'),
          }),
        ]),
      }),
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
    await createRegisterFile(projectRoot);

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

  it('loads transitive dependency manifests relative to the package that declares them', async () => {
    const projectRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-runtime-check-'),
    );
    tempDirs.push(projectRoot);

    await createExternalPackage(
      projectRoot,
      '@fixture/parent',
      {
        version: '1.0.0',
        timestamp: Date.now(),
        packageName: '@fixture/parent',
        smrtDependencies: ['@fixture/child'],
        objects: {
          '@fixture/parent:FixtureParent': {
            className: 'FixtureParent',
            qualifiedName: '@fixture/parent:FixtureParent',
            packageName: '@fixture/parent',
            collection: 'profiles',
            fields: {
              displayName: { type: 'text', required: false },
            },
          },
        },
      },
      { version: '1.0.0' },
    );

    const parentNodeModules = resolve(
      projectRoot,
      'node_modules',
      '@fixture',
      'parent',
      'node_modules',
    );

    await createExternalPackage(
      projectRoot,
      '@fixture/child',
      {
        version: '1.0.0',
        timestamp: Date.now(),
        packageName: '@fixture/child',
        objects: {
          '@fixture/child:FixtureChild': {
            className: 'FixtureChild',
            qualifiedName: '@fixture/child:FixtureChild',
            packageName: '@fixture/child',
            collection: 'profiles',
            fields: {
              nickname: { type: 'text', required: false },
            },
          },
        },
      },
      { version: '1.0.0', baseDir: parentNodeModules },
    );

    await createProject(projectRoot, {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: '@test/app',
      smrtDependencies: ['@fixture/parent'],
      objects: {
        '@test/app:FixtureGrandchild': {
          className: 'FixtureGrandchild',
          qualifiedName: '@test/app:FixtureGrandchild',
          packageName: '@test/app',
          collection: 'profiles',
          extends: '@fixture/child:FixtureChild',
          fields: {
            role: { type: 'text', required: false },
          },
        },
      },
    });
    await createRegisterFile(projectRoot);

    process.chdir(projectRoot);
    const result = await runRuntimeCheck(projectRoot);
    const errorCodes = result.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => finding.code);

    expect(errorCodes).not.toContain('missing-dependency-manifest');
    expect(errorCodes).toEqual([]);
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
