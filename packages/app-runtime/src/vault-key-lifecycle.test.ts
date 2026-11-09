import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authorityPublicKey,
  keyCommitment,
  parseHead,
  serializeHead,
  signHead,
} from './vault-account-head.js';
import { openVaultDeviceKey, wrapVaultDeviceKey } from './vault-device-key.js';
import {
  createVaultKeyLifecycle,
  parseVaultDeviceRegistry,
  serializeVaultDeviceRegistry,
  type VaultAccountHead,
  type VaultDeviceGrant,
  type VaultKeyLifecycle,
  VaultKeyLifecycleError,
} from './vault-key-lifecycle.js';
import type { VaultKeyStore } from './vault-key-store.js';
import { openVaultRecoveryKey } from './vault-recovery.js';

const RECOVERY_SECRET = 'synthetic recovery credential';
const NEW_RECOVERY_SECRET = 'replacement synthetic credential';
const ACCOUNT = 'vault-account';

interface MemoryStore extends VaultKeyStore {
  items: Map<string, Uint8Array>;
  failOnSet?: (name: string) => boolean;
}

function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    items: new Map(),
    async get(name) {
      const value = store.items.get(name);
      return value ? new Uint8Array(value) : null;
    },
    async set(name, value) {
      if (store.failOnSet?.(name)) throw new Error('simulated crash');
      store.items.set(name, new Uint8Array(value));
    },
    async delete(name) {
      store.items.delete(name);
    },
  };
  return store;
}

interface Clock {
  offsetMs: number;
}

function device(store = memoryStore(), clock: Clock = { offsetMs: 0 }) {
  return {
    store,
    clock,
    lifecycle: createVaultKeyLifecycle({
      store,
      now: () => new Date(Date.now() + clock.offsetMs),
    }),
  };
}

function clone(source: MemoryStore): MemoryStore {
  const copy = memoryStore();
  for (const [name, value] of source.items) {
    copy.items.set(name, new Uint8Array(value));
  }
  return copy;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(VaultKeyLifecycleError);
  expect((error as VaultKeyLifecycleError).code).toBe(code);
  return error as VaultKeyLifecycleError;
}

async function enroll(
  enroller: VaultKeyLifecycle,
  deviceId: string,
  accountId = ACCOUNT,
) {
  const joiner = device();
  const { request, deviceCode } =
    await joiner.lifecycle.createEnrollmentRequest({ accountId, deviceId });
  const { grant, accountCode } = await enroller.enrollDevice(request, {
    confirmationCode: deviceCode,
    recoverySecret: RECOVERY_SECRET,
  });
  await joiner.lifecycle.acceptEnrollment(grant, {
    confirmationCode: accountCode,
  });
  return joiner;
}

async function initialized(deviceId = 'laptop') {
  const created = device();
  await created.lifecycle.initializeAccount({
    accountId: ACCOUNT,
    deviceId,
    recoverySecret: RECOVERY_SECRET,
  });
  return created;
}

/** Laptop, phone and tablet, all on the same signed head. */
async function family() {
  const laptop = await initialized();
  const phone = await enroll(laptop.lifecycle, 'phone');
  const tablet = await enroll(laptop.lifecycle, 'tablet');
  await phone.lifecycle.acceptAccountHead(
    (await laptop.lifecycle.accountHead()).head,
  );
  return { laptop, phone, tablet };
}

function tamper(grant: VaultDeviceGrant, patch: Partial<VaultDeviceGrant>) {
  return { ...structuredClone(grant), ...patch } as VaultDeviceGrant;
}

function grantFor(grants: VaultDeviceGrant[], deviceId: string) {
  return grants.find(
    (grant) => grant.recipientDeviceId === deviceId,
  ) as VaultDeviceGrant;
}

/** A head the thief signs with an authority key of its own. */
function forgeHead(
  base: VaultAccountHead,
  patch: (head: ReturnType<typeof parseHead>) => void,
) {
  const seed = new Uint8Array(randomBytes(32));
  const head = parseHead(base);
  patch(head);
  head.authorityPublicKey = Buffer.from(authorityPublicKey(seed)).toString(
    'base64url',
  );
  return serializeHead(signHead(head, seed));
}

async function sealingKeyId(lifecycle: VaultKeyLifecycle) {
  const key = await lifecycle.openSealingKey();
  key.key.fill(0);
  return key.keyId;
}

