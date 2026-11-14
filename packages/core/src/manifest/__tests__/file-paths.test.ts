import { describe, expect, it } from 'vitest';
import type { SmartObjectManifest } from '../../scanner/types.js';
import { stampedLibraryManifest } from '../../vite-plugin/index.js';
import {
  assertPackageRelativeFilePaths,
  findAbsoluteManifestFilePaths,
  isAbsoluteManifestPath,
  relativizeManifestFilePaths,
} from '../file-paths.js';

function manifestOf(...filePaths: string[]): SmartObjectManifest {
  const objects: Record<string, unknown> = {};
  filePaths.forEach((filePath, index) => {
    objects[`@test/pkg:Model${index}`] = {
      name: `model${index}`,
      className: `Model${index}`,
      filePath,
      fields: {},
    };
  });
  return {
    version: '1',
    timestamp: 0,
    packageName: '@test/pkg',
    objects,
  } as unknown as SmartObjectManifest;
}

describe('package-relative manifest filePath (#4948)', () => {
  it('rewrites an absolute path to a package-relative one with / separators', () => {
    const out = relativizeManifestFilePaths(
      manifestOf('/build/machine/packages/x/src/models/A.ts'),
      '/build/machine/packages/x',
    );
    expect(out.objects['@test/pkg:Model0'].filePath).toBe('src/models/A.ts');
  });

  it('gives the same result for two build locations of the same package', () => {
    const one = relativizeManifestFilePaths(
      manifestOf('/Users/a/work/pkg/src/A.ts'),
      '/Users/a/work/pkg',
    );
    const two = relativizeManifestFilePaths(
      manifestOf('/home/ci/checkout/pkg/src/A.ts'),
      '/home/ci/checkout/pkg',
    );
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('leaves an already relative path and the input object untouched', () => {
    const input = manifestOf('src/A.ts', '/root/pkg/src/B.ts');
    const out = relativizeManifestFilePaths(input, '/root/pkg');
    expect(out.objects['@test/pkg:Model0'].filePath).toBe('src/A.ts');
    expect(out.objects['@test/pkg:Model1'].filePath).toBe('src/B.ts');
    expect(input.objects['@test/pkg:Model1'].filePath).toBe(
      '/root/pkg/src/B.ts',
    );
  });

  it('recognises POSIX, drive, UNC and file: paths as absolute', () => {
    for (const p of [
      '/a/b.ts',
      'C:\\a\\b.ts',
      'c:/a/b.ts',
      '\\\\host\\s\\b.ts',
      'file:///a/b.ts',
    ]) {
      expect(isAbsoluteManifestPath(p)).toBe(true);
    }
    for (const p of ['src/a.ts', './src/a.ts', '../x/a.ts']) {
      expect(isAbsoluteManifestPath(p)).toBe(false);
    }
  });

  it('names the offending entries and throws on an absolute path', () => {
    const bad = manifestOf('src/ok.ts', '/leaked/src/Bad.ts');
    expect(findAbsoluteManifestFilePaths(bad)).toEqual([
      '@test/pkg:Model1 (/leaked/src/Bad.ts)',
    ]);
    expect(() =>
      assertPackageRelativeFilePaths(bad, 'Library manifest'),
    ).toThrow(/absolute filePath.*Bad\.ts/);
    expect(() =>
      assertPackageRelativeFilePaths(
        manifestOf('src/ok.ts'),
        'Library manifest',
      ),
    ).not.toThrow();
  });

  it('publishes a package-relative manifest from the library build step', () => {
    const published = stampedLibraryManifest(
      manifestOf('/root/pkg/src/A.ts'),
      '/root/pkg',
    );
    expect(published.objects['@test/pkg:Model0'].filePath).toBe('src/A.ts');
    expect(published.stampsConstructors).toBe(true);
  });
});
