import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertRealContained,
  type ContentInspector,
  copyTree,
  createStaging,
  disposeStaging,
  ensureDirectories,
  isContained,
  isSafeName,
  nodeTreeFs,
  publishStaging,
  readRegularFile,
  resolveInside,
  type SkippedEntry,
  type Staging,
  type TreeFs,
  type TreeHandle,
  type TreeStats,
  walkTree,
  withStagedPublish,
  writeNewFile,
} from './paths.js';
import { BundleTreeError } from './tree-errors.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BundleTreeError);
    return (error as BundleTreeError).code;
  }
  return 'ok';
}

describe('lexical containment', () => {
  it('compares whole segments, not string prefixes', () => {
    expect(isContained('/a/b', '/a/b/c', 'linux')).toBe(true);
    expect(isContained('/a/b', '/a/bc', 'linux')).toBe(false);
    expect(isContained('/a/b', '/a/b', 'linux')).toBe(false);
    expect(isContained('/a/b', '/a/b', 'linux', true)).toBe(true);
    expect(isContained('/a/b/c', '/a/b', 'linux')).toBe(false);
  });

  it('folds case on win32 and darwin only', () => {
    expect(isContained('C:\\Root', 'c:\\root\\X\\y', 'win32')).toBe(true);
    expect(isContained('C:\\Root', 'C:\\Rootx', 'win32')).toBe(false);
    expect(isContained('/Users/A', '/users/a/b', 'darwin')).toBe(true);
    expect(isContained('/Users/A', '/users/a/b', 'linux')).toBe(false);
  });

  it('rejects relative, UNC and extended-length roots', () => {
    expect(isContained('a/b', 'a/b/c', 'linux')).toBe(false);
    expect(
      isContained('\\\\server\\share', '\\\\server\\share\\x', 'win32'),
    ).toBe(false);
    expect(isContained('\\\\?\\C:\\a', '\\\\?\\C:\\a\\b', 'win32')).toBe(false);
    expect(isContained('C:\\a', 'C:\\a\\..\\b', 'win32')).toBe(false);
  });

  it('builds children only from single validated segments', () => {
    expect(resolveInside('/root', ['a', 'b.js'], 'linux')).toBe('/root/a/b.js');
    expect(resolveInside('C:\\root', ['a', 'b.js'], 'win32')).toBe(
      'C:\\root\\a\\b.js',
    );
    for (const segments of [
      ['..'],
      ['.'],
      ['a/b'],
      ['a\\b'],
      [''],
      ['a', '..', 'b'],
      ['x\0y'],
    ]) {
      expect(() => resolveInside('/root', segments, 'linux')).toThrow(
        BundleTreeError,
      );
    }
    expect(() => resolveInside('relative', ['a'], 'linux')).toThrow(
      BundleTreeError,
    );
  });

  it('accepts real package names and refuses unportable ones', () => {
    for (const name of ['@types', '+esm.js', 'a b.txt', '.bin', 'é.js']) {
      expect(isSafeName(name)).toBe(true);
    }
    for (const name of [
      '',
      '.',
      '..',
      'a:b',
      'a*b',
      'aux.js',
      'COM1',
      'trail.',
      'trail ',
      'a\u0001b',
      'x'.repeat(256),
    ]) {
      expect(isSafeName(name)).toBe(false);
    }
  });
});

/** In-memory filesystem with Windows-style paths for lexical tests. */
class MemoryTreeFs implements TreeFs {
  readonly nodes = new Map<string, { kind: 'dir' | 'file'; text: string }>();
  private inode = 1;
  private readonly inodes = new Map<string, number>();

  constructor(private readonly sep: string) {}

  add(path: string, kind: 'dir' | 'file', text = ''): this {
    this.nodes.set(path, { kind, text });
    this.inodes.set(path, this.inode++);
    return this;
  }