describe('vault key lifecycle: enrollment', () => {
  it('enrolls a device with confirmation codes on both screens', async () => {
    const laptop = await initialized();
    const joiner = device();
    const { request, deviceCode } =
      await joiner.lifecycle.createEnrollmentRequest({
        accountId: ACCOUNT,
        deviceId: 'phone',
      });
    expect(deviceCode).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(JSON.stringify(request)).not.toContain('pairingSecret');
    const { grant, accountCode } = await laptop.lifecycle.enrollDevice(
      request,
      {
        confirmationCode: deviceCode.toLowerCase().replace(/-/g, ' '),
        recoverySecret: RECOVERY_SECRET,
      },
    );
    expect(accountCode).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    await joiner.lifecycle.acceptEnrollment(grant, {
      confirmationCode: accountCode,
    });

    const laptopKey = await laptop.lifecycle.openSealingKey();
    const phoneKey = await joiner.lifecycle.openSealingKey();
    expect(phoneKey).toEqual({ ...laptopKey, deviceId: 'phone' });
    for (const status of [
      await laptop.lifecycle.status(),
      await joiner.lifecycle.status(),
    ]) {
      expect(status?.sequence).toBe(2n);
      expect(status?.devices.map((entry) => entry.deviceId)).toEqual([
        'laptop',
        'phone',
      ]);
    }
    expect(joiner.store.items.has('enrollment-request')).toBe(false);
  });

  it('threat: a QR observer cannot substitute the device key or pull the device into another vault', async () => {
    const laptop = await initialized();
    const joiner = device();
    const { request, deviceCode } =
      await joiner.lifecycle.createEnrollmentRequest({
        accountId: ACCOUNT,
        deviceId: 'phone',
      });
    const before = laptop.store.items.get('registry');

    // Key substitution: the relayed request carries the attacker's key, so
    // the code read from the real device's screen does not match.
    const attacker = device();
    const attackerRequest = (
      await attacker.lifecycle.createEnrollmentRequest({
        accountId: ACCOUNT,
        deviceId: 'phone',
      })
    ).request;
    await expectCode(
      laptop.lifecycle.enrollDevice(
        { ...request, publicKey: attackerRequest.publicKey },
        { confirmationCode: deviceCode, recoverySecret: RECOVERY_SECRET },
      ),
      'confirmation_rejected',
    );
    await expectCode(
      laptop.lifecycle.enrollDevice(request, {
        confirmationCode: 'AAAA-AAAA-AAAA',
        recoverySecret: RECOVERY_SECRET,
      }),
      'confirmation_rejected',
    );
    // Enrolling needs the recovery secret, not just a device.
    await expectCode(
      laptop.lifecycle.enrollDevice(request, {
        confirmationCode: deviceCode,
        recoverySecret: 'incorrect recovery credential',
      }),
      'recovery_rejected',
    );
    await expectCode(
      laptop.lifecycle.enrollDevice(
        { ...request, accountId: 'other' },
        { confirmationCode: deviceCode, recoverySecret: RECOVERY_SECRET },
      ),
      'account_mismatch',
    );
    expect(laptop.store.items.get('registry')).toBe(before);

    // Pull-in: someone who saw the QR enrolls the device into a vault of
    // their own with the same account ID. The code on the real enroller's
    // screen does not match that vault.
    const impostor = await initialized('laptop');
    const foreign = await impostor.lifecycle.enrollDevice(request, {
      confirmationCode: deviceCode,
      recoverySecret: RECOVERY_SECRET,
    });
    const real = await laptop.lifecycle.enrollDevice(request, {
      confirmationCode: deviceCode,
      recoverySecret: RECOVERY_SECRET,
    });
    expect(foreign.accountCode).not.toBe(real.accountCode);
    await expectCode(
      joiner.lifecycle.acceptEnrollment(foreign.grant, {
        confirmationCode: real.accountCode,
      }),
      'confirmation_rejected',
    );
    // Grants for another request, recipient or kind are rejected.
    for (const forged of [
      tamper(real.grant, { recipientDeviceId: 'tablet' }),
      tamper(real.grant, {
        requestNonce: Buffer.alloc(16, 1).toString('base64url'),
      }),
      tamper(real.grant, { kind: 'update', requestNonce: null }),
      tamper(real.grant, { accountId: 'other' }),
      tamper(real.grant, { senderDeviceId: 'phone' }),
    ]) {
      await expectCode(
        joiner.lifecycle.acceptEnrollment(forged, {
          confirmationCode: real.accountCode,
        }),
        'grant_rejected',
      );
    }
    expect(joiner.store.items.has('registry')).toBe(false);
    await joiner.lifecycle.acceptEnrollment(real.grant, {
      confirmationCode: real.accountCode,
    });
    expect((await joiner.lifecycle.status())?.accountId).toBe(ACCOUNT);
  });

  it('threat: enrollment requests expire on both devices', async () => {
    const laptop = await initialized();
    const clock = { offsetMs: 0 };
    const joiner = device(memoryStore(), clock);
    await expectCode(
      joiner.lifecycle.createEnrollmentRequest({
        accountId: ACCOUNT,
        deviceId: 'phone',
        ttlMs: 16 * 60 * 1000,
      }),
      'invalid_input',
    );
    const { request, deviceCode } =
      await joiner.lifecycle.createEnrollmentRequest({
        accountId: ACCOUNT,
        deviceId: 'phone',
        ttlMs: 60_000,
      });
    const confirmation = {
      confirmationCode: deviceCode,
      recoverySecret: RECOVERY_SECRET,
    };
    // The enroller rejects past and implausibly distant expiries by its
    // own clock, even when the attacker controls the request.
    const late = device(laptop.store, { offsetMs: 120_000 });
    await expectCode(
      late.lifecycle.enrollDevice(request, confirmation),
      'request_expired',
    );
    await expectCode(
      laptop.lifecycle.enrollDevice(
        {
          ...request,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        confirmation,
      ),
      'request_expired',
    );
    const { grant, accountCode } = await laptop.lifecycle.enrollDevice(
      request,
      confirmation,
    );
    clock.offsetMs = 120_000;
    await expectCode(
      joiner.lifecycle.acceptEnrollment(grant, {
        confirmationCode: accountCode,
      }),
      'request_expired',
    );
    expect(joiner.store.items.has('enrollment-request')).toBe(false);
  });

  it('propagates membership through signed heads', async () => {
    const laptop = await initialized();
    const phone = await enroll(laptop.lifecycle, 'phone');
    // The phone enrolls the tablet; the laptop learns it from the head.
    const tablet = await enroll(phone.lifecycle, 'tablet');
    await laptop.lifecycle.acceptAccountHead(
      (await phone.lifecycle.accountHead()).head,
    );
    expect(
      (await laptop.lifecycle.status())?.devices.map((entry) => entry.deviceId),
    ).toEqual(['laptop', 'phone', 'tablet']);
    const rotated = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    expect(rotated.grants.map((grant) => grant.recipientDeviceId)).toEqual([
      'phone',
      'tablet',
    ]);
    await tablet.lifecycle.acceptDeviceGrant(
      grantFor(rotated.grants, 'tablet'),
    );
    expect(await sealingKeyId(tablet.lifecycle)).toBe(rotated.keyId);
  });
});

describe('vault key lifecycle: recovery', () => {
  it('enrolls a fresh machine from a signed head and the recovery code', async () => {
    const laptop = await initialized();
    const { head, authorityRecord } = await laptop.lifecycle.accountHead();
    const status = await laptop.lifecycle.status();
    const recoveryRecord = await laptop.lifecycle.recoveryRecord({
      generation: 1n,
      keyId: status?.currentKeyId as string,
    });
    const input = {
      accountId: ACCOUNT,
      deviceId: 'replacement',
      head,
      authorityRecord,
      recoveryRecord,
      recoverySecret: RECOVERY_SECRET,
    };
    const fresh = device();
    const other = await initialized('other');
    for (const forged of [
      { ...input, recoverySecret: 'incorrect recovery credential' },
      { ...input, accountId: 'other' },
      // A head the relay edited, or another account's head and record.
      {
        ...input,
        head: { ...head, sequence: '9' } as VaultAccountHead,
      },
      { ...input, head: (await other.lifecycle.accountHead()).head },
      { ...input, recoveryRecord: new Uint8Array(randomBytes(200)) },
    ]) {
      await expectCode(
        fresh.lifecycle.enrollFromRecovery(forged),
        'recovery_rejected',
      );
    }
    await expectCode(
      fresh.lifecycle.enrollFromRecovery({ ...input, deviceId: 'laptop' }),
      'device_conflict',
    );
    expect(fresh.store.items.has('registry')).toBe(false);

    const recovered = await fresh.lifecycle.enrollFromRecovery(input);
    expect(recovered.sequence).toBe(2n);
    expect(recovered.devices.map((entry) => entry.deviceId)).toEqual([
      'laptop',
      'replacement',
    ]);
    const key = await fresh.lifecycle.openSealingKey();
    expect(key.key).toEqual((await laptop.lifecycle.openSealingKey()).key);
    // The recovered device's signed head brings it into the account.
    const learned = await laptop.lifecycle.acceptAccountHead(
      (await fresh.lifecycle.accountHead()).head,
    );
    expect(learned.devices.map((entry) => entry.deviceId)).toContain(
      'replacement',
    );
    await expectCode(
      fresh.lifecycle.enrollFromRecovery(input),
      'already_initialized',
    );
  });

  it('threat: a stale head served at recovery surfaces as a fork at the first peer', async () => {
    const { laptop, tablet } = await family();
    const stale = await laptop.lifecycle.accountHead();
    const staleStatus = await laptop.lifecycle.status();
    const staleRecord = await laptop.lifecycle.recoveryRecord({
      generation: 1n,
      keyId: staleStatus?.currentKeyId as string,
    });
    await laptop.lifecycle.revokeDevice('phone', {
      recoverySecret: RECOVERY_SECRET,
    });
    const rotated = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    await tablet.lifecycle.acceptDeviceGrant(
      grantFor(rotated.grants, 'tablet'),
    );

    // The relay serves the pre-rotation head and record.
    const fresh = device();
    await fresh.lifecycle.enrollFromRecovery({
      accountId: ACCOUNT,
      deviceId: 'replacement',
      head: stale.head,
      authorityRecord: stale.authorityRecord,
      recoveryRecord: staleRecord,
      recoverySecret: RECOVERY_SECRET,
    });
    const freshHead = (await fresh.lifecycle.accountHead()).head;
    const atPeer = await tablet.lifecycle.acceptAccountHead(freshHead);
    expect(atPeer.conflict).toBe(true);
    await expectCode(tablet.lifecycle.openSealingKey(), 'generation_conflict');
    const atFresh = await fresh.lifecycle.acceptAccountHead(rotated.head);
    expect(atFresh.conflict).toBe(true);
    // The fork carries the phone revocation to the recovered device.
    expect(atFresh.revokedDevices.map((entry) => entry.deviceId)).toEqual([
      'phone',
    ]);
    await expectCode(fresh.lifecycle.openSealingKey(), 'generation_conflict');

    // A merge rotation resolves the fork for everyone and excludes the phone.
    const merged = await tablet.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    expect(merged.grants.map((grant) => grant.recipientDeviceId)).toEqual([
      'laptop',
      'replacement',
    ]);
    for (const peer of [laptop, fresh]) {
      const status = await peer.lifecycle.acceptDeviceGrant(
        grantFor(merged.grants, peer === laptop ? 'laptop' : 'replacement'),
      );
      expect(status.conflict).toBe(false);
      expect(await sealingKeyId(peer.lifecycle)).toBe(merged.keyId);
    }
  });
});

describe('vault key lifecycle: rotation and revocation', () => {
  it('rotates for every active device and keeps old generations readable', async () => {
    const { laptop, phone, tablet } = await family();
    const before = await laptop.lifecycle.openSealingKey();

    await expectCode(
      laptop.lifecycle.rotate({ recoverySecret: 'incorrect recovery secret' }),
      'recovery_rejected',
    );
    expect((await laptop.lifecycle.status())?.currentGeneration).toBe(1n);

    const rotated = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    expect(rotated.generation).toBe(2n);
    expect(rotated.grants.map((grant) => grant.recipientDeviceId)).toEqual([
      'phone',
      'tablet',
    ]);
    for (const target of [phone, tablet]) {
      const status = await target.lifecycle.acceptDeviceGrant(
        grantFor(rotated.grants, target === phone ? 'phone' : 'tablet'),
      );
      expect(status.currentGeneration).toBe(2n);
      expect(status.generations.map((entry) => entry.status)).toEqual([
        'read-only',
        'current',
      ]);
    }
    const after = await laptop.lifecycle.openSealingKey();
    expect(after.key).not.toEqual(before.key);
    expect((await phone.lifecycle.openSealingKey()).key).toEqual(after.key);
    const old = await tablet.lifecycle.openReadingKey({
      generation: 1n,
      keyId: before.keyId,
    });
    expect(old).toMatchObject({ purpose: 'read', key: before.key });
    await expectCode(
      tablet.lifecycle.openReadingKey({
        generation: 1n,
        keyId: after.keyId,
      }),
      'key_missing',
    );
    expect(
      await laptop.lifecycle.recoveryRecord({
        generation: 2n,
        keyId: rotated.keyId,
      }),
    ).toEqual(rotated.recoveryRecord);

    // The rotated head and records restore with the unchanged code.
    const fresh = device();
    await fresh.lifecycle.enrollFromRecovery({
      accountId: ACCOUNT,
      deviceId: 'replacement',
      head: rotated.head,
      authorityRecord: rotated.authorityRecord,
      recoveryRecord: rotated.recoveryRecord,
      recoverySecret: RECOVERY_SECRET,
    });
    expect((await fresh.lifecycle.openSealingKey()).key).toEqual(after.key);
  });

  it('threat: a revoked device cannot reuse an old wrapper after rotation', async () => {
    const { laptop, phone, tablet } = await family();
    const phoneSecret = phone.store.items.get('device-secret') as Uint8Array;
    const oldKeyId = (await laptop.lifecycle.status())?.currentKeyId as string;
    const oldPhoneRecord = phone.store.items.get(
      `key.1.${oldKeyId}`,
    ) as Uint8Array;
    const phoneGrantBeforeRevoke =
      await phone.lifecycle.createDeviceGrant('tablet');

    const revoked = await laptop.lifecycle.revokeDevice('phone', {
      recoverySecret: RECOVERY_SECRET,
    });
    expect(revoked.rotationRequired).toBe(true);
    expect(revoked.devices.map((entry) => entry.deviceId)).toEqual([
      'laptop',
      'tablet',
    ]);
    // New data is refused until rotation; old data stays readable.
    await expectCode(laptop.lifecycle.openSealingKey(), 'rotation_required');
    expect(
      (
        await laptop.lifecycle.openReadingKey({
          generation: 1n,
          keyId: oldKeyId,
        })
      ).purpose,
    ).toBe('read');
    await expectCode(
      laptop.lifecycle.createDeviceGrant('phone'),
      'device_revoked',
    );

    const rotated = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    expect(rotated.grants.map((grant) => grant.recipientDeviceId)).toEqual([
      'tablet',
    ]);
    const status = await laptop.lifecycle.status();
    expect(status?.rotationRequired).toBe(false);
    expect(status?.revokedDevices).toEqual([
      expect.objectContaining({ deviceId: 'phone', effectiveGeneration: 2n }),
    ]);
    const tabletStatus = await tablet.lifecycle.acceptDeviceGrant(
      rotated.grants[0],
    );
    expect(tabletStatus.revokedDevices[0]).toMatchObject({
      deviceId: 'phone',
      effectiveGeneration: 2n,
    });

    // The revoked wrapper cannot open the new generation.
    expect(() =>
      openVaultDeviceKey(oldPhoneRecord, phoneSecret, {
        accountId: ACCOUNT,
        deviceId: 'phone',
        generation: 2n,
        keyId: rotated.keyId,
      }),
    ).toThrow('Vault device key authentication failed');
    // A rotation grant addressed to another device is useless to it, and
    // its signed head tells the phone it is revoked.
    await expectCode(
      phone.lifecycle.acceptDeviceGrant(
        tamper(rotated.grants[0], { recipientDeviceId: 'phone' }),
      ),
      'device_revoked',
    );
    // The revoked device's own grants are refused once peers know.
    await expectCode(
      tablet.lifecycle.acceptDeviceGrant(phoneGrantBeforeRevoke),
      'device_revoked',
    );
    // The revoked device learns of its revocation and holds no new key.
    await expectCode(
      phone.lifecycle.acceptAccountHead(rotated.head),
      'device_revoked',
    );
    await expectCode(
      phone.lifecycle.openReadingKey({
        generation: 2n,
        keyId: rotated.keyId,
      }),
      'key_missing',
    );
    // A revoked identity cannot enroll again under the same ID or key.
    const reenroll = device();
    const again = await reenroll.lifecycle.createEnrollmentRequest({
      accountId: ACCOUNT,
      deviceId: 'phone',
    });
    await expectCode(
      laptop.lifecycle.enrollDevice(again.request, {
        confirmationCode: again.deviceCode,
        recoverySecret: RECOVERY_SECRET,
      }),
      'device_revoked',
    );
  });

  it('threat: a crash mid-rotation leaves the current key usable and resumes', async () => {
    const { laptop } = await family();
    const before = await laptop.lifecycle.openSealingKey();

    // Crash after the candidate is recorded and its device record written,
    // before the recovery record and the commit.
    laptop.store.failOnSet = (name) => name.startsWith('recovery.2.');
    await expect(
      laptop.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET }),
    ).rejects.toThrow('simulated crash');
    laptop.store.failOnSet = undefined;
    let status = await laptop.lifecycle.status();
    expect(status?.currentGeneration).toBe(1n);
    expect(status?.pendingRotation?.generation).toBe(2n);
    expect((await laptop.lifecycle.openSealingKey()).key).toEqual(before.key);

    // An incomplete candidate is replaced, never committed.
    const replaced = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    expect(replaced.generation).toBe(2n);
    expect(replaced.keyId).not.toBe(status?.pendingRotation?.keyId);

    // Crash after every candidate record is written, before the commit:
    // the next call resumes the same candidate.
    let registryWrites = 0;
    laptop.store.failOnSet = (name) =>
      name === 'registry' && ++registryWrites === 2;
    await expect(
      laptop.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET }),
    ).rejects.toThrow('simulated crash');
    laptop.store.failOnSet = undefined;
    status = await laptop.lifecycle.status();
    expect(status?.currentGeneration).toBe(2n);
    const pending = status?.pendingRotation;
    expect(pending?.generation).toBe(3n);
    expect(await sealingKeyId(laptop.lifecycle)).toBe(replaced.keyId);
    const resumed = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    expect(resumed).toMatchObject({ generation: 3n, keyId: pending?.keyId });
    expect(
      (await laptop.lifecycle.status())?.generations.map((entry) => [
        entry.generation,
        entry.status,
      ]),
    ).toEqual([
      [1n, 'read-only'],
      [2n, 'read-only'],
      [3n, 'current'],
    ]);
    expect(
      (
        await laptop.lifecycle.openReadingKey({
          generation: 1n,
          keyId: before.keyId,
        })
      ).key,
    ).toEqual(before.key);
  });

  it('threat: grants and heads cannot downgrade the current generation', async () => {
    const { laptop, phone } = await family();
    const staleGrant = await laptop.lifecycle.createDeviceGrant('phone');
    const rotated = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    await phone.lifecycle.acceptDeviceGrant(grantFor(rotated.grants, 'phone'));
    const current = await phone.lifecycle.openSealingKey();

    // Replaying an older grant or head never lowers the current generation.
    const status = await phone.lifecycle.acceptDeviceGrant(staleGrant);
    expect(status).toMatchObject({ currentGeneration: 2n, conflict: false });
    await phone.lifecycle.acceptAccountHead(staleGrant.head);
    expect(await phone.lifecycle.openSealingKey()).toEqual(current);
    // Editing the signed head fails its signature.
    const fresh = await laptop.lifecycle.createDeviceGrant('phone');
    for (const head of [
      { ...fresh.head, current: staleGrant.head.current },
      { ...fresh.head, sequence: '1' },
      { ...fresh.head, issuerDeviceId: 'phone' },
    ] as VaultAccountHead[]) {
      await expectCode(
        phone.lifecycle.acceptDeviceGrant(tamper(fresh, { head })),
        'grant_rejected',
      );
    }
    expect(await phone.lifecycle.openSealingKey()).toEqual(current);
  });
});

