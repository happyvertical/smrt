import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';
import {
  openVaultDeviceKey,
  type VaultDeviceKeyContext,
  wrapVaultDeviceKey,
} from './vault-device-key.js';

const RECORD_PREFIX = Buffer.of(0x48, 0x56, 0x44, 0x54, 1); // HVDT v1
const KEY_BYTES = 32;
const EPHEMERAL_OFFSET = RECORD_PREFIX.length;
const DEVICE_RECORD_OFFSET = EPHEMERAL_OFFSET + KEY_BYTES;
// HVDK v1 records are at most 672 bytes.
const MAX_RECORD_BYTES = DEVICE_RECORD_OFFSET + 672;
const AGREEMENT_INFO = 'smrt-vault-device-agreement-v1';
const TRANSFER_INFO = Buffer.from('smrt-vault-device-transfer-v1');
const PKCS8_X25519_PREFIX = Buffer.from(
  '302e020100300506032b656e04220420',
  'hex',
);
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const LONE_SURROGATE = /[\ud800-\udfff]/u;

export interface VaultDeviceTransferContext extends VaultDeviceKeyContext {
  /** Device ID of the device that seals the transfer. */
  senderDeviceId: string;
  /** Sender's public key, from the pairing exchange or the trusted registry. */
  senderPublicKey: Uint8Array;
  /** Recipient's public key. Only sealing needs it. */
  recipientPublicKey?: Uint8Array;
  /** Single-use 32-byte pairing secret; present only for enrollment. */
  pairingSecret?: Uint8Array;
  /**
   * SHA-256 digest of the metadata that travels with the transfer. Binding it
   * makes any change to that metadata fail authentication.
   */
  bindingDigest?: Uint8Array;
}

function assertKeyBytes(value: unknown, message: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== KEY_BYTES) {
    throw new Error(message);
  }
  return value;
}

function agreementPrivateKey(deviceSecret: Uint8Array): KeyObject {
  assertKeyBytes(deviceSecret, 'Vault device secret must be 32 bytes');
  const scalar = Buffer.from(
    hkdfSync('sha256', deviceSecret, '', AGREEMENT_INFO, KEY_BYTES),
  );
  const der = Buffer.concat([PKCS8_X25519_PREFIX, scalar]);
  try {
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } finally {
    scalar.fill(0);
    der.fill(0);
  }
}

function publicKeyBytes(key: KeyObject): Uint8Array {
  const der = key.export({ format: 'der', type: 'spki' });
  return new Uint8Array(der.subarray(SPKI_X25519_PREFIX.length));
}

function publicKeyObject(publicKey: Uint8Array): KeyObject {
  assertKeyBytes(publicKey, 'Vault device public key must be 32 bytes');
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_X25519_PREFIX, publicKey]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new Error('Invalid vault device public key');
  }
}

function agree(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  const shared = diffieHellman({ privateKey, publicKey });
  if (shared.length !== KEY_BYTES || shared.every((byte) => byte === 0)) {
    shared.fill(0);
    throw new Error('Vault device key agreement failed');
  }
  return shared;
}

function senderIdBytes(senderDeviceId: string): Buffer {
  if (
    typeof senderDeviceId !== 'string' ||
    senderDeviceId.length === 0 ||
    LONE_SURROGATE.test(senderDeviceId) ||
    Buffer.byteLength(senderDeviceId) > 255
  ) {
    throw new Error('Invalid vault sender device ID');
  }
  const id = Buffer.from(senderDeviceId);
  return Buffer.concat([Buffer.of(id.length), id]);
}

function transferSecret(
  ephemeralShared: Buffer,
  staticShared: Buffer,
  {
    senderDeviceId,
    pairingSecret,
    bindingDigest,
  }: Pick<
    VaultDeviceTransferContext,
    'senderDeviceId' | 'pairingSecret' | 'bindingDigest'
  >,
  senderPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
): Uint8Array {
  if (pairingSecret !== undefined) {
    assertKeyBytes(pairingSecret, 'Vault pairing secret must be 32 bytes');
  }
  if (bindingDigest !== undefined) {
    assertKeyBytes(bindingDigest, 'Vault binding digest must be 32 bytes');
  }
  const ikm = Buffer.concat([ephemeralShared, staticShared]);
  try {
    return new Uint8Array(
      hkdfSync(
        'sha256',
        ikm,
        pairingSecret ?? Buffer.alloc(0),
        Buffer.concat([
          TRANSFER_INFO,
          Buffer.of(
            (pairingSecret === undefined ? 0 : 1) |
              (bindingDigest === undefined ? 0 : 2),
          ),
          senderIdBytes(senderDeviceId),
          senderPublicKey,
          recipientPublicKey,
          ephemeralPublicKey,
          bindingDigest ?? Buffer.alloc(0),
        ]),
        KEY_BYTES,
      ),
    );
  } finally {
    ikm.fill(0);
  }
}

