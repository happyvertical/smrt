import { hkdfSync } from 'node:crypto';
import {
  openVaultSnapshot,
  sealVaultSnapshot,
} from '@happyvertical/encryption/vault-snapshot';

const RECORD_PREFIX = Buffer.of(0x48, 0x56, 0x44, 0x4b, 1); // HVDK v1
const ENVELOPE_PREFIX = Buffer.of(0x48, 0x56, 0x53, 0x45, 1, 1, 0);
const KEY_BYTES = 32;
// SDK v1 allows two 255-byte IDs. With the fixed key payload and no
// compression, every valid record fits inside this bound.
const MAX_RECORD_BYTES = 672;

export interface VaultDeviceKeyContext {
  accountId: string;
  deviceId: string;
  generation: bigint;
  keyId: string;
}

function deriveDeviceWrappingKey(deviceSecret: Uint8Array): Uint8Array {
  if (
    !(deviceSecret instanceof Uint8Array) ||
    deviceSecret.length !== KEY_BYTES
  ) {
    throw new Error('Vault device secret must be 32 bytes');
  }
  return new Uint8Array(
    hkdfSync('sha256', deviceSecret, '', 'smrt-vault-device-key-v1', KEY_BYTES),
  );
}

/** Wrap the account data key with an independently generated device secret. */
export function wrapVaultDeviceKey(
  dataKey: Uint8Array,
  deviceSecret: Uint8Array,
  { accountId, deviceId, generation, keyId }: VaultDeviceKeyContext,
): Uint8Array {
  if (!(dataKey instanceof Uint8Array) || dataKey.length !== KEY_BYTES) {
    throw new Error('Vault data key must be 32 bytes');
  }

  const wrappingKey = deriveDeviceWrappingKey(deviceSecret);
  try {
    const envelope = sealVaultSnapshot(dataKey, {
      context: { accountId, deviceId, sequence: generation },
      key: wrappingKey,
      keyId,
    });
    const record = Buffer.concat([RECORD_PREFIX, envelope]);
    const output = Buffer.alloc(record.length);
    record.copy(output);
    return output;
  } finally {
    wrappingKey.fill(0);
  }
}

/** Open a device record against the caller's trusted key and device context. */
export function openVaultDeviceKey(
  record: Uint8Array,
  deviceSecret: Uint8Array,
  { accountId, deviceId, generation, keyId }: VaultDeviceKeyContext,
): Uint8Array {
  if (
    !(record instanceof Uint8Array) ||
    record.length <= RECORD_PREFIX.length ||
    record.length > MAX_RECORD_BYTES
  ) {
    throw new Error('Invalid vault device key record');
  }
  const bytes = Buffer.from(record);
  const envelope = bytes.subarray(RECORD_PREFIX.length);
  if (
    !bytes.subarray(0, RECORD_PREFIX.length).equals(RECORD_PREFIX) ||
    !envelope.subarray(0, ENVELOPE_PREFIX.length).equals(ENVELOPE_PREFIX)
  ) {
    throw new Error('Unsupported vault device key format');
  }

  const wrappingKey = deriveDeviceWrappingKey(deviceSecret);
  try {
    const dataKey = openVaultSnapshot(envelope, {
      context: { accountId, deviceId, sequence: generation },
      resolveKey: (recordKeyId) =>
        recordKeyId === keyId ? wrappingKey : undefined,
    });
    if (dataKey.length !== KEY_BYTES) {
      dataKey.fill(0);
      throw new Error('Invalid vault data key size');
    }
    return dataKey;
  } catch {
    throw new Error('Vault device key authentication failed');
  } finally {
    wrappingKey.fill(0);
  }
}
