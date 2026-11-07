import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openVaultDeviceKey } from './vault-device-key.js';
import { prepareVaultKeyGeneration } from './vault-key-generation.js';
import { openVaultRecoveryKey } from './vault-recovery.js';

describe('prepareVaultKeyGeneration', () => {
  const options = {
    accountId: 'vault-account',
    deviceId: 'active-device',
    deviceSecret: randomBytes(32),
    recoverySecret: 'synthetic recovery credential',
    currentGeneration: null,
  };

  it('prepares the same fresh key in both records and returns no raw key', async () => {
    const prepared = await prepareVaultKeyGeneration(options);
    expect(prepared).toEqual({
      accountId: options.accountId,
      deviceId: options.deviceId,
      generation: 1n,
      keyId: expect.stringMatching(/^[0-9a-f]{32}$/),
      deviceRecord: expect.any(Uint8Array),
      recoveryRecord: expect.any(Uint8Array),
    });

    for (const record of [prepared.deviceRecord, prepared.recoveryRecord]) {
      expect(record.byteOffset).toBe(0);
      expect(record.buffer.byteLength).toBe(record.byteLength);
    }

    const deviceKey = openVaultDeviceKey(
      prepared.deviceRecord,
      options.deviceSecret,
      prepared,
    );
    expect(deviceKey).toHaveLength(32);
    await expect(
      openVaultRecoveryKey(
        prepared.recoveryRecord,
        options.recoverySecret,
        prepared,
      ),
    ).resolves.toEqual({ keyId: prepared.keyId, key: deviceKey });
    expect(() =>
      openVaultDeviceKey(prepared.deviceRecord, options.deviceSecret, {
        ...prepared,
        accountId: 'other-account',
      }),
    ).toThrow('Vault device key authentication failed');
    await expect(
      openVaultRecoveryKey(
        prepared.recoveryRecord,
        'incorrect recovery credential',
        prepared,
      ),
    ).rejects.toThrow('Vault recovery authentication failed');
  });

  it('prepares a new key and rejects records replayed across generations', async () => {
    const before = await prepareVaultKeyGeneration(options);
    const nextSecret = randomBytes(32);
    const after = await prepareVaultKeyGeneration({
      ...options,
      deviceSecret: nextSecret,
      currentGeneration: before.generation,
    });

    expect(after.generation).toBe(2n);
    expect(after.keyId).not.toBe(before.keyId);
    const oldKey = openVaultDeviceKey(
      before.deviceRecord,
      options.deviceSecret,
      before,
    );
    const newKey = openVaultDeviceKey(after.deviceRecord, nextSecret, after);
    expect(newKey).not.toEqual(oldKey);
    expect(() =>
      openVaultDeviceKey(after.deviceRecord, options.deviceSecret, after),
    ).toThrow('Vault device key authentication failed');
    expect(() =>
      openVaultDeviceKey(before.deviceRecord, options.deviceSecret, {
        ...before,
        generation: after.generation,
      }),
    ).toThrow('Vault device key authentication failed');
    await expect(
      openVaultRecoveryKey(
        before.recoveryRecord,
        options.recoverySecret,
        after,
      ),
    ).rejects.toThrow('Vault recovery authentication failed');
    await expect(
      openVaultRecoveryKey(after.recoveryRecord, options.recoverySecret, after),
    ).resolves.toEqual({ keyId: after.keyId, key: newKey });
  });

  it('rejects invalid or exhausted generations before preparing records', async () => {
    for (const currentGeneration of [-1n, (1n << 64n) - 1n, 1n << 64n]) {
      await expect(
        prepareVaultKeyGeneration({ ...options, currentGeneration }),
      ).rejects.toThrow('Vault key generation cannot be advanced');
    }
  });

  it('can retry from the same current generation after the second wrap fails', async () => {
    const current = await prepareVaultKeyGeneration(options);
    const secretBefore = Uint8Array.from(options.deviceSecret);
    const oldRecord = Uint8Array.from(current.deviceRecord);
    const retry = { ...options, currentGeneration: current.generation };
    await expect(
      prepareVaultKeyGeneration({ ...retry, recoverySecret: 'short' }),
    ).rejects.toThrow('Vault recovery secret must be 16 to 1024 UTF-8 bytes');
    expect(Uint8Array.from(options.deviceSecret)).toEqual(secretBefore);
    expect(Uint8Array.from(current.deviceRecord)).toEqual(oldRecord);

    const prepared = await prepareVaultKeyGeneration(retry);
    expect(prepared.generation).toBe(current.generation + 1n);
    const key = openVaultDeviceKey(
      prepared.deviceRecord,
      options.deviceSecret,
      prepared,
    );
    await expect(
      openVaultRecoveryKey(
        prepared.recoveryRecord,
        options.recoverySecret,
        prepared,
      ),
    ).resolves.toEqual({ keyId: prepared.keyId, key });
  });

  it('keeps concurrently prepared candidates separate', async () => {
    const input = { ...options, currentGeneration: 4n };
    const [left, right] = await Promise.all([
      prepareVaultKeyGeneration(input),
      prepareVaultKeyGeneration(input),
    ]);
    expect(left.generation).toBe(5n);
    expect(right.generation).toBe(5n);
    expect(left.keyId).not.toBe(right.keyId);
    expect(() =>
      openVaultDeviceKey(left.deviceRecord, options.deviceSecret, right),
    ).toThrow('Vault device key authentication failed');
  });

  it('preserves the wrappers’ validation of device material', async () => {
    await expect(
      prepareVaultKeyGeneration({
        ...options,
        deviceSecret: new Uint8Array(31),
      }),
    ).rejects.toThrow('Vault device secret must be 32 bytes');
  });
});
