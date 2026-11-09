/**
 * Encrypted snapshot framing (#4797): round trips plus one test per threat in
 * the issue's security review (truncation, reordering, duplication,
 * cross-snapshot splicing, wrong context, generation downgrade, key and
 * plaintext hygiene, hostile headers, fail-closed restore).
 */

import { hkdfSync, randomBytes } from 'node:crypto';
import {
  lstatSync,
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
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVaultSnapshot } from '@happyvertical/encryption/vault-snapshot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planDataRootArchive } from '../snapshot-archive.js';
import {
  decryptSnapshot,
  deriveSnapshotSubkey,
  EncryptedSnapshotError,
  MIN_SNAPSHOT_CHUNK_BYTES,
  parseSnapshotHeader,
  readSnapshotHeader,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_SUBKEY_INFO,
  type SnapshotContext,
  type SnapshotKeyProvider,
  type SnapshotKind,
  verifySnapshot,
  writeEncryptedSnapshot,
} from '../snapshot-framing.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workspace(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'smrt-snapshot-')),
  );
  roots.push(root);
  return root;
}

interface TestKeyring extends SnapshotKeyProvider {
  context: SnapshotContext;
  keys: Map<bigint, { keyId: string; key: Buffer }>;
  issued: Uint8Array[];
  rotate(): void;
  current: bigint;
}

function keyring(
  accountId = 'account-1',
  deviceId = 'device-1',
  sequence = 7n,
): TestKeyring {
  const ring: TestKeyring = {
    context: { accountId, deviceId, sequence },
    keys: new Map(),
    issued: [],
    current: 0n,
    rotate() {
      ring.current += 1n;
      ring.keys.set(ring.current, {
        keyId: randomBytes(16).toString('hex'),
        key: randomBytes(32),
      });
    },
    async sealingKey() {
      const { keyId, key } = ring.keys.get(ring.current) as {
        keyId: string;
        key: Buffer;
      };
      const copy = new Uint8Array(key);
      ring.issued.push(copy);
      return {
        ...ring.context,
        generation: ring.current,
        keyId,
        key: copy,
      };
    },
    async openingKey({ accountId: account, generation, keyId }) {
      const entry = ring.keys.get(generation);
      if (account !== ring.context.accountId || entry?.keyId !== keyId) {
        return undefined;
      }
      const copy = new Uint8Array(entry.key);
      ring.issued.push(copy);
      return copy;
    },
  };
  ring.rotate();
  return ring;
}

async function sealBytes(
  ring: TestKeyring,
  destination: string,
  plaintext: Buffer,
  kind: SnapshotKind = 'export-bundle',
) {
  return writeEncryptedSnapshot({
    destination,
    kind,
    totalLength: plaintext.length,
    // Odd-sized pieces exercise chunk boundaries that do not align.
    source: (function* () {
      for (let offset = 0; offset < plaintext.length; offset += 1000) {
        yield plaintext.subarray(offset, offset + 1000);
      }
    })(),
    sealing: await ring.sealingKey(),
    chunkSize: MIN_SNAPSHOT_CHUNK_BYTES,
  });
}

/** Clear header length: the fixed part plus the producing device ID. */
function headerLength(file: Buffer): number {
  return SNAPSHOT_HEADER_BYTES + file.readUInt16BE(6);
}

/** [start, end) byte ranges of each length-prefixed record. */
function records(file: Buffer): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let position = headerLength(file);
  while (position < file.length) {
    const end = position + 4 + file.readUInt32BE(position);
    ranges.push([position, end]);
    position = end;
  }
  return ranges;
}

function leftovers(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.startsWith('.'));
}

async function expectRestoreFails(
  ring: TestKeyring,
  source: string,
  message: RegExp,
  overrides: Partial<Parameters<typeof decryptSnapshot>[0]> = {},
) {
  const destination = join(
    source,
    '..',
    `restore-${randomBytes(4).toString('hex')}`,
  );
  await expect(
    decryptSnapshot({
      source,
      destination,
      context: ring.context,
      keys: ring,
      ...overrides,
    }),
  ).rejects.toThrow(message);
  expect(() => lstatSync(destination)).toThrow();
  expect(leftovers(join(source, '..'))).toEqual([]);
}

