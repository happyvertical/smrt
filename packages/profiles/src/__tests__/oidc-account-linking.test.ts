/**
 * Tests for OIDC account linking functionality
 *
 * Tests the createProfileFromOidc function which handles:
 * - Creating new profiles from OIDC claims
 * - Linking multiple OIDC identities to the same profile by email
 * - Security: only linking when email_verified is true
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProfileFromOidc } from '../auth/resolveIdentity.js';
import { OidcIdentityCollection } from '../collections/OidcIdentityCollection.js';
import { ProfileCollection } from '../collections/ProfileCollection.js';
import { ProfileTypeCollection } from '../collections/ProfileTypeCollection.js';

describe('OIDC Account Linking', () => {
  let dbUrl: string;

  beforeEach(async () => {
    // Use a temp file database for each test
    dbUrl = join(
      tmpdir(),
      `test-oidc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );

    // Initialize collections to create tables
    const typeCollection = await ProfileTypeCollection.create({
      persistence: { type: 'sqlite', url: dbUrl },
    });
    const personType = await typeCollection.create({
      name: 'Person',
      description: 'Individual person',
    });
    await personType.save();
  });

  describe('createProfileFromOidc', () => {
    it('should create a new profile for first-time OIDC login', async () => {
      const { profile, oidcIdentity, created } = await createProfileFromOidc(
        {
          sub: 'google-user-123',
          iss: 'https://accounts.google.com',
          email: 'alice@example.com',
          email_verified: true,
          name: 'Alice Johnson',
        },
        'google',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      expect(created).toBe(true);
      expect(profile.id).toBeDefined();
      expect(profile.email).toBe('alice@example.com');
      expect(profile.name).toBe('Alice Johnson');
      expect(oidcIdentity.subject).toBe('google-user-123');
      expect(oidcIdentity.issuer).toBe('https://accounts.google.com');
    });

    it('should return existing profile for same OIDC identity', async () => {
      const claims = {
        sub: 'google-user-456',
        iss: 'https://accounts.google.com',
        email: 'bob@example.com',
        email_verified: true,
        name: 'Bob Smith',
      };

      // First login
      const first = await createProfileFromOidc(claims, 'google', {
        db: { type: 'sqlite', url: dbUrl },
      });
      expect(first.created).toBe(true);

      // Second login with same identity
      const second = await createProfileFromOidc(claims, 'google', {
        db: { type: 'sqlite', url: dbUrl },
      });
      expect(second.created).toBe(false);
      expect(second.profile.id).toBe(first.profile.id);
      expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
    });

    it('should link different providers with same verified email to same profile', async () => {
      const email = 'carol@example.com';

      // First login with Google
      const googleLogin = await createProfileFromOidc(
        {
          sub: 'google-carol-123',
          iss: 'https://accounts.google.com',
          email,
          email_verified: true,
          name: 'Carol Davis',
        },
        'google',
        { db: { type: 'sqlite', url: dbUrl } },
      );
      expect(googleLogin.created).toBe(true);

      // Second login with GitHub (same email)
      const githubLogin = await createProfileFromOidc(
        {
          sub: '98765',
          iss: 'https://github.com',
          email,
          email_verified: true,
          name: 'Carol Davis',
        },
        'github',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      // Should link to same profile, not create new one
      expect(githubLogin.created).toBe(false);
      expect(githubLogin.profile.id).toBe(googleLogin.profile.id);

      // But should have different OIDC identities
      expect(githubLogin.oidcIdentity.id).not.toBe(googleLogin.oidcIdentity.id);
      expect(githubLogin.oidcIdentity.issuer).toBe('https://github.com');
      expect(googleLogin.oidcIdentity.issuer).toBe(
        'https://accounts.google.com',
      );

      // Verify both identities exist and link to same profile
      const identityCollection = await OidcIdentityCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });
      const identities = await identityCollection.list({});
      expect(identities.length).toBe(2);
      expect(
        identities.every((i) => i.profileId === googleLogin.profile.id),
      ).toBe(true);
    });

    it('should NOT link accounts when email is not verified', async () => {
      const email = 'dave@example.com';

      // First login with verified email
      const firstLogin = await createProfileFromOidc(
        {
          sub: 'provider1-dave',
          iss: 'https://provider1.com',
          email,
          email_verified: true,
          name: 'Dave Wilson',
        },
        'provider1',
        { db: { type: 'sqlite', url: dbUrl } },
      );
      expect(firstLogin.created).toBe(true);

      // Second login with UNVERIFIED email (should NOT link)
      const secondLogin = await createProfileFromOidc(
        {
          sub: 'provider2-dave',
          iss: 'https://provider2.com',
          email,
          email_verified: false, // Not verified!
          name: 'Dave Wilson',
        },
        'provider2',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      // Should create a new profile, not link to existing
      expect(secondLogin.created).toBe(true);
      expect(secondLogin.profile.id).not.toBe(firstLogin.profile.id);
    });

    it('should NOT link accounts when email_verified is undefined', async () => {
      const email = 'eve@example.com';

      // First login with verified email
      const firstLogin = await createProfileFromOidc(
        {
          sub: 'provider1-eve',
          iss: 'https://provider1.com',
          email,
          email_verified: true,
          name: 'Eve Brown',
        },
        'provider1',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      // Second login without email_verified claim
      const secondLogin = await createProfileFromOidc(
        {
          sub: 'provider2-eve',
          iss: 'https://provider2.com',
          email,
          // email_verified is undefined
          name: 'Eve Brown',
        },
        'provider2',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      // Should create a new profile, not link
      expect(secondLogin.created).toBe(true);
      expect(secondLogin.profile.id).not.toBe(firstLogin.profile.id);
    });

    it('should create separate profiles for different emails', async () => {
      const login1 = await createProfileFromOidc(
        {
          sub: 'user-1',
          iss: 'https://auth.example.com',
          email: 'user1@example.com',
          email_verified: true,
          name: 'User One',
        },
        'example',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      const login2 = await createProfileFromOidc(
        {
          sub: 'user-2',
          iss: 'https://auth.example.com',
          email: 'user2@example.com',
          email_verified: true,
          name: 'User Two',
        },
        'example',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      expect(login1.created).toBe(true);
      expect(login2.created).toBe(true);
      expect(login1.profile.id).not.toBe(login2.profile.id);
    });

    it('should handle login without email', async () => {
      const { profile, created } = await createProfileFromOidc(
        {
          sub: 'nostr-pubkey-abc123',
          iss: 'https://nostr.example.com',
          // No email
          name: 'Anon User',
        },
        'nostr',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      expect(created).toBe(true);
      expect(profile.id).toBeDefined();
      expect(profile.name).toBe('Anon User');
    });
  });

  describe('ProfileCollection.findByEmail', () => {
    it('should find profile by email case-insensitively', async () => {
      const collection = await ProfileCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });

      // Create a profile with lowercase email
      await createProfileFromOidc(
        {
          sub: 'user-123',
          iss: 'https://auth.example.com',
          email: 'test@example.com',
          email_verified: true,
          name: 'Test User',
        },
        'example',
        { db: { type: 'sqlite', url: dbUrl } },
      );

      // Find by uppercase email
      const found = await collection.findByEmail('TEST@EXAMPLE.COM');
      expect(found).not.toBeNull();
      expect(found?.email).toBe('test@example.com');
    });

    it('should return null for non-existent email', async () => {
      const collection = await ProfileCollection.create({
        persistence: { type: 'sqlite', url: dbUrl },
      });

      const found = await collection.findByEmail('nonexistent@example.com');
      expect(found).toBeNull();
    });
  });
});