  private stats(path: string): TreeStats {
    const node = this.nodes.get(path);
    if (node === undefined) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return {
      isFile: () => node.kind === 'file',
      isDirectory: () => node.kind === 'dir',
      isSymbolicLink: () => false,
      mode: node.kind === 'dir' ? 0o755 : 0o644,
      size: node.text.length,
      dev: 1n,
      ino: BigInt(this.inodes.get(path) ?? 0),
      nlink: 1,
    };
  }

  async lstat(path: string) {
    return this.stats(path);
  }
  async readdir(path: string) {
    if (this.nodes.get(path)?.kind !== 'dir') {
      throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
    }
    const prefix = path.endsWith(this.sep) ? path : path + this.sep;
    return [...this.nodes.keys()]
      .filter(
        (key) =>
          key.startsWith(prefix) &&
          !key.slice(prefix.length).includes(this.sep),
      )
      .map((key) => key.slice(prefix.length));
  }
  async open(path: string): Promise<TreeHandle> {
    const node = this.nodes.get(path);
    const stats = this.stats(path);
    let read = false;
    return {
      stat: async () => stats,
      read: async (buffer) => {
        if (read || node === undefined) return { bytesRead: 0 };
        read = true;
        const bytes = Buffer.from(node.text);
        buffer.set(bytes);
        return { bytesRead: bytes.length };
      },
      write: async () => {
        throw new Error('read only');
      },
      chmod: async () => undefined,
      close: async () => undefined,
    };
  }
  async realpath(path: string) {
    return path;
  }
  async mkdir(): Promise<void> {
    throw new Error('unsupported');
  }
  async mkdtemp(): Promise<string> {
    throw new Error('unsupported');
  }
  async rename(): Promise<void> {
    throw new Error('unsupported');
  }
  async unlink(): Promise<void> {
    throw new Error('unsupported');
  }
  async rmdir(): Promise<void> {
    throw new Error('unsupported');
  }
}

describe('walking with Windows paths (lexical, injected filesystem)', () => {
  const win = () =>
    new MemoryTreeFs('\\')
      .add('C:\\root', 'dir')
      .add('C:\\root\\b.txt', 'file', 'b')
      .add('C:\\root\\a', 'dir')
      .add('C:\\root\\a\\z.txt', 'file', 'zz');

  it('lists in sorted order with forward-slash relative paths', async () => {
    const result = await walkTree({
      root: 'C:\\root',
      fs: win(),
      platform: 'win32',
    });
    expect(result.entries.map((entry) => `${entry.kind}:${entry.rel}`)).toEqual(
      ['dir:a', 'file:a/z.txt', 'file:b.txt'],
    );
    expect(result.bytes).toBe(3);
  });

  it('rejects reserved device names, illegal characters and case collisions', async () => {
    const reserved = win().add('C:\\root\\aux.txt', 'file');
    expect(
      await codeOf(
        walkTree({ root: 'C:\\root', fs: reserved, platform: 'win32' }),
      ),
    ).toBe('invalid_name');
    const illegal = win().add('C:\\root\\a:b', 'file');
    expect(
      await codeOf(
        walkTree({ root: 'C:\\root', fs: illegal, platform: 'win32' }),
      ),
    ).toBe('invalid_name');
    const collide = win().add('C:\\root\\B.TXT', 'file');
    expect(
      await codeOf(
        walkTree({ root: 'C:\\root', fs: collide, platform: 'win32' }),
      ),
    ).toBe('name_collision');
  });

  it('refuses a non-Windows root on win32', async () => {
    expect(
      await codeOf(walkTree({ root: '/root', fs: win(), platform: 'win32' })),
    ).toBe('invalid_option');
  });
});

