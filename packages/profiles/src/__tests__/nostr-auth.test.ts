/**
 * Tests for Nostr authentication primitives
 *
 * Tests cover:
 * - Nostr crypto utilities (keypair gen, encryption, signatures, bech32)
 * - NostrIdentity model CRUD and methods
 * - MagicLinkToken model CRUD and methods
 * - NIP-05 handler and utilities
 * - Integration flow
 *
 * Following Organization-Wide Testing Standard:
 * - Uses real resources (in-memory SQLite database)
 * - Tests behavior, not implementation
 * - Tests read like executable examples
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeEventId,
  createAuthEvent,
  createNip05Handler,
  decryptPrivkey,
  deriveEncryptionKey,
  encryptPrivkey,
  // Crypto utilities
  generateNostrKeypair,
  getPublicKey,
  // NIP-05 utilities
  isValidNip05Identifier,
  isValidPrivkey,
  isValidPubkey,
  MagicLinkToken,
  MagicLinkTokenCollection,
  // Models and collections
  NostrIdentity,
  NostrIdentityCollection,
  npubToPubkey,
  nsecToPrivkey,
  ProfileCollection,
  ProfileTypeCollection,
  parseNip05Identifier,
  privkeyToNsec,
  pubkeyToNpub,
  signEvent,
  verifyAuthEvent,
  verifyNostrSignature,
} from '../index.js';

const TEST_MASTER_SECRET = 'test-master-secret-32-bytes-long';

describe('Nostr Crypto Utilities', () => {
  describe('Keypair Generation', () => {
    it('should generate a valid keypair', () => {
      const keypair = generateNostrKeypair();

      expect(keypair.pubkey).toHaveLength(64);
      expect(keypair.privkey).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(keypair.pubkey)).toBe(true);
      expect(/^[0-9a-f]+$/.test(keypair.privkey)).toBe(true);
    });

    it('should generate unique keypairs', () => {
      const keypair1 = generateNostrKeypair();
      const keypair2 = generateNostrKeypair();

      expect(keypair1.pubkey).not.toBe(keypair2.pubkey);
      expect(keypair1.privkey).not.toBe(keypair2.privkey);
    });

    it('should derive public key from private key', () => {
      const keypair = generateNostrKeypair();
      const derivedPubkey = getPublicKey(keypair.privkey);

      expect(derivedPubkey).toBe(keypair.pubkey);
    });
  });

  describe('Key Validation', () => {
    it('should validate a valid public key', () => {
      const keypair = generateNostrKeypair();
      expect(isValidPubkey(keypair.pubkey)).toBe(true);
    });

    it('should reject invalid public keys', () => {
      expect(isValidPubkey('')).toBe(false);
      expect(isValidPubkey('not-hex')).toBe(false);
      expect(isValidPubkey('abc123')).toBe(false);
      expect(isValidPubkey('0'.repeat(64))).toBe(false); // All zeros is not a valid point
    });

    it('should validate a valid private key', () => {
      const keypair = generateNostrKeypair();
      expect(isValidPrivkey(keypair.privkey)).toBe(true);
    });

    it('should reject invalid private keys', () => {
      expect(isValidPrivkey('')).toBe(false);
      expect(isValidPrivkey('not-hex')).toBe(false);
      expect(isValidPrivkey('abc123')).toBe(false);
    });
  });

  describe('Private Key Encryption', () => {
    it('should encrypt and decrypt a private key', () => {
      const keypair = generateNostrKeypair();

      const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);

      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.tag).toBeTruthy();

      const decrypted = decryptPrivkey(encrypted, TEST_MASTER_SECRET);
      expect(decrypted).toBe(keypair.privkey);
    });

    it('should fail to decrypt with wrong master secret', () => {
      const keypair = generateNostrKeypair();
      const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);

      expect(() =>
        decryptPrivkey(encrypted, 'wrong-master-secret-32-bytes!!!'),
      ).toThrow();
    });

    it('should derive consistent encryption key', () => {
      const key1 = deriveEncryptionKey(TEST_MASTER_SECRET);
      const key2 = deriveEncryptionKey(TEST_MASTER_SECRET);

      expect(key1.toString('hex')).toBe(key2.toString('hex'));
      expect(key1).toHaveLength(32); // AES-256 key
    });
  });

  describe('Bech32 Encoding', () => {
    it('should convert pubkey to npub and back', () => {
      const keypair = generateNostrKeypair();

      const npub = pubkeyToNpub(keypair.pubkey);
      expect(npub.startsWith('npub1')).toBe(true);

      const pubkey = npubToPubkey(npub);
      expect(pubkey).toBe(keypair.pubkey);
    });

    it('should convert privkey to nsec and back', () => {
      const keypair = generateNostrKeypair();

      const nsec = privkeyToNsec(keypair.privkey);
      expect(nsec.startsWith('nsec1')).toBe(true);

      const privkey = nsecToPrivkey(nsec);
      expect(privkey).toBe(keypair.privkey);
    });

    it('should reject invalid npub prefix', () => {
      const keypair = generateNostrKeypair();
      const nsec = privkeyToNsec(keypair.privkey);

      expect(() => npubToPubkey(nsec)).toThrow('Invalid npub prefix');
    });

    it('should reject invalid nsec prefix', () => {
      const keypair = generateNostrKeypair();
      const npub = pubkeyToNpub(keypair.pubkey);

      expect(() => nsecToPrivkey(npub)).toThrow('Invalid nsec prefix');
    });
  });

  describe('Event Signing', () => {
    it('should sign and verify an event', () => {
      const keypair = generateNostrKeypair();

      const event = {
        pubkey: keypair.pubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [],
        content: 'Hello, Nostr!',
      };

      const signedEvent = signEvent(event, keypair.privkey);

      expect(signedEvent.id).toHaveLength(64);
      expect(signedEvent.sig).toHaveLength(128);
      expect(verifyNostrSignature(signedEvent)).toBe(true);
    });

    it('should compute event ID correctly', () => {
      const keypair = generateNostrKeypair();
      const event = {
        pubkey: keypair.pubkey,
        created_at: 1234567890,
        kind: 1,
        tags: [],
        content: 'Test content',
      };

      const id = computeEventId(event as any);
      expect(id).toHaveLength(64);

      // Same event should always produce same ID
      const id2 = computeEventId(event as any);
      expect(id).toBe(id2);
    });

    it('should reject event with invalid signature', () => {
      const keypair = generateNostrKeypair();
      const signedEvent = signEvent(
        {
          pubkey: keypair.pubkey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 1,
          tags: [],
          content: 'Test',
        },
        keypair.privkey,
      );

      // Tamper with the signature
      signedEvent.sig = '0'.repeat(128);
      expect(verifyNostrSignature(signedEvent)).toBe(false);
    });

    it('should reject event with tampered content', () => {
      const keypair = generateNostrKeypair();
      const signedEvent = signEvent(
        {
          pubkey: keypair.pubkey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 1,
          tags: [],
          content: 'Original content',
        },
        keypair.privkey,
      );

      // Tamper with the content
      signedEvent.content = 'Modified content';
      expect(verifyNostrSignature(signedEvent)).toBe(false);
    });
  });

  describe('Auth Event (NIP-42)', () => {
    it('should create and verify an auth event', () => {
      const keypair = generateNostrKeypair();
      const challenge = 'test-challenge-12345';

      const authEvent = createAuthEvent(keypair.privkey, challenge);

      expect(authEvent.kind).toBe(22242);
      expect(authEvent.pubkey).toBe(keypair.pubkey);
      expect(authEvent.tags.find((t) => t[0] === 'challenge')?.[1]).toBe(
        challenge,
      );

      const result = verifyAuthEvent(authEvent, challenge);
      expect(result.valid).toBe(true);
    });

    it('should create auth event with relay', () => {
      const keypair = generateNostrKeypair();
      const challenge = 'test-challenge';
      const relay = 'wss://relay.example.com';

      const authEvent = createAuthEvent(keypair.privkey, challenge, relay);

      expect(authEvent.tags.find((t) => t[0] === 'relay')?.[1]).toBe(relay);
    });

    it('should reject auth event with wrong challenge', () => {
      const keypair = generateNostrKeypair();
      const authEvent = createAuthEvent(keypair.privkey, 'correct-challenge');

      const result = verifyAuthEvent(authEvent, 'wrong-challenge');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Challenge mismatch');
    });

    it('should reject expired auth event', () => {
      const keypair = generateNostrKeypair();
      const challenge = 'test-challenge';

      // Create event with old timestamp
      const authEvent = signEvent(
        {
          pubkey: keypair.pubkey,
          created_at: Math.floor(Date.now() / 1000) - 600, // 10 minutes ago
          kind: 22242,
          tags: [['challenge', challenge]],
          content: '',
        },
        keypair.privkey,
      );

      const result = verifyAuthEvent(authEvent, challenge, 300); // 5 min max age
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Event expired or too far in future');
    });

    it('should reject auth event with wrong kind', () => {
      const keypair = generateNostrKeypair();
      const challenge = 'test-challenge';

      const event = signEvent(
        {
          pubkey: keypair.pubkey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 1, // Wrong kind (should be 22242)
          tags: [['challenge', challenge]],
          content: '',
        },
        keypair.privkey,
      );

      const result = verifyAuthEvent(event, challenge);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid event kind');
    });
  });
});

describe('NIP-05 Utilities', () => {
  describe('isValidNip05Identifier', () => {
    it('should accept valid identifiers', () => {
      expect(isValidNip05Identifier('alice@example.com')).toBe(true);
      expect(isValidNip05Identifier('bob_smith@domain.org')).toBe(true);
      expect(isValidNip05Identifier('test-user@sub.domain.io')).toBe(true);
      expect(isValidNip05Identifier('user123@site.co')).toBe(true);
    });

    it('should reject invalid identifiers', () => {
      expect(isValidNip05Identifier('')).toBe(false);
      expect(isValidNip05Identifier('noatsign')).toBe(false);
      expect(isValidNip05Identifier('multiple@at@signs')).toBe(false);
      expect(isValidNip05Identifier('invalid chars@domain.com')).toBe(false);
      expect(isValidNip05Identifier('user@nodot')).toBe(false);
    });
  });

  describe('parseNip05Identifier', () => {
    it('should parse valid identifiers', () => {
      const result = parseNip05Identifier('alice@example.com');
      expect(result).toEqual({ localPart: 'alice', domain: 'example.com' });
    });

    it('should return null for invalid identifiers', () => {
      expect(parseNip05Identifier('invalid')).toBeNull();
      expect(parseNip05Identifier('')).toBeNull();
    });
  });
});

describe('NostrIdentity Model', () => {
  let dbUrl: string;

  beforeEach(async () => {
    dbUrl = join(tmpdir(), `nostr-test-${Date.now()}.db`);
  });

  describe('CRUD Operations', () => {
    it('should create a NostrIdentity', async () => {
      const profileTypeCollection = await ProfileTypeCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });
      const profileType = await profileTypeCollection.create({
        name: 'Person',
      });
      await profileType.save();

      const profileCollection = await ProfileCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });
      const profile = await profileCollection.create({
        typeId: profileType.id,
        name: 'Test User',
        email: 'test@example.com',
      });
      await profile.save();

      const collection = await NostrIdentityCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });

      const keypair = generateNostrKeypair();
      const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);

      const identity = await collection.create({
        profileId: profile.id,
        pubkey: keypair.pubkey,
        encryptedPrivkey: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
        email: 'test@example.com',
        nip05Username: 'testuser',
      });
      await identity.save();

      expect(identity.id).toBeDefined();
      expect(identity.pubkey).toBe(keypair.pubkey);
      expect(identity.email).toBe('test@example.com');
      expect(identity.nip05Username).toBe('testuser');
    });

    it('should find NostrIdentity by pubkey', async () => {
      const profileTypeCollection = await ProfileTypeCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });
      const profileType = await profileTypeCollection.create({
        name: 'Person',
      });
      await profileType.save();

      const profileCollection = await ProfileCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });
      const profile = await profileCollection.create({
        typeId: profileType.id,
        name: 'Test User',
        email: 'test@example.com',
      });
      await profile.save();

      const collection = await NostrIdentityCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });

      const keypair = generateNostrKeypair();
      const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);

      const identity = await collection.create({
        profileId: profile.id,
        pubkey: keypair.pubkey,
        encryptedPrivkey: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
        email: 'pubkey@example.com',
      });
      await identity.save();

      const found = await collection.findByPubkey(keypair.pubkey);
      expect(found).toBeDefined();
      expect(found?.id).toBe(identity.id);
    });

    it('should find NostrIdentity by email', async () => {
      const profileTypeCollection = await ProfileTypeCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });
      const profileType = await profileTypeCollection.create({
        name: 'Person',
      });
      await profileType.save();

      const profileCollection = await ProfileCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });
      const profile = await profileCollection.create({
        typeId: profileType.id,
        name: 'Test User',
        email: 'email@example.com',
      });
      await profile.save();

      const collection = await NostrIdentityCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });

      const keypair = generateNostrKeypair();
      const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);

      const identity = await collection.create({
        profileId: profile.id,
        pubkey: keypair.pubkey,
        encryptedPrivkey: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
        email: 'email@example.com',
      });
      await identity.save();

      const found = await collection.findByEmail('email@example.com');
      expect(found).toBeDefined();
      expect(found?.id).toBe(identity.id);
    });
  });

  describe('Instance Methods', () => {
    it('should decrypt private key', async () => {
      const keypair = generateNostrKeypair();
      const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);

      const identity = new NostrIdentity({
        pubkey: keypair.pubkey,
        encryptedPrivkey: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
        email: 'test@example.com',
      });

      const decrypted = identity.decryptPrivkey(TEST_MASTER_SECRET);
      expect(decrypted).toBe(keypair.privkey);
    });

    it('should return full keypair with bech32 encoding', async () => {
      const keypair = generateNostrKeypair();
      const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);

      const identity = new NostrIdentity({
        pubkey: keypair.pubkey,
        encryptedPrivkey: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
        email: 'test@example.com',
      });

      const fullKeypair = identity.getKeypair(TEST_MASTER_SECRET);

      expect(fullKeypair.pubkey).toBe(keypair.pubkey);
      expect(fullKeypair.privkey).toBe(keypair.privkey);
      expect(fullKeypair.npub.startsWith('npub1')).toBe(true);
      expect(fullKeypair.nsec.startsWith('nsec1')).toBe(true);
    });

    it('should generate NIP-05 identifier', () => {
      const identity = new NostrIdentity({
        email: 'alice@example.com',
        nip05Username: 'alice',
      });

      expect(identity.getNip05Identifier('nostr.example.com')).toBe(
        'alice@nostr.example.com',
      );
    });

    it('should use email local part if no nip05Username', () => {
      const identity = new NostrIdentity({
        email: 'bob@example.com',
      });

      expect(identity.getNip05Identifier('nostr.example.com')).toBe(
        'bob@nostr.example.com',
      );
    });

    it('should track verification status', () => {
      const identity = new NostrIdentity({
        email: 'test@example.com',
      });

      expect(identity.isVerified()).toBe(false);

      identity.verifiedAt = new Date();
      expect(identity.isVerified()).toBe(true);
    });
  });
});

describe('MagicLinkToken Model', () => {
  let dbUrl: string;

  beforeEach(async () => {
    dbUrl = join(tmpdir(), `magic-test-${Date.now()}.db`);
  });

  describe('Token Generation', () => {
    it('should hash tokens consistently', () => {
      const token = 'test-token-value';
      const hash1 = MagicLinkToken.hashToken(token);
      const hash2 = MagicLinkToken.hashToken(token);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 produces 64 hex characters
    });

    it('should generate unique tokens', async () => {
      // Create supporting models
      const profileTypeCollection = await ProfileTypeCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });
      const profileType = await profileTypeCollection.create({
        name: 'Person',
      });
      await profileType.save();

      const profileCollection = await ProfileCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });
      const profile = await profileCollection.create({
        typeId: profileType.id,
        name: 'Token Test User',
        email: 'token@example.com',
      });
      await profile.save();

      const identityCollection = await NostrIdentityCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });
      const keypair = generateNostrKeypair();
      const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);
      const identity = await identityCollection.create({
        profileId: profile.id,
        pubkey: keypair.pubkey,
        encryptedPrivkey: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
        email: 'token@example.com',
      });
      await identity.save();

      // Generate multiple tokens
      const result1 = await MagicLinkToken.generate(
        identity,
        'token@example.com',
        { db: { type: 'sqlite', url: dbUrl } },
      );
      const result2 = await MagicLinkToken.generate(
        identity,
        'token@example.com',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      expect(result1.token).not.toBe(result2.token);
      expect(result1.magicLinkToken.id).not.toBe(result2.magicLinkToken.id);
    });
  });

  describe('Token Validation', () => {
    it('should mark token as valid when not expired and not used', () => {
      const token = new MagicLinkToken({
        expiresAt: new Date(Date.now() + 60000), // 1 minute from now
        usedAt: null,
      });

      expect(token.isValid()).toBe(true);
      expect(token.isExpired()).toBe(false);
      expect(token.isUsed()).toBe(false);
    });

    it('should mark token as invalid when expired', () => {
      const token = new MagicLinkToken({
        expiresAt: new Date(Date.now() - 60000), // 1 minute ago
        usedAt: null,
      });

      expect(token.isValid()).toBe(false);
      expect(token.isExpired()).toBe(true);
    });

    it('should mark token as invalid when used', () => {
      const token = new MagicLinkToken({
        expiresAt: new Date(Date.now() + 60000),
        usedAt: new Date(),
      });

      expect(token.isValid()).toBe(false);
      expect(token.isUsed()).toBe(true);
    });

    it('should calculate time remaining', () => {
      const token = new MagicLinkToken({
        expiresAt: new Date(Date.now() + 120000), // 2 minutes from now
      });

      const remaining = token.getTimeRemainingSeconds();
      expect(remaining).toBeGreaterThan(110);
      expect(remaining).toBeLessThanOrEqual(120);
    });

    it('should return 0 for expired tokens', () => {
      const token = new MagicLinkToken({
        expiresAt: new Date(Date.now() - 60000), // 1 minute ago
      });

      expect(token.getTimeRemainingSeconds()).toBe(0);
    });
  });
});

describe('NIP-05 Handler', () => {
  let dbUrl: string;

  beforeEach(async () => {
    dbUrl = join(tmpdir(), `nip05-test-${Date.now()}.db`);
  });

  it('should return NIP-05 response for known user', async () => {
    // Setup
    const profileTypeCollection = await ProfileTypeCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profileType = await profileTypeCollection.create({
      name: 'Person',
    });
    await profileType.save();

    const profileCollection = await ProfileCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profile = await profileCollection.create({
      typeId: profileType.id,
      name: 'NIP-05 User',
      email: 'nip05@example.com',
    });
    await profile.save();

    const identityCollection = await NostrIdentityCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const keypair = generateNostrKeypair();
    const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);
    const identity = await identityCollection.create({
      profileId: profile.id,
      pubkey: keypair.pubkey,
      encryptedPrivkey: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
      email: 'nip05@example.com',
      nip05Username: 'alice',
    });
    await identity.save();

    // Create handler and test
    const handler = createNip05Handler({
      db: { type: 'sqlite', url: dbUrl },
    });

    const result = await handler({ name: 'alice' });

    expect(result.status).toBe(200);
    expect(result.body.names.alice).toBe(keypair.pubkey);
    expect(result.headers['Content-Type']).toBe('application/json');
    expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('should return empty names for unknown user', async () => {
    // Setup minimal DB
    const profileTypeCollection = await ProfileTypeCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profileType = await profileTypeCollection.create({
      name: 'Person',
    });
    await profileType.save();

    // Create empty identity collection
    await NostrIdentityCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });

    const handler = createNip05Handler({
      db: { type: 'sqlite', url: dbUrl },
    });

    const result = await handler({ name: 'unknown' });

    expect(result.status).toBe(200); // NIP-05 spec says 200 with empty names
    expect(result.body.names).toEqual({});
  });

  it('should add default relays when configured', async () => {
    // Setup
    const profileTypeCollection = await ProfileTypeCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profileType = await profileTypeCollection.create({
      name: 'Person',
    });
    await profileType.save();

    const profileCollection = await ProfileCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profile = await profileCollection.create({
      typeId: profileType.id,
      name: 'Relay Test User',
      email: 'relay@example.com',
    });
    await profile.save();

    const identityCollection = await NostrIdentityCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const keypair = generateNostrKeypair();
    const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);
    const identity = await identityCollection.create({
      profileId: profile.id,
      pubkey: keypair.pubkey,
      encryptedPrivkey: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
      email: 'relay@example.com',
      nip05Username: 'bob',
    });
    await identity.save();

    const handler = createNip05Handler({
      db: { type: 'sqlite', url: dbUrl },
      defaultRelays: ['wss://relay1.example.com', 'wss://relay2.example.com'],
    });

    const result = await handler({ name: 'bob' });

    expect(result.body.relays).toBeDefined();
    expect(result.body.relays?.[keypair.pubkey]).toEqual([
      'wss://relay1.example.com',
      'wss://relay2.example.com',
    ]);
  });
});

describe('NostrIdentityCollection', () => {
  let dbUrl: string;

  beforeEach(async () => {
    dbUrl = join(tmpdir(), `collection-test-${Date.now()}.db`);
  });

  it('should create identity for profile', async () => {
    // Setup
    const profileTypeCollection = await ProfileTypeCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profileType = await profileTypeCollection.create({
      name: 'Person',
    });
    await profileType.save();

    const profileCollection = await ProfileCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profile = await profileCollection.create({
      typeId: profileType.id,
      name: 'Collection Test User',
      email: 'collection@example.com',
    });
    await profile.save();

    const identityCollection = await NostrIdentityCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });

    const identity = await identityCollection.createForProfile(
      profile,
      'collection@example.com',
      TEST_MASTER_SECRET,
      'collectionuser',
    );

    expect(identity.id).toBeDefined();
    expect(identity.profileId).toBe(profile.id);
    expect(identity.email).toBe('collection@example.com');
    expect(identity.nip05Username).toBe('collectionuser');
    expect(identity.pubkey).toHaveLength(64);
    expect(identity.encryptedPrivkey).toBeTruthy();
  });

  it('should return NIP-05 response', async () => {
    // Setup
    const profileTypeCollection = await ProfileTypeCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profileType = await profileTypeCollection.create({
      name: 'Person',
    });
    await profileType.save();

    const profileCollection = await ProfileCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profile = await profileCollection.create({
      typeId: profileType.id,
      name: 'NIP Response User',
      email: 'nipresponse@example.com',
    });
    await profile.save();

    const identityCollection = await NostrIdentityCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });

    const identity = await identityCollection.createForProfile(
      profile,
      'nipresponse@example.com',
      TEST_MASTER_SECRET,
      'nipuser',
    );

    const response = await identityCollection.getNip05Response('nipuser');

    expect(response.names.nipuser).toBe(identity.pubkey);
  });
});

describe('MagicLinkTokenCollection', () => {
  let dbUrl: string;

  beforeEach(async () => {
    dbUrl = join(tmpdir(), `rate-limit-test-${Date.now()}.db`);
  });

  it('should count recent tokens by email', async () => {
    // Setup
    const profileTypeCollection = await ProfileTypeCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profileType = await profileTypeCollection.create({
      name: 'Person',
    });
    await profileType.save();

    const profileCollection = await ProfileCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profile = await profileCollection.create({
      typeId: profileType.id,
      name: 'Rate Limit User',
      email: 'ratelimit@example.com',
    });
    await profile.save();

    const identityCollection = await NostrIdentityCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const identity = await identityCollection.createForProfile(
      profile,
      'ratelimit@example.com',
      TEST_MASTER_SECRET,
    );

    // Generate multiple tokens
    await MagicLinkToken.generate(identity, 'ratelimit@example.com', {
      db: { type: 'sqlite', url: dbUrl },
    });
    await MagicLinkToken.generate(identity, 'ratelimit@example.com', {
      db: { type: 'sqlite', url: dbUrl },
    });
    await MagicLinkToken.generate(identity, 'ratelimit@example.com', {
      db: { type: 'sqlite', url: dbUrl },
    });

    const tokenCollection = await MagicLinkTokenCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });

    const count = await tokenCollection.countRecentByEmail(
      'ratelimit@example.com',
      60,
    );

    expect(count).toBe(3);
  });

  it('should detect rate limiting by email', async () => {
    // Setup
    const profileTypeCollection = await ProfileTypeCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profileType = await profileTypeCollection.create({
      name: 'Person',
    });
    await profileType.save();

    const profileCollection = await ProfileCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const profile = await profileCollection.create({
      typeId: profileType.id,
      name: 'Rate Test User',
      email: 'ratetest@example.com',
    });
    await profile.save();

    const identityCollection = await NostrIdentityCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const identity = await identityCollection.createForProfile(
      profile,
      'ratetest@example.com',
      TEST_MASTER_SECRET,
    );

    // Generate tokens to trigger rate limit (default is 5/hour)
    for (let i = 0; i < 6; i++) {
      await MagicLinkToken.generate(identity, 'ratetest@example.com', {
        db: { type: 'sqlite', url: dbUrl },
      });
    }

    const tokenCollection = await MagicLinkTokenCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });

    const isRateLimited = await tokenCollection.isRateLimitedByEmail(
      'ratetest@example.com',
      5,
    );

    expect(isRateLimited).toBe(true);
  });
});
