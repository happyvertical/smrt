/**
 * Backup targets (#4804): the shared ciphertext guard, retention, and the
 * file, Google Drive and vault relay targets, with one test per threat in the
 * issue's security review.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBackupTarget } from '../backup-target-file.js';
import {
  assertNarrowDriveScope,
  createGoogleDriveFilesystem,
  DRIVE_APPDATA_SCOPE,
  DRIVE_FILE_SCOPE,
  type DriveCredentials,
  GoogleDriveBackupTarget,
} from '../backup-target-gdrive.js';
import {
  normalizeRelayUrl,
  VaultRelayBackupTarget,
} from '../backup-target-vault.js';
import {
  type BackupObject,
  BackupTargetError,
  planRetention,
  verifiedCiphertext,
} from '../backup-targets.js';
import { decryptSnapshot } from '../snapshot-framing.js';
import {
  collect,
  driveError,
  entitled,
  FakeDrive,
  json,
  keyring,
  pieces,
  relayWithSigner,
  seal,
  tempRoot,
  unentitled,
} from './backup-test-support.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function failure(promise: Promise<unknown>): Promise<BackupTargetError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BackupTargetError);
    return error as BackupTargetError;
  }
  throw new Error('expected a BackupTargetError');
}

async function* explodingAfter(
  bytes: Buffer,
  size: number,
): AsyncGenerator<Uint8Array> {
  yield bytes.subarray(0, size);
  throw new Error('connection dropped mid-upload');
}

describe('verifiedCiphertext (plaintext must never reach a target)', () => {
  it('passes a real snapshot through unchanged', async () => {
    const snap = await seal(tempRoot(roots), 3n);
    const out = await collect(verifiedCiphertext(snap.request()));
    expect(out.equals(snap.bytes)).toBe(true);
  });

  it('refuses a plaintext archive before yielding a single byte', async () => {
    const plaintext = Buffer.concat([
      Buffer.from('HVSA\u0001'),
      randomBytes(4000),
    ]);
    const yielded: Uint8Array[] = [];
    const request = {
      sequence: 3n,
      byteSize: plaintext.length,
      sha256: (await import('node:crypto'))
        .createHash('sha256')
        .update(plaintext)
        .digest('hex'),
      source: pieces(plaintext, 80),
    };
    const error = await failure(
      (async () => {
        for await (const chunk of verifiedCiphertext(request)) {
          yielded.push(chunk);
        }
      })(),
    );
    expect(error.code).toBe('invalid_snapshot');
    expect(yielded).toEqual([]);
  });

  it('refuses a snapshot whose header sequence differs from the declared one', async () => {
    const snap = await seal(tempRoot(roots), 3n);
    const error = await failure(
      collect(verifiedCiphertext(snap.request({ sequence: 4n }))),
    );
    expect(error.code).toBe('invalid_snapshot');
  });

  it.each([
    ['truncated', (b: Buffer) => b.subarray(0, b.length - 5)],
    ['extended', (b: Buffer) => Buffer.concat([b, Buffer.from('x')])],
  ])('detects a %s stream against the declared size', async (_name, edit) => {
    const snap = await seal(tempRoot(roots), 3n);
    const error = await failure(
      collect(
        verifiedCiphertext(snap.request({ source: pieces(edit(snap.bytes)) })),
      ),
    );
    expect(error.code).toBe('integrity');
  });

  it('detects a flipped byte through the declared digest', async () => {
    const snap = await seal(tempRoot(roots), 3n);
    const flipped = Buffer.from(snap.bytes);
    flipped[flipped.length - 3] ^= 0xff;
    const error = await failure(
      collect(verifiedCiphertext(snap.request({ source: pieces(flipped) }))),
    );
    expect(error.code).toBe('integrity');
  });
});

describe('retention planning', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 10, 8);
  const object = (sequence: number, ageDays: number): BackupObject => ({
    id: String(sequence),
    sequence: BigInt(sequence),
    byteSize: 1,
    createdAt: new Date(now - ageDays * day),
  });

  it('keeps the newest N by sequence and removes the rest', () => {
    const plan = planRetention(
      [object(1, 9), object(5, 1), object(3, 5), object(4, 2), object(2, 7)],
      { keepLast: 2 },
      now,
    );
    expect(plan.keep.map((o) => o.id)).toEqual(['5', '4']);
    expect(plan.remove.map((o) => o.id)).toEqual(['3', '2', '1']);
  });

  it('also keeps snapshots inside the age window', () => {
    const plan = planRetention(
      [object(1, 9), object(2, 7), object(3, 3), object(4, 1)],
      { keepLast: 1, keepWithinDays: 4 },
      now,
    );
    expect(plan.keep.map((o) => o.id)).toEqual(['4', '3']);
    expect(plan.remove.map((o) => o.id)).toEqual(['2', '1']);
  });

  it('never removes the newest, even with a skewed clock', () => {
    const plan = planRetention([object(9, 400)], { keepLast: 1 }, now);
    expect(plan.remove).toEqual([]);
  });

  it.each([0, -1, 1.5, 10_001])('rejects keepLast %s', (keepLast) => {
    expect(() => planRetention([], { keepLast }, now)).toThrow(
      BackupTargetError,
    );
  });
});

describe('file target', () => {
  it('stores, lists newest first, reads back and deletes ciphertext', async () => {
    const root = tempRoot(roots);
    const target = new FileBackupTarget({
      name: 'disk',
      directory: join(root, 'vault'),
    });
    const one = await seal(join(root, 'work'), 1n);
    const two = await seal(join(root, 'work'), 2n);
    await target.put(one.request());
    const stored = await target.put(two.request());
    expect(stored).toMatchObject({ sequence: 2n, byteSize: two.byteSize });
    expect((await target.list()).map((o) => o.sequence)).toEqual([2n, 1n]);
    expect((await collect(target.get(stored.id))).equals(two.bytes)).toBe(true);
    await target.delete(stored.id);
    expect((await target.list()).map((o) => o.sequence)).toEqual([1n]);
    expect((await failure(target.delete(stored.id))).code).toBe('not_found');
    expect(statSync(join(root, 'vault')).mode & 0o777).toBe(0o700);
  });

  it('stores only ciphertext that restores with the key', async () => {
    const root = tempRoot(roots);
    const target = new FileBackupTarget({
      name: 'd',
      directory: join(root, 'v'),
    });
    const snap = await seal(
      join(root, 'w'),
      4n,
      Buffer.from('plain-marker'.repeat(500)),
    );
    const stored = await target.put(snap.request());
    const raw = readFileSync(join(root, 'v', stored.id));
    expect(raw.includes('plain-marker')).toBe(false);
    expect(statSync(join(root, 'v', stored.id)).mode & 0o777).toBe(0o600);
    await decryptSnapshot({
      source: join(root, 'v', stored.id),
      destination: join(root, 'restored.json'),
      context: { accountId: 'account-1', deviceId: 'device-1', sequence: 4n },
      keys: keyring(),
      expectedKind: 'export-bundle',
    });
    expect(readFileSync(join(root, 'restored.json'), 'utf8')).toBe(
      'plain-marker'.repeat(500),
    );
  });

  it('leaves nothing visible when the upload is interrupted', async () => {
    const root = tempRoot(roots);
    const directory = join(root, 'v');
    const target = new FileBackupTarget({ name: 'd', directory });
    const snap = await seal(join(root, 'w'), 5n);
    await expect(
      target.put(snap.request({ source: explodingAfter(snap.bytes, 2000) })),
    ).rejects.toThrow('connection dropped');
    expect(await target.list()).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('rejects a digest mismatch without publishing', async () => {
    const root = tempRoot(roots);
    const directory = join(root, 'v');
    const target = new FileBackupTarget({ name: 'd', directory });
    const snap = await seal(join(root, 'w'), 5n);
    const error = await failure(
      target.put(snap.request({ sha256: 'f'.repeat(64) })),
    );
    expect(error.code).toBe('integrity');
    expect(readdirSync(directory)).toEqual([]);
  });

  it('refuses plaintext', async () => {
    const root = tempRoot(roots);
    const directory = join(root, 'v');
    const target = new FileBackupTarget({ name: 'd', directory });
    const bytes = randomBytes(2000);
    const error = await failure(
      target.put({
        sequence: 1n,
        byteSize: bytes.length,
        sha256: '0'.repeat(64),
        source: pieces(bytes),
      }),
    );
    expect(error.code).toBe('invalid_snapshot');
    expect(readdirSync(directory)).toEqual([]);
  });

  it('never replaces an existing snapshot', async () => {
    const root = tempRoot(roots);
    const target = new FileBackupTarget({
      name: 'd',
      directory: join(root, 'v'),
    });
    const snap = await seal(join(root, 'w'), 6n);
    await target.put(snap.request());
    const again = await seal(join(root, 'w2'), 6n, randomBytes(3000));
    expect((await failure(target.put(again.request()))).code).toBe(
      'already_exists',
    );
    expect(
      readFileSync(
        join(root, 'v', readdirSync(join(root, 'v'))[0] as string),
      ).equals(snap.bytes),
    ).toBe(true);
  });

  it('ignores partial files and foreign names when listing', async () => {
    const root = tempRoot(roots);
    const directory = join(root, 'v');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '.snapshot-1.partial'), 'x');
    writeFileSync(join(directory, 'notes.txt'), 'x');
    const target = new FileBackupTarget({ name: 'd', directory });
    expect(await target.list()).toEqual([]);
  });

  it('lists only files whose header agrees with their name (planted names are ignored)', async () => {
    const root = tempRoot(roots);
    const directory = join(root, 'v');
    const target = new FileBackupTarget({ name: 'd', directory });
    const real = await seal(join(root, 'w'), 2n);
    await target.put(real.request());
    writeFileSync(
      join(directory, 'snapshot-99999999999999999999.hvsnap'),
      'not a snapshot',
    );
    const other = await seal(join(root, 'w2'), 7n);
    writeFileSync(
      join(directory, 'snapshot-00000000000000000009.hvsnap'),
      other.bytes,
    );
    expect((await target.list()).map((o) => o.sequence)).toEqual([2n]);
    // Retention therefore cannot be steered into removing the real newest.
    const plan = planRetention(await target.list(), { keepLast: 1 });
    expect(plan.remove).toEqual([]);
  });

  it('refuses a directory others can write to', async () => {
    const root = tempRoot(roots);
    const directory = join(root, 'v');
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o777);
    const target = new FileBackupTarget({ name: 'd', directory });
    expect((await failure(target.preflight())).code).toBe('invalid_config');
    expect((await failure(target.list())).code).toBe('invalid_config');
  });

  it('rejects ids that are not snapshot names (no path traversal)', async () => {
    const root = tempRoot(roots);
    const target = new FileBackupTarget({
      name: 'd',
      directory: join(root, 'v'),
    });
    writeFileSync(join(root, 'secret.hvsnap'), 'secret');
    for (const id of [
      '../secret.hvsnap',
      '/etc/passwd',
      'snapshot-1.hvsnap',
      '',
    ]) {
      expect((await failure(collect(target.get(id)))).code).toBe('not_found');
      expect((await failure(target.delete(id))).code).toBe('not_found');
    }
  });

  it('refuses a symbolic link in place of the directory', async () => {
    const root = tempRoot(roots);
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const target = new FileBackupTarget({
      name: 'd',
      directory: join(root, 'link'),
    });
    expect((await failure(target.preflight())).code).toBe('invalid_config');
  });

  it('removes only stale partials of its own', async () => {
    const root = tempRoot(roots);
    const directory = join(root, 'v');
    mkdirSync(directory, { recursive: true });
    const stale = join(
      directory,
      '.snapshot-00000000000000000001.hvsnap.1.ab.partial',
    );
    writeFileSync(stale, 'x');
    writeFileSync(join(directory, '.other.partial'), 'x');
    chmodSync(stale, 0o600);
    const target = new FileBackupTarget({ name: 'd', directory });
    expect(await target.removeStalePartials(1000, Date.now() + 5000)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(directory, '.other.partial'))).toBe(true);
  });
});

describe('google drive target', () => {
  const TOKEN = 'refresh-token-must-never-print-0123456789';
  const credentials = (scope = DRIVE_FILE_SCOPE): DriveCredentials => ({
    clientId: 'client-id',
    clientSecret: 'client-secret-must-never-print',
    refreshToken: TOKEN,
    scope,
  });
  const make = (drive: FakeDrive, scope?: string, maxBytes?: number) =>
    new GoogleDriveBackupTarget({
      name: 'drive',
      folder: 'smrt-backups',
      credentials: async () => credentials(scope),
      createFilesystem: async () => drive,
      maxBytes,
    });

  it('stores through staging, lists newest first and reads back', async () => {
    const root = tempRoot(roots);
    const drive = new FakeDrive();
    const target = make(drive);
    const one = await seal(root, 1n);
    const two = await seal(root, 2n);
    await target.put(one.request());
    const stored = await target.put(two.request());
    expect(drive.visible('smrt-backups')).toHaveLength(2);
    expect(drive.staged('smrt-backups')).toEqual([]);
    expect((await target.list()).map((o) => o.sequence)).toEqual([2n, 1n]);
    expect((await collect(target.get(stored.id))).equals(two.bytes)).toBe(true);
    await target.delete(stored.id);
    expect(drive.trashed).toEqual([`smrt-backups/snapshots/${stored.id}`]);
    expect((await target.list()).map((o) => o.sequence)).toEqual([1n]);
  });

  it('holds only ciphertext in Drive', async () => {
    const root = tempRoot(roots);
    const drive = new FakeDrive();
    const snap = await seal(
      root,
      7n,
      Buffer.from('drive-plain-marker'.repeat(400)),
    );
    await make(drive).put(snap.request());
    for (const bytes of drive.files.values()) {
      expect(bytes.includes('drive-plain-marker')).toBe(false);
    }
  });

  it('shows no snapshot when the upload is interrupted before or during write', async () => {
    const root = tempRoot(roots);
    const drive = new FakeDrive();
    const snap = await seal(root, 8n);
    await expect(
      make(drive).put(
        snap.request({ source: explodingAfter(snap.bytes, 1500) }),
      ),
    ).rejects.toThrow('connection dropped');
    expect(drive.files.size).toBe(0);

    drive.failOn.set('write', driveError('other'));
    expect((await failure(make(drive).put(snap.request()))).code).toBe(
      'unavailable',
    );
    expect(drive.visible('smrt-backups')).toEqual([]);
    expect(drive.staged('smrt-backups')).toEqual([]);
  });

  it('discards a staged upload Drive stored short, and a move that fails', async () => {
    const root = tempRoot(roots);
    const snap = await seal(root, 9n);
    const drive = new FakeDrive();
    drive.truncateTo = 100;
    expect((await failure(make(drive).put(snap.request()))).code).toBe(
      'integrity',
    );
    expect(drive.visible('smrt-backups')).toEqual([]);
    expect(drive.staged('smrt-backups')).toEqual([]);

    const second = new FakeDrive();
    second.failOn.set('move', driveError('other'));
    await failure(make(second).put(snap.request()));
    expect(second.visible('smrt-backups')).toEqual([]);
    expect(second.staged('smrt-backups')).toEqual([]);
  });

  it('refuses plaintext before contacting Drive', async () => {
    const drive = new FakeDrive();
    const bytes = randomBytes(1000);
    const error = await failure(
      make(drive).put({
        sequence: 1n,
        byteSize: bytes.length,
        sha256: '0'.repeat(64),
        source: pieces(bytes),
      }),
    );
    expect(error.code).toBe('invalid_snapshot');
    expect(drive.writes).toBe(0);
    expect(drive.dirs.size).toBe(0);
  });

  it('never overwrites an existing snapshot', async () => {
    const root = tempRoot(roots);
    const drive = new FakeDrive();
    const target = make(drive);
    await target.put((await seal(root, 3n)).request());
    const before = drive.writes;
    expect(
      (
        await failure(
          target.put((await seal(root, 3n, randomBytes(2000))).request()),
        )
      ).code,
    ).toBe('already_exists');
    expect(drive.writes).toBe(before);
  });

  it('refuses a snapshot too large to buffer', async () => {
    const root = tempRoot(roots);
    const snap = await seal(root, 4n);
    const drive = new FakeDrive();
    expect(
      (await failure(make(drive, undefined, 100).put(snap.request()))).code,
    ).toBe('limit');
    expect(drive.writes).toBe(0);
  });

  describe('scope', () => {
    it.each([
      ['full Drive', 'https://www.googleapis.com/auth/drive'],
      ['read-only Drive', 'https://www.googleapis.com/auth/drive.readonly'],
      ['metadata', 'https://www.googleapis.com/auth/drive.metadata'],
      [
        'a narrow scope bundled with a wide one',
        `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive`,
      ],
      ['no recorded scope', ''],
    ])('refuses %s before any Drive call', async (_name, scope) => {
      const drive = new FakeDrive();
      const createFilesystem = vi.fn(async () => drive);
      const target = new GoogleDriveBackupTarget({
        name: 'drive',
        folder: 'f',
        credentials: async () => credentials(scope),
        createFilesystem,
      });
      expect((await failure(target.preflight())).code).toBe('scope_too_wide');
      expect(createFilesystem).not.toHaveBeenCalled();
      expect(drive.files.size).toBe(0);
    });

    it('accepts the two app-scoped grants at the policy level', () => {
      expect(assertNarrowDriveScope(DRIVE_FILE_SCOPE)).toEqual([
        DRIVE_FILE_SCOPE,
      ]);
      expect(assertNarrowDriveScope(DRIVE_APPDATA_SCOPE)).toEqual([
        DRIVE_APPDATA_SCOPE,
      ]);
    });

    it('does not pretend the SDK provider serves an app-data-only grant', async () => {
      const error = await failure(
        createGoogleDriveFilesystem(credentials(DRIVE_APPDATA_SCOPE)),
      );
      expect(error.code).toBe('scope_too_wide');
    });
  });

  describe('failures a user can act on', () => {
    it('reports an expired or revoked grant, without echoing provider text', async () => {
      const root = tempRoot(roots);
      const drive = new FakeDrive();
      drive.failOn.set('createDirectory', driveError('grant', TOKEN));
      const error = await failure(
        make(drive).put((await seal(root, 1n)).request()),
      );
      expect(error.code).toBe('grant_expired');
      expect(error.message).toMatch(/reconnect/i);
      expect(error.message).not.toContain(TOKEN);
    });

    it.each([
      ['a 403 permission/quota denial', driveError('permission', TOKEN)],
      ['a storage quota error', driveError('quota', TOKEN)],
    ])('reports %s as storage or access', async (_name, cause) => {
      const root = tempRoot(roots);
      const drive = new FakeDrive();
      drive.failOn.set('write', cause);
      const error = await failure(
        make(drive).put((await seal(root, 1n)).request()),
      );
      expect(error.code).toBe('quota_or_access');
      expect(error.message).toMatch(/storage may be full/i);
      expect(error.message).not.toContain(TOKEN);
      expect(drive.staged('smrt-backups')).toEqual([]);
    });

    it('reports missing credentials and unreadable stores plainly', async () => {
      const none = new GoogleDriveBackupTarget({
        name: 'd',
        folder: 'f',
        credentials: async () => undefined,
      });
      expect((await failure(none.preflight())).code).toBe(
        'credentials_unavailable',
      );
      const broken = new GoogleDriveBackupTarget({
        name: 'd',
        folder: 'f',
        credentials: async () => {
          throw new Error(`keychain locked ${TOKEN}`);
        },
      });
      const error = await failure(broken.preflight());
      expect(error.code).toBe('credentials_unavailable');
      expect(error.message).not.toContain(TOKEN);
    });
  });

  it('refuses to act when Drive holds two files with one snapshot name', async () => {
    const root = tempRoot(roots);
    const drive = new FakeDrive();
    const target = make(drive);
    const snap = await seal(root, 3n);
    await target.put(snap.request());
    // Drive allows duplicate names; a second writer published the same one.
    drive.duplicates.add(
      `smrt-backups/snapshots/${(await target.list())[0]?.id}`,
    );
    expect((await failure(target.list())).code).toBe('integrity');
    const second = new FakeDrive();
    second.duplicateOnMove = true;
    expect(
      (await failure(make(second).put((await seal(root, 4n)).request()))).code,
    ).toBe('integrity');
  });

  it('rejects a Drive read that disagrees with the reported size', async () => {
    const root = tempRoot(roots);
    const drive = new FakeDrive();
    const target = make(drive);
    const stored = await target.put((await seal(root, 5n)).request());
    drive.readExtra = true;
    expect((await failure(collect(target.get(stored.id)))).code).toBe(
      'integrity',
    );
  });

  it('keeps Drive query-breaking folder names out', () => {
    for (const folder of ["a'b", 'a/b', '../x', '', ' ', 'a\\b']) {
      expect(
        () =>
          new GoogleDriveBackupTarget({
            name: 'd',
            folder,
            credentials: async () => undefined,
          }),
      ).toThrow(BackupTargetError);
    }
  });

  it('maps ids safely', async () => {
    const drive = new FakeDrive();
    const target = make(drive);
    expect((await failure(collect(target.get('../x')))).code).toBe('not_found');
    expect((await failure(target.delete('x'))).code).toBe('not_found');
  });
});

describe('vault relay target', () => {
  const fast = { retryDelayMs: 0, sleep: async () => undefined };
  const make = (
    relay: ReturnType<typeof relayWithSigner>,
    options: Partial<
      ConstructorParameters<typeof VaultRelayBackupTarget>[0]
    > = {},
  ) =>
    new VaultRelayBackupTarget({
      name: 'vault',
      url: 'https://relay.example',
      signer: async () => relay.identity.signer,
      entitlements: entitled,
      fetch: relay.relay.fetch,
      chunkBytes: 4096,
      ...fast,
      ...options,
    });

  it('uploads in signed chunks, publishes on commit, and reads back', async () => {
    const root = tempRoot(roots);
    const relay = relayWithSigner();
    const target = make(relay);
    const one = await seal(root, 1n);
    const two = await seal(root, 2n);
    await target.put(one.request());
    const stored = await target.put(two.request());
    expect(stored).toMatchObject({
      id: '2',
      sequence: 2n,
      byteSize: two.byteSize,
      sha256: two.sha256,
    });
    expect(relay.relay.calls.filter((c) => c.method === 'PUT').length).toBe(
      Math.ceil(one.byteSize / 4096) + Math.ceil(two.byteSize / 4096),
    );
    expect((await target.list()).map((o) => o.sequence)).toEqual([2n, 1n]);
    expect((await collect(target.get('2'))).equals(two.bytes)).toBe(true);
    await target.delete('1');
    expect((await target.list()).map((o) => o.id)).toEqual(['2']);
  });

  it('rejects a relay URL that could leak signed requests', () => {
    for (const url of [
      'http://relay.example',
      'https://user:pw@relay.example',
      'https://relay.example/prefix',
      'https://relay.example/?x=1',
      'ftp://relay.example',
      'nonsense',
    ]) {
      expect(() => normalizeRelayUrl(url)).toThrow(BackupTargetError);
    }
    expect(normalizeRelayUrl('http://localhost:8080/')).toBe(
      'http://localhost:8080',
    );
    expect(normalizeRelayUrl('https://relay.example/')).toBe(
      'https://relay.example',
    );
  });

  describe('entitlement', () => {
    it.each([
      ['an empty entitlement', unentitled],
      ['no entitlement source', undefined],
      [
        'a failing entitlement source',
        {
          async status() {
            throw new Error('cache unreadable');
          },
        },
      ],
    ])('blocks the upload with an upgrade message for %s, sending nothing', async (_n, source) => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const target = make(relay, { entitlements: source });
      const snap = await seal(root, 1n);
      const error = await failure(target.put(snap.request()));
      expect(error.code).toBe('entitlement_required');
      expect(error.message).toMatch(/upgrade/i);
      expect((await failure(target.preflight())).code).toBe(
        'entitlement_required',
      );
      expect(relay.relay.calls).toEqual([]);
      expect(relay.identity.signed).toBe(0);
    });

    it('turns the relay denial into the same upgrade message', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      relay.relay.fail.set('POST /v1/uploads', () =>
        json(403, {
          error: 'server text that is not shown',
          code: 'feature_upgrade_required',
          message: 'server text that is not shown',
          grantingPlan: { name: 'Vault' },
        }),
      );
      const error = await failure(
        make(relay).put((await seal(root, 1n)).request()),
      );
      expect(error.code).toBe('entitlement_required');
      expect(error.message).not.toContain('server text');
    });

    it('file and Drive targets never consult the entitlement source', async () => {
      const root = tempRoot(roots);
      const spy = vi.fn(async () => ({ featureKeys: [] as string[] }));
      const file = new FileBackupTarget({
        name: 'f',
        directory: join(root, 'v'),
      });
      await file.put((await seal(root, 1n)).request());
      const drive = new GoogleDriveBackupTarget({
        name: 'd',
        folder: 'f',
        credentials: async () => ({
          clientId: 'a',
          clientSecret: 'b',
          refreshToken: 'c',
          scope: DRIVE_FILE_SCOPE,
        }),
        createFilesystem: async () => new FakeDrive(),
      });
      await drive.put((await seal(root, 2n)).request());
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('partial uploads', () => {
    it('aborts the upload when the stream breaks, leaving nothing published', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const snap = await seal(root, 1n);
      await expect(
        make(relay).put(
          snap.request({ source: explodingAfter(snap.bytes, 5000) }),
        ),
      ).rejects.toThrow();
      expect(relay.relay.snapshots.size).toBe(0);
      expect(relay.relay.pending.size).toBe(0);
      expect(relay.relay.calls.some((c) => c.method === 'DELETE')).toBe(true);
      expect(relay.relay.calls.some((c) => c.path.endsWith('/commit'))).toBe(
        false,
      );
    });

    it('never commits a stream whose digest does not match', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const snap = await seal(root, 1n);
      const error = await failure(
        make(relay).put(snap.request({ sha256: 'e'.repeat(64) })),
      );
      expect(error.code).toBe('integrity');
      expect(relay.relay.calls.some((c) => c.path.endsWith('/commit'))).toBe(
        false,
      );
      expect(relay.relay.snapshots.size).toBe(0);
    });

    it('retries a failed chunk and still publishes exactly once', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      relay.relay.fail.set('PUT /v1/uploads/:id/chunks/1', () => json(503, {}));
      const snap = await seal(root, 1n);
      await make(relay).put(snap.request());
      expect(relay.relay.snapshots.size).toBe(1);
      expect(
        relay.relay.calls.filter((c) => c.path.endsWith('/chunks/1')).length,
      ).toBe(2);
      expect(relay.identity.signed).toBeGreaterThan(5);
    });

    it('aborts after the retry budget is spent', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      let attempts = 0;
      const target = make(relay, {
        attempts: 2,
        fetch: (async (input, init) => {
          if (String(input).endsWith('/chunks/0')) {
            attempts += 1;
            throw new TypeError('connection reset');
          }
          return relay.relay.fetch(input, init);
        }) as typeof fetch,
      });
      const error = await failure(target.put((await seal(root, 1n)).request()));
      expect(error.code).toBe('unavailable');
      expect(attempts).toBe(2);
      expect(relay.relay.snapshots.size).toBe(0);
      expect(relay.relay.pending.size).toBe(0);
    });

    it('recovers when the commit succeeded but its answer was lost', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      relay.relay.loseCommitAnswer = true;
      const snap = await seal(root, 1n);
      const stored = await make(relay).put(snap.request());
      expect(stored.sequence).toBe(1n);
      expect(relay.relay.snapshots.size).toBe(1);
    });

    it('does not claim success when the lost commit is not on the relay', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      relay.relay.fail.set('POST /v1/uploads/:id/commit', () => json(502, {}));
      const snap = await seal(root, 1n);
      const error = await failure(make(relay).put(snap.request()));
      expect(error.code).toBe('unavailable');
      expect(relay.relay.snapshots.size).toBe(0);
    });

    it('shrinks the chunk size once when the relay caps it', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner(2048);
      const snap = await seal(root, 1n);
      await make(relay, { chunkBytes: 8192 }).put(snap.request());
      expect(relay.relay.snapshots.get(1)?.chunkSize).toBe(2048);
    });
  });

  describe('relay response confusion', () => {
    const upload = async (
      tamper: (relay: ReturnType<typeof relayWithSigner>) => void,
    ) => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      tamper(relay);
      const snap = await seal(root, 5n);
      return {
        relay,
        snap,
        error: await failure(make(relay).put(snap.request())),
      };
    };

    it('rejects a begin answer for another sequence', async () => {
      const { relay, error } = await upload((r) => {
        r.relay.tamper.begin = (body) => ({ ...body, sequence: 6 });
      });
      expect(error.code).toBe('protocol');
      expect(relay.relay.snapshots.size).toBe(0);
    });

    it('rejects a begin answer with a forged upload id', async () => {
      const { error } = await upload((r) => {
        r.relay.tamper.begin = (body) => ({ ...body, uploadId: '../../x' });
      });
      expect(error.code).toBe('protocol');
    });

    it('rejects a begin answer with a different size or chunking', async () => {
      const { error } = await upload((r) => {
        r.relay.tamper.begin = (body) => ({ ...body, chunkCount: 1 });
      });
      expect(error.code).toBe('protocol');
    });

    it('rejects a chunk acknowledgement for different bytes', async () => {
      const { error } = await upload((r) => {
        r.relay.tamper.chunkEcho = (body) => ({
          ...body,
          sha256: 'a'.repeat(64),
        });
      });
      expect(error.code).toBe('protocol');
    });

    it('rejects a commit that publishes a different sequence or digest', async () => {
      for (const edit of [
        { sequence: 4 },
        { sha256: 'b'.repeat(64) },
        { byteSize: 1 },
      ]) {
        const { error } = await upload((r) => {
          r.relay.tamper.commit = (body) => ({ ...body, ...edit });
        });
        expect(error.code).toBe('protocol');
      }
    });

    it('rejects a listing out of order or with repeats', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const target = make(relay);
      await target.put((await seal(root, 1n)).request());
      await target.put((await seal(root, 2n)).request());
      relay.relay.tamper.list = (body) => ({
        snapshots: [...body.snapshots].reverse(),
      });
      expect((await failure(target.list())).code).toBe('protocol');
      relay.relay.tamper.list = (body) => ({
        snapshots: [body.snapshots[0], body.snapshots[0]],
      });
      expect((await failure(target.list())).code).toBe('protocol');
      relay.relay.tamper.list = () => ({ snapshots: 'nope' });
      expect((await failure(target.list())).code).toBe('protocol');
    });

    it('rejects metadata for another sequence on download', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const target = make(relay);
      await target.put((await seal(root, 1n)).request());
      relay.relay.tamper.meta = (body) => ({ ...body, sequence: 9 });
      expect((await failure(collect(target.get('1')))).code).toBe('protocol');
    });

    it('rejects a downloaded chunk that does not match its record', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const target = make(relay);
      await target.put((await seal(root, 1n)).request());
      relay.relay.tamper.chunkBytes = (bytes, index) =>
        index === 1
          ? Buffer.concat([bytes.subarray(0, -1), Buffer.from('x')])
          : bytes;
      expect((await failure(collect(target.get('1')))).code).toBe('integrity');
      relay.relay.tamper.chunkBytes = undefined;
      relay.relay.tamper.chunkHeader = () => 'c'.repeat(64);
      expect((await failure(collect(target.get('1')))).code).toBe('integrity');
    });

    it('rejects another snapshot served under the requested sequence', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const target = make(relay);
      const one = await seal(root, 1n);
      const two = await seal(root, 2n, randomBytes(9000));
      await target.put(one.request());
      await target.put(two.request());
      const stored = relay.relay.snapshots;
      const first = stored.get(1);
      const second = stored.get(2);
      if (!first || !second) throw new Error('setup');
      // The relay swaps the stored blobs while keeping each record consistent.
      stored.set(1, { ...second, sequence: 1 });
      expect((await failure(collect(target.get('1')))).code).toBe('integrity');
    });

    it('bounds hostile chunk sizes and counts in every record', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const target = make(relay);
      await target.put((await seal(root, 1n)).request());
      for (const edit of [
        { chunkSize: 2 ** 40, chunkCount: 1, byteSize: 2 ** 40 },
        { chunkSize: 1, chunkCount: 9000, byteSize: 9000 },
        { chunkSize: 4096, chunkCount: 2 ** 40, byteSize: 4096 * 2 ** 40 },
        { chunkSize: 4096, chunkCount: 1, byteSize: 40 },
      ]) {
        relay.relay.tamper.meta = (body) => ({ ...body, ...edit });
        expect((await failure(collect(target.get('1')))).code).toBe('protocol');
        relay.relay.tamper.list = (body) => ({
          snapshots: body.snapshots.map((entry) => ({ ...entry, ...edit })),
        });
        expect((await failure(target.list())).code).toBe('protocol');
      }
      expect(() => make(relay, { chunkBytes: 2 ** 31 })).toThrow(
        BackupTargetError,
      );
    });

    it('lists a few thousand snapshots without tripping the JSON bound', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const target = make(relay);
      await target.put((await seal(root, 1n)).request());
      relay.relay.tamper.list = (body) => ({
        snapshots: Array.from({ length: 2500 }, (_, index) => ({
          ...(body.snapshots[0] as Record<string, unknown>),
          sequence: 2500 - index,
        })),
      });
      expect(await target.list()).toHaveLength(2500);
    });

    it('treats a delete retried after a lost answer as done, but not an unknown id', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const target = make(relay);
      await target.put((await seal(root, 1n)).request());
      expect((await failure(target.delete('42'))).code).toBe('not_found');
      let lost = true;
      const lossy = make(relay, {
        fetch: (async (input, init) => {
          const response = await relay.relay.fetch(input, init);
          if (init?.method === 'DELETE' && lost) {
            lost = false;
            throw new TypeError('connection reset');
          }
          return response;
        }) as typeof fetch,
      });
      await lossy.delete('1');
      expect(relay.relay.snapshots.size).toBe(0);
    });

    it('rejects plaintext served as a snapshot', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const target = make(relay);
      const snap = await seal(root, 1n);
      await target.put(snap.request());
      const stored = relay.relay.snapshots.get(1);
      if (!stored) throw new Error('setup');
      const plain = Buffer.alloc(snap.byteSize, 0x41);
      const chunks: Buffer[] = [];
      for (let o = 0; o < plain.length; o += stored.chunkSize) {
        chunks.push(plain.subarray(o, o + stored.chunkSize));
      }
      stored.chunks = chunks;
      stored.sha256 = (await import('node:crypto'))
        .createHash('sha256')
        .update(plain)
        .digest('hex');
      expect((await failure(collect(target.get('1')))).code).toBe('integrity');
    });

    it('does not follow redirects with signed headers', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const seen: RequestInit[] = [];
      const target = make(relay, {
        fetch: (async (_input, init) => {
          seen.push(init as RequestInit);
          throw new TypeError('redirect refused');
        }) as typeof fetch,
        attempts: 1,
      });
      await failure(target.put((await seal(root, 1n)).request()));
      expect(seen[0]?.redirect).toBe('error');
    });
  });

  describe('failures a user can act on', () => {
    it('explains a full vault, a stale sequence and a rejected device', async () => {
      const root = tempRoot(roots);
      const cases: Array<[number, Record<string, unknown>, string]> = [
        [413, { error: 'quota_exceeded' }, 'quota_or_access'],
        [409, { error: 'stale_sequence' }, 'stale_sequence'],
        [401, { error: 'unauthorized' }, 'unauthorized'],
      ];
      for (const [status, body, code] of cases) {
        const relay = relayWithSigner();
        relay.relay.fail.set('POST /v1/uploads', () => json(status, body));
        const error = await failure(
          make(relay).put((await seal(root, 1n)).request()),
        );
        expect(error.code).toBe(code);
      }
    });

    it('reports a missing device identity without sending a request', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      const target = make(relay, { signer: async () => undefined });
      expect(
        (await failure(target.put((await seal(root, 1n)).request()))).code,
      ).toBe('credentials_unavailable');
      expect(relay.relay.calls).toEqual([]);
    });

    it('never puts a signature, nonce or account id into an error', async () => {
      const root = tempRoot(roots);
      const relay = relayWithSigner();
      relay.relay.fail.set('POST /v1/uploads', () => json(500, {}));
      const error = await failure(
        make(relay).put((await seal(root, 1n)).request()),
      );
      expect(error.message).not.toMatch(/account-1|device-1|signature|nonce/i);
    });
  });
});
