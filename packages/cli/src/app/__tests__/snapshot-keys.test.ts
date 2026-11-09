/**
 * The vault key lifecycle (#4785) satisfying the encrypted snapshot key seam
 * (#4797), against the real lifecycle. Threats: sealing with a stale or
 * unauthorized key, spending a sequence on a refused seal, sealing through the
 * ungated reading path, and cross-account key release.
 */

import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVaultKeyLifecycle,
  type VaultKeyLifecycle,
  VaultKeyLifecycleError,
} from '@happyvertical/smrt-app-runtime/vault-key-lifecycle';
import type { VaultKeyStore } from '@happyvertical/smrt-app-runtime/vault-key-store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decryptSnapshot,
  MIN_SNAPSHOT_CHUNK_BYTES,
  writeEncryptedSnapshot,
} from '../snapshot-framing.js';
import {
  createLifecycleSnapshotKeys,
  snapshotAccountTrustFromLifecycle,
} from '../snapshot-keys.js';

const RECOVERY_SECRET = 'synthetic recovery credential';
const ACCOUNT = 'vault-account';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workspace(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'smrt-snapshot-keys-')),
  );
  roots.push(root);
  return root;
}

function memoryStore(): VaultKeyStore {
  const items = new Map<string, Uint8Array>();
  return {
    async get(name) {
      const value = items.get(name);
      return value ? new Uint8Array(value) : null;
    },
    async set(name, value) {
      items.set(name, new Uint8Array(value));
    },
    async delete(name) {
      items.delete(name);
    },
  };
}

function device() {
  return createVaultKeyLifecycle({ store: memoryStore() });
}

async function initialized(deviceId = 'laptop') {
  const lifecycle = device();
  await lifecycle.initializeAccount({
    accountId: ACCOUNT,
    deviceId,
    recoverySecret: RECOVERY_SECRET,
  });
  return lifecycle;
}

async function enroll(enroller: VaultKeyLifecycle, deviceId: string) {
  const joiner = device();
  const { request, deviceCode } = await joiner.createEnrollmentRequest({
    accountId: ACCOUNT,
    deviceId,
  });
  const { grant, accountCode } = await enroller.enrollDevice(request, {
    confirmationCode: deviceCode,
    recoverySecret: RECOVERY_SECRET,
  });
  await joiner.acceptEnrollment(grant, { confirmationCode: accountCode });
  return joiner;
}

/** A counter standing in for the account's next unused snapshot sequence. */
function sequencer(start = 1n) {
  let next = start;
  const nextSequence = vi.fn(() => next++);
  return { nextSequence, peek: () => next };
}

async function sealWith(
  keys: ReturnType<typeof createLifecycleSnapshotKeys>,
  destination: string,
  plaintext: Buffer,
) {
  return writeEncryptedSnapshot({
    destination,
    kind: 'export-bundle',
    totalLength: plaintext.length,
    source: [plaintext],
    sealing: await keys.sealingKey(),
    chunkSize: MIN_SNAPSHOT_CHUNK_BYTES,
  });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(VaultKeyLifecycleError);
  return (error as VaultKeyLifecycleError).code;
}

