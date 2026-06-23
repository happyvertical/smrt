/**
 * Tests for API key authentication: the ApiKey model and ApiKeyCollection,
 * plus the Profile-level convenience wrappers (getApiKeys / getActiveApiKeys /
 * generateApiKey).
 *
 * Following the Organization-Wide Testing Standard:
 * - Real in-memory/file SQLite, no DB mocking
 * - Tests behaviour, not implementation
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApiKey,
  ApiKeyCollection,
  ProfileCollection,
  ProfileTypeCollection,
} from '../index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function createProfileFixture(dbUrl: string) {
  const db = { type: 'sqlite' as const, url: dbUrl };
  const profiles = await ProfileCollection.create({ db });
  const profileTypes = await ProfileTypeCollection.create({ db });

  const type = await profileTypes.create({ name: 'Person' });
  await type.save();

  const profile = await profiles.create({
    typeId: type.id,
    name: 'Alice Example',
    email: `alice-${randomUUID()}@example.com`,
  });
  await profile.save();

  return { db, profiles, profile };
}

describe('ApiKey model', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('api-keys');
  });

  it('hashes keys deterministically', () => {
    const hashA = ApiKey.hashKey('sk_live_secret');
    const hashB = ApiKey.hashKey('sk_live_secret');
    expect(hashA).toBe(hashB);
    expect(hashA).toHaveLength(64); // SHA-256 hex
    expect(ApiKey.hashKey('different')).not.toBe(hashA);
  });

  it('generates a key, returns the plaintext once, and stores only the hash', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);

    const { key, apiKey } = await ApiKey.generate(profile, {
      name: 'CI Bot',
      scopes: ['repo:read'],
      db,
    });

    expect(key.startsWith('sk_live_')).toBe(true);
    expect(apiKey.keyPrefix).toBe(key.substring(0, 16));
    expect(apiKey.keyHash).toBe(ApiKey.hashKey(key));
    expect(apiKey.keyHash).not.toBe(key);
    expect(apiKey.name).toBe('CI Bot');
    expect(apiKey.scopes).toEqual(['repo:read']);
    expect(apiKey.profileId).toBe(profile.id);
  });

  it('defaults to the wildcard scope when none are provided', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);
    const { apiKey } = await ApiKey.generate(profile, { name: 'CLI', db });

    expect(apiKey.scopes).toEqual(['*']);
    expect(apiKey.hasScope('anything')).toBe(true);
    expect(apiKey.hasScope('repo:write')).toBe(true);
  });

  it('checks specific scopes', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);
    const { apiKey } = await ApiKey.generate(profile, {
      name: 'scoped',
      scopes: ['repo:read', 'issues:write'],
      db,
    });

    expect(apiKey.hasScope('repo:read')).toBe(true);
    expect(apiKey.hasScope('issues:write')).toBe(true);
    expect(apiKey.hasScope('admin')).toBe(false);
  });

  it('reports validity based on revocation and expiry', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);

    const active = await ApiKey.generate(profile, { name: 'active', db });
    expect(active.apiKey.isValid()).toBe(true);

    const expired = await ApiKey.generate(profile, {
      name: 'expired',
      expiresAt: new Date(Date.now() - 60_000),
      db,
    });
    expect(expired.apiKey.isValid()).toBe(false);

    await active.apiKey.revoke();
    expect(active.apiKey.isValid()).toBe(false);
    expect(active.apiKey.revokedAt).toBeInstanceOf(Date);
  });

  it('records usage timestamps', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);
    const { apiKey } = await ApiKey.generate(profile, { name: 'used', db });

    expect(apiKey.lastUsedAt).toBeNull();
    await apiKey.recordUsage();
    expect(apiKey.lastUsedAt).toBeInstanceOf(Date);
  });

  it('resolves the linked profile', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);
    const { apiKey } = await ApiKey.generate(profile, { name: 'linked', db });

    const linked = await apiKey.getProfile();
    expect(linked?.id).toBe(profile.id);
  });

  it('verifies a valid key and records usage; rejects unknown/expired/revoked', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);

    const { key } = await ApiKey.generate(profile, { name: 'verify', db });
    const verified = await ApiKey.verify(key, { db });
    expect(verified).not.toBeNull();
    expect(verified?.lastUsedAt).toBeInstanceOf(Date);

    expect(await ApiKey.verify('sk_live_nope', { db })).toBeNull();

    const expired = await ApiKey.generate(profile, {
      name: 'expired',
      expiresAt: new Date(Date.now() - 60_000),
      db,
    });
    expect(await ApiKey.verify(expired.key, { db })).toBeNull();
  });
});

describe('ApiKeyCollection', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('api-key-collection');
  });

  it('generates, finds, and filters keys by profile', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);
    const collection = await ApiKeyCollection.create({ db });

    await collection.generateForProfile(profile, { name: 'first' });
    const second = await collection.generateForProfile(profile, {
      name: 'second',
    });

    const all = await collection.findByProfile(profile.id as string);
    expect(all).toHaveLength(2);

    // Revoke one; only active keys remain in findActiveByProfile.
    await second.apiKey.revoke();
    const active = await collection.findActiveByProfile(profile.id as string);
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('first');
  });

  it('finds a key by hash and verifies a key string', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);
    const collection = await ApiKeyCollection.create({ db });

    const { key, apiKey } = await collection.generateForProfile(profile, {
      name: 'hash',
    });

    const byHash = await collection.findByHash(apiKey.keyHash);
    expect(byHash?.id).toBe(apiKey.id);

    const verified = await collection.verify(key);
    expect(verified?.id).toBe(apiKey.id);

    expect(await collection.verify('sk_live_unknown')).toBeNull();
  });

  it('revokes all active keys for a profile', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);
    const collection = await ApiKeyCollection.create({ db });

    await collection.generateForProfile(profile, { name: 'a' });
    await collection.generateForProfile(profile, { name: 'b' });

    const revokedCount = await collection.revokeAllForProfile(
      profile.id as string,
    );
    expect(revokedCount).toBe(2);
    expect(await collection.findActiveByProfile(profile.id as string)).toEqual(
      [],
    );
  });

  it('revokes a key by prefix', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);
    const collection = await ApiKeyCollection.create({ db });

    const { apiKey } = await collection.generateForProfile(profile, {
      name: 'prefixed',
    });

    expect(await collection.revokeByPrefix(apiKey.keyPrefix)).toBe(true);
    // A second attempt finds the now-revoked key but does not re-revoke it.
    expect(await collection.revokeByPrefix(apiKey.keyPrefix)).toBe(false);
    // Unknown prefix.
    expect(await collection.revokeByPrefix('sk_live_missing')).toBe(false);
  });

  it('cleans up expired keys by soft-revoking them', async () => {
    const { db, profile } = await createProfileFixture(dbUrl);
    const collection = await ApiKeyCollection.create({ db });

    await collection.generateForProfile(profile, {
      name: 'expired',
      expiresAt: new Date(Date.now() - 60_000),
    });
    await collection.generateForProfile(profile, { name: 'active' });

    const cleaned = await collection.cleanupExpired();
    expect(cleaned).toBe(1);
    // Idempotent: re-running cleans up nothing new.
    expect(await collection.cleanupExpired()).toBe(0);
  });
});

describe('Profile auth helpers (API keys)', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('profile-api-keys');
  });

  it('exposes API keys through the profile model', async () => {
    const { profile } = await createProfileFixture(dbUrl);

    const generated = await profile.generateApiKey({
      name: 'profile-key',
      scopes: ['*'],
    });
    expect(generated.key.startsWith('sk_live_')).toBe(true);

    const all = await profile.getApiKeys();
    expect(all).toHaveLength(1);

    const active = await profile.getActiveApiKeys();
    expect(active).toHaveLength(1);

    await active[0].revoke();
    expect(await profile.getActiveApiKeys()).toHaveLength(0);
  });
});