describe('vault key lifecycle: hostile active sender', () => {
  /**
   * The phone is stolen and its device secret extracted. The laptop revokes
   * it and rotates. The thief races the laptop's grant to the tablet.
   */
  async function theft() {
    const { laptop, phone, tablet } = await family();
    const thief = device(clone(phone.store));
    const authentic = await thief.lifecycle.createDeviceGrant('tablet');
    const status = await tablet.lifecycle.status();
    // The thief wraps a key of its choosing for the current entry.
    const thiefKey = new Uint8Array(randomBytes(32));
    const current = {
      generation: status?.currentGeneration as bigint,
      keyId: status?.currentKeyId as string,
    };
    const substituted = clone(phone.store);
    substituted.items.set(
      `key.${current.generation}.${current.keyId}`,
      wrapVaultDeviceKey(
        thiefKey,
        phone.store.items.get('device-secret') as Uint8Array,
        { accountId: ACCOUNT, deviceId: 'phone', ...current },
      ),
    );
    const keySwap =
      await device(substituted).lifecycle.createDeviceGrant('tablet');
    // A head advancing to generation 2 under the thief's key, revoking the
    // laptop, signed by the only authority the thief can hold: its own.
    const forgedAdvance = tamper(authentic, {
      head: forgeHead(authentic.head, (head) => {
        const generation = head.current.generation + 1n;
        const keyId = 'f'.repeat(32);
        head.sequence += 1n;
        head.current = { generation, keyId };
        head.generations.push({
          generation,
          keyId,
          keyCommitment: keyCommitment(thiefKey, ACCOUNT, generation, keyId),
          recoveryDigest: head.generations[0].recoveryDigest,
        });
        const laptopDevice = head.devices.find(
          (entry) => entry.deviceId === 'laptop',
        );
        head.devices = head.devices.filter(
          (entry) => entry.deviceId !== 'laptop',
        );
        head.revokedDevices.push({
          ...(laptopDevice as (typeof head.devices)[number]),
          revokedAt: head.issuedAt,
          effectiveGeneration: generation,
        });
        head.issuerDeviceId = 'phone';
      }),
    });
    // The same edits without re-signing: the account signature fails.
    const unsigned = tamper(authentic, {
      head: {
        ...authentic.head,
        sequence: (BigInt(authentic.head.sequence) + 1n).toString(),
        revokedDevices: forgedAdvance.head.revokedDevices,
      },
    });
    await laptop.lifecycle.revokeDevice('phone', {
      recoverySecret: RECOVERY_SECRET,
    });
    const rotated = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    return {
      laptop,
      tablet,
      legitimate: grantFor(rotated.grants, 'tablet'),
      rotated,
      attacks: [forgedAdvance, unsigned, keySwap],
      originalKeyId: current.keyId,
    };
  }

  it('threat: the thief races ahead of the legitimate rotation', async () => {
    const { laptop, tablet, legitimate, rotated, attacks, originalKeyId } =
      await theft();
    for (const attack of attacks) {
      await expectCode(
        tablet.lifecycle.acceptDeviceGrant(attack),
        'grant_rejected',
      );
      const status = await tablet.lifecycle.status();
      expect(status).toMatchObject({
        currentGeneration: 1n,
        conflict: false,
        rotationRequired: false,
      });
      // The laptop stays active: no forged revocation was learned.
      expect(status?.devices.map((entry) => entry.deviceId)).toEqual([
        'laptop',
        'phone',
        'tablet',
      ]);
      expect(await sealingKeyId(tablet.lifecycle)).toBe(originalKeyId);
    }
    // The legitimate grant is still accepted, with its revocation.
    const status = await tablet.lifecycle.acceptDeviceGrant(legitimate);
    expect(status.currentGeneration).toBe(2n);
    expect(status.revokedDevices.map((entry) => entry.deviceId)).toEqual([
      'phone',
    ]);
    expect(await sealingKeyId(tablet.lifecycle)).toBe(rotated.keyId);
    // The laptop is not locked out.
    await tablet.lifecycle.acceptDeviceGrant(
      await laptop.lifecycle.createDeviceGrant('tablet'),
    );
  });

  it('threat: the thief arrives after the legitimate rotation', async () => {
    const { tablet, legitimate, rotated, attacks } = await theft();
    await tablet.lifecycle.acceptDeviceGrant(legitimate);
    const codes = [];
    for (const attack of attacks) {
      const error = await tablet.lifecycle
        .acceptDeviceGrant(attack)
        .catch((caught: VaultKeyLifecycleError) => caught);
      codes.push((error as VaultKeyLifecycleError).code);
    }
    expect(codes).toEqual([
      'grant_rejected',
      'grant_rejected',
      'device_revoked',
    ]);
    const status = await tablet.lifecycle.status();
    expect(status).toMatchObject({ currentGeneration: 2n, conflict: false });
    expect(status?.devices.map((entry) => entry.deviceId)).toEqual([
      'laptop',
      'tablet',
    ]);
    expect(await sealingKeyId(tablet.lifecycle)).toBe(rotated.keyId);
  });

  it('threat: a bad transfer cannot hide the signed head that carries it', async () => {
    const { tablet, legitimate, rotated } = await theft();
    const broken = structuredClone(legitimate);
    const transfer = Buffer.from(broken.generations[0].transfer, 'base64url');
    transfer[transfer.length - 1] ^= 1;
    broken.generations[0].transfer = transfer.toString('base64url');
    await expectCode(
      tablet.lifecycle.acceptDeviceGrant(broken),
      'grant_rejected',
    );
    const status = await tablet.lifecycle.status();
    expect(status?.sequence).toBe(BigInt(rotated.head.sequence));
    expect(status?.revokedDevices.map((entry) => entry.deviceId)).toEqual([
      'phone',
    ]);
    // Without the new key the tablet refuses to seal rather than fall back.
    await expectCode(tablet.lifecycle.openSealingKey(), 'key_missing');
    await tablet.lifecycle.acceptDeviceGrant(legitimate);
    expect(await sealingKeyId(tablet.lifecycle)).toBe(rotated.keyId);
  });
});

