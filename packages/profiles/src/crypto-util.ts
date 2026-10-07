/**
 * Portable crypto primitives (no `node:` imports).
 *
 * The profiles root entry must load in browsers (#3617), so hashing, key
 * derivation, AES-GCM and randomness come from Web Crypto's
 * `getRandomValues` and the audited, synchronous `@noble/*` packages. The
 * outputs are byte-for-byte identical to the previous `node:crypto` calls.
 *
 * @internal
 */

import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export { bytesToHex, hexToBytes };

export function utf8ToBytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Cryptographically secure random bytes from `globalThis.crypto`. */
export function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** SHA-256 of a UTF-8 string, hex encoded. */
export function sha256Hex(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** HKDF-SHA256 (RFC 5869). */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}

const GCM_TAG_LENGTH = 16;

/** AES-256-GCM encrypt; returns ciphertext and the 16-byte auth tag apart. */
export function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): { ciphertext: Uint8Array; tag: Uint8Array } {
  const sealed = gcm(key, iv).encrypt(plaintext);
  const split = sealed.length - GCM_TAG_LENGTH;
  return { ciphertext: sealed.slice(0, split), tag: sealed.slice(split) };
}

/** AES-256-GCM decrypt; throws when the tag does not authenticate. */
export function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
): Uint8Array {
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext);
  sealed.set(tag, ciphertext.length);
  return gcm(key, iv).decrypt(sealed);
}
