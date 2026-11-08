import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '../testing/memory-fs.js';
import { FsTrustError } from './fs-seam.js';
import {
  assertPrivateDirectory,
  readPrivateFile,
  readTrustedFile,
  writePrivateFileAtomic,
} from './private-file.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

async function kind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FsTrustError);
    return (error as FsTrustError).kind;
  }
  return 'ok';
}

posixOnly('private files on a real filesystem', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-desktop-pf-')));
    chmodSync(dir, 0o700);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a 0600 file we own', async () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, '{"ok":true}', { mode: 0o600 });
    expect(await readPrivateFile(file)).toBe('{"ok":true}');
  });

  it('reports a missing file as absent', async () => {
    expect(await kind(readPrivateFile(join(dir, 'nope')))).toBe('absent');
    expect(await kind(readPrivateFile(join(dir, 'nope', 'deeper')))).toBe(
      'absent',
    );
  });

  it.each([
    0o640, 0o604, 0o660, 0o644, 0o666, 0o607,
  ])('rejects mode %o', async (mode) => {
    const file = join(dir, 'a.json');
    writeFileSync(file, '{}');
    chmodSync(file, mode);
    expect(await kind(readPrivateFile(file))).toBe('untrusted');
  });

  it('accepts stricter modes', async () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o400);
    expect(await readPrivateFile(file)).toBe('{}');
  });

  it('rejects a symlink even to a valid private file', async () => {
    const real = join(dir, 'real.json');
    writeFileSync(real, '{}', { mode: 0o600 });
    const link = join(dir, 'link.json');
    symlinkSync(real, link);
    expect(await kind(readPrivateFile(link))).toBe('untrusted');
    expect(await kind(readTrustedFile(link))).toBe('untrusted');
  });

  it('rejects a dangling symlink and a directory', async () => {
    symlinkSync(join(dir, 'missing'), join(dir, 'dangling'));
    expect(await kind(readPrivateFile(join(dir, 'dangling')))).toBe(
      'untrusted',
    );
    mkdirSync(join(dir, 'sub'), { mode: 0o700 });
    expect(await kind(readPrivateFile(join(dir, 'sub')))).toBe('untrusted');
  });

  it('rejects a FIFO planted at the record path without blocking', async () => {
    const fifo = join(dir, 'instance.json');
    const made = spawnSync('mkfifo', [fifo]);
    expect(made.status).toBe(0);
    const started = Date.now();
    expect(await kind(readPrivateFile(fifo))).toBe('untrusted');
    expect(await kind(readTrustedFile(fifo))).toBe('untrusted');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects a foreign uid on the descriptor', async () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, '{}', { mode: 0o600 });
    const mine = process.getuid?.() as number;
    expect(await readPrivateFile(file, { currentUid: mine })).toBe('{}');
    expect(await kind(readPrivateFile(file, { currentUid: mine + 1 }))).toBe(
      'untrusted',
    );
  });

  it('enforces the size cap before and while reading', async () => {
    const file = join(dir, 'big.json');
    writeFileSync(file, 'x'.repeat(100), { mode: 0o600 });
    expect(await readPrivateFile(file, { maxBytes: 100 })).toHaveLength(100);
    expect(await kind(readPrivateFile(file, { maxBytes: 99 }))).toBe(
      'too_large',
    );
  });

  it('rejects invalid UTF-8 and a BOM-prefixed document stays visible', async () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]), { mode: 0o600 });
    expect(await kind(readPrivateFile(file))).toBe('malformed_text');
    writeFileSync(file, '\ufeff{}', { mode: 0o600 });
    expect(await readPrivateFile(file)).toBe('\ufeff{}');
  });

  it('validates private directories with lstat', async () => {
    await assertPrivateDirectory(dir);
    chmodSync(dir, 0o750);
    expect(await kind(assertPrivateDirectory(dir))).toBe('untrusted');
    chmodSync(dir, 0o700);
    const link = join(tmpdir(), `smrt-desktop-link-${process.pid}`);
    symlinkSync(dir, link);
    try {
      expect(await kind(assertPrivateDirectory(link))).toBe('untrusted');
    } finally {
      rmSync(link);
    }
    expect(await kind(assertPrivateDirectory(join(dir, 'nope')))).toBe(
      'absent',
    );
    writeFileSync(join(dir, 'f'), '', { mode: 0o600 });
    expect(await kind(assertPrivateDirectory(join(dir, 'f')))).toBe(
      'untrusted',
    );
  });

  it('readTrustedFile allows 0644 but not group or other writable', async () => {
    const file = join(dir, 'm.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);
    expect(await readTrustedFile(file)).toBe('{}');
    chmodSync(file, 0o664);
    expect(await kind(readTrustedFile(file))).toBe('untrusted');
    chmodSync(file, 0o646);
    expect(await kind(readTrustedFile(file))).toBe('untrusted');
  });

  it('writes atomically with mode 0600 and leaves no temp file', async () => {
    const file = join(dir, 'out.json');
    await writePrivateFileAtomic(file, '{"v":1}\n');
    expect(readFileSync(file, 'utf8')).toBe('{"v":1}\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await writePrivateFileAtomic(file, new Uint8Array([0x7b, 0x7d]));
    expect(readFileSync(file, 'utf8')).toBe('{}');
    expect(readdirSync(dir)).toEqual(['out.json']);
    expect(await readPrivateFile(file)).toBe('{}');
  });

  it('replaces a symlink at the destination instead of following it', async () => {
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched', { mode: 0o600 });
    const file = join(dir, 'out.json');
    symlinkSync(victim, file);
    await writePrivateFileAtomic(file, '{}');
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(readFileSync(file, 'utf8')).toBe('{}');
  });

  it('refuses to reuse a pre-created temp file name (O_EXCL)', async () => {
    const file = join(dir, 'out.json');
    const planted = `${file}.fixed.tmp`;
    symlinkSync(join(dir, 'victim'), planted);
    expect(
      await kind(
        writePrivateFileAtomic(file, '{}', { randomSuffix: () => 'fixed' }),
      ),
    ).toBe('unreadable');
    expect(readdirSync(dir).sort()).toEqual(['out.json.fixed.tmp']);
  });
});