posixOnly('walking and copying on a real filesystem', () => {
  let base: string;
  let src: string;
  let out: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-bundler-paths-')));
    src = join(base, 'src');
    out = join(base, 'out');
    mkdirSync(src);
    mkdirSync(out);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const put = (rel: string, content = rel) => {
    const path = join(src, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    return path;
  };

  it('is deterministic: sorted by code unit order whatever the creation order', async () => {
    for (const name of [
      'b.txt',
      'a.txt',
      'C.txt',
      'z/y.txt',
      'z/a.txt',
      'Ä.txt',
    ]) {
      put(name);
    }
    const first = await walkTree({ root: src });
    expect(first.entries.map((entry) => entry.rel)).toEqual([
      'C.txt',
      'a.txt',
      'b.txt',
      'z',
      'z/a.txt',
      'z/y.txt',
      'Ä.txt',
    ]);
    const second = await walkTree({ root: src });
    expect(second.entries).toEqual(first.entries);
  });

  it('rejects a symlink anywhere in the tree without following it', async () => {
    put('real.txt');
    mkdirSync(join(src, 'deep/er'), { recursive: true });
    symlinkSync(join(base, 'outside'), join(src, 'deep/er/link'));
    const error = await walkTree({ root: src }).catch((e) => e);
    expect(error).toBeInstanceOf(BundleTreeError);
    expect(error.code).toBe('symlink_refused');
    expect(error.subjects).toEqual(['deep/er/link']);
    expect(error.message).not.toContain('deep');
  });

  it('refuses a symlinked root and a root under a symlinked ancestor', async () => {
    symlinkSync(src, join(base, 'srclink'));
    expect(await codeOf(walkTree({ root: join(base, 'srclink') }))).toBe(
      'symlink_refused',
    );
    put('inner/f.txt');
    expect(
      await codeOf(walkTree({ root: join(base, 'srclink', 'inner') })),
    ).toBe('symlink_refused');
  });

  it('can skip symlinks under an explicit policy', async () => {
    put('a.txt');
    symlinkSync(join(src, 'a.txt'), join(src, 'l'));
    const skipped: SkippedEntry[] = [];
    const result = await walkTree({
      root: src,
      policy: { symlinks: 'skip' },
      onSkip: (entry) => skipped.push(entry),
    });
    expect(result.entries.map((entry) => entry.rel)).toEqual(['a.txt']);
    expect(skipped).toMatchObject([
      { rel: 'l', kind: 'symlink', reason: 'symlink' },
    ]);
  });

  it('rejects FIFOs and, under policy, skips them', async () => {
    put('a.txt');
    execFileSync('mkfifo', [join(src, 'pipe')]);
    expect(await codeOf(walkTree({ root: src }))).toBe('special_file');
    const result = await walkTree({ root: src, policy: { special: 'skip' } });
    expect(result.entries.map((entry) => entry.rel)).toEqual(['a.txt']);
  });

  it('rejects device files and sockets (injected stats)', async () => {
    put('a.txt');
    const fs: TreeFs = {
      ...nodeTreeFs,
      async lstat(path) {
        const real = await nodeTreeFs.lstat(path);
        if (!path.endsWith('a.txt')) return real;
        return {
          ...real,
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        };
      },
    };
    expect(await codeOf(walkTree({ root: src, fs }))).toBe('special_file');
  });

  it('refuses hard-linked files by default and copies them as independent files when allowed', async () => {
    const original = put('a.txt', 'shared bytes');
    linkSync(original, join(src, 'b.txt'));
    const error = await walkTree({ root: src }).catch((e) => e);
    expect(error.code).toBe('hardlink_refused');

    const result = await copyTree({
      root: src,
      destRoot: out,
      policy: { hardlinks: 'allow' },
    });
    expect(result.copied.map((file) => file.rel)).toEqual(['a.txt', 'b.txt']);
    const a = statSync(join(out, 'a.txt'));
    const b = statSync(join(out, 'b.txt'));
    expect(a.ino).not.toBe(b.ino);
    expect(a.nlink).toBe(1);
    expect(b.nlink).toBe(1);
    expect(readFileSync(join(out, 'b.txt'), 'utf8')).toBe('shared bytes');
    // Mutating the source later cannot alter the copy.
    writeFileSync(original, 'changed');
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('shared bytes');
  });

  describe('limits', () => {
    it('caps the file count', async () => {
      put('a');
      put('b');
      put('c');
      expect(
        await codeOf(walkTree({ root: src, limits: { maxFiles: 2 } })),
      ).toBe('too_many_files');
    });
    it('caps one file and the total', async () => {
      put('big', 'x'.repeat(100));
      expect(
        await codeOf(walkTree({ root: src, limits: { maxFileBytes: 99 } })),
      ).toBe('file_too_large');
      put('big2', 'x'.repeat(100));
      expect(
        await codeOf(walkTree({ root: src, limits: { maxTotalBytes: 150 } })),
      ).toBe('tree_too_large');
    });
    it('caps depth and path length', async () => {
      put('a/b/c/d.txt');
      expect(
        await codeOf(walkTree({ root: src, limits: { maxDepth: 3 } })),
      ).toBe('tree_too_deep');
      expect(
        await codeOf(walkTree({ root: src, limits: { maxRelPathLength: 5 } })),
      ).toBe('path_too_long');
    });
    it('does not count skipped entries against the caps', async () => {
      put('keep.txt');
      put('node_modules/huge', 'x'.repeat(1000));
      const result = await walkTree({
        root: src,
        limits: { maxFileBytes: 100 },
        filter: (entry) => (entry.name === 'node_modules' ? 'skip' : 'keep'),
      });
      expect(result.entries.map((entry) => entry.rel)).toEqual(['keep.txt']);
    });
  });

  it('runs the filter before any policy and never descends into a skipped directory', async () => {
    put('pkg/index.js');
    mkdirSync(join(src, '.bin'));
    symlinkSync('../pkg/index.js', join(src, '.bin/tool'));
    const skipped: SkippedEntry[] = [];
    const result = await walkTree({
      root: src,
      filter: (entry) => (entry.name === '.bin' ? 'skip' : 'keep'),
      onSkip: (entry) => skipped.push(entry),
      accountSkipped: true,
    });
    expect(result.entries.map((entry) => entry.rel)).toEqual([
      'pkg',
      'pkg/index.js',
    ]);
    expect(result.skipped).toEqual({ entries: 1, files: 1, bytes: 0 });
  });

  it('accounts files and bytes under skipped directories', async () => {
    put('docs/a.md', 'x'.repeat(10));
    put('docs/sub/b.md', 'y'.repeat(5));
    put('index.js');
    const result = await walkTree({
      root: src,
      filter: (entry) => (entry.name === 'docs' ? 'skip' : 'keep'),
      accountSkipped: true,
    });
    expect(result.skipped).toEqual({ entries: 1, files: 2, bytes: 15 });
  });

  it('can omit directories that end up empty', async () => {
    put('keep/a.js');
    put('gone/a.d.ts');
    put('@scope/pkg/a.d.ts');
    const filter = (entry: { name: string }) =>
      entry.name.endsWith('.d.ts') ? 'skip' : 'keep';
    const kept = await walkTree({ root: src, filter });
    expect(kept.entries.map((entry) => entry.rel)).toContain('gone');
    const dropped = await walkTree({
      root: src,
      filter,
      dropEmptyDirectories: true,
    });
    expect(dropped.entries.map((entry) => entry.rel)).toEqual([
      'keep',
      'keep/a.js',
    ]);
  });

  describe('copy', () => {
    it('copies content, hashes it and normalises modes', async () => {
      put('a.txt', 'hello');
      const exec = put('bin/tool', '#!/bin/sh\n');
      chmodSync(exec, 0o700);
      chmodSync(join(src, 'a.txt'), 0o600);
      const result = await copyTree({ root: src, destRoot: out });
      expect(result.copied).toEqual([
        {
          rel: 'a.txt',
          size: 5,
          sha256: createHash('sha256').update('hello').digest('hex'),
          mode: 0o644,
        },
        {
          rel: 'bin/tool',
          size: 10,
          sha256: createHash('sha256').update('#!/bin/sh\n').digest('hex'),
          mode: 0o755,
        },
      ]);
      expect(statSync(join(out, 'a.txt')).mode & 0o777).toBe(0o644);
      expect(statSync(join(out, 'bin/tool')).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(out, 'bin/tool'), 'utf8')).toBe('#!/bin/sh\n');
    });

    it('refuses to write through anything already at the destination', async () => {
      put('a.txt');
      writeFileSync(join(out, 'a.txt'), 'planted');
      expect(await codeOf(copyTree({ root: src, destRoot: out }))).toBe(
        'destination_exists',
      );
      expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('planted');
    });

    it('does not follow a symlink planted at the destination', async () => {
      put('a.txt', 'new');
      const target = join(base, 'victim');
      writeFileSync(target, 'victim');
      symlinkSync(target, join(out, 'a.txt'));
      expect(await codeOf(copyTree({ root: src, destRoot: out }))).toBe(
        'destination_exists',
      );
      expect(readFileSync(target, 'utf8')).toBe('victim');
    });

    it('requires disjoint source and destination', async () => {
      put('a.txt');
      mkdirSync(join(src, 'inner'));
      expect(
        await codeOf(copyTree({ root: src, destRoot: join(src, 'inner') })),
      ).toBe('path_escape');
      expect(await codeOf(copyTree({ root: src, destRoot: base }))).toBe(
        'path_escape',
      );
    });

    it('creates the destination root on request', async () => {
      put('a.txt');
      const fresh = join(out, 'fresh');
      await copyTree({ root: src, destRoot: fresh, createRoot: true });
      expect(existsSync(join(fresh, 'a.txt'))).toBe(true);
      expect(
        await codeOf(
          copyTree({ root: src, destRoot: fresh, createRoot: true }),
        ),
      ).toBe('destination_exists');
    });

    it('streams content to an inspector and lets it abort the copy', async () => {
      put('a.txt', 'abc');
      const seen: string[] = [];
      await copyTree({
        root: src,
        destRoot: out,
        inspect: (entry): ContentInspector => ({
          push: (chunk) => seen.push(Buffer.from(chunk).toString()),
          finish: () => seen.push(`done:${entry.rel}`),
        }),
      });
      expect(seen).toEqual(['abc', 'done:a.txt']);

      rmSync(join(out, 'a.txt'));
      expect(
        await codeOf(
          copyTree({
            root: src,
            destRoot: out,
            inspect: () => ({
              push: () => undefined,
              finish: () => {
                throw new BundleTreeError('secret_content');
              },
            }),
          }),
        ),
      ).toBe('secret_content');
    });
  });

  describe('races between the walk and the copy (injected filesystem)', () => {
    it('refuses a file replaced by a different inode between lstat and open', async () => {
      put('a.txt', 'good');
      const fs: TreeFs = {
        ...nodeTreeFs,
        async open(path, flags, mode) {
          const handle = await nodeTreeFs.open(path, flags, mode);
          if (!path.endsWith('a.txt') || path.startsWith(out)) return handle;
          return {
            ...handle,
            async stat() {
              const real = await handle.stat();
              return { ...real, ino: BigInt(real.ino) + 1n };
            },
          };
        },
      };
      const error = await copyTree({ root: src, destRoot: out, fs }).catch(
        (e) => e,
      );
      expect(error.code).toBe('entry_changed');
      expect(error.subjects).toEqual(['a.txt']);
      expect(existsSync(join(out, 'a.txt'))).toBe(false);
    });

    it('refuses a file swapped for a symlink after the walk (O_NOFOLLOW)', async () => {
      const target = join(base, 'secret');
      writeFileSync(target, 'TOP SECRET');
      const file = put('a.txt', 'good');
      const fs: TreeFs = {
        ...nodeTreeFs,
        async open(path, flags, mode) {
          if (path === file) {
            unlinkSync(file);
            symlinkSync(target, file);
          }
          return nodeTreeFs.open(path, flags, mode);
        },
      };
      expect(await codeOf(copyTree({ root: src, destRoot: out, fs }))).toBe(
        'symlink_refused',
      );
      expect(existsSync(join(out, 'a.txt'))).toBe(false);
    });

    it('refuses a file that grew after the walk', async () => {
      const file = put('a.txt', 'short');
      const fs: TreeFs = {
        ...nodeTreeFs,
        async open(path, flags, mode) {
          if (path === file) writeFileSync(file, 'much longer content');
          return nodeTreeFs.open(path, flags, mode);
        },
      };
      expect(await codeOf(copyTree({ root: src, destRoot: out, fs }))).toBe(
        'entry_changed',
      );
    });

    it('refuses a file that grows while it is being read', async () => {
      put('a.txt', 'abcd');
      const fs: TreeFs = {
        ...nodeTreeFs,
        async open(path, flags, mode) {
          const handle = await nodeTreeFs.open(path, flags, mode);
          if (!path.endsWith('a.txt') || path.startsWith(out)) return handle;
          let calls = 0;
          return {
            ...handle,
            async read(buffer, offset, length, position) {
              const result = await handle.read(
                buffer,
                offset,
                length,
                position,
              );
              if (result.bytesRead === 0 && calls++ === 0) {
                buffer.set(Buffer.from('zz'));
                return { bytesRead: 2 };
              }
              return result;
            },
          };
        },
      };
      expect(await codeOf(copyTree({ root: src, destRoot: out, fs }))).toBe(
        'entry_changed',
      );
    });

    it('refuses a directory replaced between its listing and its re-check', async () => {
      put('d/a.txt');
      let dirLstats = 0;
      const fs: TreeFs = {
        ...nodeTreeFs,
        async lstat(path) {
          const real = await nodeTreeFs.lstat(path);
          if (path === join(src, 'd') && ++dirLstats === 2) {
            return { ...real, ino: BigInt(real.ino) + 1n };
          }
          return real;
        },
      };
      expect(await codeOf(walkTree({ root: src, fs }))).toBe('entry_changed');
    });
  });
});

