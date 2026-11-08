import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openVaultDeviceKey } from './vault-device-key.js';
import {
  createVaultKeyLifecycle,
  parseVaultDeviceRegistry,
  serializeVaultDeviceRegistry,
  type VaultDeviceGrant,
  type VaultKeyLifecycle,
  VaultKeyLifecycleError,
} from './vault-key-lifecycle.js';
import type { VaultKeyStore } from './vault-key-store.js';

const RECOVERY_SECRET = 'synthetic recovery credential';
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

function device(store = memoryStore()) {
  return { store, lifecycle: createVaultKeyLifecycle({ store }) };
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
  const request = await joiner.lifecycle.createEnrollmentRequest({
    accountId,
    deviceId,
  });
  const grant = await enroller.enrollDevice(request);
  await joiner.lifecycle.acceptEnrollment(grant);
  return joiner;
}

async function family() {
  const laptop = device();
  await laptop.lifecycle.initializeAccount({
    accountId: ACCOUNT,
    deviceId: 'laptop',
    recoverySecret: RECOVERY_SECRET,
  });
  const phone = await enroll(laptop.lifecycle, 'phone');
  const tablet = await enroll(laptop.lifecycle, 'tablet');
  return { laptop, phone, tablet };
}

function tamper(grant: VaultDeviceGrant, patch: Partial<VaultDeviceGrant>) {
  return { ...structuredClone(grant), ...patch } as VaultDeviceGrant;
}

describe('vault key lifecycle: enrollment', () => {
  it('enrolls a device that opens the same key and records both devices', async () => {
    const laptop = device();
    const initialized = await laptop.lifecycle.initializeAccount({
      accountId: ACCOUNT,
      deviceId: 'laptop',
      recoverySecret: RECOVERY_SECRET,
    });
    expect(initialized.generation).toBe(1n);
    const phone = await enroll(laptop.lifecycle, 'phone');

    const laptopKey = await laptop.lifecycle.openCurrentKey();
    const phoneKey = await phone.lifecycle.openCurrentKey();
    expect(phoneKey).toEqual({ ...laptopKey, deviceId: 'phone' });

    for (const status of [
      await laptop.lifecycle.status(),
      await phone.lifecycle.status(),
    ]) {
      expect(status?.devices.map((entry) => entry.deviceId).sort()).toEqual([
        'laptop',
        'phone',
      ]);
      expect(status?.devices[1]).toMatchObject({
        generation: 1n,
        keyId: initialized.keyId,
        enrolledAt: expect.any(String),
      });
    }
    expect(phone.store.items.has('enrollment-request')).toBe(false);
  });

  it('enrolls a fresh machine from the recovery code through the same registry', async () => {
    const laptop = device();
    const { generation, keyId, recoveryRecord } =
      await laptop.lifecycle.initializeAccount({
        accountId: ACCOUNT,
        deviceId: 'laptop',
        recoverySecret: RECOVERY_SECRET,
      });
    const fresh = device();
    const input = {
      accountId: ACCOUNT,
      deviceId: 'replacement',
      generation,
      keyId,
      recoveryRecord,
      recoverySecret: RECOVERY_SECRET,
    };
    await expectCode(
      fresh.lifecycle.enrollFromRecovery({
        ...input,
        recoverySecret: 'incorrect recovery credential',
      }),
      'recovery_rejected',
    );
    await expectCode(
      fresh.lifecycle.enrollFromRecovery({ ...input, accountId: 'other' }),
      'recovery_rejected',
    );
    await expectCode(
      fresh.lifecycle.enrollFromRecovery({ ...input, generation: 2n }),
      'recovery_rejected',
    );
    await expectCode(
      fresh.lifecycle.enrollFromRecovery({ ...input, keyId: '0'.repeat(32) }),
      'recovery_rejected',
    );
    expect(fresh.store.items.has('registry')).toBe(false);

    const status = await fresh.lifecycle.enrollFromRecovery(input);
    expect(status.devices.map((entry) => entry.deviceId)).toEqual([
      'replacement',
    ]);
    expect((await fresh.lifecycle.openCurrentKey()).key).toEqual(
      (await laptop.lifecycle.openCurrentKey()).key,
    );
    await expectCode(
      fresh.lifecycle.enrollFromRecovery(input),
      'already_initialized',
    );
  });

  it('threat: enrollment cannot substitute account, device ID or generation', async () => {
    const laptop = device();
    await laptop.lifecycle.initializeAccount({
      accountId: ACCOUNT,
      deviceId: 'laptop',
      recoverySecret: RECOVERY_SECRET,
    });
    const joiner = device();
    const request = await joiner.lifecycle.createEnrollmentRequest({
      accountId: ACCOUNT,
      deviceId: 'phone',
    });

    // The enrolling side checks the request against its own account and
    // devices before it wraps anything.
    await expectCode(
      laptop.lifecycle.enrollDevice({ ...request, accountId: 'other' }),
      'account_mismatch',
    );
    await expectCode(
      laptop.lifecycle.enrollDevice({ ...request, deviceId: 'laptop' }),
      'device_conflict',
    );

    const grant = await laptop.lifecycle.enrollDevice(request);
    await expectCode(
      laptop.lifecycle.enrollDevice({
        ...request,
        publicKey: Buffer.alloc(32, 9).toString('base64url'),
      }),
      'device_conflict',
    );

    // The new device checks the grant against its own pending request and
    // the authenticated context of every wrapped key.
    const generation = grant.generations[0];
    for (const forged of [
      tamper(grant, { accountId: 'other' }),
      tamper(grant, { recipientDeviceId: 'tablet' }),
      tamper(grant, { kind: 'update' }),
      tamper(grant, {
        generations: [{ ...generation, generation: '2' }],
        currentGeneration: '2',
      }),
      tamper(grant, {
        generations: [{ ...generation, keyId: 'f'.repeat(32) }],
      }),
      tamper(grant, { senderDeviceId: 'tablet' }),
    ]) {
      await expectCode(
        joiner.lifecycle.acceptEnrollment(forged),
        'grant_rejected',
      );
    }

    // A grant made for a different pairing request cannot be accepted.
    const other = device();
    const otherRequest = await other.lifecycle.createEnrollmentRequest({
      accountId: ACCOUNT,
      deviceId: 'phone-2',
    });
    const otherGrant = await laptop.lifecycle.enrollDevice(otherRequest);
    await expectCode(
      joiner.lifecycle.acceptEnrollment(
        tamper(otherGrant, { recipientDeviceId: 'phone' }),
      ),
      'grant_rejected',
    );
    // A grant sealed by a device outside the pairing exchange is rejected.
    const impostor = device();
    await impostor.lifecycle.initializeAccount({
      accountId: ACCOUNT,
      deviceId: 'laptop',
      recoverySecret: RECOVERY_SECRET,
    });
    await expectCode(
      joiner.lifecycle.acceptEnrollment(
        tamper(await impostor.lifecycle.enrollDevice(request), {
          senderPublicKey: grant.senderPublicKey,
        }),
      ),
      'grant_rejected',
    );
    expect(joiner.store.items.has('registry')).toBe(false);

    await joiner.lifecycle.acceptEnrollment(grant);
    expect((await joiner.lifecycle.status())?.accountId).toBe(ACCOUNT);
  });
});

