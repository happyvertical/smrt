/**
 * Nostr crypto round-trips pinned to the @noble/curves 2.x API
 * (`secp256k1.js` subpath, `Point.fromBytes`) so a curve-library upgrade
 * cannot silently break key derivation, signing, or pubkey validation.
 */
import { describe, expect, it } from 'vitest';
import {
  createAuthEvent,
  generateNostrKeypair,
  getPublicKey,
  isValidPrivkey,
  isValidPubkey,
  signEvent,
  verifyAuthEvent,
  verifyNostrSignature,
} from '../auth/nostrCrypto';

// BIP-340 test vector 1: secret key 3 -> x-only public key.
const BIP340_SECKEY =
  '0000000000000000000000000000000000000000000000000000000000000003';
const BIP340_PUBKEY =
  'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';

describe('nostrCrypto', () => {
  it('derives the BIP-340 x-only public key', () => {
    expect(getPublicKey(BIP340_SECKEY)).toBe(BIP340_PUBKEY);
  });

  it('generates keypairs whose pubkey matches the privkey', () => {
    const { pubkey, privkey } = generateNostrKeypair();
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(getPublicKey(privkey)).toBe(pubkey);
    expect(isValidPrivkey(privkey)).toBe(true);
    expect(isValidPubkey(pubkey)).toBe(true);
  });

  it('signs and verifies events, rejecting tampering', () => {
    const { pubkey, privkey } = generateNostrKeypair();
    const signed = signEvent(
      { pubkey, created_at: 1, kind: 1, tags: [], content: 'hello' },
      privkey,
    );
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyNostrSignature(signed)).toBe(true);
    expect(verifyNostrSignature({ ...signed, content: 'tampered' })).toBe(
      false,
    );
  });

  it('round-trips NIP-42 auth events', () => {
    const { privkey } = generateNostrKeypair();
    const event = createAuthEvent(privkey, 'challenge-1', 'wss://relay');
    expect(verifyAuthEvent(event, 'challenge-1')).toEqual({ valid: true });
    expect(verifyAuthEvent(event, 'other').valid).toBe(false);
  });

  it('rejects x coordinates that are not on the curve', () => {
    // x = 5 has no secp256k1 point (x^3 + 7 is a non-residue mod p).
    expect(isValidPubkey(`${'0'.repeat(63)}5`)).toBe(false);
    expect(isValidPubkey('zz')).toBe(false);
    expect(isValidPrivkey('0'.repeat(64))).toBe(false);
  });
});