/** Public X25519 key a device shares with peers; derived from its secret. */
export function deriveVaultDevicePublicKey(
  deviceSecret: Uint8Array,
): Uint8Array {
  return publicKeyBytes(createPublicKey(agreementPrivateKey(deviceSecret)));
}

/**
 * Seal a data key from one enrolled device to another device's public key.
 *
 * The transfer combines an ephemeral and a static X25519 agreement, so only
 * the recipient can open it and the recipient can authenticate the sender's
 * public key. Enrollment adds the single-use pairing secret.
 */
export function sealVaultDeviceTransfer(
  dataKey: Uint8Array,
  senderSecret: Uint8Array,
  context: VaultDeviceTransferContext,
): Uint8Array {
  assertKeyBytes(dataKey, 'Vault data key must be 32 bytes');
  const senderPrivate = agreementPrivateKey(senderSecret);
  const senderPublic = publicKeyBytes(createPublicKey(senderPrivate));
  if (!Buffer.from(senderPublic).equals(Buffer.from(context.senderPublicKey))) {
    throw new Error('Vault sender public key does not match its secret');
  }
  const recipientPublic = assertKeyBytes(
    context.recipientPublicKey,
    'Vault device public key must be 32 bytes',
  );
  const recipient = publicKeyObject(recipientPublic);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = publicKeyBytes(ephemeral.publicKey);
  const ephemeralShared = agree(ephemeral.privateKey, recipient);
  const staticShared = agree(senderPrivate, recipient);
  const secret = transferSecret(
    ephemeralShared,
    staticShared,
    context,
    senderPublic,
    recipientPublic,
    ephemeralPublic,
  );
  ephemeralShared.fill(0);
  staticShared.fill(0);
  try {
    const deviceRecord = wrapVaultDeviceKey(dataKey, secret, context);
    return new Uint8Array(
      Buffer.concat([RECORD_PREFIX, ephemeralPublic, deviceRecord]),
    );
  } finally {
    secret.fill(0);
  }
}

/** Open a transfer against the recipient's trusted context and sender key. */
export function openVaultDeviceTransfer(
  record: Uint8Array,
  recipientSecret: Uint8Array,
  context: VaultDeviceTransferContext,
): Uint8Array {
  if (
    !(record instanceof Uint8Array) ||
    record.length <= DEVICE_RECORD_OFFSET ||
    record.length > MAX_RECORD_BYTES
  ) {
    throw new Error('Invalid vault device transfer record');
  }
  const bytes = Buffer.from(record);
  if (!bytes.subarray(0, RECORD_PREFIX.length).equals(RECORD_PREFIX)) {
    throw new Error('Unsupported vault device transfer format');
  }
  const recipientPrivate = agreementPrivateKey(recipientSecret);
  const recipientPublic = publicKeyBytes(createPublicKey(recipientPrivate));
  const ephemeralPublic = new Uint8Array(
    bytes.subarray(EPHEMERAL_OFFSET, DEVICE_RECORD_OFFSET),
  );
  let secret: Uint8Array | undefined;
  try {
    const ephemeralShared = agree(
      recipientPrivate,
      publicKeyObject(ephemeralPublic),
    );
    const staticShared = agree(
      recipientPrivate,
      publicKeyObject(context.senderPublicKey),
    );
    secret = transferSecret(
      ephemeralShared,
      staticShared,
      context,
      context.senderPublicKey,
      recipientPublic,
      ephemeralPublic,
    );
    ephemeralShared.fill(0);
    staticShared.fill(0);
    return openVaultDeviceKey(
      bytes.subarray(DEVICE_RECORD_OFFSET),
      secret,
      context,
    );
  } catch {
    throw new Error('Vault device transfer authentication failed');
  } finally {
    secret?.fill(0);
  }
}