describe('vault key lifecycle: rotation and revocation', () => {
  it('rotates for every active device and keeps old generations read-only', async () => {
    const { laptop, phone, tablet } = await family();
    const before = await laptop.lifecycle.openCurrentKey();

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
    for (const [target, grant] of [
      [phone, rotated.grants[0]],
      [tablet, rotated.grants[1]],
    ] as const) {
      const status = await target.lifecycle.acceptDeviceGrant(grant);
      expect(status.currentGeneration).toBe(2n);
      expect(status.generations.map((entry) => entry.status)).toEqual([
        'read-only',
        'current',
      ]);
    }
    const after = await laptop.lifecycle.openCurrentKey();
    expect(after.key).not.toEqual(before.key);
    expect((await phone.lifecycle.openCurrentKey()).key).toEqual(after.key);
    expect((await tablet.lifecycle.openGenerationKey(1n)).key).toEqual(
      before.key,
    );
    expect(await laptop.lifecycle.recoveryRecord(2n)).toEqual(
      rotated.recoveryRecord,
    );

    // The rotated recovery record opens with the unchanged recovery code.
    const fresh = device();
    await fresh.lifecycle.enrollFromRecovery({
      accountId: ACCOUNT,
      deviceId: 'replacement',
      generation: 2n,
      keyId: rotated.keyId,
      recoveryRecord: rotated.recoveryRecord,
      recoverySecret: RECOVERY_SECRET,
    });
    expect((await fresh.lifecycle.openCurrentKey()).key).toEqual(after.key);
  });

  it('threat: a revoked device cannot reuse an old wrapper after rotation', async () => {
    const { laptop, phone, tablet } = await family();
    const oldPhoneRecord = phone.store.items.get('key.1') as Uint8Array;
    const phoneSecret = phone.store.items.get('device-secret') as Uint8Array;
    const phoneGrantBeforeRevoke =
      await phone.lifecycle.createDeviceGrant('laptop');

    const revoked = await laptop.lifecycle.revokeDevice('phone');
    expect(revoked.rotationRequired).toBe(true);
    expect(revoked.devices.map((entry) => entry.deviceId)).toEqual([
      'laptop',
      'tablet',
    ]);
    // Revocation is not effective until rotation: new snapshots are refused.
    await expectCode(laptop.lifecycle.openCurrentKey(), 'rotation_required');
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
    const newKey = await laptop.lifecycle.openCurrentKey();

    // The revoked wrapper cannot open the new generation under any context.
    expect(() =>
      openVaultDeviceKey(oldPhoneRecord, phoneSecret, {
        accountId: ACCOUNT,
        deviceId: 'phone',
        generation: 2n,
        keyId: newKey.keyId,
      }),
    ).toThrow('Vault device key authentication failed');
    // A rotation grant addressed to another device is useless to it.
    await expectCode(
      phone.lifecycle.acceptDeviceGrant(
        tamper(rotated.grants[0], { recipientDeviceId: 'phone' }),
      ),
      'grant_rejected',
    );
    // Devices that know the revocation reject the revoked device's grants,
    // including ones it issued before it was revoked.
    await expectCode(
      laptop.lifecycle.acceptDeviceGrant(phoneGrantBeforeRevoke),
      'device_revoked',
    );
    // The revoked device still holds only generation 1.
    expect((await phone.lifecycle.status())?.currentGeneration).toBe(1n);
    await expectCode(
      phone.lifecycle.openGenerationKey(2n),
      'generation_conflict',
    );
    // A revoked identity cannot enroll again under the same ID or key.
    const reenroll = device();
    await expectCode(
      laptop.lifecycle.enrollDevice(
        await reenroll.lifecycle.createEnrollmentRequest({
          accountId: ACCOUNT,
          deviceId: 'phone',
        }),
      ),
      'device_revoked',
    );
  });

  it('threat: a crash mid-rotation leaves the current key usable and resumes', async () => {
    const { laptop } = await family();
    const before = await laptop.lifecycle.openCurrentKey();

    // Crash after the candidate is recorded and its device record written,
    // before the recovery record and the commit.
    laptop.store.failOnSet = (name) => name === 'recovery.2';
    await expect(
      laptop.lifecycle.rotate({ recoverySecret: RECOVERY_SECRET }),
    ).rejects.toThrow('simulated crash');
    laptop.store.failOnSet = undefined;
    let status = await laptop.lifecycle.status();
    expect(status?.currentGeneration).toBe(1n);
    expect(status?.pendingRotation?.generation).toBe(2n);
    expect((await laptop.lifecycle.openCurrentKey()).key).toEqual(before.key);

    // An incomplete candidate is replaced, never committed.
    const replaced = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    expect(replaced.generation).toBe(2n);
    expect(replaced.keyId).not.toBe(status?.pendingRotation?.keyId);
    expect((await laptop.lifecycle.openGenerationKey(1n)).key).toEqual(
      before.key,
    );

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
    expect((await laptop.lifecycle.openCurrentKey()).keyId).toBe(
      replaced.keyId,
    );
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
    expect((await laptop.lifecycle.openGenerationKey(1n)).key).toEqual(
      before.key,
    );
  });

  it('threat: grants cannot downgrade to an earlier or conflicting generation', async () => {
    const { laptop, phone } = await family();
    const staleGrant = await laptop.lifecycle.createDeviceGrant('phone');
    const rotated = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    await phone.lifecycle.acceptDeviceGrant(rotated.grants[0]);
    const current = await phone.lifecycle.openCurrentKey();

    // Replaying an older grant never lowers the current generation.
    const status = await phone.lifecycle.acceptDeviceGrant(staleGrant);
    expect(status.currentGeneration).toBe(2n);
    expect(await phone.lifecycle.openCurrentKey()).toEqual(current);
    // Claiming a lower current generation inside a fresh grant is rejected
    // or ignored, and relabelling a wrapper fails authentication.
    const fresh = await laptop.lifecycle.createDeviceGrant('phone');
    await expectCode(
      phone.lifecycle.acceptDeviceGrant(
        tamper(fresh, { currentGeneration: '1' }),
      ),
      'grant_rejected',
    );
    await expectCode(
      phone.lifecycle.acceptDeviceGrant(
        tamper(fresh, {
          generations: fresh.generations.map((entry) => ({
            ...entry,
            generation: entry.generation === '2' ? '3' : entry.generation,
          })),
          currentGeneration: '3',
        }),
      ),
      'grant_rejected',
    );
    expect(await phone.lifecycle.openCurrentKey()).toEqual(current);
  });

  it('threat: generation conflicts from an enrolled sender are rejected', async () => {
    const { laptop, phone, tablet } = await family();
    // Two devices rotate concurrently to the same generation.
    const fromPhone = await phone.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    const fromTablet = await tablet.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    const forLaptop = (grants: VaultDeviceGrant[]) =>
      grants.find(
        (grant) => grant.recipientDeviceId === 'laptop',
      ) as VaultDeviceGrant;
    expect(fromTablet.generation).toBe(fromPhone.generation);
    await laptop.lifecycle.acceptDeviceGrant(forLaptop(fromPhone.grants));
    await expectCode(
      laptop.lifecycle.acceptDeviceGrant(forLaptop(fromTablet.grants)),
      'generation_conflict',
    );
    expect((await laptop.lifecycle.openCurrentKey()).keyId).toBe(
      fromPhone.keyId,
    );
  });
});

