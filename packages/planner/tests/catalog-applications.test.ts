import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleCatalog } from '../src/lib/catalog/generate/build.ts';
import { NON_CATALOG_PACKAGES } from '../src/lib/catalog/generate/exclusions.ts';
import { readLocalPackages } from '../src/lib/catalog/generate/local.ts';
import { getPackage } from '../src/lib/catalog/index.ts';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'planner-ws-'));
  const pkg = (dir: string, json: object) => {
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    writeFileSync(
      join(root, 'packages', dir, 'package.json'),
      JSON.stringify(json),
    );
  };
  // An application: declares ./manifest for the release guards, never built here.
  pkg('app-shell', {
    name: '@happyvertical/smrt-app-shell',
    exports: { './manifest': './dist/manifest.json' },
  });
  // A module that is built.
  pkg('widgets', {
    name: '@happyvertical/smrt-widgets',
    version: '1.0.0',
    exports: { './manifest.json': './dist/manifest.json' },
  });
  mkdirSync(join(root, 'packages', 'widgets', 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'widgets', 'dist', 'manifest.json'),
    JSON.stringify({ objects: {} }),
  );
  return root;
}

describe('applications are not catalog sources', () => {
  it('app-shell is listed with a reason', () => {
    expect(NON_CATALOG_PACKAGES['app-shell']).toMatch(/application/);
    expect(getPackage('app-shell')).toBeUndefined();
  });

  it('an unbuilt application manifest is not an error and is not read', async () => {
    const raws = await readLocalPackages(workspace());
    expect(raws.map((r) => r.packageName)).toEqual([
      '@happyvertical/smrt-widgets',
    ]);
  });

  it('a module that declares a manifest but is not built still fails', async () => {
    const root = workspace();
    mkdirSync(join(root, 'packages', 'orders'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'orders', 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-orders',
        exports: { './manifest.json': './dist/manifest.json' },
      }),
    );
    await expect(readLocalPackages(root)).rejects.toThrow(
      /smrt-orders.*not built|not built[\s\S]*smrt-orders/,
    );
  });

  it('assembling drops an application even when its manifest is supplied', () => {
    const catalog = assembleCatalog(
      [
        {
          packageName: '@happyvertical/smrt-app-shell',
          version: '0.0.0',
          description: '',
          manifest: {
            objects: {
              '@happyvertical/smrt-app-shell:App': {
                className: 'App',
                fields: {},
                methods: {},
              },
            },
          },
          knowledge: null,
        } as never,
      ],
      'test',
    );
    expect(catalog.packages.map((p) => p.id)).not.toContain('app-shell');
  });
});
