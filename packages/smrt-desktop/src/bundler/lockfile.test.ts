import { describe, expect, it } from 'vitest';
import { findNonRegistryLockfilePackages } from './lockfile.js';

const lock = (body: string): string =>
  `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      a:\n        specifier: ^1\n        version: 1.0.0\n\npackages:\n\n${body}\nsnapshots:\n\n  a@1.0.0: {}\n`;

describe('findNonRegistryLockfilePackages', () => {
  it('accepts plain integrity resolutions', () => {
    expect(
      findNonRegistryLockfilePackages(
        lock(
          "  a@1.0.0:\n    resolution: {integrity: sha512-AAA}\n\n  '@s/b@2.0.0':\n    resolution: {integrity: sha512-BBB}\n    engines: {node: '>=12'}\n",
        ),
      ),
    ).toEqual([]);
  });

  it('reports tarball, git and directory resolutions by package name', () => {
    expect(
      findNonRegistryLockfilePackages(
        lock(
          [
            '  a@https://codeload.example/a.tar.gz:',
            '    resolution: {tarball: https://codeload.example/a.tar.gz}',
            '',
            "  '@s/g@https://github.com/s/g/commit/abc':",
            '    resolution: {commit: abc, repo: https://github.com/s/g, type: git}',
            '',
            '  d@file:../d:',
            '    resolution: {directory: ../d, type: directory}',
            '',
            '  ok@1.0.0:',
            '    resolution: {integrity: sha512-OK}',
            '',
          ].join('\n'),
        ),
      ),
    ).toEqual(['@s/g', 'a', 'd']);
  });

  it('fails closed on an entry with no integrity or an unreadable resolution', () => {
    expect(
      findNonRegistryLockfilePackages(
        lock(
          '  a@1.0.0:\n    engines: {node: 18}\n\n  b@1.0.0:\n    resolution: {}\n',
        ),
      ),
    ).toEqual(['a', 'b']);
  });

  it('understands a block-form resolution', () => {
    expect(
      findNonRegistryLockfilePackages(
        lock(
          '  a@1.0.0:\n    resolution:\n      integrity: sha512-AAA\n\n  b@1.0.0:\n    resolution:\n      tarball: https://x.test/b.tgz\n      integrity: sha512-BBB\n',
        ),
      ),
    ).toEqual(['b']);
  });

  it('ignores everything outside the packages section', () => {
    expect(
      findNonRegistryLockfilePackages(
        "lockfileVersion: '9.0'\nsnapshots:\n  a@1.0.0:\n    resolution: {tarball: https://x}\n",
      ),
    ).toEqual([]);
  });

  it('never returns URLs', () => {
    const names = findNonRegistryLockfilePackages(
      lock(
        '  a@https://user:secret@host/a.tgz:\n    resolution: {tarball: https://user:secret@host/a.tgz}\n',
      ),
    );
    expect(names).toEqual(['a']);
    expect(JSON.stringify(names)).not.toContain('secret');
  });
});