posixOnly('single files, directories and real containment', () => {
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-bundler-single-')));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('reads a regular file within the cap and refuses links and big files', async () => {
    writeFileSync(join(base, 'a'), 'abc');
    symlinkSync(join(base, 'a'), join(base, 'l'));
    expect(
      Buffer.from(await readRegularFile(join(base, 'a'), 10)).toString(),
    ).toBe('abc');
    expect(await codeOf(readRegularFile(join(base, 'l'), 10))).toBe(
      'symlink_refused',
    );
    expect(await codeOf(readRegularFile(join(base, 'a'), 2))).toBe(
      'file_too_large',
    );
    expect(await codeOf(readRegularFile(base, 10))).toBe('special_file');
  });

  it('checks real containment through symlinked components', async () => {
    mkdirSync(join(base, 'app/build'), { recursive: true });
    mkdirSync(join(base, 'elsewhere'));
    symlinkSync(join(base, 'elsewhere'), join(base, 'app/escape'));
    await assertRealContained(join(base, 'app'), join(base, 'app/build'));
    expect(
      await codeOf(
        assertRealContained(join(base, 'app'), join(base, 'app/escape')),
      ),
    ).toBe('path_escape');
    expect(
      await codeOf(assertRealContained(join(base, 'app'), join(base, 'app'))),
    ).toBe('path_escape');
    await assertRealContained(join(base, 'app'), join(base, 'app'), {
      allowEqual: true,
    });
  });

  it('creates nested directories one component at a time', async () => {
    const leaf = await ensureDirectories(base, ['a', 'b']);
    expect(leaf).toBe(join(base, 'a/b'));
    // Reusing an existing real directory is fine.
    expect(await ensureDirectories(base, ['a', 'b', 'c'])).toBe(
      join(base, 'a/b/c'),
    );
    symlinkSync(join(base, 'a'), join(base, 'link'));
    expect(await codeOf(ensureDirectories(base, ['link', 'x']))).toBe(
      'symlink_refused',
    );
    expect(await codeOf(ensureDirectories(base, ['..']))).toBe('invalid_name');
  });
});

