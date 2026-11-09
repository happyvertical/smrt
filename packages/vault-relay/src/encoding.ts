/**
 * Identifier shapes and byte encodings shared by the relay and its client
 * helper. Every identifier that reaches SQL, an object key, or a log line is
 * checked here first, so a hostile header can never become a path segment or
 * an unbounded string.
 */
import { createHash } from 'node:crypto';

/** Account and device identifiers: an opaque, URL-safe token. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Request nonce: 16 to 64 base64url characters (at least 96 bits). */
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UPLOAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** SHA-256 of the empty body, the content hash of a bodiless request. */
export const EMPTY_SHA256 = createHash('sha256').digest('hex');

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE.test(value);
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

export function isUploadId(value: unknown): value is string {
  return typeof value === 'string' && UPLOAD_ID.test(value);
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The account's storage and log handle: a hash, so object keys and log lines
 * never carry the account identifier itself.
 */
export function accountHandle(accountId: string): string {
  return sha256Hex(`smrt-vault-relay:account:${accountId}`);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Strict base64url decode; `null` for anything not canonical base64url. */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (!BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return null;
  return new Uint8Array(bytes);
}

/** Parse a non-negative safe integer written in canonical decimal. */
export function parseCanonicalInteger(value: string): number | null {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Coerce a database integer (BIGINT may arrive as a string) to a safe number. */
export function toSafeInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint'
        ? Number(value)
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`vault relay: ${field} is not a safe integer`);
  }
  return parsed;
}
