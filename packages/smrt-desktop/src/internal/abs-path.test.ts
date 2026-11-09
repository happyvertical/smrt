import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../testing/memory-fs.js';
import {
  appendSegments,
  assertTrustedChain,
  formatAbsolutePath,
  isInside,
  parentOf,
  parseAbsolutePath,
  samePath,
} from './abs-path.js';
import { FsTrustError } from './fs-seam.js';

const posix = (value: unknown) => parseAbsolutePath(value, 'posix');
const win = (value: unknown) => parseAbsolutePath(value, 'win32');

describe('parseAbsolutePath (posix)', () => {
  it.each([
    '/',
    '/usr',
    '/usr/bin/node',
    '/Applications/My App.app/Contents/MacOS',
    '/home/u/.local/share/com.example.app',
    '/a/b.c/..d/e..',
  ])('accepts %j and round-trips', (value) => {
    const parsed = posix(value);
    expect(parsed).not.toBeNull();
    expect(formatAbsolutePath(parsed as never)).toBe(value);
  });

  it.each([
    '',
    'relative/path',
    './a',
    '//a',
    '/a//b',
    '/a/',
    '/a/./b',
    '/a/../b',
    '/..',
    '/a/..',
    '/a\\b',
    'C:\\a',
    '\\\\server\\share',
    '/a\0b',
    '/\ud800',
    42,
    null,
    undefined,
  ])('rejects %j', (value) => {
    expect(posix(value)).toBeNull();
  });
});

describe('parseAbsolutePath (win32)', () => {
  it.each([
    'C:\\',
    'c:\\Program Files\\Product',
    'D:\\Apps\\a.b\\c',
    'C:\\Users\\u\\AppData\\Local\\Programs\\Product',
  ])('accepts %j and round-trips', (value) => {
    const parsed = win(value);
    expect(parsed).not.toBeNull();
    expect(formatAbsolutePath(parsed as never)).toBe(value);
  });

  it.each([
    '',
    'C:',
    'C:foo',
    'C:foo\\bar',
    '\\\\server\\share\\x',
    '\\\\?\\C:\\x',
    '\\\\.\\C:\\x',
    '\\\\.\\pipe\\x',
    '\\rooted',
    'C:/Program Files',
    'C:\\Program Files/x',
    'C:\\a\\\\b',
    'C:\\a\\',
    'C:\\a\\.\\b',
    'C:\\a\\..\\b',
    'C:\\a\\CON',
    'C:\\a\\nul.txt',
    'C:\\a\\COM1',
    'C:\\a\\x:stream',
    'C:\\a\\x?',
    'C:\\a\\x*',
    'C:\\a\\x.',
    'C:\\a\\x ',
    'C:\\a\0',
    '/usr/bin',
    'relative\\path',
    7,
  ])('rejects %j', (value) => {
    expect(win(value)).toBeNull();
  });
});

describe('containment', () => {
  it('compares whole segments, never prefixes', () => {
    const root = posix('/opt/app') as never;
    expect(isInside(root, posix('/opt/app/bin') as never)).toBe(true);
    expect(isInside(root, posix('/opt/app-evil/bin') as never)).toBe(false);
    expect(isInside(root, posix('/opt/app') as never)).toBe(false);
    expect(isInside(root, posix('/opt/app') as never, true)).toBe(true);
    expect(isInside(root, posix('/opt') as never, true)).toBe(false);
    expect(isInside(posix('/') as never, posix('/x') as never)).toBe(true);
  });

  it('is case-sensitive on posix and ASCII-insensitive on win32', () => {
    expect(isInside(posix('/Opt') as never, posix('/opt/x') as never)).toBe(
      false,
    );
    const root = win('C:\\Program Files\\App') as never;
    expect(isInside(root, win('c:\\PROGRAM files\\app\\Bin') as never)).toBe(
      true,
    );
    expect(isInside(root, win('D:\\Program Files\\App\\Bin') as never)).toBe(
      false,
    );
  });

  it('never relates different flavors', () => {
    expect(isInside(posix('/') as never, win('C:\\x') as never)).toBe(false);
  });

  it('exposes parent, append and equality helpers', () => {
    const a = posix('/a/b') as never;
    expect(formatAbsolutePath(parentOf(a) as never)).toBe('/a');
    expect(parentOf(posix('/') as never)).toBeNull();
    expect(formatAbsolutePath(appendSegments(a, ['c', 'd']))).toBe('/a/b/c/d');
    expect(samePath(a, posix('/a/b') as never)).toBe(true);
    expect(samePath(a, posix('/a') as never)).toBe(false);
  });
});

