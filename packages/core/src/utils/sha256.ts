import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();

/**
 * SHA-256 of `text` (UTF-8) as lowercase hex.
 *
 * Synchronous and free of `node:crypto`, so the schema, registry and
 * embedding paths that fingerprint strings load in a browser (#2838). The
 * digest is identical to `createHash('sha256').update(text).digest('hex')`;
 * `sha256.test.ts` pins that against Node's implementation.
 */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(encoder.encode(text)));
}

/**
 * SHA-256 of `text` (UTF-8) as unpadded base64url, identical to
 * `createHash('sha256').update(text).digest('base64url')`.
 */
export function sha256Base64Url(text: string): string {
  const bytes = sha256(encoder.encode(text));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
