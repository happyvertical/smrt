import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getCoreEntries } from '../vite.config';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  readFileSync(resolve(packageDir, 'package.json'), 'utf8'),
) as { browser?: Record<string, string> };

/**
 * `package.json#browser` swaps Node-only modules for browser builds (#2838).
 * Each pair must name real sources, and both sides must be emitted by the
 * build or the mapping points at a file that does not ship.
 */
describe('package.json browser field', () => {
  const pairs = Object.entries(manifest.browser ?? {});

  it('maps at least the host and json modules', () => {
    expect(pairs.map(([from]) => from).sort()).toEqual([
      './dist/host.js',
      './dist/utils/json.js',
    ]);
  });

  for (const [from, to] of pairs) {
    it(`${from} -> ${to} names sources the build emits`, () => {
      const entries = getCoreEntries();
      const sourceOf = (dist: string) =>
        resolve(
          packageDir,
          'src',
          `${dist.replace(/^\.\/dist\//, '').replace(/\.js$/, '')}.ts`,
        );
      // The Node module is emitted because other modules import it.
      expect(existsSync(sourceOf(from)), `${sourceOf(from)} is missing`).toBe(
        true,
      );
      // Nothing imports the browser build, so it needs its own entry.
      const name = to.replace(/^\.\/dist\//, '').replace(/\.js$/, '');
      expect(existsSync(sourceOf(to)), `${sourceOf(to)} is missing`).toBe(true);
      expect(entries[name], `${name} is not a build entry`).toBe(sourceOf(to));
    });
  }
});
