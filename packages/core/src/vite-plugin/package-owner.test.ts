import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stampPackageModule } from './index.js';
import { createPackageOwnerResolver } from './package-owner.js';

const root = mkdtempSync(join(tmpdir(), 'smrt-5655-owner-'));
const write = (path: string, contents: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
};
write('package.json', JSON.stringify({ name: '@mono/root' }));
write('packages/work/package.json', JSON.stringify({ name: '@mono/work' }));
write('packages/work/src/A.ts', '');
write('apps/plain/package.json', JSON.stringify({ name: 'plain-app' }));
write('apps/plain/src/B.ts', '');
write('apps/nameless/package.json', JSON.stringify({}));
write('apps/nameless/src/C.ts', '');
write('apps/scoped/package.json', JSON.stringify({ name: '@mono/scoped' }));
write(
  'apps/scoped/vendor/inner/package.json',
  JSON.stringify({ name: '@inner/lib' }),
);
write('apps/scoped/vendor/inner/D.ts', '');
write('apps/scoped/src/E.ts', '');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('package owner resolver (#5655)', () => {
  it('names a sibling workspace package source by its own package', () => {
    const owner = createPackageOwnerResolver(join(root, 'apps/plain'));
    expect(owner(join(root, 'packages/work/src/A.ts'))).toBe('@mono/work');
  });

  it('keeps an unscoped or nameless app inside a scoped monorepo root', () => {
    for (const app of ['plain', 'nameless']) {
      const owner = createPackageOwnerResolver(join(root, 'apps', app));
      expect(
        owner(
          join(root, 'apps', app, 'src', app === 'plain' ? 'B.ts' : 'C.ts'),
        ),
      ).toBeUndefined();
    }
  });

  it('leaves the app’s own files and falls back for a nested scoped package', () => {
    const owner = createPackageOwnerResolver(join(root, 'apps/scoped'));
    expect(owner(join(root, 'apps/scoped/src/E.ts'))).toBeUndefined();
    expect(owner(join(root, 'apps/scoped/vendor/inner/D.ts'))).toBe(
      '@inner/lib',
    );
  });

  it('stamps a module with its owner package, else the manifest package', async () => {
    const source = `import { smrt, SmrtObject } from '@happyvertical/smrt-core';\n@smrt()\nexport class Thing extends SmrtObject {}\n`;
    const manifest = {
      version: '1',
      timestamp: 0,
      packageName: '@mono/web',
      objects: {},
    } as never;
    const ownerOf = createPackageOwnerResolver(join(root, 'apps/plain'));
    const foreign = await stampPackageModule(
      source,
      join(root, 'packages/work/src/A.ts'),
      manifest,
      ownerOf,
    );
    expect(foreign?.code).toContain('__smrtPackage__ = "@mono/work"');
    const own = await stampPackageModule(
      source,
      join(root, 'apps/plain/src/B.ts'),
      manifest,
      ownerOf,
    );
    expect(own?.code).toContain('__smrtPackage__ = "@mono/web"');
  });
});
