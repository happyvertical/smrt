import { randomBytes, scrypt } from 'node:crypto';
import {
  openVaultSnapshot,
  sealVaultSnapshot,
  type VaultSnapshotContext,
} from '@happyvertical/encryption/vault-snapshot';

const MAGIC = Buffer.from('HVRK');
const VERSION = 1;
const SALT_BYTES = 16;
const SALT_OFFSET = MAGIC.length + 1;
const ENVELOPE_OFFSET = SALT_OFFSET + SALT_BYTES;
const KEY_BYTES = 32;
const MAX_GENERATION = (1n << 64n) - 1n;
const RECOVERY_DOMAIN = 'smrt-vault-recovery-v1';
const V1_ENVELOPE_PREFIX = Buffer.of(0x48, 0x56, 0x53, 0x45, 1, 1, 0);
// SDK v1: two 47-byte headers, 16-byte secretbox tag, two one-byte
// ID lengths and an eight-byte sequence, plus the device ID and data key.
const V1_RECORD_FIXED_BYTES =
  ENVELOPE_OFFSET + 2 * 47 + 16 + 10 + RECOVERY_DOMAIN.length + KEY_BYTES;
const MAX_RECORD_BYTES = V1_RECORD_FIXED_BYTES + 255;
// In Unicode mode, a valid surrogate pair is matched as one code point.
const LONE_SURROGATE = /[\ud800-\udfff]/u;

export interface VaultRecoveryContext {
  accountId: string;
  generation: bigint;
}

export interface VaultRecoveryDataKey {
  keyId: string;
  key: Uint8Array;
}

function snapshotContext({
  accountId,
  generation,
}: VaultRecoveryContext): VaultSnapshotContext {
  if (
    typeof accountId !== 'string' ||
    accountId.length === 0 ||
    accountId.length > 255 ||
    Buffer.byteLength(accountId) > 255 ||
    LONE_SURROGATE.test(accountId)
  ) {
    throw new Error('Invalid vault recovery account ID');
  }
  if (
    typeof generation !== 'bigint' ||
    generation < 0n ||
    generation > MAX_GENERATION
  ) {
    throw new Error('Invalid vault recovery generation');
  }
  return { accountId, deviceId: RECOVERY_DOMAIN, sequence: generation };
}

async function deriveWrappingKey(
  recoverySecret: string,
  salt: Uint8Array,
): Promise<Buffer> {
  if (
    typeof recoverySecret !== 'string' ||
    recoverySecret.length > 1024 ||
    LONE_SURROGATE.test(recoverySecret) ||
    Buffer.byteLength(recoverySecret) < 16 ||
    Buffer.byteLength(recoverySecret) > 1024
  ) {
    throw new Error('Vault recovery secret must be 16 to 1024 UTF-8 bytes');
  }
  const secretBytes = Buffer.from(recoverySecret);
  const domainSalt = Buffer.concat([Buffer.from(RECOVERY_DOMAIN), salt]);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        secretBytes,
        domainSalt,
        KEY_BYTES,
        { N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
        (error, key) => {
          if (error) reject(error);
          else resolve(key);
        },
      );
    });
  } finally {
    secretBytes.fill(0);
  }
}

/** Protect a vault data key using a recovery secret held by the user. */
export async function wrapVaultRecoveryKey(
  { keyId, key }: VaultRecoveryDataKey,
  recoverySecret: string,
  context: VaultRecoveryContext,
): Promise<Uint8Array> {
  if (
    typeof keyId !== 'string' ||
    keyId.length !== 32 ||
    !/^[0-9a-f]{32}$/.test(keyId)
  ) {
    throw new Error('Invalid vault recovery key ID');
  }
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error('Vault data key must be 32 bytes');
  }

  const trustedContext = snapshotContext(context);
  const salt = randomBytes(SALT_BYTES);
  const dataKey = Buffer.from(key);
  try {
    const wrappingKey = await deriveWrappingKey(recoverySecret, salt);
    try {
      const envelope = sealVaultSnapshot(dataKey, {
        context: trustedContext,
        key: wrappingKey,
        keyId,
      });
      const record = Buffer.concat([MAGIC, Buffer.of(VERSION), salt, envelope]);
      const output = Buffer.alloc(record.length);
      record.copy(output);
      return output;
    } finally {
      wrappingKey.fill(0);
    }
  } finally {
    dataKey.fill(0);
  }
}

/** Recover a key using the expected account and generation from local state. */
export async function openVaultRecoveryKey(
  record: Uint8Array,
  recoverySecret: string,
  context: VaultRecoveryContext,
): Promise<VaultRecoveryDataKey> {
  if (
    !(record instanceof Uint8Array) ||
    record.length <= ENVELOPE_OFFSET ||
    record.length > MAX_RECORD_BYTES
  ) {
    throw new Error('Invalid vault recovery record');
  }
  const bytes = Buffer.from(record);
  if (
    !bytes.subarray(0, MAGIC.length).equals(MAGIC) ||
    bytes[MAGIC.length] !== VERSION
  ) {
    throw new Error('Unsupported vault recovery format');
  }

  const trustedContext = snapshotContext(context);
  const envelope = bytes.subarray(ENVELOPE_OFFSET);
  if (
    bytes.length !==
      V1_RECORD_FIXED_BYTES + Buffer.byteLength(trustedContext.accountId) ||
    !envelope.subarray(0, V1_ENVELOPE_PREFIX.length).equals(V1_ENVELOPE_PREFIX)
  ) {
    throw new Error('Invalid vault recovery record');
  }
  const wrappingKey = await deriveWrappingKey(
    recoverySecret,
    bytes.subarray(SALT_OFFSET, ENVELOPE_OFFSET),
  );
  let keyId = '';
  try {
    const key = openVaultSnapshot(envelope, {
      context: trustedContext,
      resolveKey(id) {
        keyId = id;
        return wrappingKey;
      },
    });
    if (key.length !== KEY_BYTES) {
      key.fill(0);
      throw new Error('Invalid recovered key size');
    }
    return { keyId, key };
  } catch {
    throw new Error('Vault recovery authentication failed');
  } finally {
    wrappingKey.fill(0);
  }
}
