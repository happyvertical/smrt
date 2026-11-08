import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveVaultDevicePublicKey,
  openVaultDeviceTransfer,
  sealVaultDeviceTransfer,
} from './vault-device-transfer.js';

describe('vault device transfer', () => {
  const dataKey = new Uint8Array(randomBytes(32));
  const senderSecret = new Uint8Array(randomBytes(32));
  const recipientSecret = new Uint8Array(randomBytes(32));
  const otherSecret = new Uint8Array(randomBytes(32));
  const pairingSecret = new Uint8Array(randomBytes(32));
  const senderPublicKey = deriveVaultDevicePublicKey(senderSecret);
  const recipientPublicKey = deriveVaultDevicePublicKey(recipientSecret);
  const context = {
    accountId: 'account-1',
    deviceId: 'recipient',
    generation: 4n,
    keyId: '0123456789abcdef0123456789abcdef',
    senderDeviceId: 'sender',
    senderPublicKey,
    recipientPublicKey,
  };

  it('derives a stable public key that never equals the secret', () => {
    expect(deriveVaultDevicePublicKey(senderSecret)).toEqual(senderPublicKey);
    expect(senderPublicKey).toHaveLength(32);
    expect(senderPublicKey).not.toEqual(senderSecret);
    expect(recipientPublicKey).not.toEqual(senderPublicKey);
  });

  it('opens only for the recipient, the sender key and the bound context', () => {
    const record = sealVaultDeviceTransfer(dataKey, senderSecret, context);
    expect(Buffer.from(record.subarray(0, 5)).toString('latin1')).toBe(
      'HVDT\u0001',
    );
    expect(openVaultDeviceTransfer(record, recipientSecret, context)).toEqual(
      dataKey,
    );
    expect(sealVaultDeviceTransfer(dataKey, senderSecret, context)).not.toEqual(
      record,
    );

    const failures = [
      () => openVaultDeviceTransfer(record, otherSecret, context),
      () => openVaultDeviceTransfer(record, senderSecret, context),
      () =>
        openVaultDeviceTransfer(record, recipientSecret, {
          ...context,
          senderPublicKey: deriveVaultDevicePublicKey(otherSecret),
        }),
      () =>
        openVaultDeviceTransfer(record, recipientSecret, {
          ...context,
          senderDeviceId: 'other-sender',
        }),
      () =>
        openVaultDeviceTransfer(record, recipientSecret, {
          ...context,
          accountId: 'account-2',
        }),
      () =>
        openVaultDeviceTransfer(record, recipientSecret, {
          ...context,
          deviceId: 'other-recipient',
        }),
      () =>
        openVaultDeviceTransfer(record, recipientSecret, {
          ...context,
          generation: 3n,
        }),
      () =>
        openVaultDeviceTransfer(record, recipientSecret, {
          ...context,
          keyId: 'f'.repeat(32),
        }),
      () =>
        openVaultDeviceTransfer(record, recipientSecret, {
          ...context,
          pairingSecret,
        }),
    ];
    for (const attempt of failures) {
      expect(attempt).toThrow('Vault device transfer authentication failed');
    }

    for (const index of [6, 40, record.length - 1]) {
      const tampered = Uint8Array.from(record);
      tampered[index] ^= 1;
      expect(() =>
        openVaultDeviceTransfer(tampered, recipientSecret, context),
      ).toThrow('Vault device transfer authentication failed');
    }
  });

  it('binds enrollment transfers to the pairing secret', () => {
    const enrollment = { ...context, pairingSecret };
    const record = sealVaultDeviceTransfer(dataKey, senderSecret, enrollment);
    expect(
      openVaultDeviceTransfer(record, recipientSecret, enrollment),
    ).toEqual(dataKey);
    for (const attempt of [
      () => openVaultDeviceTransfer(record, recipientSecret, context),
      () =>
        openVaultDeviceTransfer(record, recipientSecret, {
          ...context,
          pairingSecret: new Uint8Array(randomBytes(32)),
        }),
    ]) {
      expect(attempt).toThrow('Vault device transfer authentication failed');
    }
  });

  it('rejects malformed inputs before sealing', () => {
    expect(() =>
      sealVaultDeviceTransfer(dataKey, otherSecret, context),
    ).toThrow('Vault sender public key does not match its secret');
    expect(() =>
      sealVaultDeviceTransfer(dataKey, senderSecret, {
        ...context,
        recipientPublicKey: new Uint8Array(31),
      }),
    ).toThrow('Vault device public key must be 32 bytes');
    expect(() =>
      sealVaultDeviceTransfer(dataKey, senderSecret, {
        ...context,
        // All-zero is a low-order X25519 point.
        recipientPublicKey: new Uint8Array(32),
      }),
    ).toThrow();
    expect(() =>
      sealVaultDeviceTransfer(new Uint8Array(31), senderSecret, context),
    ).toThrow('Vault data key must be 32 bytes');
    expect(() =>
      openVaultDeviceTransfer(new Uint8Array(4), recipientSecret, context),
    ).toThrow('Invalid vault device transfer record');
  });
});