describe('encrypted snapshot framing', () => {
  it('round-trips a multi-chunk export bundle through an owner-only file', async () => {
    const root = workspace();
    const ring = keyring();
    const plaintext = randomBytes(MIN_SNAPSHOT_CHUNK_BYTES * 4 + 123);
    const source = join(root, 'out', 'bundle.hvsnap');
    const written = await sealBytes(ring, source, plaintext);
    expect(written).toMatchObject({
      format: 'hvsf-v1',
      kind: 'export-bundle',
      generation: '1',
      sequence: '7',
      chunkCount: 5,
      totalLength: plaintext.length,
    });
    expect(statSync(source).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'out')).mode & 0o777).toBe(0o700);
    expect(leftovers(join(root, 'out'))).toEqual([]);

    const verified = await verifySnapshot({
      source,
      context: ring.context,
      keys: ring,
    });
    expect(verified).toEqual(written);
    const destination = join(root, 'restored', 'bundle.json');
    const restored = await decryptSnapshot({
      source,
      destination,
      context: ring.context,
      keys: ring,
      expectedKind: 'export-bundle',
    });
    expect(restored.digest).toBe(written.digest);
    expect(readFileSync(destination).equals(plaintext)).toBe(true);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(leftovers(join(root, 'restored'))).toEqual([]);
  });

  it('round-trips a data-root archive into a new private candidate directory', async () => {
    const root = workspace();
    const ring = keyring();
    const data = join(root, 'data');
    mkdirSync(join(data, 'assets', 'nested'), { recursive: true });
    writeFileSync(join(data, 'app.sqlite'), randomBytes(20_000));
    writeFileSync(join(data, 'assets', 'nested', 'a.bin'), randomBytes(9_000));
    writeFileSync(join(data, 'assets', 'empty'), '');
    const archive = planDataRootArchive(data);
    const source = join(root, 'backup.hvsnap');
    await writeEncryptedSnapshot({
      destination: source,
      kind: 'data-root',
      totalLength: archive.totalLength,
      source: archive.chunks(),
      sealing: await ring.sealingKey(),
      chunkSize: MIN_SNAPSHOT_CHUNK_BYTES,
    });

    const candidate = join(root, 'candidate');
    await decryptSnapshot({
      source,
      destination: candidate,
      context: ring.context,
      keys: ring,
    });
    expect(statSync(candidate).mode & 0o777).toBe(0o700);
    for (const path of ['app.sqlite', 'assets/nested/a.bin', 'assets/empty']) {
      expect(readFileSync(join(candidate, path))).toEqual(
        readFileSync(join(data, path)),
      );
      expect(statSync(join(candidate, path)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(join(candidate, 'assets')).mode & 0o777).toBe(0o700);
  });

  it('refuses symbolic links in a data root instead of following them', () => {
    const root = workspace();
    const data = join(root, 'data');
    mkdirSync(data);
    symlinkSync('/etc/passwd', join(data, 'link'));
    expect(() => planDataRootArchive(data)).toThrow(
      'Encrypted backup refuses a symbolic link or special file: link',
    );
  });

  it('refuses a data-root name restore would reject, before writing anything', () => {
    const root = workspace();
    const data = join(root, 'data');
    mkdirSync(data);
    writeFileSync(join(data, 'back\\slash'), 'x');
    expect(() => planDataRootArchive(data)).toThrow(
      'Data root path cannot be stored in an encrypted snapshot: back\\slash',
    );
  });

  it('completes short writes on both sides instead of publishing a truncated file', async () => {
    const root = workspace();
    const ring = keyring();
    const probe = await open(join(root, 'probe'), 'w');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const original = prototype.write;
    const spy = vi.spyOn(prototype, 'write').mockImplementation(function (
      this: unknown,
      buffer: Uint8Array,
      offset = 0,
      length = buffer.length - offset,
    ) {
      return original.call(this, buffer, offset, Math.min(length, 999));
    } as never);
    try {
      const plaintext = randomBytes(MIN_SNAPSHOT_CHUNK_BYTES * 2 + 5);
      const source = join(root, 'short.hvsnap');
      await sealBytes(ring, source, plaintext);
      const destination = join(root, 'short.bin');
      await decryptSnapshot({
        source,
        destination,
        context: ring.context,
        keys: ring,
      });
      expect(readFileSync(destination).equals(plaintext)).toBe(true);
      expect(spy.mock.calls.length).toBeGreaterThan(10);
    } finally {
      spy.mockRestore();
    }
  });

  describe('threats', () => {
    async function fixture() {
      const root = workspace();
      const ring = keyring();
      const plaintext = randomBytes(MIN_SNAPSHOT_CHUNK_BYTES * 3);
      const source = join(root, 'snapshot.hvsnap');
      await sealBytes(ring, source, plaintext);
      return { root, ring, plaintext, source, file: readFileSync(source) };
    }

    it('detects truncation of the manifest or of a chunk', async () => {
      const { ring, source, file } = await fixture();
      const ranges = records(file);
      writeFileSync(source, file.subarray(0, ranges.at(-1)?.[0]));
      await expectRestoreFails(ring, source, /length does not match/);
      writeFileSync(source, file.subarray(0, ranges[1][1] - 10));
      await expectRestoreFails(ring, source, /length does not match/);
      // Dropping a whole chunk keeps every record well-formed.
      writeFileSync(
        source,
        Buffer.concat([
          file.subarray(0, ranges[1][0]),
          file.subarray(ranges[2][0]),
        ]),
      );
      await expectRestoreFails(ring, source, /length does not match/);
      // Rewriting the header to declare the shorter length is caught by the
      // authenticated header copy inside every record.
      const shortened = Buffer.concat([
        file.subarray(0, ranges[2][0]),
        file.subarray(...(ranges.at(-1) as [number, number])),
      ]);
      shortened.writeUInt32BE(2, 60);
      shortened.writeBigUInt64BE(BigInt(MIN_SNAPSHOT_CHUNK_BYTES * 2), 64);
      writeFileSync(source, shortened);
      await expectRestoreFails(
        ring,
        source,
        /record 0 belongs to a different snapshot/,
      );
    });

    it('seals under a purpose subkey: no envelope opens with the raw data key or another label', async () => {
      const { ring, source, file } = await fixture();
      const dataKey = ring.keys.get(1n)?.key as Buffer;
      const keyId = ring.keys.get(1n)?.keyId as string;
      const [first] = records(file);
      const envelope = file.subarray(first[0] + 4, first[1]);
      const openWith = (key: Uint8Array) =>
        openVaultSnapshot(envelope, {
          context: ring.context,
          resolveKey: (id) => (id === keyId ? key : undefined),
        });
      const derive = (info: string) =>
        new Uint8Array(hkdfSync('sha256', dataKey, Buffer.alloc(0), info, 32));

      expect(SNAPSHOT_SUBKEY_INFO).toBe('smrt-hvsf-v1');
      expect(() => openWith(new Uint8Array(dataKey))).toThrow();
      expect(() => openWith(derive('smrt-hvsf-v2'))).toThrow();
      expect(() => openWith(derive('smrt-other-purpose'))).toThrow();
      // Same info with a salt is a different key too.
      expect(() =>
        openWith(
          new Uint8Array(
            hkdfSync(
              'sha256',
              dataKey,
              Buffer.from('salt'),
              'smrt-hvsf-v1',
              32,
            ),
          ),
        ),
      ).toThrow();
      // Positive control: the derived subkey opens it, and HVSF restores.
      expect(openWith(derive('smrt-hvsf-v1')).length).toBeGreaterThan(0);
      expect(deriveSnapshotSubkey(dataKey)).toEqual(derive('smrt-hvsf-v1'));
      await expect(
        verifySnapshot({ source, context: ring.context, keys: ring }),
      ).resolves.toMatchObject({ format: 'hvsf-v1' });
    });

    it('restores on a new device from the file and the vault key alone', async () => {
      const { root, ring, plaintext, source } = await fixture();
      // A new device knows the account and holds the vault key, but neither the
      // producing device ID nor the snapshot sequence.
      const newDevice = keyring();
      newDevice.keys = ring.keys;
      newDevice.current = ring.current;
      newDevice.context = {
        accountId: ring.context.accountId,
        deviceId: 'replacement-laptop',
        sequence: 1n,
      };
      const header = await readSnapshotHeader(source);
      expect(header.deviceId).toBe('device-1');
      expect(header.sequence).toBe(7n);

      const destination = join(root, 'restored.bin');
      const restored = await decryptSnapshot({
        source,
        destination,
        context: { accountId: ring.context.accountId },
        keys: newDevice,
      });
      expect(restored).toMatchObject({ deviceId: 'device-1', sequence: '7' });
      expect(readFileSync(destination).equals(plaintext)).toBe(true);
      await expect(
        verifySnapshot({
          source,
          context: { accountId: ring.context.accountId },
          keys: newDevice,
        }),
      ).resolves.toMatchObject({ deviceId: 'device-1' });
      // Another account's key still cannot open it.
      await expectRestoreFails(ring, source, /No key is available/, {
        context: { accountId: 'account-2' },
      });
    });

    it('rejects an edited, truncated or hostile clear device ID', async () => {
      const { ring, source, file } = await fixture();
      const edit = (change: (bytes: Buffer) => void) => {
        const bytes = Buffer.from(file);
        change(bytes);
        writeFileSync(source, bytes);
      };
      const open = { context: { accountId: ring.context.accountId } };
      // Same-length rewrite: the envelope context authenticates the device.
      edit((bytes) => bytes.write('device-X', SNAPSHOT_HEADER_BYTES));
      await expectRestoreFails(ring, source, /failed authentication/, open);
      // Length edits are caught by the header copy or the exact file length.
      edit((bytes) => bytes.writeUInt16BE(7, 6));
      await expectRestoreFails(
        ring,
        source,
        /length does not match|header/,
        open,
      );
      edit((bytes) => bytes.writeUInt16BE(0, 6));
      await expectRestoreFails(
        ring,
        source,
        /device ID length is invalid/,
        open,
      );
      edit((bytes) => bytes.writeUInt16BE(256, 6));
      await expectRestoreFails(
        ring,
        source,
        /device ID length is invalid/,
        open,
      );
      edit((bytes) => bytes.writeUInt8(0xff, SNAPSHOT_HEADER_BYTES));
      await expectRestoreFails(
        ring,
        source,
        /device ID is not valid UTF-8/,
        open,
      );
      edit((bytes) => bytes.writeUInt8(0x1b, SNAPSHOT_HEADER_BYTES));
      await expectRestoreFails(ring, source, /control characters/, open);
      writeFileSync(source, file.subarray(0, SNAPSHOT_HEADER_BYTES + 3));
      await expectRestoreFails(ring, source, /truncated/, open);
    });

    it('refuses to seal with a device ID that cannot be printed safely', async () => {
      const root = workspace();
      const ring = keyring('account-1', 'bad\u001b[2Jdevice');
      await expect(
        sealBytes(ring, join(root, 'x.hvsnap'), randomBytes(10)),
      ).rejects.toThrow(/control characters/);
      expect(readdirSync(root)).toEqual([]);
    });

    it('detects reordered and duplicated chunks', async () => {
      const { ring, source, file } = await fixture();
      const [a, b] = records(file);
      const chunk = (range: [number, number]) => file.subarray(...range);
      writeFileSync(
        source,
        Buffer.concat([
          file.subarray(0, a[0]),
          chunk(b),
          chunk(a),
          file.subarray(b[1]),
        ]),
      );
      await expectRestoreFails(
        ring,
        source,
        /record 0 .*|chunk 0 is out of order/,
      );
      writeFileSync(
        source,
        Buffer.concat([
          file.subarray(0, a[0]),
          chunk(a),
          chunk(a),
          file.subarray(b[1]),
        ]),
      );
      await expectRestoreFails(ring, source, /chunk 1 is out of order/);
    });

    it('detects a chunk spliced in from another snapshot with the same key and sequence', async () => {
      const { root, ring, source, file } = await fixture();
      const other = join(root, 'other.hvsnap');
      await sealBytes(ring, other, randomBytes(MIN_SNAPSHOT_CHUNK_BYTES * 3));
      const foreign = readFileSync(other);
      const [, target] = records(file);
      const [, donor] = records(foreign);
      writeFileSync(
        source,
        Buffer.concat([
          file.subarray(0, target[0]),
          foreign.subarray(...donor),
          file.subarray(target[1]),
        ]),
      );
      await expectRestoreFails(
        ring,
        source,
        /record 1 belongs to a different snapshot/,
      );
    });

    it('rejects the wrong account, device or sequence', async () => {
      const { ring, source } = await fixture();
      await expectRestoreFails(ring, source, /device does not match/, {
        context: { ...ring.context, deviceId: 'device-2' },
      });
      await expectRestoreFails(ring, source, /No key is available/, {
        context: { ...ring.context, accountId: 'account-2' },
      });
      await expectRestoreFails(ring, source, /sequence does not match/, {
        context: { ...ring.context, sequence: 8n },
      });
    });

    it('rejects an edited clear header, including a generation downgrade', async () => {
      const { ring, source, file } = await fixture();
      // Rewriting the clear sequence to match a forged expectation still
      // fails: the envelope context and header copy are authenticated.
      const sequence = Buffer.from(file);
      sequence.writeBigUInt64BE(8n, 16);
      writeFileSync(source, sequence);
      await expectRestoreFails(ring, source, /failed authentication/, {
        context: { ...ring.context, sequence: 8n },
      });

      // Seal under generation 2, then relabel the header as generation 1
      // with generation 1's key ID: the key no longer authenticates.
      ring.rotate();
      const rotated = join(source, '..', 'rotated.hvsnap');
      await sealBytes(ring, rotated, randomBytes(MIN_SNAPSHOT_CHUNK_BYTES));
      const downgraded = readFileSync(rotated);
      downgraded.writeBigUInt64BE(1n, 8);
      Buffer.from(ring.keys.get(1n)?.keyId as string, 'hex').copy(
        downgraded,
        24,
      );
      writeFileSync(rotated, downgraded);
      await expectRestoreFails(ring, rotated, /uses a different key/);

      // Policy floor: an authentic older generation is refused when asked.
      writeFileSync(source, file);
      await expectRestoreFails(ring, source, /older than allowed/, {
        minimumGeneration: 2n,
      });
    });

    it('keeps an older generation readable after rotation', async () => {
      const { root, ring, source, plaintext } = await fixture();
      ring.rotate();
      const destination = join(root, 'old.bin');
      const restored = await decryptSnapshot({
        source,
        destination,
        context: ring.context,
        keys: ring,
      });
      expect(restored.generation).toBe('1');
      expect(readFileSync(destination).equals(plaintext)).toBe(true);
    });

    it('fails closed on a corrupted last chunk and leaves no partial restore', async () => {
      const root = workspace();
      const ring = keyring();
      const data = join(root, 'data');
      mkdirSync(data);
      writeFileSync(join(data, 'one'), randomBytes(MIN_SNAPSHOT_CHUNK_BYTES));
      writeFileSync(join(data, 'two'), randomBytes(MIN_SNAPSHOT_CHUNK_BYTES));
      const archive = planDataRootArchive(data);
      const source = join(root, 'backup.hvsnap');
      await writeEncryptedSnapshot({
        destination: source,
        kind: 'data-root',
        totalLength: archive.totalLength,
        source: archive.chunks(),
        sealing: await ring.sealingKey(),
        chunkSize: MIN_SNAPSHOT_CHUNK_BYTES,
      });
      const file = readFileSync(source);
      const ranges = records(file);
      const corrupt = Buffer.from(file);
      corrupt[(ranges.at(-2) as [number, number])[1] - 1] ^= 0x01;
      writeFileSync(source, corrupt);
      // Earlier chunks were already extracted when the last one failed.
      await expectRestoreFails(
        ring,
        source,
        /record \d+ failed authentication/,
      );
      expect(readdirSync(root).sort()).toEqual(['backup.hvsnap', 'data']);
    });

    it('bounds a hostile header and record length before allocating', async () => {
      const { ring, source, file } = await fixture();
      const hostile = (edit: (bytes: Buffer) => void) => {
        const bytes = Buffer.from(file);
        edit(bytes);
        writeFileSync(source, bytes);
      };
      hostile((bytes) => bytes.writeBigUInt64BE(1n << 50n, 64));
      await expectRestoreFails(ring, source, /exceeds the supported size/);
      hostile((bytes) => bytes.writeUInt32BE(0xffff_ffff, 56));
      await expectRestoreFails(ring, source, /chunk size is out of range/);
      hostile((bytes) => bytes.writeUInt32BE(99, 60));
      await expectRestoreFails(ring, source, /chunk count does not match/);
      hostile((bytes) => {
        bytes[5] = 9;
      });
      await expectRestoreFails(
        ring,
        source,
        /Unsupported encrypted snapshot kind/,
      );
      // A record claiming 4 GiB is rejected by its exact expected length;
      // the trailing padding keeps the file size plausible.
      hostile((bytes) => bytes.writeUInt32BE(0xffff_ffff, headerLength(bytes)));
      await expectRestoreFails(ring, source, /record 0 has an invalid length/);
      writeFileSync(source, Buffer.concat([file, Buffer.of(0)]));
      await expectRestoreFails(ring, source, /length does not match/);
      expect(() => parseSnapshotHeader(Buffer.alloc(10))).toThrow(
        EncryptedSnapshotError,
      );
    });

    it('rejects unsafe archive paths without writing outside the candidate', async () => {
      const root = workspace();
      const ring = keyring();
      const path = Buffer.from('../escape');
      const archive = Buffer.concat([
        Buffer.from('HVSA\x01', 'latin1'),
        Buffer.of(2),
        Buffer.from([0, path.length]),
        path,
        Buffer.alloc(8),
        Buffer.of(0),
      ]);
      const source = join(root, 'evil.hvsnap');
      await sealBytes(ring, source, archive, 'data-root');
      await expectRestoreFails(ring, source, /unsafe path/);
      expect(readdirSync(root)).toEqual(['evil.hvsnap']);
    });

    it('never replaces an existing destination', async () => {
      const { root, ring, source } = await fixture();
      const existing = join(root, 'existing');
      writeFileSync(existing, 'keep');
      await expect(
        decryptSnapshot({
          source,
          destination: existing,
          context: ring.context,
          keys: ring,
        }),
      ).rejects.toThrow('Restore destination already exists');
      expect(readFileSync(existing, 'utf8')).toBe('keep');
      await expect(sealBytes(ring, source, randomBytes(10))).rejects.toThrow(
        'Snapshot destination already exists',
      );
      expect(leftovers(root)).toEqual([]);
    });

    it('rejects a source that disagrees with its declared length and cleans up', async () => {
      const root = workspace();
      const ring = keyring();
      const destination = join(root, 'short.hvsnap');
      for (const totalLength of [5, 50]) {
        await expect(
          writeEncryptedSnapshot({
            destination,
            kind: 'export-bundle',
            totalLength,
            source: [randomBytes(10)],
            sealing: await ring.sealingKey(),
          }),
        ).rejects.toThrow(/longer|shorter/);
      }
      await expect(
        writeEncryptedSnapshot({
          destination,
          kind: 'toString' as SnapshotKind,
          totalLength: 0,
          source: [],
          sealing: await ring.sealingKey(),
        }),
      ).rejects.toThrow('Unsupported encrypted snapshot kind');
      expect(readdirSync(root)).toEqual([]);
    });

    it('keeps plaintext, the account ID and keys out of the file and errors, and zeroes key copies', async () => {
      const root = workspace();
      const ring = keyring('acct-visible-marker', 'device-visible-marker');
      const marker = Buffer.from('PLAINTEXT-MARKER-'.repeat(400));
      const source = join(root, 'snapshot.hvsnap');
      await sealBytes(ring, source, marker);
      const file = readFileSync(source);
      expect(file.includes(Buffer.from('PLAINTEXT-MARKER-'))).toBe(false);
      expect(file.includes(Buffer.from('acct-visible-marker'))).toBe(false);
      // The producing device ID is deliberately clear in the header so a new
      // device can restore from the file alone; the account ID is not.
      expect(
        file
          .subarray(SNAPSHOT_HEADER_BYTES, headerLength(file))
          .toString('utf8'),
      ).toBe('device-visible-marker');
      expect(file.includes(Buffer.from('device-visible-marker'))).toBe(true);
      const key = ring.keys.get(1n)?.key as Buffer;
      expect(file.includes(key)).toBe(false);

      const corrupt = Buffer.from(file);
      corrupt[corrupt.length - 1] ^= 0x01;
      writeFileSync(source, corrupt);
      const error = await decryptSnapshot({
        source,
        destination: join(root, 'out'),
        context: ring.context,
        keys: ring,
      }).catch((caught: Error) => caught);
      expect(String(error)).not.toContain(key.toString('hex'));
      expect(ring.issued.length).toBeGreaterThanOrEqual(2);
      for (const copy of ring.issued) {
        expect(copy.every((byte) => byte === 0)).toBe(true);
      }
    });
  });
});
