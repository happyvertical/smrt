/**
 * Tests for ProfileCollection query/batch helpers, assorted Profile model
 * methods (type slug, identity linking, static stubs), and the remaining
 * NostrIdentityCollection helpers.
 *
 * Real file-backed SQLite, no DB mocking.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  encryptPrivkey,
  generateNostrKeypair,
  NostrIdentityCollection,
  Profile,
  ProfileCollection,
  ProfileMetafieldCollection,
  ProfileTypeCollection,
} from '../index.js';

const TEST_MASTER_SECRET = 'test-master-secret-32-bytes-long';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function setup(dbUrl: string) {
  const db = { type: 'sqlite' as const, url: dbUrl };
  const profiles = await ProfileCollection.create({ db });
  const profileTypes = await ProfileTypeCollection.create({ db });
  const metafields = await ProfileMetafieldCollection.create({ db });

  const type = await profileTypes.create({ name: 'Person' });
  await type.save();

  const mkProfile = async (name: string, extra: Record<string, any> = {}) => {
    const p = await profiles.create({
      typeId: type.id,
      name,
      email: `${name.toLowerCase()}-${randomUUID()}@example.com`,
      ...extra,
    });
    await p.save();
    return p;
  };

  return { db, profiles, profileTypes, metafields, type, mkProfile };
}

describe('ProfileCollection query and batch helpers', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('profile-collection');
  });

  it('finds profiles by type slug', async () => {
    const { profiles, profileTypes, mkProfile } = await setup(dbUrl);

    await mkProfile('Person A');
    await mkProfile('Person B');

    const orgType = await profileTypes.create({ name: 'Organization' });
    await orgType.save();
    const org = await profiles.create({
      typeId: orgType.id,
      name: 'Acme',
      email: `acme-${randomUUID()}@example.com`,
    });
    await org.save();

    const people = await profiles.findByType('person');
    expect(people).toHaveLength(2);
    const orgs = await profiles.findByType('organization');
    expect(orgs).toHaveLength(1);
    expect(orgs[0].name).toBe('Acme');
  });

  it('batch-updates and batch-reads metadata', async () => {
    const { profiles, metafields, mkProfile } = await setup(dbUrl);

    const city = await metafields.create({ name: 'City' });
    await city.save();

    const alice = await mkProfile('Alice');
    const bob = await mkProfile('Bob');

    await profiles.batchUpdateMetadata([
      { profileId: alice.id as string, data: { city: 'Paris' } },
      { profileId: bob.id as string, data: { city: 'Rome' } },
    ]);

    const result = await profiles.batchGetMetadata([
      alice.id as string,
      bob.id as string,
    ]);
    expect(result.get(alice.id as string)).toEqual({ city: 'Paris' });
    expect(result.get(bob.id as string)).toEqual({ city: 'Rome' });
  });

  it('finds profiles scoped to a tenant', async () => {
    const { profiles, mkProfile } = await setup(dbUrl);

    const scoped = await mkProfile('Scoped');
    scoped.tenantId = 'tenant-xyz';
    await scoped.save();
    await mkProfile('Global'); // tenantId stays null

    const tenantProfiles = await profiles.findByTenant('tenant-xyz');
    expect(tenantProfiles).toHaveLength(1);
    expect(tenantProfiles[0].name).toBe('Scoped');
  });
});

describe('Profile model misc methods', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('profile-misc');
  });

  it('returns the profile type slug', async () => {
    const { mkProfile } = await setup(dbUrl);
    const profile = await mkProfile('Alice');
    expect(await profile.getTypeSlug()).toBe('person');
  });

  it('setTypeBySlug throws for an unresolved static lookup', async () => {
    const { mkProfile } = await setup(dbUrl);
    const profile = await mkProfile('Alice');
    // ProfileType.getBySlug is a static stub that returns null, so the lookup
    // always reports "not found".
    await expect(profile.setTypeBySlug('person')).rejects.toThrow(/not found/);
  });

  it('static finder stubs return empty defaults', async () => {
    expect(await Profile.findByType('person')).toEqual([]);
    expect(await Profile.findByMetadata('k', 'v')).toEqual([]);
    expect(await Profile.findRelated('id')).toEqual([]);
    expect(await Profile.searchByEmail('x@example.com')).toBeNull();
  });

  it('links and reads OIDC identities through the profile model', async () => {
    const { mkProfile } = await setup(dbUrl);
    const profile = await mkProfile('Olive');

    const identity = await profile.linkOidcIdentity({
      provider: 'github',
      issuer: 'https://github.com',
      subject: 'gh-123',
      email: 'olive@example.com',
    });
    expect(identity.profileId).toBe(profile.id);

    const identities = await profile.getOidcIdentities();
    expect(identities).toHaveLength(1);
    expect(identities[0].subject).toBe('gh-123');
  });

  it('links and reads Nostr identities through the profile model', async () => {
    const { mkProfile } = await setup(dbUrl);
    const profile = await mkProfile('Nova');

    const keypair = generateNostrKeypair();
    const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);
    const identity = await profile.linkNostrIdentity({
      pubkey: keypair.pubkey,
      encryptedPrivkey: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
      email: `nova-link-${randomUUID()}@example.com`,
      nip05Username: 'nova',
    });
    expect(identity.profileId).toBe(profile.id);

    const identities = await profile.getNostrIdentities();
    expect(identities).toHaveLength(1);
    expect(identities[0].pubkey).toBe(keypair.pubkey);
  });
});

describe('NostrIdentityCollection helpers', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('nostr-identity-collection');
  });

  it('manages NIP-05 usernames and unlinking', async () => {
    const { db, mkProfile } = await setup(dbUrl);
    const profile = await mkProfile('Ned');
    const identities = await NostrIdentityCollection.create({ db });

    const email = `ned-${randomUUID()}@example.com`;
    const identity = await identities.createForProfile(
      profile,
      email,
      TEST_MASTER_SECRET,
      'ned',
    );

    expect(await identities.findByProfile(profile.id as string)).toHaveLength(
      1,
    );
    expect((await identities.findByNip05('ned'))?.id).toBe(identity.id);
    expect(await identities.isNip05Available('ned')).toBe(false);
    expect(await identities.isNip05Available('free-name')).toBe(true);

    const updated = await identities.updateNip05Username(identity, 'ned2');
    expect(updated.nip05Username).toBe('ned2');
    expect(await identities.isNip05Available('ned')).toBe(true);

    // Unlink removes the identity.
    expect(
      await identities.unlinkFromProfile(
        profile.id as string,
        identity.pubkey,
      ),
    ).toBe(true);
    expect(await identities.findByProfile(profile.id as string)).toEqual([]);
    // Unlinking again is a no-op.
    expect(
      await identities.unlinkFromProfile(
        profile.id as string,
        identity.pubkey,
      ),
    ).toBe(false);
  });

  it('rejects a NIP-05 rename that collides with another identity', async () => {
    const { db, mkProfile } = await setup(dbUrl);
    const profileA = await mkProfile('Amy');
    const profileB = await mkProfile('Ben');
    const identities = await NostrIdentityCollection.create({ db });

    const a = await identities.createForProfile(
      profileA,
      `amy-${randomUUID()}@example.com`,
      TEST_MASTER_SECRET,
      'amy',
    );
    await identities.createForProfile(
      profileB,
      `ben-${randomUUID()}@example.com`,
      TEST_MASTER_SECRET,
      'ben',
    );

    await expect(
      identities.updateNip05Username(a, 'ben'),
    ).rejects.toThrow(/already taken/);
  });
});
