import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planDataRootArchive } from '../snapshot-archive.js';
import {
  decryptSnapshot,
  verifySnapshot,
  writeEncryptedSnapshot,
} from '../snapshot-framing.js';

const io = vi.hoisted(() => ({
  events: [] as Array<{ operation: string; path: string; target?: string }>,
  descriptors: new Map<number, string>(),
  linkError: undefined as NodeJS.ErrnoException | undefined,
  fileSyncError: false,
  directorySyncError: false,
  directorySyncErrorPath: undefined as string | undefined,
}));

// Keep real temporary files and real flushes. Intercept only the syscall
// boundaries needed to observe completion order or inject a storage failure.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn((...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      io.descriptors.set(fd, String(args[0]));
      return fd;
    }),
    closeSync: vi.fn((fd: number) => {
      try {
        actual.closeSync(fd);
      } finally {
        io.descriptors.delete(fd);
      }
    }),
    fsyncSync: vi.fn((fd: number) => {
      if (io.fileSyncError) {
        throw Object.assign(new Error('simulated file sync failure'), {
          code: 'EIO',
        });
      }
      actual.fsyncSync(fd);
      io.events.push({
        operation: 'file-sync',
        path: io.descriptors.get(fd) ?? 'unknown',
      });
    }),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        const directory = (await handle.stat()).isDirectory();
        if (
          directory &&
          (io.directorySyncError ||
            String(args[0]) === io.directorySyncErrorPath)
        ) {
          throw Object.assign(new Error('simulated directory sync failure'), {
            code: 'EIO',
          });
        }
        await sync();
        io.events.push({
          operation: directory ? 'directory-sync' : 'file-sync',
          path: String(args[0]),
        });
      });
      return handle;
    }),
    link: vi.fn(async (...args: Parameters<typeof actual.link>) => {
      if (io.linkError) throw io.linkError;
      await actual.link(...args);
      io.events.push({
        operation: 'link',
        path: String(args[0]),
        target: String(args[1]),
      });
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      io.events.push({
        operation: 'rename',
        path: String(args[0]),
        target: String(args[1]),
      });
    }),
  };
});