describe('vault key lifecycle: forks', () => {
  it('threat: concurrent rotations fail closed in either order and merge', async () => {
    for (const order of ['phone-first', 'tablet-first'] as const) {
      const { laptop, phone, tablet } = await family();
      const fromPhone = await phone.lifecycle.rotate({
        recoverySecret: RECOVERY_SECRET,
      });
      const fromTablet = await tablet.lifecycle.rotate({
        recoverySecret: RECOVERY_SECRET,
      });
      expect(fromTablet.generation).toBe(fromPhone.generation);
      const grants =
        order === 'phone-first'
          ? [fromPhone.grants, fromTablet.grants]
          : [fromTablet.grants, fromPhone.grants];
      await laptop.lifecycle.acceptDeviceGrant(grantFor(grants[0], 'laptop'));
      const forked = await laptop.lifecycle.acceptDeviceGrant(
        grantFor(grants[1], 'laptop'),
      );
      expect(forked.conflict).toBe(true);
      await expectCode(
        laptop.lifecycle.openSealingKey(),
        'generation_conflict',
      );
      // Data sealed on either branch stays readable.
      for (const branch of [fromPhone, fromTablet]) {
        expect(
          (
            await laptop.lifecycle.openReadingKey({
              generation: branch.generation,
              keyId: branch.keyId,
            })
          ).purpose,
        ).toBe('read');
      }
      const merged = await laptop.lifecycle.rotate({
        recoverySecret: RECOVERY_SECRET,
      });
      expect(merged.generation).toBe(3n);
      for (const [peer, id] of [
        [phone, 'phone'],
        [tablet, 'tablet'],
      ] as const) {
        const status = await peer.lifecycle.acceptDeviceGrant(
          grantFor(merged.grants, id),
        );
        expect(status.conflict).toBe(false);
        expect(await sealingKeyId(peer.lifecycle)).toBe(merged.keyId);
        // Each branch's key reaches the other side through the merge.
        expect(status.generations.filter((entry) => entry.held)).toHaveLength(
          4,
        );
      }
      // Replaying a merged branch changes nothing.
      const replay = await laptop.lifecycle.acceptDeviceGrant(
        grantFor(fromTablet.grants, 'laptop'),
      );
      expect(replay.conflict).toBe(false);
      expect(await sealingKeyId(laptop.lifecycle)).toBe(merged.keyId);
    }
  });

  it('keeps a pending revocation through an unrelated enrollment head', async () => {
    const { laptop, tablet } = await family();
    await laptop.lifecycle.revokeDevice('phone', {
      recoverySecret: RECOVERY_SECRET,
    });
    await enroll(tablet.lifecycle, 'watch');
    const status = await laptop.lifecycle.acceptAccountHead(
      (await tablet.lifecycle.accountHead()).head,
    );
    expect(status.rotationRequired).toBe(true);
    expect(status.devices.map((entry) => entry.deviceId)).toEqual([
      'laptop',
      'tablet',
      'watch',
    ]);
    await expectCode(laptop.lifecycle.openSealingKey(), 'rotation_required');
    // Enrolling waits for the rotation that publishes the revocation.
    const joiner = device();
    const { request, deviceCode } =
      await joiner.lifecycle.createEnrollmentRequest({
        accountId: ACCOUNT,
        deviceId: 'tv',
      });
    await expectCode(
      laptop.lifecycle.enrollDevice(request, {
        confirmationCode: deviceCode,
        recoverySecret: RECOVERY_SECRET,
      }),
      'rotation_required',
    );
  });
});

