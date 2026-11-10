import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSourceFiles } from '../discovery.js';
import { OxcScanner } from '../scanner.js';

describe('mixed workspace and application source discovery', () => {
  let root: string;
  let cwd: string;
  function write(path: string, name: string) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(
      full,
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';\n@smrt() export class ${name} extends SmrtObject { value = ''; }\n`,
    );
    return full;
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'smrt-mixed-root-'));
    cwd = join(root, 'apps/web');
    write('apps/web/src/resource.ts', 'LocalResource');
    write('packages/models/model.ts', 'ExternalModel');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const includes = () => [
    '../../packages/models/**/*.ts',
    'src/**/*.ts',
    'src/resource.ts',
  ];

  it('discovers and parses the complete local/external union, deduplicated and ordered independently of pattern order', async () => {
    const expected = [
      join(cwd, 'src/resource.ts'),
      join(root, 'packages/models/model.ts'),
    ];
    for (const include of [
      includes(),
      includes().reverse(),
      includes().map((path) => join(cwd, path)),
    ]) {
      expect(await discoverSourceFiles({ cwd, include, exclude: [] })).toEqual(
        expected,
      );
      const { results, resolved } = await new OxcScanner({
        cwd,
        include,
        exclude: [],
      }).scanAndResolve();
      expect(results.fileCount).toBe(2);
      expect(resolved.map((entry) => entry.className).sort()).toEqual([
        'ExternalModel',
        'LocalResource',
      ]);
    }
  });

  it('applies negative includes and explicit exclusions globally without reopening pruned source trees', async () => {
    write('apps/web/src/local-blocked.ts', 'LocalBlocked');
    write('packages/models/external-blocked.ts', 'ExternalBlocked');
    write('apps/web/src/local-excluded.ts', 'LocalExcluded');
    write('packages/models/external-excluded.ts', 'ExternalExcluded');
    write('packages/models/.hidden/hidden.ts', 'Hidden');
    write('packages/models/node_modules/vendor/model.ts', 'Vendor');
    write('packages/models/.hidden.ts', 'HiddenFile');
    const include = [
      ...includes(),
      '!src/*-blocked.ts',
      '!../../packages/models/*-blocked.ts',
    ];
    const exclude = [
      'src/*-excluded.ts',
      '../../packages/models/*-excluded.ts',
    ];
    expect(await discoverSourceFiles({ cwd, include, exclude })).toEqual([
      join(cwd, 'src/resource.ts'),
      join(root, 'packages/models/model.ts'),
    ]);
    expect(
      await discoverSourceFiles({ cwd, include: include.reverse(), exclude }),
    ).toEqual([
      join(cwd, 'src/resource.ts'),
      join(root, 'packages/models/model.ts'),
    ]);
  });

  it('keeps a hidden ancestor of cwd available while pruning hidden descendants across mixed roots', async () => {
    const hiddenCwd = join(root, '.worktrees/web');
    write('.worktrees/web/src/resource.ts', 'HiddenCheckoutResource');
    write('.worktrees/web/src/.hidden.ts', 'HiddenLocal');
    write('packages/models/.hidden.ts', 'HiddenExternal');
    expect(
      await discoverSourceFiles({
        cwd: hiddenCwd,
        include: ['../../packages/models/**/*.ts', 'src/**/*.ts'],
        exclude: [],
      }),
    ).toEqual([
      join(hiddenCwd, 'src/resource.ts'),
      join(root, 'packages/models/model.ts'),
    ]);
  });
  it('preserves extglob includes and default no-follow behavior across roots', async () => {
    write('apps/web/src/other.ts', 'Other');
    write('packages/linked/link.ts', 'Linked');
    symlinkSync(join(root, 'packages/linked'), join(cwd, 'src/linked'));
    const include = [
      '../../packages/models/**/*.ts',
      'src/!(other).ts',
      'src/linked/**/*.ts',
    ];
    expect(await discoverSourceFiles({ cwd, include, exclude: [] })).toEqual([
      join(cwd, 'src/resource.ts'),
      join(root, 'packages/models/model.ts'),
    ]);
    expect(
      await discoverSourceFiles({
        cwd,
        include,
        exclude: [],
        followSymbolicLinks: true,
      }),
    ).toEqual([
      join(cwd, 'src/linked/link.ts'),
      join(cwd, 'src/resource.ts'),
      join(root, 'packages/models/model.ts'),
    ]);
  });
});