describe('lifecycle snapshot key provider', () => {
  it('seals and restores a snapshot through the gated sealing path', async () => {
    const root = workspace();
    const lifecycle = await initialized();
    const { nextSequence } = sequencer(5n);
    const keys = createLifecycleSnapshotKeys({ lifecycle, nextSequence });
    const plaintext = randomBytes(MIN_SNAPSHOT_CHUNK_BYTES * 2 + 17);
    const source = join(root, 'snapshot.hvsnap');

    const written = await sealWith(keys, source, plaintext);
    expect(written).toMatchObject({ generation: '1', sequence: '5' });

    const restored = join(root, 'restored.bin');
    await decryptSnapshot({
      source,
      destination: restored,
      context: { accountId: ACCOUNT, deviceId: 'laptop', sequence: 5n },
      keys,
      expectedKind: 'export-bundle',
    });
    expect(readFileSync(restored).equals(plaintext)).toBe(true);
  });

  it('threat: a pending revocation refuses to seal and spends no sequence, while old snapshots stay readable', async () => {
    const root = workspace();
    const laptop = await initialized();
    await enroll(laptop, 'phone');
    const sequence = sequencer();
    const keys = createLifecycleSnapshotKeys({
      lifecycle: laptop,
      nextSequence: sequence.nextSequence,
    });
    const old = join(root, 'before.hvsnap');
    await sealWith(keys, old, randomBytes(2000));

    await laptop.revokeDevice('phone', { recoverySecret: RECOVERY_SECRET });
    expect((await laptop.status())?.rotationRequired).toBe(true);

    const refused = join(root, 'refused.hvsnap');
    expect(await refusal(sealWith(keys, refused, randomBytes(2000)))).toBe(
      'rotation_required',
    );
    expect(() => lstatSync(refused)).toThrow();
    // The gate runs first: the refused seal did not consume a sequence.
    expect(sequence.nextSequence).toHaveBeenCalledTimes(1);

    // Reading is deliberately ungated.
    await decryptSnapshot({
      source: old,
      destination: join(root, 'old.bin'),
      context: { accountId: ACCOUNT, deviceId: 'laptop', sequence: 1n },
      keys,
      expectedKind: 'export-bundle',
    });

    // The rotation reopens the gate with a new generation.
    await laptop.rotate({ recoverySecret: RECOVERY_SECRET });
    const rotated = await sealWith(
      keys,
      join(root, 'after.hvsnap'),
      Buffer.alloc(8),
    );
    expect(rotated).toMatchObject({ generation: '2', sequence: '2' });
  });

  it('derives the restore trust from the adopted head: revoked devices and the generation floor', async () => {
    const laptop = await initialized();
    await enroll(laptop, 'phone');
    expect(await snapshotAccountTrustFromLifecycle(laptop)).toEqual({
      minimumGeneration: 1n,
      revokedDeviceIds: [],
      rotationPending: false,
    });

    // A revocation names the device at once but it still holds the current
    // key until the rotation that excludes it: restore must wait for that.
    await laptop.revokeDevice('phone', { recoverySecret: RECOVERY_SECRET });
    expect(await snapshotAccountTrustFromLifecycle(laptop)).toMatchObject({
      revokedDeviceIds: ['phone'],
      rotationPending: true,
    });
    // The floor moves once the rotation publishes the effective generation.
    await laptop.rotate({ recoverySecret: RECOVERY_SECRET });
    const trust = await snapshotAccountTrustFromLifecycle(laptop);
    expect(trust.revokedDeviceIds).toEqual(['phone']);
    expect(trust.minimumGeneration).toBe(2n);
    expect(trust.rotationPending).toBe(false);

    await expect(snapshotAccountTrustFromLifecycle(device())).rejects.toThrow(
      'no vault account state',
    );
  });

  it('moves the host sequence counter only when the host supplies one', async () => {
    const lifecycle = await initialized();
    expect(
      createLifecycleSnapshotKeys({ lifecycle, nextSequence: () => 1n })
        .advanceSealingSequence,
    ).toBeUndefined();
    let next = 1n;
    const advance = vi.fn((above: bigint) => {
      if (next <= above) next = above + 1n;
    });
    const keys = createLifecycleSnapshotKeys({
      lifecycle,
      nextSequence: () => next++,
      advanceSequence: advance,
    });
    await keys.advanceSealingSequence?.(7n);
    expect(advance).toHaveBeenCalledWith(7n);
    const sealing = await keys.sealingKey();
    expect(sealing.sequence).toBe(8n);
    sealing.key.fill(0);
  });

  it('threat: fork evidence refuses to seal until a merge rotation', async () => {
    const root = workspace();
    const laptop = await initialized();
    const tablet = await enroll(laptop, 'tablet');
    const stale = await laptop.accountHead();
    const staleStatus = await laptop.status();
    const staleRecord = await laptop.recoveryRecord({
      generation: 1n,
      keyId: staleStatus?.currentKeyId as string,
    });
    await laptop.revokeDevice('tablet', { recoverySecret: RECOVERY_SECRET });
    const rotated = await laptop.rotate({ recoverySecret: RECOVERY_SECRET });
    void rotated;

    // A device recovered from the stale head publishes a different head.
    const recovered = device();
    await recovered.enrollFromRecovery({
      accountId: ACCOUNT,
      deviceId: 'replacement',
      head: stale.head,
      authorityRecord: stale.authorityRecord as Uint8Array,
      recoveryRecord: staleRecord,
      recoverySecret: RECOVERY_SECRET,
    });
    const forked = await laptop.acceptAccountHead(
      (await recovered.accountHead()).head,
    );
    expect(forked.conflict).toBe(true);

    const sequence = sequencer();
    const keys = createLifecycleSnapshotKeys({
      lifecycle: laptop,
      nextSequence: sequence.nextSequence,
    });
    const refused = join(root, 'forked.hvsnap');
    expect(await refusal(sealWith(keys, refused, randomBytes(1000)))).toBe(
      'generation_conflict',
    );
    expect(() => lstatSync(refused)).toThrow();
    expect(sequence.nextSequence).not.toHaveBeenCalled();
    void tablet;
  });

  it('threat: an uninitialized device refuses to seal', async () => {
    const lifecycle = device();
    const keys = createLifecycleSnapshotKeys({
      lifecycle,
      nextSequence: () => 1n,
    });
    expect(await refusal(keys.sealingKey())).toBe('not_initialized');
  });

  it('seals only through openSealingKey, never through the reading path', async () => {
    const real = await initialized();
    const openReadingKey = vi.fn(real.openReadingKey);
    const openSealingKey = vi.fn(real.openSealingKey);
    const keys = createLifecycleSnapshotKeys({
      lifecycle: {
        status: real.status,
        openSealingKey,
        openReadingKey,
      },
      nextSequence: () => 9n,
    });
    const sealing = await keys.sealingKey();
    expect(openSealingKey).toHaveBeenCalledTimes(1);
    expect(openReadingKey).not.toHaveBeenCalled();
    expect(sealing).toMatchObject({
      accountId: ACCOUNT,
      deviceId: 'laptop',
      sequence: 9n,
      generation: 1n,
    });
    expect(sealing.key).toHaveLength(32);
  });

  it('zeroes the key when the sequence is unusable', async () => {
    const real = await initialized();
    let issued: Uint8Array | undefined;
    const keys = createLifecycleSnapshotKeys({
      lifecycle: {
        status: real.status,
        openReadingKey: real.openReadingKey,
        async openSealingKey() {
          const key = await real.openSealingKey();
          issued = key.key;
          return key;
        },
      },
      nextSequence: () => 0n,
    });
    await expect(keys.sealingKey()).rejects.toThrow(/sequence is invalid/);
    expect(issued?.every((byte) => byte === 0)).toBe(true);
  });

  it('opens only held keys of the trusted account and reports others as absent', async () => {
    const lifecycle = await initialized();
    const status = await lifecycle.status();
    const keys = createLifecycleSnapshotKeys({
      lifecycle,
      nextSequence: () => 1n,
    });
    const reference = {
      accountId: ACCOUNT,
      generation: 1n,
      keyId: status?.currentKeyId as string,
    };
    const key = await keys.openingKey(reference);
    expect(key).toHaveLength(32);
    // Another account's snapshot is never opened with this account's key.
    expect(
      await keys.openingKey({ ...reference, accountId: 'other-account' }),
    ).toBeUndefined();
    // A generation or key id this device does not hold.
    expect(
      await keys.openingKey({ ...reference, generation: 2n }),
    ).toBeUndefined();
    expect(
      await keys.openingKey({ ...reference, keyId: 'ab'.repeat(16) }),
    ).toBeUndefined();
    // No account on this device at all.
    expect(
      await createLifecycleSnapshotKeys({
        lifecycle: device(),
        nextSequence: () => 1n,
      }).openingKey(reference),
    ).toBeUndefined();
  });
});
