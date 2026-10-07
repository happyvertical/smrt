/**
 * Nostr cryptographic utilities
 *
 * Handles keypair generation, encryption/decryption of private keys,
 * signature verification, and bech32 encoding for Nostr authentication.
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32 } from 'bech32';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  hexToBytes,
  hkdfSha256,
  randomBytes,
  sha256Hex,
  utf8ToBytes,
} from '../crypto-util.js';

export interface NostrKeypair {
  /** Hex-encoded public key (64 characters) */
  pubkey: string;
  /** Hex-encoded private key (64 characters) */
  privkey: string;
}

export interface EncryptedKey {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded initialization vector */
  iv: string;
  /** Base64-encoded authentication tag */
  tag: string;
}

export interface NostrEvent {
  id?: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

/**
 * Generate a new Nostr keypair (secp256k1)
 */
export function generateNostrKeypair(): NostrKeypair {
  // Generate 32 random bytes for private key
  const privkeyBytes = randomBytes(32);
  const privkey = bytesToHex(privkeyBytes);

  // Derive public key from private key
  const pubkeyBytes = secp256k1.getPublicKey(privkeyBytes, true);
  // Remove the prefix byte (02 or 03) for compressed public key
  const pubkey = bytesToHex(pubkeyBytes.slice(1));

  return { pubkey, privkey };
}

/**
 * Derive an encryption key from the master secret using HKDF
 * @param masterSecret - Server master secret
 */
export function deriveEncryptionKey(masterSecret: string): Buffer {
  const salt = utf8ToBytes('nostr-privkey-encryption');
  const info = utf8ToBytes('aes-256-gcm');
  const keyMaterial = utf8ToBytes(masterSecret);

  const key = hkdfSha256(keyMaterial, salt, info, 32);
  // Node callers keep the `Buffer` this function always returned (`.toString('hex')`,
  // Buffer-typed consumers). Without a global `Buffer` (browsers) the same bytes
  // come back as a plain `Uint8Array`; the root entry imports no `node:*` (#3617).
  return (typeof Buffer !== 'undefined' ? Buffer.from(key) : key) as Buffer;
}

/**
 * Encrypt a private key using AES-256-GCM
 * @param privkey - Hex-encoded private key
 * @param masterSecret - Server master secret (from env)
 */
export function encryptPrivkey(
  privkey: string,
  masterSecret: string,
): EncryptedKey {
  const key = deriveEncryptionKey(masterSecret);
  const iv = randomBytes(12); // 96-bit IV for GCM

  const { ciphertext, tag } = aesGcmEncrypt(key, iv, utf8ToBytes(privkey));

  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(tag),
  };
}

/**
 * Decrypt a private key using AES-256-GCM
 * @param encrypted - Encrypted key data
 * @param masterSecret - Server master secret (from env)
 */
export function decryptPrivkey(
  encrypted: EncryptedKey,
  masterSecret: string,
): string {
  const key = deriveEncryptionKey(masterSecret);
  const iv = base64ToBytes(encrypted.iv);
  const tag = base64ToBytes(encrypted.tag);
  const ciphertext = base64ToBytes(encrypted.ciphertext);

  return bytesToUtf8(aesGcmDecrypt(key, iv, ciphertext, tag));
}

/**
 * Compute the event ID (SHA-256 hash of serialized event)
 */
export function computeEventId(event: NostrEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);

  return sha256Hex(serialized);
}

/**
 * Sign a Nostr event using Schnorr signatures (BIP-340)
 * @param event - Event to sign (without id and sig)
 * @param privkey - Hex-encoded private key
 */
export function signEvent(
  event: Omit<NostrEvent, 'id' | 'sig'>,
  privkey: string,
): NostrEvent {
  const id = computeEventId(event as NostrEvent);
  const privkeyBytes = hexToBytes(privkey);
  const idBytes = hexToBytes(id);

  // Use Schnorr signature (BIP-340) for Nostr
  const sig = schnorr.sign(idBytes, privkeyBytes);
  const sigHex = bytesToHex(sig);

  return {
    ...event,
    id,
    sig: sigHex,
  };
}

/**
 * Verify a Nostr event Schnorr signature (BIP-340)
 * @param event - Nostr event object with sig field
 */
