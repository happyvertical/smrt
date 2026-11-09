/**
 * The CLI vault backup target (`smrt app backup --encrypted --target`, #4804)
 * against the real in-process relay: protocol compatibility, the entitlement
 * gate, publish-on-commit, quota and sequence behaviour, and the blindness
 * property end to end with real encrypted snapshots.
 *
 * Since #4805 every upload needs the primary-writer lease: the target acquires
 * it at the installation's recorded vault position, sends its fencing token,
 * and records the published sequence. The lease tests at the end prove that
 * path end to end, and that a publish without the lease is refused with
 * `must_restore_first`.
 */
import { createHash, randomBytes, sign } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readVaultSyncRecord,
  writeVaultSyncRecord,
} from '@happyvertical/smrt-app-runtime';
import {
  BackupTargetError,
  type VaultDeviceSigner,
  VaultRelayBackupTarget,
  writeEncryptedSnapshot,
} from '@happyvertical/smrt-cli/app';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  type Harness,
  leaseStatus,
  newDevice,
  registerDevice,
  signed,
  type TestDevice,
} from './helpers.js';

const KEY = Buffer.alloc(32, 5);
let h: Harness;
let device: TestDevice;
let work: string;
let stateRoot: string;

beforeEach(async () => {
  h = await createHarness({
    policy: {
      quota: { maxBytes: 1_000_000, maxSnapshots: 4 },
      retention: { keepLast: 3, keepWithinMs: 0 },
      limits: {
        maxChunkBytes: 4096,
        uploadTtlMs: 60_000,
        maxClockSkewMs: 30_000,
        leaseTtlMs: 30_000,
      },
    },
  });
  device = newDevice('acct-a', 'device-a1');
  await registerDevice(h, device);
  work = await mkdtemp(join(tmpdir(), 'backup-client-'));
  stateRoot = join(work, 'state');
  await mkdir(stateRoot, { mode: 0o700 });
});

afterEach(async () => {
  await h.close();
  await rm(work, { recursive: true, force: true });
});

function signerFor(test: TestDevice): VaultDeviceSigner {
  return {
    accountId: test.accountId,
    deviceId: test.deviceId,
    async sign(message) {
      return new Uint8Array(sign(null, message, test.privateKey));
    },
  };
}

function target(
  options: {
    entitled?: boolean;
    as?: TestDevice;
    fetchImpl?: typeof fetch;
    stateRoot?: string;
  } = {},
) {
  return new VaultRelayBackupTarget({
    name: 'vault',
    url: 'https://relay.test',
    signer: async () => signerFor(options.as ?? device),
    stateRoot: options.stateRoot ?? stateRoot,
    entitlements: {
      async status() {
        return {
          featureKeys: options.entitled === false ? [] : ['backup.vault'],
        };
      },
    },
    // The relay answers in process; no network, no port.
    fetch:
      options.fetchImpl ??
      ((async (input, init) =>
        h.relay.handle(
          new Request(String(input), init as RequestInit),
        )) as typeof fetch),
    chunkBytes: 4096,
    now: () => h.clock.now,
    retryDelayMs: 0,
    sleep: async () => undefined,
  });
}

async function sealed(sequence: bigint, plaintext = randomBytes(9000)) {
  const destination = join(
    work,
    `s-${sequence}-${randomBytes(3).toString('hex')}`,
  );
  await writeEncryptedSnapshot({
    destination,
    kind: 'export-bundle',
    totalLength: plaintext.length,
    source: [plaintext],
    sealing: {
      accountId: 'acct-a',
      deviceId: 'device-a1',
      sequence,
      generation: 1n,
      keyId: 'cd'.repeat(16),
      key: new Uint8Array(KEY),
    },
    chunkSize: 4096,
  });
  const bytes = await readFile(destination);
  return {
    sequence,
    plaintext,
    bytes,
    request: () => ({
      sequence,
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      source: (async function* () {
        yield bytes;
      })(),
    }),
  };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BackupTargetError) return error.code;
    throw error;
  }
  throw new Error('expected a BackupTargetError');
}