describe('vault key lifecycle: revocation requires the recovery secret (#4818)', () => {
  function registryBytes(store: MemoryStore) {
    return Buffer.from(store.items.get('registry') as Uint8Array).toString();
  }

  it('threat: a device without the secret cannot record a revocation, so it cannot strand its own sealing', async () => {
    const { laptop } = await family();
    const before = registryBytes(laptop.store);
    for (const input of [
      { recoverySecret: 'a guess at the credential' },
      { recoverySecret: '' },
      {} as { recoverySecret: string },
      undefined as unknown as { recoverySecret: string },
    ]) {
      await expectCode(
        laptop.lifecycle.revokeDevice('phone', input),
        'recovery_rejected',
      );
    }
    // Nothing was recorded and sealing is unaffected.
    expect(registryBytes(laptop.store)).toBe(before);
    const status = await laptop.lifecycle.status();
    expect(status?.rotationRequired).toBe(false);
    expect(status?.rotation).toBeNull();
    expect(status?.revokedDevices).toEqual([]);
    await sealingKeyId(laptop.lifecycle);
  });

  it('threat: a stolen device holding only its own secret cannot lock the others out', async () => {
    const { phone, laptop } = await family();
    // The thief has the phone's store but not the recovery secret.
    const thief = device(clone(phone.store));
    await expectCode(
      thief.lifecycle.revokeDevice('laptop', {
        recoverySecret: 'not the credential',
      }),
      'recovery_rejected',
    );
    expect((await thief.lifecycle.status())?.rotationRequired).toBe(false);
    await sealingKeyId(thief.lifecycle);
    // The legitimate holder of the secret still can.
    await laptop.lifecycle.revokeDevice('phone', {
      recoverySecret: RECOVERY_SECRET,
    });
  });

  it('records the revocation once the secret is proven, and rotating clears it', async () => {
    const { laptop } = await family();
    const status = await laptop.lifecycle.revokeDevice('phone', {
      recoverySecret: RECOVERY_SECRET,
    });
    expect(status.rotationRequired).toBe(true);
    expect(status.rotation).toEqual({
      reasons: ['revocation'],
      secretProven: true,
    });
    await expectCode(laptop.lifecycle.openSealingKey(), 'rotation_required');
    // Revoke and rotate run on the same proof: rotating now succeeds.
    await laptop.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET });
    const after = await laptop.lifecycle.status();
    expect(after?.rotation).toBeNull();
    expect(after?.rotationRequired).toBe(false);
    await sealingKeyId(laptop.lifecycle);
  });

  it('keeps no trace of the secret, only the time it was proven', async () => {
    const { laptop } = await family();
    await laptop.lifecycle.revokeDevice('phone', {
      recoverySecret: RECOVERY_SECRET,
    });
    const text = registryBytes(laptop.store);
    expect(text).not.toContain(RECOVERY_SECRET);
    expect(JSON.parse(text).pendingRevocations[0].provenAt).toEqual(
      expect.any(String),
    );
  });

  it('threat: a superseded secret cannot record a revocation', async () => {
    const { laptop } = await family();
    await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
      newRecoverySecret: NEW_RECOVERY_SECRET,
    });
    await expectCode(
      laptop.lifecycle.revokeDevice('phone', {
        recoverySecret: RECOVERY_SECRET,
      }),
      'recovery_rejected',
    );
    expect((await laptop.lifecycle.status())?.rotation).toBeNull();
    const status = await laptop.lifecycle.revokeDevice('phone', {
      recoverySecret: NEW_RECOVERY_SECRET,
    });
    expect(status.rotation?.secretProven).toBe(true);
  });

  it('keeps the self and unknown-device refusals, secret or not', async () => {
    const { laptop } = await family();
    await expectCode(
      laptop.lifecycle.revokeDevice('laptop', {
        recoverySecret: RECOVERY_SECRET,
      }),
      'device_conflict',
    );
    await expectCode(
      laptop.lifecycle.revokeDevice('stranger', {
        recoverySecret: RECOVERY_SECRET,
      }),
      'unknown_device',
    );
  });

  it('reports a revocation recorded before the proof rule as unproven', async () => {
    const { laptop } = await family();
    await laptop.lifecycle.revokeDevice('phone', {
      recoverySecret: RECOVERY_SECRET,
    });
    const legacy = JSON.parse(registryBytes(laptop.store));
    // State written by an earlier build has no proof timestamp.
    delete legacy.pendingRevocations[0].provenAt;
    laptop.store.items.set(
      'registry',
      new Uint8Array(Buffer.from(JSON.stringify(legacy))),
    );
    const status = await laptop.lifecycle.status();
    expect(status?.rotation).toEqual({
      reasons: ['revocation'],
      secretProven: false,
    });
    await expectCode(laptop.lifecycle.openSealingKey(), 'rotation_required');
  });

  it('threat: fork evidence is recorded without the secret and reports it unproven', async () => {
    const { laptop, phone, tablet } = await family();
    const fromPhone = await phone.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    const fromTablet = await tablet.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    await laptop.lifecycle.acceptDeviceGrant(
      grantFor(fromPhone.grants, 'laptop'),
    );
    // Evidence arrives from the relay unasked: it must never be refused for
    // want of the secret, or a diverged device would keep sealing.
    const forked = await laptop.lifecycle.acceptDeviceGrant(
      grantFor(fromTablet.grants, 'laptop'),
    );
    expect(forked.conflict).toBe(true);
    expect(forked.rotationRequired).toBe(false);
    expect(forked.rotation).toEqual({
      reasons: ['conflict'],
      secretProven: false,
    });
    await expectCode(laptop.lifecycle.openSealingKey(), 'generation_conflict');
    // Without the secret the merge fails and nothing changes.
    const before = registryBytes(laptop.store);
    await expectCode(
      laptop.lifecycle.rotate({ recoverySecret: 'lost it' }),
      'recovery_rejected',
    );
    expect(registryBytes(laptop.store)).toBe(before);
    await expectCode(laptop.lifecycle.openSealingKey(), 'generation_conflict');
    // A revocation recorded during the fork keeps the whole state unproven
    // until the merge.
    const both = await laptop.lifecycle.revokeDevice('tablet', {
      recoverySecret: RECOVERY_SECRET,
    });
    expect(both.rotation).toEqual({
      reasons: ['revocation', 'conflict'],
      secretProven: false,
    });
    await laptop.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET });
    expect((await laptop.lifecycle.status())?.rotation).toBeNull();
    await sealingKeyId(laptop.lifecycle);
  });
});

describe('vault key lifecycle: recovery secret check (#4817)', () => {
  function snapshotOf(store: MemoryStore) {
    return JSON.stringify(
      [...store.items.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([name, value]) => [name, Buffer.from(value).toString('base64')]),
    );
  }

  it('proves the secret opens the authority and the current key without changing anything', async () => {
    const { laptop } = await family();
    const before = snapshotOf(laptop.store);
    expect(await laptop.lifecycle.checkRecoverySecret(RECOVERY_SECRET)).toEqual(
      { authority: true, currentKey: true },
    );
    expect(
      await laptop.lifecycle.checkRecoverySecret('a different credential'),
    ).toEqual({ authority: false, currentKey: false });
    expect(
      await laptop.lifecycle.checkRecoverySecret(
        undefined as unknown as string,
      ),
    ).toEqual({ authority: false, currentKey: false });
    expect(snapshotOf(laptop.store)).toBe(before);
    // The state is unchanged for sealing too.
    await sealingKeyId(laptop.lifecycle);
  });

  it('threat: a superseded secret no longer checks out after the recovery secret rotates', async () => {
    const { laptop } = await family();
    await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
      newRecoverySecret: NEW_RECOVERY_SECRET,
    });
    expect(await laptop.lifecycle.checkRecoverySecret(RECOVERY_SECRET)).toEqual(
      { authority: false, currentKey: false },
    );
    expect(
      await laptop.lifecycle.checkRecoverySecret(NEW_RECOVERY_SECRET),
    ).toEqual({ authority: true, currentKey: true });
  });

  it('reports a current key this device does not hold as unknown, not as failed', async () => {
    const { laptop, phone } = await family();
    await laptop.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET });
    // The phone learns the new head but has no grant, so no new key yet.
    await phone.lifecycle.acceptAccountHead(
      (await laptop.lifecycle.accountHead()).head,
    );
    expect(await phone.lifecycle.checkRecoverySecret(RECOVERY_SECRET)).toEqual({
      authority: true,
      currentKey: null,
    });
  });

  it('refuses before initialization', async () => {
    await expectCode(
      device().lifecycle.checkRecoverySecret(RECOVERY_SECRET),
      'not_initialized',
    );
  });
});

