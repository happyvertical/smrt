import { hkdfSync, randomBytes } from 'node:crypto';
import {
  openVaultSnapshot,
  sealVaultSnapshot,
} from '@happyvertical/encryption/vault-snapshot';
import { describe, expect, it } from 'vitest';
import { openVaultDeviceKey, wrapVaultDeviceKey } from './vault-device-key.js';

describe('vault device key wrapping', () => {
  const dataKey = Uint8Array.from(randomBytes(32));
  const deviceSecret = randomBytes(32);
  const otherSecret = randomBytes(32);
  const context = {
    accountId: 'account-1',
    deviceId: 'device-1',
    generation: 3n,
    keyId: '0123456789abcdef0123456789abcdef',
  };
  const record = wrapVaultDeviceKey(dataKey, deviceSecret, context);

  it('wraps the same account key separately for each authorized device', () => {
    const otherContext = { ...context, deviceId: 'device-2' };
    const otherRecord = wrapVaultDeviceKey(dataKey, otherSecret, otherContext);
    expect(openVaultDeviceKey(record, deviceSecret, context)).toEqual(dataKey);
    expect(openVaultDeviceKey(otherRecord, otherSecret, otherContext)).toEqual(
      dataKey,
    );
    expect(wrapVaultDeviceKey(dataKey, deviceSecret, context)).not.toEqual(
      record,
    );
    expect(() => openVaultDeviceKey(record, otherSecret, context)).toThrow(
      'Vault device key authentication failed',
    );
    expect(() =>
      openVaultDeviceKey(otherRecord, deviceSecret, otherContext),
    ).toThrow('Vault device key authentication failed');
  });

  it('uses the documented HKDF domain and requires its derived key', () => {
    const expectedKey = new Uint8Array(
      hkdfSync('sha256', deviceSecret, '', 'smrt-vault-device-key-v1', 32),
    );
    const envelope = record.subarray(5);
    const snapshotContext = {
      accountId: context.accountId,
      deviceId: context.deviceId,
      sequence: context.generation,
    };
    expect(
      openVaultSnapshot(envelope, {
        context: snapshotContext,
        resolveKey: () => expectedKey,
      }),
    ).toEqual(dataKey);
    expect(() =>
      openVaultSnapshot(envelope, {
        context: snapshotContext,
        resolveKey: () => deviceSecret,
      }),
    ).toThrow();
  });

  it('rejects account, device, generation and key substitution', () => {
    for (const unexpected of [
      { ...context, accountId: 'account-2' },
      { ...context, deviceId: 'device-2' },
      { ...context, generation: 4n },
      { ...context, keyId: 'f'.repeat(32) },
    ]) {
      expect(() =>
        openVaultDeviceKey(record, deviceSecret, unexpected),
      ).toThrow('Vault device key authentication failed');
    }
  });

  it('rejects a changed ciphertext', () => {
    const modified = Uint8Array.from(record);
    modified[modified.length - 1] ^= 1;
    expect(() => openVaultDeviceKey(modified, deviceSecret, context)).toThrow(
      'Vault device key authentication failed',
    );
  });

  it('rejects malformed records, unknown versions and incorrect key sizes', () => {
    const unknownVersion = Uint8Array.from(record);
    unknownVersion[4] = 2;
    const compressedEnvelope = Uint8Array.from(record);
    compressedEnvelope[11] = 1;
    for (const invalid of [
      record.subarray(0, 5),
      new Uint8Array(673),
      unknownVersion,
      compressedEnvelope,
    ]) {
      expect(() => openVaultDeviceKey(invalid, deviceSecret, context)).toThrow(
        /(?:Invalid vault device key record|Unsupported vault device key format)/,
      );
    }
    expect(() =>
      wrapVaultDeviceKey(new Uint8Array(31), deviceSecret, context),
    ).toThrow('Vault data key must be 32 bytes');
    expect(() =>
      openVaultDeviceKey(record, new Uint8Array(31), context),
    ).toThrow('Vault device secret must be 32 bytes');
  });

  it('rejects authenticated payloads that are not account data keys', () => {
    const wrappingKey = new Uint8Array(
      hkdfSync('sha256', deviceSecret, '', 'smrt-vault-device-key-v1', 32),
    );
    const envelope = sealVaultSnapshot(Uint8Array.of(1), {
      key: wrappingKey,
      keyId: context.keyId,
      context: {
        accountId: context.accountId,
        deviceId: context.deviceId,
        sequence: context.generation,
      },
    });
    const malformed = Buffer.concat([record.subarray(0, 5), envelope]);
    expect(() => openVaultDeviceKey(malformed, deviceSecret, context)).toThrow(
      'Vault device key authentication failed',
    );
  });

  it('accepts the maximum UTF-8 identity lengths and generation', () => {
    const longest = {
      ...context,
      accountId: 'é'.repeat(127) + 'a',
      deviceId: 'd'.repeat(255),
      generation: (1n << 64n) - 1n,
    };
    const wrapped = wrapVaultDeviceKey(dataKey, deviceSecret, longest);
    expect(openVaultDeviceKey(wrapped, deviceSecret, longest)).toEqual(dataKey);
  });
});
