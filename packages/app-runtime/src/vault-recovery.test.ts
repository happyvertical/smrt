import { beforeAll, describe, expect, it } from 'vitest';
import {
  openVaultRecoveryKey,
  wrapVaultRecoveryKey,
} from './vault-recovery.js';

describe('vault key recovery', () => {
  const context = { accountId: 'example-account', generation: 7n };
  const recoverySecret = 'test recovery credential café';
  const keyId = '102030405060708090a0b0c0d0e0f001';
  const dataKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  let record: Uint8Array;

  beforeAll(async () => {
    record = await wrapVaultRecoveryKey(
      { key: dataKey, keyId },
      recoverySecret,
      context,
    );
  });

  it('recovers a key and its ID and uses a fresh salt for each wrap', async () => {
    const secondRecord = await wrapVaultRecoveryKey(
      { key: dataKey, keyId },
      recoverySecret,
      context,
    );
    expect(secondRecord.subarray(5, 21)).not.toEqual(record.subarray(5, 21));
    for (const wrapped of [record, secondRecord]) {
      await expect(
        openVaultRecoveryKey(wrapped, recoverySecret, context),
      ).resolves.toEqual({ keyId, key: dataKey });
    }
  });

  it('rejects recovery without the user-held secret', async () => {
    await expect(
      openVaultRecoveryKey(record, 'wrong recovery credential', context),
    ).rejects.toThrow('Vault recovery authentication failed');
  });

  it('binds recovery to the account and generation supplied by the caller', async () => {
    for (const incorrectContext of [
      { ...context, accountId: 'another-account' },
      { ...context, generation: 8n },
    ]) {
      await expect(
        openVaultRecoveryKey(record, recoverySecret, incorrectContext),
      ).rejects.toThrow('Vault recovery authentication failed');
    }
  });

  it('rejects changes to the salt, public key ID, and ciphertext', async () => {
    const saltByte = 5;
    const envelopeKeyIdByte = 21 + 7;
    for (const offset of [saltByte, envelopeKeyIdByte, record.length - 1]) {
      const modified = Uint8Array.from(record);
      modified[offset] ^= 1;
      await expect(
        openVaultRecoveryKey(modified, recoverySecret, context),
      ).rejects.toThrow('Vault recovery authentication failed');
    }
  });

  it('rejects unknown versions and malformed or oversize records', async () => {
    const unknownVersion = Uint8Array.from(record);
    unknownVersion[4] = 2;
    const wrongMagic = Uint8Array.from(record);
    wrongMagic[0] ^= 1;
    for (const invalid of [unknownVersion, wrongMagic]) {
      await expect(
        openVaultRecoveryKey(invalid, recoverySecret, context),
      ).rejects.toThrow('Unsupported vault recovery format');
    }
    const brokenEnvelope = Uint8Array.from(record);
    brokenEnvelope[21] ^= 1;
    const compressedEnvelope = Uint8Array.from(record);
    compressedEnvelope[27] = 1;
    for (const invalid of [
      record.subarray(0, 21),
      record.subarray(0, 22),
      record.subarray(0, record.length - 1),
      Buffer.concat([record, Buffer.of(0)]),
      new Uint8Array(513),
      brokenEnvelope,
      compressedEnvelope,
    ]) {
      await expect(
        openVaultRecoveryKey(invalid, recoverySecret, context),
      ).rejects.toThrow('Invalid vault recovery record');
    }
  });

  it('rejects invalid keys, credentials and contexts', async () => {
    await expect(
      wrapVaultRecoveryKey(
        { key: dataKey, keyId: keyId + '\n' },
        recoverySecret,
        context,
      ),
    ).rejects.toThrow('Invalid vault recovery key ID');
    await expect(
      wrapVaultRecoveryKey(
        { key: new Uint8Array(31), keyId },
        recoverySecret,
        context,
      ),
    ).rejects.toThrow('Vault data key must be 32 bytes');
    for (const invalidSecret of [
      'too short',
      'é'.repeat(513),
      recoverySecret + '\ud800',
    ]) {
      await expect(
        openVaultRecoveryKey(record, invalidSecret, context),
      ).rejects.toThrow('Vault recovery secret must be 16 to 1024 UTF-8 bytes');
    }
    await expect(
      openVaultRecoveryKey(record, recoverySecret, {
        ...context,
        accountId: 'é'.repeat(128),
      }),
    ).rejects.toThrow('Invalid vault recovery account ID');
    await expect(
      openVaultRecoveryKey(record, recoverySecret, {
        ...context,
        generation: 1n << 64n,
      }),
    ).rejects.toThrow('Invalid vault recovery generation');
  });

  it('captures mutable inputs before deriving the wrapping key', async () => {
    const supplied = Uint8Array.from(dataKey);
    const suppliedContext = {
      accountId: 'é'.repeat(127) + 'a',
      generation: 0n,
    };
    const expectedContext = { ...suppliedContext };
    const wrapping = wrapVaultRecoveryKey(
      { key: supplied, keyId },
      recoverySecret,
      suppliedContext,
    );
    supplied.fill(255);
    suppliedContext.generation = 8n;
    const wrapped = await wrapping;
    const recovery = openVaultRecoveryKey(
      wrapped,
      recoverySecret,
      expectedContext,
    );
    wrapped.fill(0);
    expectedContext.generation = 9n;
    await expect(recovery).resolves.toEqual({ keyId, key: dataKey });
    expect(supplied).toEqual(new Uint8Array(32).fill(255));
    expect(wrapped.every((byte) => byte === 0)).toBe(true);
  });
});