export function verifyNostrSignature(event: NostrEvent): boolean {
  if (!event.id || !event.sig) {
    return false;
  }

  // Verify the event ID
  const computedId = computeEventId(event);
  if (computedId !== event.id) {
    return false;
  }

  try {
    const sigBytes = hexToBytes(event.sig);
    const idBytes = hexToBytes(event.id);
    // Nostr public keys are x-only (32 bytes) - use directly with Schnorr
    const pubkeyBytes = hexToBytes(event.pubkey);

    return schnorr.verify(sigBytes, idBytes, pubkeyBytes);
  } catch {
    return false;
  }
}

/**
 * Create a Nostr event for authentication (NIP-42 style)
 * @param privkey - Private key to sign with
 * @param challenge - Server challenge string
 * @param relay - Relay URL (optional)
 */
export function createAuthEvent(
  privkey: string,
  challenge: string,
  relay?: string,
): NostrEvent {
  const privkeyBytes = hexToBytes(privkey);
  const pubkeyBytes = secp256k1.getPublicKey(privkeyBytes, true);
  const pubkey = bytesToHex(pubkeyBytes.slice(1));

  const tags: string[][] = [['challenge', challenge]];
  if (relay) {
    tags.push(['relay', relay]);
  }

  const event: Omit<NostrEvent, 'id' | 'sig'> = {
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 22242, // NIP-42 AUTH event kind
    tags,
    content: '',
  };

  return signEvent(event, privkey);
}

/**
 * Verify an authentication event
 * @param event - Auth event to verify
 * @param expectedChallenge - Expected challenge string
 * @param maxAgeSeconds - Maximum age of the event in seconds (default: 300 = 5 minutes)
 */
export function verifyAuthEvent(
  event: NostrEvent,
  expectedChallenge: string,
  maxAgeSeconds: number = 300,
): { valid: boolean; error?: string } {
  // Check event kind
  if (event.kind !== 22242) {
    return { valid: false, error: 'Invalid event kind' };
  }

  // Check timestamp
  const now = Math.floor(Date.now() / 1000);
  const age = now - event.created_at;
  if (age > maxAgeSeconds || age < -60) {
    // Allow 60s clock skew in the future
    return { valid: false, error: 'Event expired or too far in future' };
  }

  // Check challenge
  const challengeTag = event.tags.find((t) => t[0] === 'challenge');
  if (!challengeTag || challengeTag[1] !== expectedChallenge) {
    return { valid: false, error: 'Challenge mismatch' };
  }

  // Verify signature
  if (!verifyNostrSignature(event)) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}

/**
 * Convert hex public key to npub (bech32)
 */
export function pubkeyToNpub(pubkey: string): string {
  const words = bech32.toWords(hexToBytes(pubkey));
  return bech32.encode('npub', words, 1000);
}

/**
 * Convert npub (bech32) to hex public key
 */
export function npubToPubkey(npub: string): string {
  const { prefix, words } = bech32.decode(npub, 1000);
  if (prefix !== 'npub') {
    throw new Error('Invalid npub prefix');
  }
  return bytesToHex(Uint8Array.from(bech32.fromWords(words)));
}

/**
 * Convert hex private key to nsec (bech32)
 */
export function privkeyToNsec(privkey: string): string {
  const words = bech32.toWords(hexToBytes(privkey));
  return bech32.encode('nsec', words, 1000);
}

/**
 * Convert nsec (bech32) to hex private key
 */
export function nsecToPrivkey(nsec: string): string {
  const { prefix, words } = bech32.decode(nsec, 1000);
  if (prefix !== 'nsec') {
    throw new Error('Invalid nsec prefix');
  }
  return bytesToHex(Uint8Array.from(bech32.fromWords(words)));
}

/**
 * Get public key from private key
 */
export function getPublicKey(privkey: string): string {
  const privkeyBytes = hexToBytes(privkey);
  const pubkeyBytes = secp256k1.getPublicKey(privkeyBytes, true);
  return bytesToHex(pubkeyBytes.slice(1));
}

/**
 * Validate a hex-encoded public key
 */
export function isValidPubkey(pubkey: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
    return false;
  }
  try {
    // Try to use it in a point multiplication
    const fullPubkey = hexToBytes(`02${pubkey}`);
    secp256k1.Point.fromBytes(fullPubkey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a hex-encoded private key
 */
export function isValidPrivkey(privkey: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(privkey)) {
    return false;
  }
  try {
    const privkeyBytes = hexToBytes(privkey);
    // Check if it's a valid scalar for secp256k1
    secp256k1.getPublicKey(privkeyBytes);
    return true;
  } catch {
    return false;
  }
}