describe('assertTrustedChain', () => {
  const root = posix('/opt/app') as never;
  const target = posix('/opt/app/bin/tool') as never;
  const build = () =>
    new MemoryFs()
      .set('/opt/app', 'dir', { uid: 1000, mode: 0o755 })
      .set('/opt/app/bin', 'dir', { uid: 0, mode: 0o755 })
      .set('/opt/app/bin/tool', 'file', { uid: 1000, mode: 0o755 });
  const options = (fs: MemoryFs) => ({
    fs,
    platform: 'linux' as const,
    uid: 1000,
    leaf: 'file' as const,
    executable: true,
  });
  const kind = async (promise: Promise<void>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(FsTrustError);
      return (error as FsTrustError).kind;
    }
    return 'ok';
  };

  it('accepts a clean chain owned by the user or root', async () => {
    expect(await kind(assertTrustedChain(root, target, options(build())))).toBe(
      'ok',
    );
  });

  it('reports missing components as absent', async () => {
    const fs = build();
    fs.nodes.delete('/opt/app/bin/tool');
    expect(await kind(assertTrustedChain(root, target, options(fs)))).toBe(
      'absent',
    );
  });

  it.each([
    ['symlinked root', (fs: MemoryFs) => fs.set('/opt/app', 'symlink')],
    [
      'symlinked directory',
      (fs: MemoryFs) => fs.set('/opt/app/bin', 'symlink'),
    ],
    [
      'symlinked leaf',
      (fs: MemoryFs) => fs.set('/opt/app/bin/tool', 'symlink'),
    ],
    [
      'group-writable directory',
      (fs: MemoryFs) => fs.set('/opt/app/bin', 'dir', { uid: 0, mode: 0o775 }),
    ],
    [
      'other-writable root',
      (fs: MemoryFs) => fs.set('/opt/app', 'dir', { uid: 1000, mode: 0o757 }),
    ],
    [
      'foreign-owned directory',
      (fs: MemoryFs) =>
        fs.set('/opt/app/bin', 'dir', { uid: 4242, mode: 0o755 }),
    ],
    [
      'foreign-owned leaf',
      (fs: MemoryFs) =>
        fs.set('/opt/app/bin/tool', 'file', { uid: 4242, mode: 0o755 }),
    ],
    [
      'writable leaf',
      (fs: MemoryFs) =>
        fs.set('/opt/app/bin/tool', 'file', { uid: 1000, mode: 0o775 }),
    ],
    [
      'non-executable leaf',
      (fs: MemoryFs) =>
        fs.set('/opt/app/bin/tool', 'file', { uid: 1000, mode: 0o644 }),
    ],
    ['directory leaf', (fs: MemoryFs) => fs.set('/opt/app/bin/tool', 'dir')],
    [
      'file in place of directory',
      (fs: MemoryFs) => fs.set('/opt/app/bin', 'file'),
    ],
  ])('rejects %s', async (_name, mutate) => {
    const fs = build();
    mutate(fs);
    expect(await kind(assertTrustedChain(root, target, options(fs)))).toBe(
      'untrusted',
    );
  });

  it('rejects a path that realpath resolves elsewhere', async () => {
    const fs = build();
    fs.realpaths.set('/opt/app', '/private/opt/app');
    expect(await kind(assertTrustedChain(root, target, options(fs)))).toBe(
      'untrusted',
    );
  });

  it('rejects a target outside the root', async () => {
    const fs = build();
    expect(
      await kind(
        assertTrustedChain(root, posix('/opt/other/x') as never, options(fs)),
      ),
    ).toBe('untrusted');
  });

  it('skips ownership and mode on win32 but still rejects reparse points', async () => {
    const wroot = win('C:\\Apps\\Product') as never;
    const wtarget = win('C:\\Apps\\Product\\bin\\tool.exe') as never;
    const fs = new MemoryFs()
      .set('C:\\Apps\\Product', 'dir', { uid: 7, mode: 0o777 })
      .set('C:\\Apps\\Product\\bin', 'dir', { uid: 7, mode: 0o777 })
      .set('C:\\Apps\\Product\\bin\\tool.exe', 'file', { uid: 7, mode: 0o666 });
    const opts = {
      fs,
      platform: 'win32' as const,
      uid: undefined,
      leaf: 'file' as const,
      executable: true,
    };
    expect(await kind(assertTrustedChain(wroot, wtarget, opts))).toBe('ok');
    fs.set('C:\\Apps\\Product\\bin', 'symlink');
    expect(await kind(assertTrustedChain(wroot, wtarget, opts))).toBe(
      'untrusted',
    );
  });
});