const roots: string[] = [];
afterEach(() => {
  io.events.length = 0;
  io.descriptors.clear();
  io.linkError = undefined;
  io.fileSyncError = false;
  io.directorySyncError = false;
  io.directorySyncErrorPath = undefined;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-durability-')));
  roots.push(root);
  return root;
}

function keys() {
  const key = randomBytes(32);
  const context = {
    accountId: 'account-1',
    deviceId: 'device-1',
    sequence: 1n,
  };
  return {
    context,
    provider: { openingKey: async () => new Uint8Array(key) },
    sealing: () => ({
      ...context,
      key: new Uint8Array(key),
      keyId: '01'.repeat(16),
      generation: 1n,
    }),
  };
}

async function archiveFixture(root: string) {
  const ring = keys();
  const data = join(root, 'data');
  mkdirSync(join(data, 'child', 'nested'), { recursive: true });
  writeFileSync(join(data, 'root.txt'), 'root');
  writeFileSync(join(data, 'child', 'nested', 'data.txt'), 'nested');
  writeFileSync(join(data, 'child', 'empty'), '');
  const archive = planDataRootArchive(data);
  const source = join(root, 'source.hvsnap');
  await writeEncryptedSnapshot({
    destination: source,
    kind: 'data-root',
    totalLength: archive.totalLength,
    source: archive.chunks(),
    sealing: ring.sealing(),
  });
  io.events.length = 0;
  return {
    source,
    context: ring.context,
    keys: ring.provider,
  };
}

describe('snapshot filesystem durability', () => {
  // Directory flush ordering is a POSIX guarantee; the Windows boundary is
  // exercised separately below and explicitly documented for callers.
  it.runIf(process.platform !== 'win32')(
    'flushes ciphertext before linking and parent entries before returning',
    async () => {
      const root = workspace();
      const destination = join(root, 'new', 'nested', 'snapshot.hvsnap');
      const ring = keys();
      await writeEncryptedSnapshot({
        destination,
        kind: 'export-bundle',
        totalLength: 4,
        source: [Buffer.from('data')],
        sealing: ring.sealing(),
      });
      const linked = io.events.findIndex((e) => e.operation === 'link');
      expect(linked).toBeGreaterThan(0);
      expect(io.events[linked - 1].operation).toBe('file-sync');
      expect(io.events.slice(linked + 1)).toEqual([
        { operation: 'directory-sync', path: dirname(destination) },
        { operation: 'directory-sync', path: join(root, 'new') },
        { operation: 'directory-sync', path: root },
      ]);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'flushes restored files and directories bottom-up before publishing a tree',
    async () => {
      const root = workspace();
      const fixture = await archiveFixture(root);
      const destination = join(root, 'restored', 'nested', 'candidate');
      await decryptSnapshot({ ...fixture, destination });
      const published = io.events.findIndex((e) => e.operation === 'rename');
      expect(published).toBeGreaterThan(0);
      const staging = io.events[published].path;
      for (const path of ['root.txt', 'child/nested/data.txt', 'child/empty']) {
        const file = io.events.findIndex(
          (e) => e.operation === 'file-sync' && e.path === join(staging, path),
        );
        expect(file).toBeGreaterThanOrEqual(0);
        const directory = io.events.findIndex(
          (e) =>
            e.operation === 'directory-sync' &&
            e.path === dirname(join(staging, path)),
        );
        expect(directory).toBeGreaterThan(file);
        expect(directory).toBeLessThan(published);
      }
      expect(io.events.filter((e) => e.operation === 'directory-sync')).toEqual(
        [
          {
            operation: 'directory-sync',
            path: join(staging, 'child', 'nested'),
          },
          { operation: 'directory-sync', path: join(staging, 'child') },
          { operation: 'directory-sync', path: staging },
          { operation: 'directory-sync', path: dirname(destination) },
          { operation: 'directory-sync', path: join(root, 'restored') },
          { operation: 'directory-sync', path: root },
        ],
      );
    },
  );

  it('does not publish a restore candidate when a restored file cannot be flushed', async () => {
    const root = workspace();
    const fixture = await archiveFixture(root);
    io.fileSyncError = true;
    const destination = join(root, 'candidate');
    await expect(decryptSnapshot({ ...fixture, destination })).rejects.toThrow(
      'simulated file sync failure',
    );
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith('.'))).toEqual(
      [],
    );
  });

  it.runIf(process.platform !== 'win32')(
    'does not publish a restore candidate when its tree cannot be flushed',
    async () => {
      const root = workspace();
      const fixture = await archiveFixture(root);
      io.directorySyncError = true;
      const destination = join(root, 'candidate');
      await expect(
        decryptSnapshot({ ...fixture, destination }),
      ).rejects.toThrow(/sync.*directory/i);
      expect(existsSync(destination)).toBe(false);
      expect(readdirSync(root).filter((name) => name.startsWith('.'))).toEqual(
        [],
      );
    },
  );

  it.runIf(process.platform !== 'win32')(
    'reports a post-publication sync error but retains the complete verified file',
    async () => {
      const root = workspace();
      const ring = keys();
      const destination = join(root, 'snapshot.hvsnap');
      io.directorySyncError = true;
      await expect(
        writeEncryptedSnapshot({
          destination,
          kind: 'export-bundle',
          totalLength: 4,
          source: [Buffer.from('data')],
          sealing: ring.sealing(),
        }),
      ).rejects.toThrow(/sync.*directory/i);
      io.directorySyncError = false;
      await expect(
        verifySnapshot({
          source: destination,
          context: ring.context,
          keys: ring.provider,
        }),
      ).resolves.toMatchObject({ totalLength: 4 });
      expect(readdirSync(root)).toEqual(['snapshot.hvsnap']);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'flushes bundle restores and their newly created parent entries',
    async () => {
      const root = workspace();
      const ring = keys();
      const source = join(root, 'source.hvsnap');
      await writeEncryptedSnapshot({
        destination: source,
        kind: 'export-bundle',
        totalLength: 4,
        source: [Buffer.from('data')],
        sealing: ring.sealing(),
      });
      io.events.length = 0;
      const destination = join(root, 'restored', 'nested', 'bundle.json');
      await decryptSnapshot({
        source,
        destination,
        context: ring.context,
        keys: ring.provider,
      });
      expect(io.events.map((e) => e.operation)).toEqual([
        'file-sync',
        'link',
        'directory-sync',
        'directory-sync',
        'directory-sync',
      ]);
      expect(io.events.slice(2).map((e) => e.path)).toEqual([
        dirname(destination),
        join(root, 'restored'),
        root,
      ]);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'retains a fully restored tree if its published parent cannot be flushed',
    async () => {
      const root = workspace();
      const fixture = await archiveFixture(root);
      const destination = join(root, 'candidate');
      io.directorySyncErrorPath = root;
      await expect(
        decryptSnapshot({ ...fixture, destination }),
      ).rejects.toThrow(/sync.*directory/i);
      expect(existsSync(join(destination, 'root.txt'))).toBe(true);
      expect(existsSync(join(destination, 'child', 'nested', 'data.txt'))).toBe(
        true,
      );
      expect(readdirSync(root).filter((name) => name.startsWith('.'))).toEqual(
        [],
      );
    },
  );

  it('keeps mandatory file flushes on the documented Windows directory-sync path', async () => {
    const root = workspace();
    const fixture = await archiveFixture(root);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    expect(descriptor).toBeDefined();
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      await decryptSnapshot({
        ...fixture,
        destination: join(root, 'candidate'),
      });
    } finally {
      Object.defineProperty(
        process,
        'platform',
        descriptor as PropertyDescriptor,
      );
    }
    expect(io.events.filter((e) => e.operation === 'file-sync')).toHaveLength(
      3,
    );
    expect(io.events.filter((e) => e.operation === 'directory-sync')).toEqual(
      [],
    );
  });

  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM']) {
    it(`explains an unavailable atomic hard-link publish (${code}) without leaving a target`, async () => {
      const root = workspace();
      const ring = keys();
      const destination = join(root, 'snapshot.hvsnap');
      io.linkError = Object.assign(new Error('link refused'), { code });
      await expect(
        writeEncryptedSnapshot({
          destination,
          kind: 'export-bundle',
          totalLength: 4,
          source: [Buffer.from('data')],
          sealing: ring.sealing(),
        }),
      ).rejects.toThrow(/hard links.*filesystem|filesystem.*hard links/i);
      expect(readdirSync(root)).toEqual([]);
    });
  }

  it('preserves unexpected link failures instead of relabelling them as capability errors', async () => {
    const root = workspace();
    const ring = keys();
    const error = Object.assign(new Error('disk I/O failed'), { code: 'EIO' });
    io.linkError = error;
    await expect(
      writeEncryptedSnapshot({
        destination: join(root, 'snapshot.hvsnap'),
        kind: 'export-bundle',
        totalLength: 4,
        source: [Buffer.from('data')],
        sealing: ring.sealing(),
      }),
    ).rejects.toBe(error);
  });
});
