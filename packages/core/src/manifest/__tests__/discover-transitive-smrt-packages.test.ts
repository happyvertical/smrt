import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSmrtPackages } from '../discover-smrt-packages.js';

/**
 * #5027: a smrt package that an app reaches only through another smrt package
 * (smrt-content -> smrt-images) is loaded at runtime and adds columns to
 * shared STI tables, so the build's manifest has to describe it. pnpm keeps
 * such a package out of the app's own `node_modules`; it sits beside its
 * dependent in the virtual store.
 */
function smrtPackage(dir: string, name: string, deps: string[] = []): void {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      type: 'module',
      main: './dist/index.js',
      dependencies: Object.fromEntries(deps.map((d) => [d, '1.0.0'])),
    }),
  );
  writeFileSync(join(dir, 'dist', 'index.js'), 'export {};\n');
  writeFileSync(
    join(dir, 'dist', 'manifest.json'),
    JSON.stringify({ moduleType: 'smrt', objects: {} }),
  );
}

describe('discoverSmrtPackages: transitive smrt dependencies (#5027)', () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('finds a smrt package only reachable through another smrt package', () => {
    root = mkdtempSync(join(tmpdir(), 'smrt-transitive-'));
    const store = join(root, 'store');
    const content = join(store, 'content', 'node_modules', '@happyvertical');
    // The virtual-store directory of smrt-content holds its dependency beside it.
    smrtPackage(join(content, 'smrt-content'), '@happyvertical/smrt-content', [
      '@happyvertical/smrt-images',
    ]);
    smrtPackage(
      join(store, 'images', 'node_modules', '@happyvertical', 'smrt-images'),
      '@happyvertical/smrt-images',
    );
    symlinkSync(
      join(store, 'images', 'node_modules', '@happyvertical', 'smrt-images'),
      join(content, 'smrt-images'),
    );

    const appScope = join(root, 'app', 'node_modules', '@happyvertical');
    mkdirSync(appScope, { recursive: true });
    symlinkSync(join(content, 'smrt-content'), join(appScope, 'smrt-content'));
    writeFileSync(
      join(root, 'app', 'package.json'),
      JSON.stringify({
        name: 'consumer',
        type: 'module',
        dependencies: { '@happyvertical/smrt-content': '1.0.0' },
      }),
    );

    const found = discoverSmrtPackages({
      baseDir: join(root, 'app'),
      noCache: true,
    });

    expect(found).toContain('@happyvertical/smrt-content');
    expect(found).toContain('@happyvertical/smrt-images');
  });
});