describe('vault key lifecycle: restart without the recovery secret (#4817)', () => {
  const RESTART_SECRET = 'fresh synthetic credential for the new account';
  const NEW_ACCOUNT = 'vault-account-b';

  function restart(
    lifecycle: VaultKeyLifecycle,
    patch: Partial<Parameters<VaultKeyLifecycle['restartAccount']>[0]> = {},
  ) {
    return lifecycle.restartAccount({
      accountId: NEW_ACCOUNT,
      deviceId: 'laptop-b',
      recoverySecret: RESTART_SECRET,
      confirmRestart: true,
      ...patch,
    });
  }

  function itemNames(store: MemoryStore) {
    return [...store.items.keys()].sort();
  }

  it('starts a new account from one working device that never knew the old secret', async () => {
    const { laptop } = await family();
    const oldHead = (await laptop.lifecycle.accountHead()).head;
    const oldKey = await laptop.lifecycle.openSealingKey();
    oldKey.key.fill(0);
    const published = await restart(laptop.lifecycle);
    expect(published.previousAccountId).toBe(ACCOUNT);
    expect(published.generation).toBe(1n);
    expect(published.head.accountId).toBe(NEW_ACCOUNT);
    expect(published.authorityRecord.length).toBeGreaterThan(0);
    const status = await laptop.lifecycle.status();
    expect(status?.accountId).toBe(NEW_ACCOUNT);
    expect(status?.devices.map((entry) => entry.deviceId)).toEqual([
      'laptop-b',
    ]);
    // A new data key and a new authority: nothing is shared with the old account.
    expect(published.keyId).not.toBe(oldKey.keyId);
    expect(status?.authorityPublicKey).not.toBe(oldHead.authorityPublicKey);
    expect(status?.generations.map((entry) => entry.keyId)).toEqual([
      published.keyId,
    ]);
    // The device key differs too, so the relay cannot link the two accounts.
    expect(status?.devices[0].publicKey).not.toBe(
      oldHead.devices.find((entry) => entry.deviceId === 'laptop')?.publicKey,
    );
    await expectCode(
      laptop.lifecycle.openReadingKey({
        generation: oldKey.generation,
        keyId: oldKey.keyId,
      }),
      'key_missing',
    );
    expect(await sealingKeyId(laptop.lifecycle)).toBe(published.keyId);
    expect(await laptop.lifecycle.previousAccount()).toEqual({
      accountId: ACCOUNT,
      interrupted: false,
    });
  });

  it('threat: the old secret opens nothing in the new account', async () => {
    const { laptop } = await family();
    const oldAuthority = (await laptop.lifecycle.accountHead())
      .authorityRecord as Uint8Array;
    const published = await restart(laptop.lifecycle);
    expect(await laptop.lifecycle.checkRecoverySecret(RECOVERY_SECRET)).toEqual(
      { authority: false, currentKey: false },
    );
    expect(await laptop.lifecycle.checkRecoverySecret(RESTART_SECRET)).toEqual({
      authority: true,
      currentKey: true,
    });
    // It cannot add a device, rotate or revoke.
    const joiner = device();
    const { request, deviceCode } =
      await joiner.lifecycle.createEnrollmentRequest({
        accountId: NEW_ACCOUNT,
        deviceId: 'phone-b',
      });
    await expectCode(
      laptop.lifecycle.enrollDevice(request, {
        confirmationCode: deviceCode,
        recoverySecret: RECOVERY_SECRET,
      }),
      'recovery_rejected',
    );
    await expectCode(
      laptop.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET }),
      'recovery_rejected',
    );
    // Nor can it recover into the new account, even with the old records.
    await expectCode(
      device().lifecycle.enrollFromRecovery({
        accountId: NEW_ACCOUNT,
        deviceId: 'thief',
        head: published.head,
        authorityRecord: oldAuthority,
        recoveryRecord: published.recoveryRecord,
        recoverySecret: RECOVERY_SECRET,
      }),
      'recovery_rejected',
    );
    await expectCode(
      device().lifecycle.enrollFromRecovery({
        accountId: NEW_ACCOUNT,
        deviceId: 'thief',
        head: published.head,
        authorityRecord: published.authorityRecord,
        recoveryRecord: published.recoveryRecord,
        recoverySecret: RECOVERY_SECRET,
      }),
      'recovery_rejected',
    );
  });

  it('threat: a head of the old account is refused by the new one', async () => {
    const { laptop } = await family();
    const oldHead = (await laptop.lifecycle.accountHead()).head;
    await restart(laptop.lifecycle);
    await expectCode(
      laptop.lifecycle.acceptAccountHead(oldHead),
      'account_mismatch',
    );
  });

  it('re-enrols another device through the normal exchange under the new secret', async () => {
    const { laptop, phone } = await family();
    const published = await restart(laptop.lifecycle);
    expect(await phone.lifecycle.previousAccount()).toBeNull();
    const left = await phone.lifecycle.leaveAccount({ confirmLeave: true });
    expect(left.previousAccountId).toBe(ACCOUNT);
    expect(await phone.lifecycle.status()).toBeNull();
    expect(await phone.lifecycle.previousAccount()).toEqual({
      accountId: ACCOUNT,
      interrupted: true,
    });
    const { request, deviceCode } =
      await phone.lifecycle.createEnrollmentRequest({
        accountId: NEW_ACCOUNT,
        deviceId: 'phone-b',
      });
    // The old secret cannot enrol it; the new one can.
    await expectCode(
      laptop.lifecycle.enrollDevice(request, {
        confirmationCode: deviceCode,
        recoverySecret: RECOVERY_SECRET,
      }),
      'recovery_rejected',
    );
    const { grant, accountCode } = await laptop.lifecycle.enrollDevice(
      request,
      { confirmationCode: deviceCode, recoverySecret: RESTART_SECRET },
    );
    const status = await phone.lifecycle.acceptEnrollment(grant, {
      confirmationCode: accountCode,
    });
    expect(status.accountId).toBe(NEW_ACCOUNT);
    expect(status.devices.map((entry) => entry.deviceId)).toEqual([
      'laptop-b',
      'phone-b',
    ]);
    expect(await sealingKeyId(phone.lifecycle)).toBe(published.keyId);
    expect(await phone.lifecycle.previousAccount()).toEqual({
      accountId: ACCOUNT,
      interrupted: false,
    });
  });

  it('requires confirmation and a different account', async () => {
    const { laptop } = await family();
    await expectCode(
      restart(laptop.lifecycle, { confirmRestart: undefined as never }),
      'invalid_input',
    );
    await expectCode(
      restart(laptop.lifecycle, { confirmRestart: 'yes' as never }),
      'invalid_input',
    );
    await expectCode(
      laptop.lifecycle.leaveAccount({} as never),
      'invalid_input',
    );
    await expectCode(
      restart(laptop.lifecycle, { accountId: '' }),
      'invalid_input',
    );
    expect((await laptop.lifecycle.status())?.accountId).toBe(ACCOUNT);
    // Nothing was parked by the refusals.
    expect(await laptop.lifecycle.previousAccount()).toBeNull();
    await expectCode(
      device().lifecycle.restartAccount({
        accountId: NEW_ACCOUNT,
        deviceId: 'laptop-b',
        recoverySecret: RESTART_SECRET,
        confirmRestart: true,
      }),
      'not_initialized',
    );
  });

  it('threat: a retry after the restart finished must present the same secret', async () => {
    const { laptop } = await family();
    const first = await restart(laptop.lifecycle);
    const again = await restart(laptop.lifecycle);
    expect(again.head).toEqual(first.head);
    expect(Buffer.from(again.authorityRecord)).toEqual(
      Buffer.from(first.authorityRecord),
    );
    expect(Buffer.from(again.recoveryRecord)).toEqual(
      Buffer.from(first.recoveryRecord),
    );
    expect(again.previousAccountId).toBe(ACCOUNT);
    await expectCode(
      restart(laptop.lifecycle, { recoverySecret: 'a mistyped credential' }),
      'recovery_rejected',
    );
    // A plain account that was never restarted is not a restart to retry.
    const plain = await initialized();
    await expectCode(
      plain.lifecycle.restartAccount({
        accountId: ACCOUNT,
        deviceId: 'laptop',
        recoverySecret: RECOVERY_SECRET,
        confirmRestart: true,
      }),
      'already_initialized',
    );
  });

  it('refuses a second restart until the parked account is discarded', async () => {
    const { laptop } = await family();
    await restart(laptop.lifecycle);
    await expectCode(
      restart(laptop.lifecycle, { accountId: 'vault-account-c' }),
      'restart_pending',
    );
    await expectCode(
      laptop.lifecycle.leaveAccount({ confirmLeave: true }),
      'restart_pending',
    );
    await laptop.lifecycle.discardPreviousAccount();
    expect(await laptop.lifecycle.previousAccount()).toBeNull();
    const third = await restart(laptop.lifecycle, {
      accountId: 'vault-account-c',
      deviceId: 'laptop-c',
    });
    expect(third.previousAccountId).toBe(NEW_ACCOUNT);
  });

  it('threat: a crash while creating the new account resumes, and discard waits for it', async () => {
    const { laptop } = await family();
    laptop.store.failOnSet = (name) => name === 'registry';
    await expect(restart(laptop.lifecycle)).rejects.toThrow('simulated crash');
    laptop.store.failOnSet = undefined;
    // The device holds no account, and says why.
    expect(await laptop.lifecycle.status()).toBeNull();
    expect(await laptop.lifecycle.previousAccount()).toEqual({
      accountId: ACCOUNT,
      interrupted: true,
    });
    await expectCode(
      laptop.lifecycle.discardPreviousAccount(),
      'restart_incomplete',
    );
    const finished = await restart(laptop.lifecycle);
    expect(finished.previousAccountId).toBe(ACCOUNT);
    expect((await laptop.lifecycle.status())?.accountId).toBe(NEW_ACCOUNT);
    expect(await sealingKeyId(laptop.lifecycle)).toBe(finished.keyId);
  });

  it('threat: a crash while parking the old account leaves it intact and resumes', async () => {
    const { laptop } = await family();
    const before = itemNames(laptop.store).filter((name) =>
      name.startsWith('key.'),
    );
    laptop.store.failOnSet = (name) => name === 'previous-registry';
    await expect(restart(laptop.lifecycle)).rejects.toThrow('simulated crash');
    laptop.store.failOnSet = undefined;
    // Still the old account, still sealing.
    expect((await laptop.lifecycle.status())?.accountId).toBe(ACCOUNT);
    await sealingKeyId(laptop.lifecycle);
    // Parked registry copied but not yet removed: also resumes.
    laptop.store.items.set(
      'previous-registry',
      new Uint8Array(laptop.store.items.get('registry') as Uint8Array),
    );
    const finished = await restart(laptop.lifecycle);
    expect(finished.previousAccountId).toBe(ACCOUNT);
    expect(
      itemNames(laptop.store).filter(
        (name) => name.startsWith('key.') && before.includes(name),
      ),
    ).toEqual(before);
  });

  it('reports a restart interrupted while parking, and a retry completes it', async () => {
    const { laptop } = await family();
    // Everything is parked, but the old registry could not be removed.
    const realDelete = laptop.store.delete.bind(laptop.store);
    let failed = false;
    laptop.store.delete = async (name) => {
      if (name === 'registry' && !failed) {
        failed = true;
        throw new Error('simulated crash');
      }
      await realDelete(name);
    };
    await expect(restart(laptop.lifecycle)).rejects.toThrow('simulated crash');
    expect(await laptop.lifecycle.previousAccount()).toEqual({
      accountId: ACCOUNT,
      interrupted: true,
    });
    const finished = await restart(laptop.lifecycle);
    expect(finished.previousAccountId).toBe(ACCOUNT);
    expect(await laptop.lifecycle.previousAccount()).toEqual({
      accountId: ACCOUNT,
      interrupted: false,
    });
    expect(await sealingKeyId(laptop.lifecycle)).toBe(finished.keyId);
  });

  it('discard removes only the parked account and never the new keys', async () => {
    const { laptop } = await family();
    const oldKeys = itemNames(laptop.store).filter(
      (name) => name.startsWith('key.') || name.startsWith('recovery.'),
    );
    expect(oldKeys.length).toBeGreaterThan(0);
    const published = await restart(laptop.lifecycle);
    const newKeys = [
      `key.${published.generation}.${published.keyId}`,
      `recovery.${published.generation}.${published.keyId}`,
    ];
    await laptop.lifecycle.discardPreviousAccount();
    const left = itemNames(laptop.store);
    for (const name of oldKeys) expect(left).not.toContain(name);
    for (const name of newKeys) expect(left).toContain(name);
    expect(left.filter((name) => name.startsWith('previous-'))).toEqual([]);
    expect(await sealingKeyId(laptop.lifecycle)).toBe(published.keyId);
    // Idempotent.
    await laptop.lifecycle.discardPreviousAccount();
  });

  describe('rescue reader for the parked account (#4838)', () => {
    function snapshotOf(store: MemoryStore) {
      return JSON.stringify(
        [...store.items.entries()]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([name, value]) => [name, Buffer.from(value).toString('hex')]),
      );
    }

    async function parked() {
      const { laptop } = await family();
      const old = await laptop.lifecycle.openSealingKey();
      const oldKey = Buffer.from(old.key);
      old.key.fill(0);
      const published = await restart(laptop.lifecycle);
      const ask = (patch: Record<string, unknown> = {}) =>
        laptop.lifecycle.openPreviousReadingKey({
          accountId: ACCOUNT,
          generation: old.generation,
          keyId: old.keyId,
          ...patch,
        });
      return { laptop, old, oldKey, published, ask };
    }

    it('opens a parked data key bound to the old account, without writing', async () => {
      const { laptop, old, oldKey, ask } = await parked();
      const before = snapshotOf(laptop.store);
      const reading = await ask();
      expect(reading).toMatchObject({
        purpose: 'read',
        accountId: ACCOUNT,
        generation: old.generation,
        keyId: old.keyId,
      });
      expect(Buffer.from(reading.key).equals(oldKey)).toBe(true);
      expect(snapshotOf(laptop.store)).toBe(before);
      // The key does not survive JSON or a spread, nor reach an error.
      const text = JSON.stringify(reading, (_, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      expect(text).not.toContain(oldKey.toString('base64'));
      expect(text).not.toContain('"key"');
      expect(Object.keys({ ...reading })).not.toContain('key');
      reading.key.fill(0);
      // Sealing stays on the new account.
      expect((await laptop.lifecycle.openSealingKey()).accountId).toBe(
        NEW_ACCOUNT,
      );
    });

    it('also opens it while the restart is interrupted', async () => {
      const { laptop } = await family();
      const old = await laptop.lifecycle.openSealingKey();
      old.key.fill(0);
      laptop.store.failOnSet = (name) => name === 'registry';
      await expect(restart(laptop.lifecycle)).rejects.toThrow(
        'simulated crash',
      );
      laptop.store.failOnSet = undefined;
      const reading = await laptop.lifecycle.openPreviousReadingKey({
        accountId: ACCOUNT,
        generation: old.generation,
        keyId: old.keyId,
      });
      expect(reading.accountId).toBe(ACCOUNT);
      reading.key.fill(0);
    });

    it('refuses when nothing is parked', async () => {
      const { laptop } = await family();
      const current = await laptop.lifecycle.openSealingKey();
      current.key.fill(0);
      await expectCode(
        laptop.lifecycle.openPreviousReadingKey({
          accountId: ACCOUNT,
          generation: current.generation,
          keyId: current.keyId,
        }),
        'no_previous_account',
      );
    });

    it('refuses after the parked account is discarded', async () => {
      const { laptop, ask } = await parked();
      await laptop.lifecycle.discardPreviousAccount();
      await expectCode(ask(), 'no_previous_account');
    });

    it('refuses a different account id, including the current account', async () => {
      const { ask, published } = await parked();
      await expectCode(ask({ accountId: NEW_ACCOUNT }), 'account_mismatch');
      await expectCode(
        ask({ accountId: 'vault-account-c' }),
        'account_mismatch',
      );
      await expectCode(ask({ accountId: undefined }), 'invalid_input');
      // A key of the current account is not a parked key.
      await expectCode(
        ask({ generation: published.generation, keyId: published.keyId }),
        'key_missing',
      );
      await expectCode(ask({ keyId: '0'.repeat(32) }), 'key_missing');
    });

    it('fails closed, with no key in the message, when the parked secret is gone', async () => {
      const { laptop, oldKey, ask } = await parked();
      laptop.store.items.delete('previous-device-secret');
      const error = await expectCode(ask(), 'invalid_state');
      expect(error.message).not.toContain(oldKey.toString('base64'));
    });
  });

  it('threat: secret material never reaches the parked or new records', async () => {
    const { laptop } = await family();
    await restart(laptop.lifecycle);
    for (const name of ['registry', 'previous-registry']) {
      const text = Buffer.from(
        laptop.store.items.get(name) as Uint8Array,
      ).toString();
      expect(text).not.toContain(RECOVERY_SECRET);
      expect(text).not.toContain(RESTART_SECRET);
    }
  });
});

