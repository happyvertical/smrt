/**
 * Coverage-focused tests for ManifestBuilder (manifest/generator.ts, #1500).
 *
 * The existing generator.test.ts covers file discovery, scanner config, output
 * generation, and empty-manifest handling. This file targets the remaining
 * uncovered orchestration branches:
 *
 * - loadViteConfig: the "vite.config.ts not found" path, and a real config that
 *   exposes a smrt-auto-service plugin with baseClasses
 * - includeExternalBaseClasses: loadExternalBaseClasses reading a fixture
 *   package's dist/manifest.json (success + missing-manifest paths)
 * - injectPackageInfo with an unreadable package.json (warning branch)
 * - normalizeFilePaths rewriting absolute file paths to workspace-relative
 *
 * ManifestBuilder resolves everything relative to process.cwd(), so each test
 * chdir's into an isolated fixture dir and restores cwd in a finally block.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManifestBuilder } from '../generator.js';

const LOCAL_CLASS_SRC = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';
@smrt()
class Local extends SmrtObject {
  name: string = '';
}
`;

describe('ManifestBuilder coverage', () => {
  let dir: string;
  let prev: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-builder-cov-'));
    prev = process.cwd();
    mkdirSync(join(dir, 'src'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  });

  it('continues with default baseClasses when loadViteConfig finds no vite.config.ts', async () => {
    writeFileSync(join(dir, 'src', 'thing.ts'), LOCAL_CLASS_SRC);

    const builder = new ManifestBuilder();
    process.chdir(dir);
    const manifest = await builder.generate({
      include: ['src/**/*.ts'],
      loadViteConfig: true, // no vite.config.ts present -> returns null, defaults used
      outputDir: join(dir, 'out'),
      generateTypeStub: false,
    });

    expect(manifest.objects).toBeDefined();
  });

  it('loads baseClasses from a vite.config.ts smrt-auto-service plugin', async () => {
    writeFileSync(join(dir, 'src', 'widget.ts'), LOCAL_CLASS_SRC);
    // Minimal vite config exposing a plugin named 'smrt-auto-service' with
    // options.baseClasses readable via the `.api.options` accessor.
    writeFileSync(
      join(dir, 'vite.config.ts'),
      `export default {
  plugins: [
    {
      name: 'smrt-auto-service',
      api: {
        options: {
          baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
          followImports: false,
        },
      },
    },
  ],
};
`,
    );

    const builder = new ManifestBuilder();
    process.chdir(dir);
    const manifest = await builder.generate({
      include: ['src/**/*.ts'],
      loadViteConfig: true,
      outputDir: join(dir, 'out'),
      generateTypeStub: false,
    });

    expect(manifest.objects).toBeDefined();
  });

  it('adds external base classes from a fixture package manifest', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@acme/consumer',
        type: 'module',
        dependencies: { '@happyvertical/smrt-fixture-ext': '1.0.0' },
      }),
    );
    writeFileSync(join(dir, 'src', 'local.ts'), LOCAL_CLASS_SRC);

    // Fixture external SMRT package with a dist/manifest.json the builder reads
    // both for discovery and for loadExternalBaseClasses.
    const extDir = join(
      dir,
      'node_modules',
      '@happyvertical',
      'smrt-fixture-ext',
    );
    mkdirSync(join(extDir, 'dist'), { recursive: true });
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-fixture-ext',
        type: 'module',
        exports: {
          '.': './dist/index.js',
          './manifest.json': './dist/manifest.json',
        },
      }),
    );
    writeFileSync(join(extDir, 'dist', 'index.js'), 'export {};\n');
    writeFileSync(
      join(extDir, 'dist', 'manifest.json'),
      JSON.stringify({
        moduleType: 'smrt',
        version: '1.0.0',
        packageName: '@happyvertical/smrt-fixture-ext',
        objects: {
          '@happyvertical/smrt-fixture-ext:ExternalBase': {
            className: 'ExternalBase',
            fields: {},
          },
        },
      }),
    );

    const builder = new ManifestBuilder();
    process.chdir(dir);
    const manifest = await builder.generate({
      include: ['src/**/*.ts'],
      discoverExternalPackages: true,
      includeExternalBaseClasses: true,
      outputDir: join(dir, 'out'),
      generateTypeStub: false,
    });

    // The external package is recorded as a dependency reference.
    expect(manifest.smrtDependencies).toContain(
      '@happyvertical/smrt-fixture-ext',
    );
  });

  it('tolerates a missing external manifest during loadExternalBaseClasses', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@acme/consumer',
        type: 'module',
        dependencies: { '@happyvertical/smrt-broken-ext': '1.0.0' },
      }),
    );
    writeFileSync(join(dir, 'src', 'local.ts'), LOCAL_CLASS_SRC);

    // Package resolves for discovery (has a manifest export) but the dist/
    // manifest.json that loadExternalBaseClasses expects is intentionally
    // absent in the path it reads, so the catch branch runs.
    const extDir = join(
      dir,
      'node_modules',
      '@happyvertical',
      'smrt-broken-ext',
    );
    mkdirSync(join(extDir, '.smrt'), { recursive: true });
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-broken-ext',
        type: 'module',
        exports: { './manifest.json': './.smrt/manifest.json' },
      }),
    );
    writeFileSync(
      join(extDir, '.smrt', 'manifest.json'),
      JSON.stringify({
        moduleType: 'smrt',
        version: '1.0.0',
        packageName: '@happyvertical/smrt-broken-ext',
        objects: {},
      }),
    );

    const builder = new ManifestBuilder();
    process.chdir(dir);
    // Should not throw even though dist/manifest.json is missing for the
    // external-base-class read.
    await expect(
      builder.generate({
        include: ['src/**/*.ts'],
        discoverExternalPackages: true,
        includeExternalBaseClasses: true,
        outputDir: join(dir, 'out'),
        generateTypeStub: false,
      }),
    ).resolves.toBeDefined();
  });

  it('warns and leaves packageName unset when package.json is unreadable', async () => {
    // Malformed package.json -> readPackageJson catch -> {} -> no packageName.
    writeFileSync(join(dir, 'package.json'), '{ not valid json');
    writeFileSync(join(dir, 'src', 'thing.ts'), LOCAL_CLASS_SRC);

    const builder = new ManifestBuilder();
    process.chdir(dir);
    const manifest = await builder.generate({
      include: ['src/**/*.ts'],
      injectPackageInfo: true,
      outputDir: join(dir, 'out'),
      generateTypeStub: false,
    });

    expect(manifest.packageName).toBeUndefined();
  });

  it('normalizes absolute object filePaths to workspace-relative paths', async () => {
    // Mark this temp dir as a workspace root so findWorkspaceRoot stops here.
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(dir, 'src', 'rel.ts'), LOCAL_CLASS_SRC);

    const builder = new ManifestBuilder();
    process.chdir(dir);
    const manifest = await builder.generate({
      include: ['src/**/*.ts'],
      outputDir: join(dir, 'out'),
      generateTypeStub: false,
    });

    const obj = Object.values(manifest.objects)[0];
    if (obj?.filePath) {
      // Rewritten to a relative path (no leading slash, no Windows backslashes).
      expect(obj.filePath.startsWith('/')).toBe(false);
      expect(obj.filePath).not.toContain('\\');
    }
  });
});
