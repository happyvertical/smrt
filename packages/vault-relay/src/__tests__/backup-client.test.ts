/**
 * The CLI vault backup target (`smrt app backup --encrypted --target`, #4804)
 * against the real in-process relay: protocol compatibility, the entitlement
 * gate, publish-on-commit, quota and sequence behaviour, and the blindness
 * property end to end with real encrypted snapshots.
 */
import { createHash, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  newDevice,
  registerDevice,
  type TestDevice,
} from './helpers.js';

const KEY = Buffer.alloc(32, 5);
let h: Harness;
let device: TestDevice;
let work: string;

beforeEach(async () => {
  h = await createHarness({
    policy: {
      quota: { maxBytes: 1_000_000, maxSnapshots: 4 },
      retention: { keepLast: 3, keepWithinMs: 0 },
      limits: {
        maxChunkBytes: 4096,
        uploadTtlMs: 60_000,
        maxClockSkewMs: 30_000,
      },
    },
  });
  device = newDevice('acct-a', 'device-a1');
  await registerDevice(h, device);
  work = await mkdtemp(join(tmpdir(), 'backup-client-'));
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
  } = {},
) {
  return new VaultRelayBackupTarget({
    name: 'vault',
    url: 'https://relay.test',
    signer: async () => signerFor(options.as ?? device),
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
});
