import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertPrivateDirectorySync,
  ensurePrivateDirectorySync,
  isPrivateFileStat,
  readPrivateFileBounded,
  writePrivateFileAtomic,
  writePrivateFileAtomicSync,
} from './private-files.js';

const posix = process.platform !== 'win32';
const WINDOWS_REASON = 'POSIX mode bits, uid and O_NOFOLLOW do not exist';
const itPosix = posix ? it : it.skip;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'smrt-private-files-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe.each([
  [
    'sync',
    async (...a: Parameters<typeof writePrivateFileAtomicSync>) =>
      writePrivateFileAtomicSync(...a),
  ],
  ['async', writePrivateFileAtomic],
] as const)('%s atomic private write', (_name, write) => {
  it('replaces content and leaves no temporary file', async () => {
    const path = join(root, 'record.json');
    await write(path, 'one');
    await write(path, 'two');
    expect(readFileSync(path, 'utf8')).toBe('two');
    expect(readdirSync(root)).toEqual(['record.json']);
  });

  itPosix(
    `writes mode 0600 (skipped on win32: ${WINDOWS_REASON})`,
    async () => {
      const path = join(root, 'secret');
      await write(path, 'value');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it('creates the parent only when asked', async () => {
    const path = join(root, 'nested', 'deep', 'file');
    await expect(
      Promise.resolve().then(() => write(path, 'x')),
    ).rejects.toThrow();
    await write(path, 'x', { createParent: true });
    expect(readFileSync(path, 'utf8')).toBe('x');
    if (posix) {
      expect(statSync(join(root, 'nested')).mode & 0o777).toBe(0o700);
    }
  });

  it('keeps the old file and no temporary when the rename fails', async () => {
    const path = join(root, 'blocked');
    mkdirSync(path);
    writeFileSync(join(path, 'keep'), 'old');
    // Renaming a file over a non-empty directory fails on every platform.
    await expect(
      Promise.resolve().then(() => write(path, 'new')),
    ).rejects.toThrow();
    expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('old');
    expect(readdirSync(root)).toEqual(['blocked']);
  });
});

describe('readPrivateFileBounded', () => {
  it('returns null for a missing file', async () => {
    await expect(readPrivateFileBounded(join(root, 'nope'), 10)).resolves.toBe(
      null,
    );
  });

  it('reads a regular file within the bound', async () => {
    const path = join(root, 'ok');
    writeFileSync(path, 'hello');
    await expect(readPrivateFileBounded(path, 5)).resolves.toBe('hello');
  });

  it('rejects an oversized file', async () => {
    const path = join(root, 'big');
    writeFileSync(path, 'hello!');
    await expect(readPrivateFileBounded(path, 5)).rejects.toThrow();
  });

  it('rejects a directory (not a regular file)', async () => {
    const path = join(root, 'dir');
    mkdirSync(path);
    await expect(readPrivateFileBounded(path, 10)).rejects.toThrow();
  });

  itPosix(
    `rejects a symlink (skipped on win32: ${WINDOWS_REASON})`,
    async () => {
      const target = join(root, 'target');
      writeFileSync(target, 'x');
      const link = join(root, 'link');
      symlinkSync(target, link);
      await expect(readPrivateFileBounded(link, 10)).rejects.toThrow();
    },
  );
});

describe('isPrivateFileStat', () => {
  const uid = process.getuid?.() ?? 0;
  const stat = (over: Partial<Parameters<typeof isPrivateFileStat>[0]>) => ({
    isFile: () => true,
    uid,
    mode: 0o100600,
    size: 4,
    ...over,
  });

  it('accepts an owner-only regular file within the bound', () => {
    expect(isPrivateFileStat(stat({}), 4)).toBe(true);
  });

  it('rejects oversized and non-regular entries', () => {
    expect(isPrivateFileStat(stat({ size: 5 }), 4)).toBe(false);
    expect(isPrivateFileStat(stat({ isFile: () => false }), 4)).toBe(false);
  });

  itPosix(
    `rejects group/other access and a foreign owner (skipped on win32: ${WINDOWS_REASON})`,
    () => {
      expect(isPrivateFileStat(stat({ mode: 0o100640 }), 4)).toBe(false);
      expect(isPrivateFileStat(stat({ uid: uid + 1 }), 4)).toBe(false);
    },
  );
});

describe('private directories', () => {
  it('ensurePrivateDirectorySync creates nested directories', () => {
    const path = join(root, 'a', 'b');
    ensurePrivateDirectorySync(path);
    expect(statSync(path).isDirectory()).toBe(true);
  });

  itPosix(
    `repairs mode 0755 to 0700 (skipped on win32: ${WINDOWS_REASON})`,
    () => {
      const path = join(root, 'secrets');
      mkdirSync(path);
      chmodSync(path, 0o755);
      assertPrivateDirectorySync(path);
      expect(statSync(path).mode & 0o777).toBe(0o700);
    },
  );

  itPosix(`rejects a symlink (skipped on win32: ${WINDOWS_REASON})`, () => {
    const target = join(root, 'real');
    mkdirSync(target);
    const link = join(root, 'link');
    symlinkSync(target, link);
    expect(() => assertPrivateDirectorySync(link)).toThrow();
  });

  it('rejects a regular file', () => {
    const path = join(root, 'file');
    writeFileSync(path, 'x');
    expect(() => assertPrivateDirectorySync(path)).toThrow();
  });
});

describe('Windows platform form (no uid, synthetic modes)', () => {
  const stat = (mode: number, size = 10) => ({
    isFile: () => true,
    uid: process.getuid?.() ?? 0,
    mode,
    size,
  });

  it('ignores the synthetic mode on win32 but keeps the size bound and kind', () => {
    // Windows reports 0o666 for a writable file; that is not group access.
    expect(isPrivateFileStat(stat(0o100666), 64, 'win32')).toBe(true);
    expect(isPrivateFileStat(stat(0o100666, 65), 64, 'win32')).toBe(false);
    expect(
      isPrivateFileStat(
        { ...stat(0o100666), isFile: () => false },
        64,
        'win32',
      ),
    ).toBe(false);
  });

  itPosix('still refuses group or other access on every other platform', () => {
    expect(isPrivateFileStat(stat(0o100644), 64, 'linux')).toBe(false);
    expect(isPrivateFileStat(stat(0o100644), 64, 'darwin')).toBe(false);
  });

  it('accepts a real directory and refuses a file or link on win32', () => {
    const directory = join(root, 'dir');
    mkdirSync(directory);
    expect(() => assertPrivateDirectorySync(directory, 'win32')).not.toThrow();
    const file = join(root, 'file');
    writeFileSync(file, '');
    expect(() => assertPrivateDirectorySync(file, 'win32')).toThrow();
    if (posix) {
      const link = join(root, 'link');
      symlinkSync(directory, link);
      expect(() => assertPrivateDirectorySync(link, 'win32')).toThrow();
    }
  });
});