describe('vault key lifecycle: recovery secret rotation', () => {
  it('rotates the recovery secret without changing the account authority', async () => {
    const { laptop, phone } = await family();
    const authority = (await laptop.lifecycle.status())?.authorityPublicKey;
    await expectCode(
      laptop.lifecycle.rotate({
        recoverySecret: RECOVERY_SECRET,
        newRecoverySecret: 'short',
      }),
      'invalid_input',
    );
    const rotated = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
      newRecoverySecret: NEW_RECOVERY_SECRET,
    });
    expect((await laptop.lifecycle.status())?.authorityPublicKey).toBe(
      authority,
    );
    expect(laptop.store.items.has('authority-next')).toBe(false);
    await phone.lifecycle.acceptDeviceGrant(grantFor(rotated.grants, 'phone'));
    // Only the new secret now authorizes changes on either device.
    for (const target of [laptop, phone]) {
      await expectCode(
        target.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET }),
        'recovery_rejected',
      );
    }
    const again = await phone.lifecycle.rotate({
      recoverySecret: NEW_RECOVERY_SECRET,
    });
    // The new recovery record and authority record restore with the new
    // secret only.
    const input = {
      accountId: ACCOUNT,
      deviceId: 'replacement',
      head: again.head,
      authorityRecord: again.authorityRecord,
      recoveryRecord: again.recoveryRecord,
    };
    await expectCode(
      device().lifecycle.enrollFromRecovery({
        ...input,
        recoverySecret: RECOVERY_SECRET,
      }),
      'recovery_rejected',
    );
    await device().lifecycle.enrollFromRecovery({
      ...input,
      recoverySecret: NEW_RECOVERY_SECRET,
    });
  });
});

describe('vault key lifecycle: review regressions', () => {
  it('threat: a head learned without its authority record never revives the old secret', async () => {
    const { laptop, phone } = await family();
    const rotated = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
      newRecoverySecret: NEW_RECOVERY_SECRET,
    });
    // The phone learns the head from the relay without the record.
    await phone.lifecycle.acceptAccountHead(rotated.head);
    await expectCode(
      phone.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET }),
      'recovery_rejected',
    );
    expect((await phone.lifecycle.accountHead()).authorityRecord).toBeNull();
    // With the record, only the new secret authorizes.
    await phone.lifecycle.acceptAccountHead(
      rotated.head,
      rotated.authorityRecord,
    );
    await expectCode(
      phone.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET }),
      'recovery_rejected',
    );
    expect(
      (await phone.lifecycle.rotate({ recoverySecret: NEW_RECOVERY_SECRET }))
        .generation,
    ).toBe(3n);
  });

  it('settles a recovery-secret rotation interrupted after its commit', async () => {
    const { laptop } = await family();
    laptop.store.failOnSet = (name) => name === 'authority';
    await expect(
      laptop.lifecycle.rotate({
        recoverySecret: RECOVERY_SECRET,
        newRecoverySecret: NEW_RECOVERY_SECRET,
      }),
    ).rejects.toThrow('simulated crash');
    laptop.store.failOnSet = undefined;
    expect((await laptop.lifecycle.status())?.currentGeneration).toBe(2n);
    await expectCode(
      laptop.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET }),
      'recovery_rejected',
    );
    await laptop.lifecycle.rotate({ recoverySecret: NEW_RECOVERY_SECRET });
    expect(laptop.store.items.has('authority-next')).toBe(false);
  });

  it('retries initialization and enrollment after a crash before the registry', async () => {
    const laptop = device();
    laptop.store.failOnSet = (name) => name === 'registry';
    const input = {
      accountId: ACCOUNT,
      deviceId: 'laptop',
      recoverySecret: RECOVERY_SECRET,
    };
    await expect(laptop.lifecycle.initializeAccount(input)).rejects.toThrow(
      'simulated crash',
    );
    laptop.store.failOnSet = undefined;
    await laptop.lifecycle.initializeAccount(input);

    const joiner = device();
    const { request, deviceCode } =
      await joiner.lifecycle.createEnrollmentRequest({
        accountId: ACCOUNT,
        deviceId: 'phone',
      });
    const { grant, accountCode } = await laptop.lifecycle.enrollDevice(
      request,
      { confirmationCode: deviceCode, recoverySecret: RECOVERY_SECRET },
    );
    joiner.store.failOnSet = (name) => name === 'registry';
    await expect(
      joiner.lifecycle.acceptEnrollment(grant, {
        confirmationCode: accountCode,
      }),
    ).rejects.toThrow('simulated crash');
    joiner.store.failOnSet = undefined;
    const status = await joiner.lifecycle.acceptEnrollment(grant, {
      confirmationCode: accountCode,
    });
    expect(status.deviceId).toBe('phone');
  });

  it('merges branches that enrolled one device ID twice by revoking both', async () => {
    const { laptop, phone } = await family();
    await enroll(laptop.lifecycle, 'watch');
    await enroll(phone.lifecycle, 'watch');
    const forked = await laptop.lifecycle.acceptAccountHead(
      (await phone.lifecycle.accountHead()).head,
    );
    expect(forked.conflict).toBe(true);
    const merged = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    const status = await laptop.lifecycle.status();
    expect(status?.conflict).toBe(false);
    expect(
      status?.revokedDevices.map((entry) => entry.deviceId).sort(),
    ).toEqual(['watch', 'watch']);
    expect(merged.grants.map((grant) => grant.recipientDeviceId)).toEqual([
      'phone',
      'tablet',
    ]);
    const atPhone = await phone.lifecycle.acceptDeviceGrant(
      grantFor(merged.grants, 'phone'),
    );
    expect(atPhone.conflict).toBe(false);
  });
});

