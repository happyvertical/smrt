import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyManifestCompleteness } from '../verify-completeness.js';

/**
 * Regression coverage for issue #1483: a published dist/manifest.json that omits
 * an @smrt object (there, SmrtWorker) silently breaks downstream db:migrate.
 * The guard re-scans source and asserts every object reaches the manifest.
 */
describe('verifyManifestCompleteness', () => {
  let pkgDir: string;

  const WIDGET_SOURCE = `
import { smrt, SmrtObject } from '@happyvertical/smrt-core';

@smrt({ tableName: 'widgets' })
export class Widget extends SmrtObject {
  label: string = '';
}
`;

  function writePackage(options: { withManifestExport: boolean }): void {
    const exportsMap: Record<string, unknown> = {
      '.': { import: './dist/index.js' },
    };
    if (options.withManifestExport) {
      exportsMap['./manifest'] = './dist/manifest.json';
    }
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: '@happyvertical/smrt-fixture',
          version: '0.0.0',
          exports: exportsMap,
        },
        null,
        2,
      ),
    );
    mkdirSync(join(pkgDir, 'src'), { recursive: true });
    writeFileSync(join(pkgDir, 'src', 'widget.ts'), WIDGET_SOURCE);
  }

  function writeDistManifest(objectKeys: string[]): void {
    mkdirSync(join(pkgDir, 'dist'), { recursive: true });
    const objects: Record<string, unknown> = {};
    for (const key of objectKeys) {
      objects[key] = { name: key };
    }
    writeFileSync(
      join(pkgDir, 'dist', 'manifest.json'),
      JSON.stringify({ version: '1.0.0', objects }, null, 2),
    );
  }

  beforeEach(() => {
    pkgDir = mkdtempSync(join(tmpdir(), 'smrt-verify-manifest-'));
  });

  afterEach(() => {
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it('reports objects present in source but missing from the manifest', async () => {
    writePackage({ withManifestExport: true });
    // Empty manifest: every scanned object is missing.
    writeDistManifest([]);

    const result = await verifyManifestCompleteness({ packageDir: pkgDir });

    expect(result.status).toBe('incomplete');
    expect(result.expectedCount).toBeGreaterThan(0);
    expect(result.missing).toContain('@happyvertical/smrt-fixture:Widget');
    // An empty manifest is missing every scanned object.
    expect(result.missing).toHaveLength(result.expectedCount);
  });

  it('passes when the manifest contains every scanned object', async () => {
    writePackage({ withManifestExport: true });

    // Discover the exact keys the scanner produces, then write a complete manifest.
    writeDistManifest([]);
    const discovery = await verifyManifestCompleteness({ packageDir: pkgDir });
    writeDistManifest(discovery.missing);

    const result = await verifyManifestCompleteness({ packageDir: pkgDir });

    expect(result.status).toBe('ok');
    expect(result.missing).toEqual([]);
    expect(result.distCount).toBe(result.expectedCount);
  });

  it('flags a missing manifest file when source declares objects', async () => {
    writePackage({ withManifestExport: true });
    // No dist/manifest.json written.

    const result = await verifyManifestCompleteness({ packageDir: pkgDir });

    expect(result.status).toBe('missing-manifest');
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it('skips packages that do not publish a manifest export', async () => {
    writePackage({ withManifestExport: false });

    const result = await verifyManifestCompleteness({ packageDir: pkgDir });

    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/does not publish a \.\/manifest/);
  });

  it('skips when there is no package.json', async () => {
    const result = await verifyManifestCompleteness({
      packageDir: join(pkgDir, 'does-not-exist'),
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/no package.json/);
  });

  it('skips a manifest-publishing package with no @smrt objects in source', async () => {
    // package.json declares ./manifest, but src has no @smrt() classes.
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-fixture',
        version: '0.0.0',
        exports: { './manifest': './dist/manifest.json' },
      }),
    );
    mkdirSync(join(pkgDir, 'src'), { recursive: true });
    writeFileSync(join(pkgDir, 'src', 'plain.ts'), 'export const x = 1;\n');

    const result = await verifyManifestCompleteness({ packageDir: pkgDir });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/no @smrt\(\) objects/);
  });

  it('resolves a conditional ./manifest export object', async () => {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-fixture',
        version: '0.0.0',
        exports: { './manifest': { default: './dist/manifest.json' } },
      }),
    );
    mkdirSync(join(pkgDir, 'src'), { recursive: true });
    writeFileSync(join(pkgDir, 'src', 'widget.ts'), WIDGET_SOURCE);
    // No dist manifest → must still resolve the conditional export and report it missing.

    const result = await verifyManifestCompleteness({ packageDir: pkgDir });
    expect(result.status).toBe('missing-manifest');
    expect(result.manifestPath).toMatch(/dist\/manifest\.json$/);
  });

  it('treats an unparseable manifest as missing', async () => {
    writePackage({ withManifestExport: true });
    mkdirSync(join(pkgDir, 'dist'), { recursive: true });
    writeFileSync(join(pkgDir, 'dist', 'manifest.json'), '{ not valid json');

    const result = await verifyManifestCompleteness({ packageDir: pkgDir });
    expect(result.status).toBe('missing-manifest');
    expect(result.reason).toMatch(/not valid JSON/);
  });

  it('skips framework-infrastructure packages by basename', async () => {
    const skipDir = join(pkgDir, 'core');
    mkdirSync(skipDir, { recursive: true });
    writeFileSync(
      join(skipDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-core',
        exports: { './manifest': './dist/manifest.json' },
      }),
    );

    const result = await verifyManifestCompleteness({ packageDir: skipDir });

    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/framework infrastructure/);
  });
});
