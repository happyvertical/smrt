/**
 * Nostr cryptographic utilities
 *
 * Handles keypair generation, encryption/decryption of private keys,
 * signature verification, and bech32 encoding for Nostr authentication.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bech32 } from 'bech32';

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
  const privkey = Buffer.from(privkeyBytes).toString('hex');

  // Derive public key from private key
  const pubkeyBytes = secp256k1.getPublicKey(privkeyBytes, true);
  // Remove the prefix byte (02 or 03) for compressed public key
  const pubkey = Buffer.from(pubkeyBytes.slice(1)).toString('hex');

  return { pubkey, privkey };
}

/**
 * Derive an encryption key from the master secret using HKDF
 * @param masterSecret - Server master secret
 */
export function deriveEncryptionKey(masterSecret: string): Buffer {
  const salt = Buffer.from('nostr-privkey-encryption', 'utf8');
  const info = Buffer.from('aes-256-gcm', 'utf8');
  const keyMaterial = Buffer.from(masterSecret, 'utf8');

  return Buffer.from(hkdfSync('sha256', keyMaterial, salt, info, 32));
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

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(privkey, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
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
  const iv = Buffer.from(encrypted.iv, 'base64');
  const tag = Buffer.from(encrypted.tag, 'base64');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
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

  return createHash('sha256').update(serialized).digest('hex');
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
  const privkeyBytes = Buffer.from(privkey, 'hex');
  const idBytes = Buffer.from(id, 'hex');

  // Use Schnorr signature (BIP-340) for Nostr
  const sig = schnorr.sign(idBytes, privkeyBytes);
  const sigHex = Buffer.from(sig).toString('hex');

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
    const sigBytes = Buffer.from(event.sig, 'hex');
    const idBytes = Buffer.from(event.id, 'hex');
    // Nostr public keys are x-only (32 bytes) - use directly with Schnorr
    const pubkeyBytes = Buffer.from(event.pubkey, 'hex');

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
  const privkeyBytes = Buffer.from(privkey, 'hex');
  const pubkeyBytes = secp256k1.getPublicKey(privkeyBytes, true);
  const pubkey = Buffer.from(pubkeyBytes.slice(1)).toString('hex');

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
  const words = bech32.toWords(Buffer.from(pubkey, 'hex'));
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
  return Buffer.from(bech32.fromWords(words)).toString('hex');
}

/**
 * Convert hex private key to nsec (bech32)
 */
export function privkeyToNsec(privkey: string): string {
  const words = bech32.toWords(Buffer.from(privkey, 'hex'));
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
  return Buffer.from(bech32.fromWords(words)).toString('hex');
}

/**
 * Get public key from private key
 */
export function getPublicKey(privkey: string): string {
  const privkeyBytes = Buffer.from(privkey, 'hex');
  const pubkeyBytes = secp256k1.getPublicKey(privkeyBytes, true);
  return Buffer.from(pubkeyBytes.slice(1)).toString('hex');
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
    const fullPubkey = Buffer.from(`02${pubkey}`, 'hex');
    secp256k1.ProjectivePoint.fromHex(fullPubkey);
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
    const privkeyBytes = Buffer.from(privkey, 'hex');
    // Check if it's a valid scalar for secp256k1
    secp256k1.getPublicKey(privkeyBytes);
    return true;
  } catch {
    return false;
  }
}