describe('private files through the fs seam', () => {
  it('orders tmp create, write, fsync, rename, directory fsync', async () => {
    const fs = new MemoryFs().set('/s', 'dir', { mode: 0o700 });
    await writePrivateFileAtomic('/s/a.json', '{}', {
      fs,
      randomSuffix: () => 'r',
      platform: 'linux',
    });
    expect(fs.log).toEqual([
      'open:/s/a.json.r.tmp',
      'sync',
      'rename:/s/a.json.r.tmp>/s/a.json',
      'open:/s',
      'sync',
    ]);
    expect(fs.text('/s/a.json')).toBe('{}');
    expect(fs.nodes.get('/s/a.json')?.mode).toBe(0o600);
  });

  it('removes the temp file when the write fails', async () => {
    const fs = new MemoryFs().set('/s', 'dir', { mode: 0o700 });
    fs.failNextWriteWith = 'ENOSPC';
    expect(
      await kind(
        writePrivateFileAtomic('/s/a.json', '{}', {
          fs,
          randomSuffix: () => 'r',
          platform: 'linux',
        }),
      ),
    ).toBe('unreadable');
    expect([...fs.nodes.keys()]).toEqual(['/s']);
  });

  it('applies uid and mode only off Windows', async () => {
    const fs = new MemoryFs().set('C:\\s\\a.json', 'file', {
      uid: 9,
      mode: 0o666,
      content: '{}',
    });
    expect(
      await readPrivateFile('C:\\s\\a.json', { fs, platform: 'win32' }),
    ).toBe('{}');
    expect(
      await kind(
        readPrivateFile('C:\\s\\a.json', {
          fs,
          platform: 'linux',
          currentUid: 9,
        }),
      ),
    ).toBe('untrusted');
  });

  it('does not echo the path or contents in failures', async () => {
    const fs = new MemoryFs().set('/secret-dir/secret.json', 'file', {
      mode: 0o666,
      content: 'TOKEN-123',
    });
    try {
      await readPrivateFile('/secret-dir/secret.json', {
        fs,
        platform: 'linux',
        currentUid: 1000,
      });
      expect.unreachable();
    } catch (error) {
      const text = `${(error as Error).message}${(error as Error).stack ?? ''}`;
      expect(text).not.toContain('secret-dir');
      expect(text).not.toContain('TOKEN-123');
    }
  });
});