posixOnly('staging and publish', () => {
  let parent: string;
  beforeEach(() => {
    parent = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-bundler-stage-')));
  });
  afterEach(() => rmSync(parent, { recursive: true, force: true }));

  const names = () => readdirSync(parent).sort();

  it('creates a private staging directory next to the output', async () => {
    const staging = await createStaging(parent);
    expect(statSync(staging.path).mode & 0o777).toBe(0o700);
    expect(staging.path.startsWith(`${parent}/.smrt-desktop-bundle-`)).toBe(
      true,
    );
    await disposeStaging(staging);
    expect(names()).toEqual([]);
  });

  it('refuses a symlinked parent', async () => {
    symlinkSync(parent, `${parent}-link`);
    try {
      expect(await codeOf(createStaging(`${parent}-link`))).toBe(
        'symlink_refused',
      );
    } finally {
      unlinkSync(`${parent}-link`);
    }
  });

  it('removes only staging directories it created, and never follows links', async () => {
    const victim = join(parent, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    const forged: Staging = { path: victim, parent };
    expect(await codeOf(disposeStaging(forged))).toBe('publish_failed');
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true);

    const staging = await createStaging(parent);
    symlinkSync(victim, join(staging.path, 'link'));
    await disposeStaging(staging);
    expect(existsSync(staging.path)).toBe(false);
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('publishes by rename and leaves no staging behind', async () => {
    const staging = await createStaging(parent);
    mkdirSync(join(staging.path, 'out'));
    writeFileSync(join(staging.path, 'out/file'), 'x');
    mkdirSync(join(staging.path, 'install'));
    writeFileSync(join(staging.path, 'install/junk'), 'y');
    await publishStaging(staging, join(parent, 'bundle'), { source: 'out' });
    expect(names()).toEqual(['bundle']);
    expect(readFileSync(join(parent, 'bundle/file'), 'utf8')).toBe('x');
  });

  it('replaces an empty output directory but refuses a non-empty one', async () => {
    mkdirSync(join(parent, 'bundle'));
    let staging = await createStaging(parent);
    writeFileSync(join(staging.path, 'f'), '1');
    await publishStaging(staging, join(parent, 'bundle'));
    expect(readFileSync(join(parent, 'bundle/f'), 'utf8')).toBe('1');

    staging = await createStaging(parent);
    expect(await codeOf(publishStaging(staging, join(parent, 'bundle')))).toBe(
      'out_dir_not_empty',
    );
    expect(readFileSync(join(parent, 'bundle/f'), 'utf8')).toBe('1');
    await disposeStaging(staging);
  });

  it('refuses an output that is a symlink or a file', async () => {
    mkdirSync(join(parent, 'real'));
    symlinkSync(join(parent, 'real'), join(parent, 'bundle'));
    const staging = await createStaging(parent);
    expect(await codeOf(publishStaging(staging, join(parent, 'bundle')))).toBe(
      'destination_exists',
    );
    unlinkSync(join(parent, 'bundle'));
    writeFileSync(join(parent, 'bundle'), 'file');
    expect(await codeOf(publishStaging(staging, join(parent, 'bundle')))).toBe(
      'destination_exists',
    );
    await disposeStaging(staging);
  });

  it('refuses an output that is not a direct child of the staging parent', async () => {
    mkdirSync(join(parent, 'elsewhere'));
    const staging = await createStaging(parent);
    expect(
      await codeOf(publishStaging(staging, join(parent, 'elsewhere/bundle'))),
    ).toBe('publish_failed');
    await disposeStaging(staging);
  });

  it('moves a previous bundle aside before deleting it when replacing', async () => {
    mkdirSync(join(parent, 'bundle'));
    writeFileSync(join(parent, 'bundle/old'), 'old');
    const staging = await createStaging(parent);
    writeFileSync(join(staging.path, 'new'), 'new');
    await publishStaging(staging, join(parent, 'bundle'), {
      existing: 'replace',
      randomSuffix: () => 'aside',
    });
    expect(names()).toEqual(['bundle']);
    expect(existsSync(join(parent, 'bundle/old'))).toBe(false);
    expect(readFileSync(join(parent, 'bundle/new'), 'utf8')).toBe('new');
  });

  it('restores the previous bundle if the final rename fails', async () => {
    mkdirSync(join(parent, 'bundle'));
    writeFileSync(join(parent, 'bundle/old'), 'old');
    const staging = await createStaging(parent);
    const fs: TreeFs = {
      ...nodeTreeFs,
      async rename(from, to) {
        if (from === staging.path && to === join(parent, 'bundle')) {
          throw Object.assign(new Error('boom'), { code: 'EIO' });
        }
        return nodeTreeFs.rename(from, to);
      },
    };
    expect(
      await codeOf(
        publishStaging(staging, join(parent, 'bundle'), {
          existing: 'replace',
          fs,
        }),
      ),
    ).toBe('publish_failed');
    expect(readFileSync(join(parent, 'bundle/old'), 'utf8')).toBe('old');
    await disposeStaging(staging);
  });

  it('removes staging and leaves the output untouched when the build fails', async () => {
    const final = join(parent, 'bundle');
    await expect(
      withStagedPublish(final, async (staging) => {
        writeFileSync(join(staging.path, 'partial'), 'x');
        throw new BundleTreeError('secret_file', { subjects: ['.env'] });
      }),
    ).rejects.toMatchObject({ code: 'secret_file' });
    expect(names()).toEqual([]);
  });

  it('publishes the built tree on success and returns the build result', async () => {
    const final = join(parent, 'bundle');
    const value = await withStagedPublish(final, async (staging) => {
      writeFileSync(join(staging.path, 'ok'), 'ok');
      return 42;
    });
    expect(value).toBe(42);
    expect(names()).toEqual(['bundle']);
  });

  it('removes staging when publish itself fails', async () => {
    const final = join(parent, 'bundle');
    mkdirSync(final);
    writeFileSync(join(final, 'existing'), 'x');
    await expect(
      withStagedPublish(final, async (staging) => {
        writeFileSync(join(staging.path, 'ok'), 'ok');
      }),
    ).rejects.toMatchObject({ code: 'out_dir_not_empty' });
    expect(names()).toEqual(['bundle']);
    expect(readFileSync(join(final, 'existing'), 'utf8')).toBe('x');
  });
});

describe('writeNewFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-write-new-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a file with the exact bytes and mode', async () => {
    await writeNewFile(join(dir, 'a.txt'), 'hello', 0o644);
    await writeNewFile(join(dir, 'b.bin'), Buffer.from([1, 2, 3]), 0o755);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello');
    expect([...readFileSync(join(dir, 'b.bin'))]).toEqual([1, 2, 3]);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'a.txt')).mode & 0o777).toBe(0o644);
      expect(statSync(join(dir, 'b.bin')).mode & 0o777).toBe(0o755);
    }
  });

  it('never overwrites an existing file', async () => {
    writeFileSync(join(dir, 'a.txt'), 'mine');
    expect(await codeOf(writeNewFile(join(dir, 'a.txt'), 'x', 0o644))).toBe(
      'destination_exists',
    );
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('mine');
  });

  posixOnly('through a planted symlink', () => {
    it('does not write through it', async () => {
      writeFileSync(join(dir, 'target.txt'), 'target');
      symlinkSync(join(dir, 'target.txt'), join(dir, 'link.txt'));
      expect(
        await codeOf(writeNewFile(join(dir, 'link.txt'), 'x', 0o644)),
      ).not.toBe('ok');
      expect(readFileSync(join(dir, 'target.txt'), 'utf8')).toBe('target');
    });
  });
});