describe('vault backup target against the real relay', () => {
  it('uploads, lists, downloads and deletes through signed requests', async () => {
    const one = await sealed(1n);
    const two = await sealed(2n);
    await target().put(one.request());
    const stored = await target().put(two.request());
    expect(stored).toMatchObject({
      id: '2',
      sequence: 2n,
      byteSize: two.bytes.length,
    });

    expect((await target().list()).map((o) => o.id)).toEqual(['2', '1']);
    expect((await collect(target().get('2'))).equals(two.bytes)).toBe(true);
    await target().delete('1');
    expect((await target().list()).map((o) => o.id)).toEqual(['2']);
  });

  it('is blind end to end: the relay holds ciphertext it cannot read', async () => {
    const marker = 'blind-operator-marker';
    const snap = await sealed(1n, Buffer.from(marker.repeat(600)));
    await target().put(snap.request());
    const view = await h.relay.operatorView('acct-a');
    expect(view.snapshots).toHaveLength(1);
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else files.push(path);
      }
    };
    await walk(h.storeRoot);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      expect((await readFile(file)).includes(marker)).toBe(false);
    }
  });

  it('refuses below tier before sending, and the relay refuses an unentitled account too', async () => {
    const before = h.entitlements.calls.length;
    const snap = await sealed(1n);
    expect(await code(target({ entitled: false }).put(snap.request()))).toBe(
      'entitlement_required',
    );
    expect(h.entitlements.calls.length).toBe(before);

    // A client that skips its own check still meets the relay's gate.
    const other = newDevice('acct-free', 'device-f1');
    await registerDevice(h, other);
    expect(await code(target({ as: other }).put(snap.request()))).toBe(
      'entitlement_required',
    );
    expect((await h.relay.operatorView('acct-free')).snapshots).toHaveLength(0);
  });

  it('publishes nothing when the connection drops before commit', async () => {
    const snap = await sealed(1n);
    let chunks = 0;
    const flaky = (async (input, init) => {
      if (String(input).includes('/chunks/') && ++chunks > 1) {
        throw new TypeError('connection reset');
      }
      return h.relay.handle(new Request(String(input), init as RequestInit));
    }) as typeof fetch;
    expect(await code(target({ fetchImpl: flaky }).put(snap.request()))).toBe(
      'unavailable',
    );
    expect(await target().list()).toEqual([]);
    expect((await h.relay.operatorView('acct-a')).snapshots).toEqual([]);
    // The abandoned upload was aborted, releasing its quota.
    expect((await h.relay.operatorView('acct-a')).usage?.usedBytes ?? 0).toBe(
      0,
    );
  });

  it('reports a stale sequence and a full vault in plain terms', async () => {
    await target().put((await sealed(5n)).request());
    expect(await code(target().put((await sealed(4n)).request()))).toBe(
      'stale_sequence',
    );
    const big = await sealed(6n, randomBytes(1_200_000));
    expect(await code(target().put(big.request()))).toBe('quota_or_access');
  });

  it('rejects a device the account layer revoked', async () => {
    await h.relay.revokeDevice('acct-a', 'device-a1');
    expect(await code(target().put((await sealed(1n)).request()))).toBe(
      'unauthorized',
    );
  });

  it('shrinks to the relay chunk cap', async () => {
    const small = new VaultRelayBackupTarget({
      name: 'vault',
      url: 'https://relay.test',
      signer: async () => signerFor(device),
      stateRoot,
      entitlements: { status: async () => ({ featureKeys: ['backup.vault'] }) },
      fetch: (async (input, init) =>
        h.relay.handle(
          new Request(String(input), init as RequestInit),
        )) as typeof fetch,
      chunkBytes: 16_384,
      now: () => h.clock.now,
    });
    const snap = await sealed(1n);
    await small.put(snap.request());
    expect((await collect(small.get('1'))).equals(snap.bytes)).toBe(true);
  });

  describe('primary-writer lease end to end (#4805)', () => {
    async function second() {
      const other = newDevice('acct-a', 'device-a2');
      await registerDevice(h, other);
      const otherState = join(work, 'state-b');
      await mkdir(otherState, { mode: 0o700 });
      return { other, otherState };
    }

    it('backs up under the lease: token sent, head advanced, position recorded, lease released', async () => {
      const calls: string[] = [];
      const recording = (async (input, init) => {
        calls.push(
          `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`,
        );
        return h.relay.handle(new Request(String(input), init as RequestInit));
      }) as typeof fetch;

      await target({ fetchImpl: recording }).put((await sealed(1n)).request());

      expect(calls[0]).toBe('POST /v1/lease/acquire');
      expect(calls.indexOf('POST /v1/lease/acquire')).toBeLessThan(
        calls.indexOf('POST /v1/uploads'),
      );
      expect(calls.at(-1)).toBe('POST /v1/lease/release');
      expect(readVaultSyncRecord(stateRoot)).toMatchObject({
        accountId: 'acct-a',
        baseSequence: 1,
        highestSeenSequence: 1,
        localWritesPending: false,
      });
      // The relay's head moved with the commit and nobody holds the lease.
      expect(await leaseStatus(h, device)).toMatchObject({
        holder: null,
        headSequence: 1,
      });

      // The next backup acquires at the recorded position and advances it.
      await target().put((await sealed(2n)).request());
      expect(readVaultSyncRecord(stateRoot)?.baseSequence).toBe(2);
    });

    it('threat: a device behind the account cannot publish and is told to restore first', async () => {
      await target().put((await sealed(1n)).request());
      const { other, otherState } = await second();
      const behind = target({ as: other, stateRoot: otherState });

      const error = await behind.put((await sealed(2n)).request()).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(BackupTargetError);
      expect((error as BackupTargetError).code).toBe('must_restore_first');
      expect((error as BackupTargetError).message).toMatch(/restore-latest/);
      expect(await code(behind.preflight())).toBe('must_restore_first');
      // Nothing was published, reserved or recorded by the stale device.
      expect((await target().list()).map((o) => o.id)).toEqual(['1']);
      expect((await h.relay.operatorView('acct-a')).usage?.usedBytes).toBe(
        (await target().list())[0]?.byteSize,
      );
      expect(readVaultSyncRecord(otherState)).toBeNull();
    });

    it('threat: a writer whose lease lapsed and was taken over cannot commit', async () => {
      await target().put((await sealed(1n)).request());
      const { other, otherState } = await second();
      // The second device has restored sequence 1: its position is the head.
      writeVaultSyncRecord(otherState, {
        accountId: 'acct-a',
        baseSequence: 1,
        highestSeenSequence: 1,
        localWritesPending: false,
      });

      // After the first chunk the first device's lease lapses on the relay
      // clock and the second device takes over.
      let chunks = 0;
      const lapsing = (async (input, init) => {
        const response = await h.relay.handle(
          new Request(String(input), init as RequestInit),
        );
        if (String(input).includes('/chunks/') && ++chunks === 1) {
          h.clock.now += 40_000;
          await target({ as: other, stateRoot: otherState }).preflight();
        }
        return response;
      }) as typeof fetch;

      expect(
        await code(
          target({ fetchImpl: lapsing }).put(
            (await sealed(2n, randomBytes(12_000))).request(),
          ),
        ),
      ).toBe('lease_lost');
      // Nothing from the lapsed writer is visible, and its reservation is gone.
      expect((await target().list()).map((o) => o.id)).toEqual(['1']);
      expect(readVaultSyncRecord(stateRoot)).toMatchObject({
        baseSequence: 1,
        localWritesPending: true,
      });
    });

    it('a publish without the lease is refused by the relay itself', async () => {
      const begin = async (fencingToken?: unknown) => {
        const snap = await sealed(1n);
        const response = await h.relay.handle(
          signed(h, device, 'POST', '/v1/uploads', {
            body: JSON.stringify({
              sequence: 1,
              byteSize: snap.bytes.length,
              chunkSize: 4096,
              sha256: createHash('sha256').update(snap.bytes).digest('hex'),
              ...(fencingToken === undefined ? {} : { fencingToken }),
            }),
          }),
        );
        return { status: response.status, body: await response.json() };
      };
      // No token, a token nobody was granted, and a lease nobody holds.
      expect((await begin()).status).toBe(400);
      expect(await begin(1)).toMatchObject({
        status: 409,
        body: { error: 'must_restore_first' },
      });
      expect((await h.relay.operatorView('acct-a')).snapshots).toEqual([]);
    });
  });
});
