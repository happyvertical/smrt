/**
 * Tests for the identity-resolution dispatcher (resolveIdentity) and the
 * createProfileFromNostr helper. Exercises every resolution branch: API key,
 * OIDC session, Nostr signed event, CI actor pass-through, and the
 * unauthenticated fallback.
 *
 * Real file-backed SQLite, no DB mocking.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApiKey,
  backfillProfileEmailKeys,
  createAuthEvent,
  createProfileFromNostr,
  createProfileFromOidc,
  encryptPrivkey,
  generateNostrKeypair,
  NostrIdentityCollection,
  OidcIdentityCollection,
  ProfileCollection,
  ProfileTypeCollection,
  resolveIdentity,
} from '../index.js';

const TEST_MASTER_SECRET = 'test-master-secret-32-bytes-long';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function createProfile(dbUrl: string, email: string) {
  const db = { type: 'sqlite' as const, url: dbUrl };
  const profileTypes = await ProfileTypeCollection.create({ db });
  const type = await profileTypes.create({ name: 'Person' });
  await type.save();

  const profiles = await ProfileCollection.create({ db });
  const profile = await profiles.create({
    typeId: type.id,
    name: 'User',
    email,
  });
  await profile.save();
  return { db, profile };
}

describe('resolveIdentity', () => {
  let dbUrl: string;

  beforeEach(async () => {
    dbUrl = getTestDbUrl('resolve-identity');
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    await ProfileCollection.create({ db });
    await backfillProfileEmailKeys(db);
  });

  it('resolves via API key', async () => {
    const { db, profile } = await createProfile(
      dbUrl,
      `apikey-${randomUUID()}@example.com`,
    );
    const { key } = await ApiKey.generate(profile, { name: 'CI', db });

    const result = await resolveIdentity({ apiKey: key, db });
    expect(result.source).toBe('api_key');
    expect(result.profile?.id).toBe(profile.id);
    expect(result.apiKey).toBeDefined();
  });

  it('resolves via OIDC session', async () => {
    const db = { type: 'sqlite' as const, url: dbUrl };
    const { profile } = await createProfileFromOidc(
      {
        sub: 'oidc-sub-1',
        iss: 'https://issuer.example.com',
        email: `oidc-${randomUUID()}@example.com`,
        email_verified: true,
        name: 'OIDC User',
      },
      'keycloak',
      { db },
    );

    const result = await resolveIdentity({
      oidcSession: { sub: 'oidc-sub-1', iss: 'https://issuer.example.com' },
      db,
    });
    expect(result.source).toBe('oidc');
    expect(result.profile?.id).toBe(profile.id);
    expect(result.oidcIdentity?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('fails closed on duplicate legacy issuer-subject mappings', async () => {
    const db = { type: 'sqlite' as const, url: dbUrl };
    const first = await createProfileFromOidc(
      {
        sub: 'legacy-first',
        iss: 'https://legacy-first.example.com',
        email: `legacy-first-${randomUUID()}@example.com`,
        email_verified: true,
      },
      'legacy',
      { db },
    );
    const second = await createProfileFromOidc(
      {
        sub: 'legacy-second',
        iss: 'https://legacy-second.example.com',
        email: `legacy-second-${randomUUID()}@example.com`,
        email_verified: true,
      },
      'legacy',
      { db },
    );
    const database = await getDatabase(db);
    try {
      await database.query(
        `UPDATE oidc_identities
           SET issuer = ?, subject = ?, identity_key = NULL
         WHERE id IN (?, ?)`,
        'https://duplicate.example.com',
        'duplicate-subject',
        first.oidcIdentity.id,
        second.oidcIdentity.id,
      );

      await expect(
        resolveIdentity({
          oidcSession: {
            iss: 'https://duplicate.example.com',
            sub: 'duplicate-subject',
          },
          db,
        }),
      ).rejects.toThrow(
        'Multiple OIDC identities match the same issuer and subject.',
      );
    } finally {
      await database.close?.();
    }
  });

  it('resolves via a Nostr signed auth event', async () => {
    const { db, profile } = await createProfile(
      dbUrl,
      `nostr-${randomUUID()}@example.com`,
    );

    const keypair = generateNostrKeypair();
    const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);
    const identities = await NostrIdentityCollection.create({ db });
    const identity = await identities.create({
      profileId: profile.id,
      pubkey: keypair.pubkey,
      encryptedPrivkey: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
      email: profile.email,
    });
    await identity.save();

    const challenge = 'challenge-123';
    const event = createAuthEvent(keypair.privkey, challenge);

    const result = await resolveIdentity({
      nostrAuth: { event, challenge },
      db,
    });
    expect(result.source).toBe('nostr');
    expect(result.profile?.id).toBe(profile.id);
    expect(result.nostrIdentity?.pubkey).toBe(keypair.pubkey);
  });

  it('does not resolve a Nostr event with the wrong challenge', async () => {
    const { db, profile } = await createProfile(
      dbUrl,
      `nostr-bad-${randomUUID()}@example.com`,
    );
    const keypair = generateNostrKeypair();
    const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);
    const identities = await NostrIdentityCollection.create({ db });
    const identity = await identities.create({
      profileId: profile.id,
      pubkey: keypair.pubkey,
      encryptedPrivkey: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
      email: profile.email,
    });
    await identity.save();

    const event = createAuthEvent(keypair.privkey, 'real-challenge');
    const result = await resolveIdentity({
      nostrAuth: { event, challenge: 'different-challenge' },
      db,
    });
    expect(result.source).toBe('none');
    expect(result.profile).toBeNull();
  });

  it('resolves via CI actor pass-through (matched OIDC subject)', async () => {
    const db = { type: 'sqlite' as const, url: dbUrl };
    const { profile } = await createProfileFromOidc(
      {
        sub: 'octocat',
        iss: 'https://github.com',
        email: `actor-${randomUUID()}@example.com`,
        email_verified: true,
        name: 'Octo Cat',
      },
      'github',
      { db },
    );

    const result = await resolveIdentity({ actor: 'octocat', db });
    expect(result.source).toBe('actor');
    expect(result.profile?.id).toBe(profile.id);
  });

  it('returns source "none" when nothing matches', async () => {
    const db = { type: 'sqlite' as const, url: dbUrl };
    // Initialise the schema so collection lookups have tables to read.
    await ProfileTypeCollection.create({ db });
    await ProfileCollection.create({ db });

    const result = await resolveIdentity({
      apiKey: 'sk_live_unknown',
      actor: 'nobody',
      db,
    });
    expect(result.source).toBe('none');
    expect(result.profile).toBeNull();
  });
});

describe('createProfileFromNostr', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('create-profile-nostr');
  });

  it('creates a profile + identity, then reuses them on a second call', async () => {
    const db = { type: 'sqlite' as const, url: dbUrl };
    const email = `nostr-create-${randomUUID()}@example.com`;
    const keypair = generateNostrKeypair();
    const encrypted = encryptPrivkey(keypair.privkey, TEST_MASTER_SECRET);
    const nostrData = {
      pubkey: keypair.pubkey,
      encryptedPrivkey: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
      nip05Username: 'creator',
    };

    const first = await createProfileFromNostr(email, nostrData, { db });
    expect(first.created).toBe(true);
    expect(first.profile.email).toBe(email.toLowerCase());
    expect(first.nostrIdentity.nip05Username).toBe('creator');

    const second = await createProfileFromNostr(email, nostrData, { db });
    expect(second.created).toBe(false);
    expect(second.profile.id).toBe(first.profile.id);
  });
});

describe('OidcIdentity model and collection', () => {
  let dbUrl: string;

  beforeEach(async () => {
    dbUrl = getTestDbUrl('oidc-identity');
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    await ProfileCollection.create({ db });
    await backfillProfileEmailKeys(db);
  });

  it('reuses, finds, updates, and unlinks exact OIDC identities', async () => {
    const db = { type: 'sqlite' as const, url: dbUrl };
    const created = await createProfileFromOidc(
      {
        email: `oidc-coll-${randomUUID()}@example.com`,
        email_verified: true,
        iss: 'https://accounts.google.com',
        sub: 'google-1',
      },
      'google',
      { db },
    );
    const identities = await OidcIdentityCollection.create({ db });

    const identity = await identities.linkToProfile(created.profile, {
      provider: 'google',
      issuer: 'https://accounts.google.com',
      subject: 'google-1',
      email: 'g@example.com',
    });
    expect(identity.profileId).toBe(created.profile.id);

    // Re-linking the same issuer+subject updates rather than duplicates.
    const relinked = await identities.linkToProfile(created.profile, {
      provider: 'google',
      issuer: 'https://accounts.google.com',
      subject: 'google-1',
      email: 'updated@example.com',
    });
    expect(relinked.id).toBe(identity.id);
    expect(relinked.email).toBe('updated@example.com');

    expect(
      await identities.findByProfile(created.profile.id as string),
    ).toHaveLength(1);
    expect(await identities.findByProvider('google')).toHaveLength(1);
    expect(
      (
        await identities.findBySubject(
          'https://accounts.google.com',
          'google-1',
        )
      )?.id,
    ).toBe(identity.id);

    // recordUsage bumps lastUsedAt.
    await identity.recordUsage();
    expect(identity.lastUsedAt).toBeInstanceOf(Date);
    expect((await identity.getProfile())?.id).toBe(created.profile.id);

    expect(
      await identities.unlinkFromProfile(
        created.profile.id as string,
        'https://accounts.google.com',
        'google-1',
      ),
    ).toBe(true);
    expect(
      await identities.unlinkFromProfile(
        created.profile.id as string,
        'https://accounts.google.com',
        'missing',
      ),
    ).toBe(false);
  });
});