describe('vault key lifecycle: secret custody', () => {
  it('threat: secret material never reaches registries, grants or errors', async () => {
    const { laptop, phone } = await family();
    await laptop.lifecycle.revokeDevice('tablet');
    const rotated = await laptop.lifecycle.rotate({
      recoverySecret: RECOVERY_SECRET,
    });
    await phone.lifecycle.acceptDeviceGrant(rotated.grants[0]);

    const secrets: Uint8Array[] = [];
    for (const target of [laptop, phone]) {
      secrets.push(target.store.items.get('device-secret') as Uint8Array);
      for (const generation of [1n, 2n]) {
        secrets.push(
          (await target.lifecycle.openGenerationKey(generation)).key,
        );
        secrets.push(target.store.items.get(`key.${generation}`) as Uint8Array);
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
      serializeVaultDeviceRegistry(
        (await laptop.lifecycle.status()) as NonNullable<
          Awaited<ReturnType<VaultKeyLifecycle['status']>>
        >,
      ),
      JSON.stringify(rotated.grants),
      ...errors,
    ].join('\n');
    for (const encoded of encodings) {
      expect(published.includes(encoded)).toBe(false);
    }
    const registry = parseVaultDeviceRegistry(
      Buffer.from(laptop.store.items.get('registry') as Uint8Array).toString(),
    );
    expect(Object.keys(registry).sort()).toEqual([
      'accountId',
      'currentGeneration',
      'deviceId',
      'devices',
      'generations',
      'pendingRotation',
      'revokedDevices',
    ]);
    expect(
      [...laptop.store.items.keys()].filter(
        (name) =>
          name !== 'registry' &&
          !/^(device-secret|key\.\d+|recovery\.\d+)$/.test(name),
      ),
    ).toEqual([]);
  });

  it('rejects a corrupt or hostile registry without exposing its contents', async () => {
    const { laptop } = await family();
    const original = laptop.store.items.get('registry') as Uint8Array;
    for (const replacement of [
      'not json',
      '{"format":"smrt-vault-device-registry","version":2}',
      Buffer.from(original)
        .toString()
        .replace('"status":"current"', '"status":"read-only"'),
      Buffer.from(original)
        .toString()
        .replace('{"format"', '{"__proto__":{"x":1},"format"'),
    ]) {
      laptop.store.items.set(
        'registry',
        new Uint8Array(Buffer.from(replacement)),
      );
      const error = await expectCode(
        laptop.lifecycle.openCurrentKey(),
        'invalid_state',
      );
      expect(error.message).toBe('Vault key state on this device is invalid');
    }
    laptop.store.items.set('registry', original);
    expect((await laptop.lifecycle.openCurrentKey()).generation).toBe(1n);
    laptop.store.items.set('device-secret', randomBytes(32));
    await expectCode(laptop.lifecycle.openCurrentKey(), 'invalid_state');
  });
});