describe('vault key lifecycle: grant integrity', () => {
  it('threat: every grant field is authenticated, not only the wrapped keys', async () => {
    const { laptop, phone } = await family();
    const update = await laptop.lifecycle.createDeviceGrant('phone');
    const otherAccount = await initialized('other');
    const foreignRecovery = Buffer.from(
      [...otherAccount.store.items.entries()].find(([name]) =>
        name.startsWith('recovery.'),
      )?.[1] as Uint8Array,
    ).toString('base64url');
    for (const forged of [
      tamper(update, { issuedAt: '2000-01-01T00:00:00.000Z' }),
      tamper(update, { senderDeviceId: 'tablet' }),
      tamper(update, {
        authorityRecord: Buffer.from(
          (await otherAccount.lifecycle.accountHead()).authorityRecord,
        ).toString('base64url'),
      }),
      tamper(update, {
        generations: update.generations.map((entry) => ({
          ...entry,
          recoveryRecord: foreignRecovery,
        })),
      }),
      tamper(update, {
        generations: update.generations.map((entry) => ({
          ...entry,
          keyId: 'e'.repeat(32),
        })),
      }),
      tamper(update, {
        head: (await otherAccount.lifecycle.accountHead()).head,
      }),
    ]) {
      await expectCode(
        phone.lifecycle.acceptDeviceGrant(forged),
        'grant_rejected',
      );
    }
    await phone.lifecycle.acceptDeviceGrant(update);
  });

  it('refuses to rotate past the generation limit instead of saving an unreadable registry', async () => {
    const laptop = await initialized();
    const registry = parseVaultDeviceRegistry(
      Buffer.from(laptop.store.items.get('registry') as Uint8Array).toString(),
    );
    // Sign a 1024-generation head with the account authority.
    const seed = (
      await openVaultRecoveryKey(
        laptop.store.items.get('authority') as Uint8Array,
        RECOVERY_SECRET,
        { accountId: ACCOUNT, generation: 0n },
      )
    ).key;
    const template = registry.head.generations[0];
    const generations = Array.from({ length: 1024 }, (_, index) =>
      index === 0
        ? template
        : {
            ...template,
            generation: BigInt(index + 1),
            keyId: randomBytes(16).toString('hex'),
          },
    );
    registry.head = signHead(
      {
        ...registry.head,
        sequence: 2n,
        current: {
          generation: 1024n,
          keyId: generations[1023].keyId,
        },
        generations,
      },
      seed,
    );
    laptop.store.items.set(
      'registry',
      new Uint8Array(Buffer.from(serializeVaultDeviceRegistry(registry))),
    );
    expect((await laptop.lifecycle.status())?.generations).toHaveLength(1024);
    const saved = laptop.store.items.get('registry');
    await expectCode(
      laptop.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET }),
      'generation_limit',
    );
    expect(laptop.store.items.get('registry')).toBe(saved);
    await expectCode(laptop.lifecycle.openSealingKey(), 'key_missing');
  });
});

describe('vault key lifecycle: secret custody', () => {
  it('threat: secret material never reaches registries, heads, grants or errors', async () => {
    const { laptop, phone } = await family();
    await laptop.lifecycle.revokeDevice('tablet', {
      recoverySecret: RECOVERY_SECRET,
    });
    const rotated = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    await phone.lifecycle.acceptDeviceGrant(grantFor(rotated.grants, 'phone'));

    const secrets: Uint8Array[] = [
      (
        await openVaultRecoveryKey(
          laptop.store.items.get('authority') as Uint8Array,
          RECOVERY_SECRET,
          { accountId: ACCOUNT, generation: 0n },
        )
      ).key,
    ];
    for (const target of [laptop, phone]) {
      secrets.push(target.store.items.get('device-secret') as Uint8Array);
      for (const entry of (await target.lifecycle.status())?.generations ??
        []) {
        secrets.push((await target.lifecycle.openReadingKey(entry)).key);
        secrets.push(
          target.store.items.get(
            `key.${entry.generation}.${entry.keyId}`,
          ) as Uint8Array,
        );
      }
    }
    const encodings = secrets.flatMap((bytes) => {
      const buffer = Buffer.from(bytes);
      return [
        buffer.toString('hex'),
        buffer.toString('base64'),
        buffer.toString('base64url'),
        buffer.subarray(0, 12).toString('latin1'),
      ];
    });

    const errors: string[] = [];
    for (const attempt of [
      laptop.lifecycle.rotate({ recoverySecret: 'incorrect recovery secret' }),
      phone.lifecycle.acceptDeviceGrant(
        tamper(rotated.grants[0], { accountId: 'other' }),
      ),
      laptop.lifecycle.createDeviceGrant('tablet'),
    ]) {
      const error = await attempt.catch((caught: Error) => caught);
      errors.push(`${(error as Error).message} ${(error as Error).stack}`);
    }

    const published = [
      Buffer.from(laptop.store.items.get('registry') as Uint8Array).toString(),
      Buffer.from(phone.store.items.get('registry') as Uint8Array).toString(),
      JSON.stringify(rotated.head),
      JSON.stringify(rotated.grants),
      ...errors,
    ].join('\n');
    for (const encoded of encodings) {
      expect(published.includes(encoded)).toBe(false);
    }
    expect(Object.keys(rotated.head).sort()).toEqual([
      'accountId',
      'authorityPublicKey',
      'authorityRecordDigest',
      'current',
      'devices',
      'format',
      'generations',
      'issuedAt',
      'issuerDeviceId',
      'revokedDevices',
      'sequence',
      'signature',
      'version',
    ]);
    expect(
      [...laptop.store.items.keys()].filter(
        (name) =>
          !/^(registry|authority|device-secret|(key|recovery)\.\d+\.[0-9a-f]{32})$/.test(
            name,
          ),
      ),
    ).toEqual([]);
  });

  it('rejects a corrupt or hostile registry without exposing its contents', async () => {
    const { laptop } = await family();
    const original = laptop.store.items.get('registry') as Uint8Array;
    const text = Buffer.from(original).toString();
    const registry = JSON.parse(text);
    for (const replacement of [
      'not json',
      '{"format":"smrt-vault-device-registry","version":2}',
      text.replace('{"format"', '{"__proto__":{"x":1},"format"'),
      // A registry edited to drop a device fails the head signature.
      JSON.stringify({
        ...registry,
        head: { ...registry.head, devices: registry.head.devices.slice(0, 2) },
      }),
      JSON.stringify({
        ...registry,
        keys: [],
        pendingRevocations: [
          {
            deviceId: 'laptop',
            publicKey: registry.head.devices[0].publicKey,
            revokedAt: registry.head.issuedAt,
          },
        ],
      }),
    ]) {
      laptop.store.items.set(
        'registry',
        new Uint8Array(Buffer.from(replacement)),
      );
      const error = await expectCode(
        laptop.lifecycle.openSealingKey(),
        'invalid_state',
      );
      expect(error.message).toBe('Vault key state on this device is invalid');
    }
    laptop.store.items.set('registry', original);
    expect((await laptop.lifecycle.openSealingKey()).generation).toBe(1n);
    laptop.store.items.set('device-secret', randomBytes(32));
    await expectCode(laptop.lifecycle.openSealingKey(), 'invalid_state');
  });
});
