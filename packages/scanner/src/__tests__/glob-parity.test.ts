/**
 * Discovery parity after replacing fast-glob with tinyglobby (#4206).
 *
 * Expectations are written from fast-glob semantics: no directory expansion,
 * dotfiles excluded unless `dot: true` (discovery sets it), `ignore` honoured,
 * brace patterns expanded, absolute forward-slash results.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { glob } from 'tinyglobby';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverSourceFiles } from '../discovery.js';

let root: string;

function touch(rel: string) {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'glob-parity-'));
  touch('src/a.ts');
  touch('src/nested/deep/b.ts');
  touch('src/nested/c.svelte');
  touch('src/nested/readme.md');
  touch('src/.hidden.ts');
  touch('src/.dotdir/d.ts');
  touch('ignored/e.ts');
  touch('node_modules/pkg/f.ts');
  touch('src/legacy.test.ts');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const rel = (files: string[]) =>
  files.map((f) => f.slice(root.length + 1)).sort();

describe('tinyglobby parity with fast-glob', () => {
  it('does not expand a directory pattern to its contents', async () => {
    const files = await glob('src/nested', {
      cwd: root,
      expandDirectories: false,
    });
    expect(files).toEqual([]);
  });

  it('excludes dotfiles and dot directories unless dot is set', async () => {
    const files = await glob('src/**/*.ts', {
      cwd: root,
      expandDirectories: false,
      ignore: ['**/*.test.ts'],
    });
    expect(files.sort()).toEqual(['src/a.ts', 'src/nested/deep/b.ts']);
  });

  it('expands brace patterns and honours ignore', async () => {
    const files = await glob('**/*.{ts,svelte}', {
      cwd: root,
      expandDirectories: false,
      ignore: ['**/node_modules/**', 'ignored/**', '**/*.test.ts'],
    });
    expect(files.sort()).toEqual([
      'src/a.ts',
      'src/nested/c.svelte',
      'src/nested/deep/b.ts',
    ]);
  });

  it('matches dot entries only when dot is set', async () => {
    const files = await glob('src/**/*.ts', {
      cwd: root,
      dot: true,
      expandDirectories: false,
      ignore: ['**/*.test.ts'],
    });
    expect(files.sort()).toEqual([
      'src/.dotdir/d.ts',
      'src/.hidden.ts',
      'src/a.ts',
      'src/nested/deep/b.ts',
    ]);
  });

  it('discoverSourceFiles returns absolute paths, prunes dot entries, applies exclude', async () => {
    const files = await discoverSourceFiles({
      cwd: root,
      include: ['**/*.{ts,svelte}'],
      exclude: ['ignored/**', '**/*.test.ts'],
    });
    expect(
      files.every((f) => f.startsWith('/') || /^[A-Za-z]:\//.test(f)),
    ).toBe(true);
    expect(rel(files)).toEqual([
      'src/a.ts',
      'src/nested/c.svelte',
      'src/nested/deep/b.ts',
    ]);
  });
});
