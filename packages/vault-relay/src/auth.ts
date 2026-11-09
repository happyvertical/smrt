/**
 * Device-signature request authentication (protocol `smrt-vault-relay-v1`).
 *
 * A device signs every request with its Ed25519 key. The signed string binds
 * the method, path and query, the claimed account and device, a timestamp, a
 * single-use nonce, and the SHA-256 of the exact request body:
 *
 * ```text
 * smrt-vault-relay-v1
 * <METHOD>
 * <path and query, exactly as sent>
 * <account id>
 * <device id>
 * <timestamp, unix milliseconds>
 * <nonce>
 * <body sha256, lowercase hex>
 * ```
 *
 * The relay accepts the signature only from a key registered and active for
 * that account and device, within the clock-skew window, with a nonce it has
 * not seen, and with a body whose digest matches. It derives nothing about
 * identity from blob content.
 */
import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import {
  decodeBase64Url,
  encodeBase64Url,
  isIdentifier,
  isNonce,
  isSha256Hex,
  parseCanonicalInteger,
} from './encoding.js';

export const SIGNATURE_PROTOCOL = 'smrt-vault-relay-v1';

export const HEADER_ACCOUNT = 'x-vault-account';
export const HEADER_DEVICE = 'x-vault-device';
export const HEADER_TIMESTAMP = 'x-vault-timestamp';
export const HEADER_NONCE = 'x-vault-nonce';
export const HEADER_CONTENT_SHA256 = 'x-vault-content-sha256';
export const HEADER_SIGNATURE = 'x-vault-signature';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

export interface SignedRequestFields {
  method: string;
  /** Path plus query string exactly as sent, e.g. `/v1/snapshots?x=1`. */
  pathAndQuery: string;
  accountId: string;
  deviceId: string;
  timestamp: number;
  nonce: string;
  contentSha256: string;
}

/** The exact byte string a device signs. */
export function canonicalRequest(fields: SignedRequestFields): Buffer {
  return Buffer.from(
    [
      SIGNATURE_PROTOCOL,
      fields.method.toUpperCase(),
      fields.pathAndQuery,
      fields.accountId,
      fields.deviceId,
      String(fields.timestamp),
      fields.nonce,
      fields.contentSha256,
    ].join('\n'),
    'utf8',
  );
}

/** Import a raw 32-byte Ed25519 public key (base64url). */
export function importDevicePublicKey(encoded: string): KeyObject | null {
  const raw = decodeBase64Url(encoded);
  if (raw?.length !== 32) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/** Raw 32-byte public key of an Ed25519 key object, base64url. */
export function exportDevicePublicKey(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' });
  return encodeBase64Url(der.subarray(der.length - 32));
}

/** Build an Ed25519 private key object from a raw 32-byte seed. */
export function importDevicePrivateKey(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) {
    throw new Error('vault relay: an Ed25519 seed is 32 bytes');
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Client helper: the headers that authenticate one request. The caller
 * supplies a fresh random nonce and the SHA-256 of the exact body it sends.
 */
export function signRelayRequest(
  fields: SignedRequestFields,
  privateKey: KeyObject,
): Record<string, string> {
  const signature = sign(null, canonicalRequest(fields), privateKey);
  return {
    [HEADER_ACCOUNT]: fields.accountId,
    [HEADER_DEVICE]: fields.deviceId,
    [HEADER_TIMESTAMP]: String(fields.timestamp),
    [HEADER_NONCE]: fields.nonce,
    [HEADER_CONTENT_SHA256]: fields.contentSha256,
    [HEADER_SIGNATURE]: encodeBase64Url(signature),
  };
}

export interface ParsedSignature {
  fields: SignedRequestFields;
  signature: Uint8Array;
}

/**
 * Read and shape-check the signature headers; `null` when any is missing or
 * malformed. Does not verify the signature.
 */
export function parseSignatureHeaders(
  method: string,
  pathAndQuery: string,
  headers: Headers,
): ParsedSignature | null {
  const accountId = headers.get(HEADER_ACCOUNT);
  const deviceId = headers.get(HEADER_DEVICE);
  const timestampText = headers.get(HEADER_TIMESTAMP);
  const nonce = headers.get(HEADER_NONCE);
  const contentSha256 = headers.get(HEADER_CONTENT_SHA256);
  const signatureText = headers.get(HEADER_SIGNATURE);
  if (
    !isIdentifier(accountId) ||
    !isIdentifier(deviceId) ||
    !isNonce(nonce) ||
    !isSha256Hex(contentSha256) ||
    timestampText === null ||
    signatureText === null ||
    signatureText.length > 128
  ) {
    return null;
  }
  const timestamp = parseCanonicalInteger(timestampText);
  const signature = decodeBase64Url(signatureText);
  if (timestamp === null || !signature || signature.length !== 64) {
    return null;
  }
  return {
    fields: {
      method,
      pathAndQuery,
      accountId,
      deviceId,
      timestamp,
      nonce,
      contentSha256,
    },
    signature,
  };
}

/** Verify an Ed25519 signature over the canonical request. */
export function verifySignature(
  parsed: ParsedSignature,
  publicKey: KeyObject,
): boolean {
  try {
    return verify(
      null,
      canonicalRequest(parsed.fields),
      publicKey,
      parsed.signature,
    );
  } catch {
    return false;
  }
}
