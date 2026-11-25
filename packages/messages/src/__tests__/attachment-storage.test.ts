/**
 * Attachment storage root: configuration, path rules and reads (#5645).
 * Real temp directories; no database is needed for the file layer.
 */

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
import {
  AttachmentStorageError,
  configureAttachmentStorage,
  normalizeAttachmentPath,
  readStoredAttachmentFile,
  resetAttachmentStorage,
  scopeAttachmentPath,
} from '../attachment-storage.js';

const ACCT = 'acct-1';
const read = (filePath: string, account: string | null = ACCT) =>
  readStoredAttachmentFile(filePath, account);

describe('configureAttachmentStorage', () => {
  let dir: string;
  let base: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-attachment-root-'));
    base = join(dir, ACCT);
    mkdirSync(base);
  });
  afterEach(() => {
    resetAttachmentStorage();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a relative, missing or non-directory root', () => {
    writeFileSync(join(dir, 'file.txt'), 'x');
    expect(() => configureAttachmentStorage({ root: 'relative/dir' })).toThrow(
      AttachmentStorageError,
    );
    expect(() => configureAttachmentStorage({ root: '' })).toThrow(/absolute/);
    expect(() =>
      configureAttachmentStorage({ root: join(dir, 'missing') }),
    ).toThrow(/does not exist/);
    expect(() =>
      configureAttachmentStorage({ root: join(dir, 'file.txt') }),
    ).toThrow(/not a directory/);
  });

  it('reads nothing until a root is configured', async () => {
    writeFileSync(join(base, 'a.txt'), 'a');
    await expect(read(`${ACCT}/a.txt`)).rejects.toThrow(
      /configureAttachmentStorage/,
    );
    configureAttachmentStorage({ root: dir });
    expect((await read(`${ACCT}/a.txt`))?.toString()).toBe('a');
    resetAttachmentStorage();
    await expect(read(`${ACCT}/a.txt`)).rejects.toThrow(AttachmentStorageError);
  });

  it('returns null for a missing file or a directory', async () => {
    configureAttachmentStorage({ root: dir });
    expect(await read(`${ACCT}/nope.txt`)).toBeNull();
    mkdirSync(join(base, 'sub'));
    expect(await read(`${ACCT}/sub`)).toBeNull();
  });

  it("refuses another account's directory, loose files and no account", async () => {
    mkdirSync(join(dir, 'acct-2'));
    writeFileSync(join(dir, 'acct-2', 'a.txt'), 'other');
    writeFileSync(join(dir, 'loose.txt'), 'loose');
    configureAttachmentStorage({ root: dir });
    for (const filePath of [
      'acct-2/a.txt',
      'loose.txt',
      ACCT,
      'acct-10/a.txt',
    ]) {
      await expect(read(filePath)).rejects.toThrow(/account directory/);
    }
    await expect(read(`${ACCT}/a.txt`, null)).rejects.toThrow(
      /account directory/,
    );
  });

  it('refuses stored absolute and escaping paths on read', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'smrt-attachment-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      configureAttachmentStorage({ root: dir });
      for (const filePath of [
        join(outside, 'secret.txt'),
        '../secret.txt',
        `${ACCT}/../../secret.txt`,
        `${ACCT}\\b`,
      ]) {
        await expect(read(filePath)).rejects.toThrow(AttachmentStorageError);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'follows symlinks only while they stay inside the root',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'smrt-attachment-outside-'));
      try {
        writeFileSync(join(outside, 'secret.txt'), 'secret');
        writeFileSync(join(base, 'real.txt'), 'real');
        symlinkSync(join(outside, 'secret.txt'), join(base, 'out.txt'));
        symlinkSync(outside, join(base, 'outdir'));
        symlinkSync(join(base, 'real.txt'), join(base, 'in.txt'));
        configureAttachmentStorage({ root: dir });

        await expect(read(`${ACCT}/out.txt`)).rejects.toThrow(
          /outside the attachment storage root/,
        );
        await expect(read(`${ACCT}/outdir/secret.txt`)).rejects.toThrow(
          /outside/,
        );
        expect((await read(`${ACCT}/in.txt`))?.toString()).toBe('real');
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});

describe('scopeAttachmentPath', () => {
  it('needs a file below the account directory', () => {
    expect(scopeAttachmentPath('a1/x.pdf', 'a1')).toBe('a1/x.pdf');
    expect(scopeAttachmentPath('./a1//d/x.pdf', 'a1')).toBe('a1/d/x.pdf');
    for (const [path, account] of [
      ['a1/x.pdf', 'a2'],
      ['a1', 'a1'],
      ['x.pdf', 'a1'],
      ['a10/x.pdf', 'a1'],
      ['a1/x.pdf', null],
      ['a1/x.pdf', ''],
    ] as const) {
      expect(() => scopeAttachmentPath(path, account)).toThrow(
        AttachmentStorageError,
      );
    }
  });
});

describe('normalizeAttachmentPath', () => {
  it('keeps a relative path and drops empty and dot segments', () => {
    expect(normalizeAttachmentPath('a/b.pdf')).toBe('a/b.pdf');
    expect(normalizeAttachmentPath('./a//b/./c.pdf')).toBe('a/b/c.pdf');
    expect(normalizeAttachmentPath('100%25.pdf')).toBe('100%25.pdf');
  });

  it.each([
    '/abs/file',
    '//host/share',
    'C:\\x',
    'C:/x',
    '..',
    '../a',
    'a/..',
    'a/../../b',
    'a\\b',
    'a\u0000b',
    '%2e%2e/a',
    '%2E%2E%2Fa',
    'a%2Fb',
    'a%5cb',
    '%252e%252e/a',
    '',
    '.',
    './',
  ])('refuses %j', (value) => {
    expect(() => normalizeAttachmentPath(value)).toThrow(
      AttachmentStorageError,
    );
  });
});
