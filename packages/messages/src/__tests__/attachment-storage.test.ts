/**
 * Attachment storage root: configuration, path rules and reads (#5645).
 * Real temp directories; no database is needed to read a row's file.
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
  resetAttachmentStorage,
} from '../attachment-storage.js';
import { Attachment } from '../models/Attachment.js';

describe('configureAttachmentStorage', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-attachment-root-'));
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
    writeFileSync(join(dir, 'a.txt'), 'a');
    const row = new Attachment({ filePath: 'a.txt' });
    await expect(row.readContent()).rejects.toThrow(
      /configureAttachmentStorage/,
    );
    configureAttachmentStorage({ root: dir });
    expect((await row.readContent())?.toString()).toBe('a');
    resetAttachmentStorage();
    await expect(row.readContent()).rejects.toThrow(AttachmentStorageError);
  });

  it('returns null for a row without a file or a missing file', async () => {
    configureAttachmentStorage({ root: dir });
    expect(await new Attachment({}).readContent()).toBeNull();
    expect(await new Attachment({ filePath: 'nope.txt' }).readContent()).toBe(
      null,
    );
    mkdirSync(join(dir, 'sub'));
    expect(await new Attachment({ filePath: 'sub' }).readContent()).toBeNull();
  });

  it('refuses stored absolute and escaping paths on read', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'smrt-attachment-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      configureAttachmentStorage({ root: dir });
      for (const filePath of [
        join(outside, 'secret.txt'),
        '../secret.txt',
        `../${outside.split('/').pop()}/secret.txt`,
        'a\\b',
      ]) {
        await expect(
          new Attachment({ filePath }).readContent(),
        ).rejects.toThrow(AttachmentStorageError);
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
        writeFileSync(join(dir, 'real.txt'), 'real');
        symlinkSync(join(outside, 'secret.txt'), join(dir, 'out.txt'));
        symlinkSync(outside, join(dir, 'outdir'));
        symlinkSync(join(dir, 'real.txt'), join(dir, 'in.txt'));
        configureAttachmentStorage({ root: dir });

        await expect(
          new Attachment({ filePath: 'out.txt' }).readContent(),
        ).rejects.toThrow(/outside the attachment storage root/);
        await expect(
          new Attachment({ filePath: 'outdir/secret.txt' }).readContent(),
        ).rejects.toThrow(/outside/);
        expect(
          (
            await new Attachment({ filePath: 'in.txt' }).readContent()
          )?.toString(),
        ).toBe('real');
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
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
