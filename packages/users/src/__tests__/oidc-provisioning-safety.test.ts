import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  createProfileFromOidc,
  normalizeIdentityEmail,
  OidcIdentityCollection,
  ProfileCollection,
} from '@happyvertical/smrt-profiles';
import {
  createIsolatedTestDb,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import { getDatabase, syncSchema } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type OidcClaims,
  type OidcProvisioningError,
  UserCollection,
} from '../collections/UserCollection.js';
import {
  OIDC_USERS_TEST_SCHEMA,
  prepareOidcEmailKeyBackfills,
} from './helpers/oidc-test-server.js';

const PERSON_META_TYPE = '@happyvertical/smrt-profiles:Person';
const ORGANIZATION_META_TYPE = '@happyvertical/smrt-profiles:Organization';

describe('safe OIDC provisioning', () => {
  let isolated: IsolatedTestDbResult;
  let db: DatabaseInterface;
  let users: UserCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDb({ schema: OIDC_USERS_TEST_SCHEMA });
    db = isolated.db;
    await prepareOidcEmailKeyBackfills(db);
    users = await UserCollection.create({ db });
  });

  afterEach(async () => {
    await isolated.cleanup();
  });

  it('reuses one unowned global Person for a verified email', async () => {
    const profileId = await seedProfile(db, {
      email: ' Safe@Example.com ',
    });

    const result = await users.getOrCreateFromOidc(
      claims({ email: ' SAFE@example.com ' }),
      'dex',
    );

    expect(result.created).toBe(false);
    expect(result.profile.id).toBe(profileId);
    expect(result.user.profileId).toBe(profileId);
    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(1);
  });

  it('fails closed on a tenant-scoped Profile-only email collision', async () => {
    await seedProfile(db, {
      email: '\tÜser@Example.com\t',
      tenantId: randomUUID(),
    });

    await expect(
      users.getOrCreateFromOidc(claims({ email: 'üser@example.com' }), 'dex'),
    ).rejects.toMatchObject({ code: 'tenant_scoped' });
    await expectNoProvisioningWrites(db);
  });

  it('fails closed on a non-Person Profile-only email collision', async () => {
    await seedProfile(db, {
      email: '\tÜser@Example.com\t',
      metaType: ORGANIZATION_META_TYPE,
    });

    await expect(
      users.getOrCreateFromOidc(claims({ email: 'üser@example.com' }), 'dex'),
    ).rejects.toMatchObject({ code: 'non_person' });
    await expectNoProvisioningWrites(db);
  });

  it('fails closed when duplicate Profiles share the verified email', async () => {
    await seedProfile(db, { email: '\tÜser@Example.com\t' });
    await seedProfile(db, { email: 'üser@example.com' });

    await expect(
      users.getOrCreateFromOidc(claims({ email: 'ÜSER@example.com' }), 'dex'),
    ).rejects.toMatchObject({ code: 'ambiguous_email' });
    await expectNoProvisioningWrites(db, 2);
  });

  it('fails closed when the matching Person already belongs to a User', async () => {
    const profileId = await seedProfile(db, {
      email: 'collision@example.com',
    });
    await seedUser(db, profileId, 'collision@example.com');

    await expect(users.getOrCreateFromOidc(claims(), 'dex')).rejects.toEqual(
      expect.objectContaining<Partial<OidcProvisioningError>>({
        code: 'profile_owned',
      }),
    );
    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(0);
  });

  it('prevents the Profile-only helper from planting an identity on an owned Profile', async () => {
    const profileId = await seedProfile(db, {
      email: 'profile-helper-owned@example.com',
    });
    await seedUser(db, profileId, 'profile-helper-owned@example.com');

    await expect(
      createProfileFromOidc(
        {
          email: 'profile-helper-owned@example.com',
          email_verified: true,
          iss: 'https://new-issuer.example.com',
          sub: 'new-subject',
        },
        'new-provider',
        { db },
      ),
    ).rejects.toThrow('cannot prove that Profile is unowned');

    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(0);
  });

  it('prevents legacy Profile link helpers from planting an identity on an owned Profile', async () => {
    const profileId = await seedProfile(db, {
      email: 'legacy-link-owned@example.com',
    });
    await seedUser(db, profileId, 'legacy-link-owned@example.com');
    const profiles = await ProfileCollection.create({ db });
    const profile = await profiles.get({ id: profileId });
    if (!profile) throw new Error('Expected seeded Profile.');
    const oidcData = {
      email: 'legacy-link-owned@example.com',
      issuer: 'https://attacker.example.com',
      provider: 'attacker',
      subject: 'attacker-subject',
    };

    await expect(profile.linkOidcIdentity(oidcData)).rejects.toThrow(
      'no longer creates authentication links',
    );
    const identities = await OidcIdentityCollection.create({ db });
    await expect(identities.linkToProfile(profile, oidcData)).rejects.toThrow(
      'no longer creates authentication links',
    );

    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
  });

  it('fails closed on a Unicode and whitespace-equivalent User-only collision', async () => {
    const existingProfileId = await seedProfile(db, {
      email: 'different@example.com',
    });
    await seedUser(db, existingProfileId, '\tÜser@Example.com\t');

    await expect(
      users.getOrCreateFromOidc(claims({ email: 'üser@example.com' }), 'dex'),
    ).rejects.toMatchObject({ code: 'user_email_conflict' });

    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
  });

  it('fails closed until legacy Profile email keys are backfilled', async () => {
    const profileId = await seedProfile(db, {
      email: 'legacy-profile@example.com',
    });
    await db.query(
      'UPDATE profiles SET email_key = NULL WHERE id = ?',
      profileId,
    );
    await deleteBackfillMarker(
      db,
      '@happyvertical/smrt-profiles:profile-email-keys:v1',
    );

    await expect(
      users.getOrCreateFromOidc(
        claims({ email: 'new-profile@example.com' }),
        'dex',
      ),
    ).rejects.toMatchObject({ code: 'email_key_backfill_required' });

    await expectNoProvisioningWrites(db, 1);
  });

  it('fails closed when a Profile identity email key is stale', async () => {
    const profileId = await seedProfile(db, {
      email: 'different-profile@example.com',
    });
    await db.query(
      'UPDATE profiles SET email_key = ? WHERE id = ?',
      'collision@example.com',
      profileId,
    );

    await expect(
      users.getOrCreateFromOidc(claims(), 'dex'),
    ).rejects.toMatchObject({ code: 'email_key_backfill_required' });

    await expectNoProvisioningWrites(db, 1);
  });

  it('rolls back provisioning until legacy User email keys are backfilled', async () => {
    const profileId = await seedProfile(db, {
      email: 'legacy-user@example.com',
    });
    const userId = await seedUser(db, profileId, 'legacy-user@example.com');
    await db.query('UPDATE users SET email_key = NULL WHERE id = ?', userId);
    await deleteBackfillMarker(
      db,
      '@happyvertical/smrt-users:user-email-keys:v1',
    );

    await expect(
      users.getOrCreateFromOidc(
        claims({ email: 'new-user@example.com' }),
        'dex',
      ),
    ).rejects.toMatchObject({ code: 'user_email_backfill_required' });

    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(0);
  });

  it('rolls back provisioning when a User email key is stale', async () => {
    const profileId = await seedProfile(db, {
      email: 'different-profile@example.com',
    });
    const userId = await seedUser(db, profileId, 'collision@example.com');
    await db.query(
      'UPDATE users SET email_key = ? WHERE id = ?',
      'stale@example.com',
      userId,
    );

    await expect(
      users.getOrCreateFromOidc(claims({ email: 'stale@example.com' }), 'dex'),
    ).rejects.toMatchObject({ code: 'user_email_backfill_required' });

    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(0);
  });

  it.each([
    ['tenant-scoped', 'tenant_scoped'],
    ['non-Person', 'non_person'],
    ['duplicate', 'ambiguous_email'],
    ['different canonical Person', 'email_mismatch'],
  ] as const)('fails closed when an existing identity without a User presents a %s Profile collision', async (scenario, expectedCode) => {
    const profileId = await seedProfile(db, {
      email: `original-${scenario.replaceAll(' ', '-')}@example.com`,
    });
    const subject = `existing-no-owner-${scenario.replaceAll(' ', '-')}`;
    await seedIdentity(db, profileId, {
      email: `original-${scenario.replaceAll(' ', '-')}@example.com`,
      subject,
    });
    await seedProfile(db, {
      email: 'claimed-collision@example.com',
      metaType: scenario === 'non-Person' ? ORGANIZATION_META_TYPE : undefined,
      tenantId: scenario === 'tenant-scoped' ? randomUUID() : undefined,
    });
    if (scenario === 'duplicate') {
      await seedProfile(db, { email: ' Claimed-Collision@Example.com ' });
    }

    await expect(
      users.getOrCreateFromOidc(
        claims({ email: 'claimed-collision@example.com', sub: subject }),
        'dex',
      ),
    ).rejects.toMatchObject({ code: expectedCode });

    await expect(countRows(db, 'profiles')).resolves.toBe(
      scenario === 'duplicate' ? 3 : 2,
    );
    await expect(countRows(db, 'users')).resolves.toBe(0);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(1);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(0);
  });

  it.each([
    ['tenant-scoped', 'tenant_scoped'],
    ['non-Person', 'non_person'],
  ] as const)('fails closed when the exact issuer and subject links directly to a %s Profile', async (scenario, expectedCode) => {
    const email = `unsafe-${scenario.toLowerCase()}@example.com`;
    const subject = `unsafe-linked-${scenario.toLowerCase()}`;
    const profileId = await seedProfile(db, {
      email,
      metaType: scenario === 'non-Person' ? ORGANIZATION_META_TYPE : undefined,
      tenantId: scenario === 'tenant-scoped' ? randomUUID() : undefined,
    });
    await seedIdentity(db, profileId, { email, subject });

    await expect(
      users.getOrCreateFromOidc(claims({ email, sub: subject }), 'dex'),
    ).rejects.toMatchObject({ code: expectedCode });

    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(0);
    await expect(countRows(db, 'sessions')).resolves.toBe(0);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(1);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(0);
  });

  it('converges concurrent first-login callbacks on one identity and User', async () => {
    await isolated.db.rollback();
    db = isolated.baseDb;
    await prepareOidcEmailKeyBackfills(db);
    users = await UserCollection.create({ db });
    const oidcClaims = claims({
      email: 'concurrent@example.com',
      sub: 'concurrent-subject',
    });

    const [first, second] = await Promise.all([
      users.getOrCreateFromOidc(oidcClaims, 'dex'),
      users.getOrCreateFromOidc(oidcClaims, 'dex'),
    ]);

    expect(second.profile.id).toBe(first.profile.id);
    expect(second.user.id).toBe(first.user.id);
    expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(1);
  });

  it('serializes unrelated first logins on one SQLite root handle', async () => {
    await isolated.db.rollback();
    db = isolated.baseDb;
    await prepareOidcEmailKeyBackfills(db);
    users = await UserCollection.create({ db });
    let activeResolvers = 0;
    let maxActiveResolvers = 0;
    const observeResolver = async () => {
      activeResolvers += 1;
      maxActiveResolvers = Math.max(maxActiveResolvers, activeResolvers);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      activeResolvers -= 1;
      return undefined;
    };

    const [first, second] = await Promise.all([
      users.getOrCreateFromOidc(
        claims({
          email: 'sqlite-unrelated-first@example.com',
          sub: 'sqlite-unrelated-first',
        }),
        'dex',
        { resolveProfile: observeResolver },
      ),
      users.getOrCreateFromOidc(
        claims({
          email: 'sqlite-unrelated-second@example.com',
          sub: 'sqlite-unrelated-second',
        }),
        'dex',
        { resolveProfile: observeResolver },
      ),
    ]);

    expect(maxActiveResolvers).toBe(1);
    expect(second.profile.id).not.toBe(first.profile.id);
    expect(second.user.id).not.toBe(first.user.id);
    await expect(countRows(db, 'profiles')).resolves.toBe(2);
    await expect(countRows(db, 'users')).resolves.toBe(2);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(2);
  });

  it('converges first login across independent SQLite connections', async () => {
    await isolated.db.rollback();
    db = isolated.baseDb;
    await prepareOidcEmailKeyBackfills(db);
    const databaseUrl = db.url;
    if (!databaseUrl) throw new Error('Expected a file-backed SQLite URL.');
    const firstDb = (await getDatabase({
      type: 'sqlite',
      url: databaseUrl,
      dbid: `oidc-sqlite-first-${randomUUID()}`,
    })) as DatabaseInterface;
    const secondDb = (await getDatabase({
      type: 'sqlite',
      url: databaseUrl,
      dbid: `oidc-sqlite-second-${randomUUID()}`,
    })) as DatabaseInterface;

    try {
      const firstUsers = await UserCollection.create({ db: firstDb });
      const secondUsers = await UserCollection.create({ db: secondDb });
      let activeResolvers = 0;
      let maxActiveResolvers = 0;
      let resolverCalls = 0;
      const observeResolver = async () => {
        resolverCalls += 1;
        activeResolvers += 1;
        maxActiveResolvers = Math.max(maxActiveResolvers, activeResolvers);
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        activeResolvers -= 1;
        return undefined;
      };
      const concurrentClaims = claims({
        email: 'independent-sqlite@example.com',
        sub: 'independent-sqlite-subject',
      });

      const [first, second] = await Promise.all([
        firstUsers.getOrCreateFromOidc(concurrentClaims, 'dex', {
          resolveProfile: observeResolver,
        }),
        secondUsers.getOrCreateFromOidc(concurrentClaims, 'dex', {
          resolveProfile: observeResolver,
        }),
      ]);

      // Each callback crosses the application rejection boundary, including
      // the serialized callback that observes the winner's exact identity.
      expect(resolverCalls).toBe(2);
      expect(maxActiveResolvers).toBe(1);
      expect(second.profile.id).toBe(first.profile.id);
      expect(second.user.id).toBe(first.user.id);
      expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
      await expect(countRows(firstDb, 'profiles')).resolves.toBe(1);
      await expect(countRows(firstDb, 'users')).resolves.toBe(1);
      await expect(countRows(firstDb, 'oidc_identities')).resolves.toBe(1);
      await expect(
        countRows(firstDb, 'oidc_profile_email_reservations'),
      ).resolves.toBe(1);
    } finally {
      await Promise.all([closeDatabase(firstDb), closeDatabase(secondDb)]);
    }
  });

  it('serializes one issuer/subject with different emails across independent DuckDB handles', async () => {
    await isolated.db.rollback();
    db = isolated.baseDb;
    const duckDb = (await getDatabase({
      type: 'duckdb',
      url: ':memory:',
    })) as DatabaseInterface;
    await syncSchema({ db: duckDb, schema: OIDC_USERS_TEST_SCHEMA });
    await prepareOidcEmailKeyBackfills(duckDb);
    const firstDb = independentDatabaseHandle(duckDb);
    const secondDb = independentDatabaseHandle(duckDb);
    let activeResolvers = 0;
    let maxActiveResolvers = 0;
    const observeResolver = async () => {
      activeResolvers += 1;
      maxActiveResolvers = Math.max(maxActiveResolvers, activeResolvers);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      activeResolvers -= 1;
      return undefined;
    };

    try {
      const firstUsers = await UserCollection.create({ db: firstDb });
      const secondUsers = await UserCollection.create({ db: secondDb });
      const [first, second] = await Promise.all([
        firstUsers.getOrCreateFromOidc(
          claims({
            email: 'duckdb-user-first@example.com',
            sub: 'duckdb-shared-user-subject',
          }),
          'dex',
          { resolveProfile: observeResolver },
        ),
        secondUsers.getOrCreateFromOidc(
          claims({
            email: 'duckdb-user-second@example.com',
            sub: 'duckdb-shared-user-subject',
          }),
          'dex',
          { resolveProfile: observeResolver },
        ),
      ]);

      expect(maxActiveResolvers).toBe(1);
      expect(second.profile.id).toBe(first.profile.id);
      expect(second.user.id).toBe(first.user.id);
      expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
      await expect(countRows(firstDb, 'profiles')).resolves.toBe(1);
      await expect(countRows(firstDb, 'users')).resolves.toBe(1);
      await expect(countRows(firstDb, 'oidc_identities')).resolves.toBe(1);
    } finally {
      await closeDatabase(duckDb);
    }
  });

  it('serializes unrelated first logins on one DuckDB root handle', async () => {
    const duckDb = (await getDatabase({
      type: 'duckdb',
      url: ':memory:',
    })) as DatabaseInterface;
    await syncSchema({ db: duckDb, schema: OIDC_USERS_TEST_SCHEMA });
    await prepareOidcEmailKeyBackfills(duckDb);
    const duckUsers = await UserCollection.create({ db: duckDb });
    let activeResolvers = 0;
    let maxActiveResolvers = 0;
    const observeResolver = async () => {
      activeResolvers += 1;
      maxActiveResolvers = Math.max(maxActiveResolvers, activeResolvers);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      activeResolvers -= 1;
      return undefined;
    };

    try {
      const [first, second] = await Promise.all([
        duckUsers.getOrCreateFromOidc(
          claims({
            email: 'duckdb-unrelated-first@example.com',
            sub: 'duckdb-unrelated-first',
          }),
          'dex',
          { resolveProfile: observeResolver },
        ),
        duckUsers.getOrCreateFromOidc(
          claims({
            email: 'duckdb-unrelated-second@example.com',
            sub: 'duckdb-unrelated-second',
          }),
          'dex',
          { resolveProfile: observeResolver },
        ),
      ]);

      expect(maxActiveResolvers).toBe(1);
      expect(second.profile.id).not.toBe(first.profile.id);
      expect(second.user.id).not.toBe(first.user.id);
      await expect(countRows(duckDb, 'profiles')).resolves.toBe(2);
      await expect(countRows(duckDb, 'users')).resolves.toBe(2);
      await expect(countRows(duckDb, 'oidc_identities')).resolves.toBe(2);
    } finally {
      await closeDatabase(duckDb);
    }
  });

  it('rejects concurrent distinct subjects competing for one verified email', async () => {
    await isolated.db.rollback();
    db = isolated.baseDb;
    await prepareOidcEmailKeyBackfills(db);
    users = await UserCollection.create({ db });

    const results = await Promise.allSettled([
      users.getOrCreateFromOidc(
        claims({ email: 'shared@example.com', sub: 'subject-one' }),
        'dex',
      ),
      users.getOrCreateFromOidc(
        claims({ email: 'shared@example.com', sub: 'subject-two' }),
        'dex',
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'profile_owned' }),
      }),
    ]);
    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(1);
  });

  it('preserves issuer and subject reuse for an existing safe identity', async () => {
    const oidcClaims = claims({
      email: 'returning@example.com',
      sub: 'returning-subject',
    });
    const first = await users.getOrCreateFromOidc(oidcClaims, 'dex');
    const second = await users.getOrCreateFromOidc(
      { ...oidcClaims, name: 'Updated display name' },
      'dex',
    );

    expect(second.created).toBe(false);
    expect(second.profile.id).toBe(first.profile.id);
    expect(second.user.id).toBe(first.user.id);
    expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(1);
  });

  it('runs the resolver before exact identity reuse and rejects without User or session creation', async () => {
    const profileId = await seedProfile(db, {
      email: 'resolver-returning@example.com',
    });
    await seedIdentity(db, profileId, {
      email: 'resolver-returning@example.com',
      subject: 'resolver-returning-subject',
    });
    let resolverCalls = 0;

    await expect(
      users.getOrCreateFromOidc(
        claims({
          email: 'resolver-returning@example.com',
          sub: 'resolver-returning-subject',
        }),
        'dex',
        {
          resolveProfile: ({ claims: resolvedClaims }) => {
            resolverCalls += 1;
            expect(resolvedClaims.sub).toBe('resolver-returning-subject');
            return null;
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'rejected' });

    expect(resolverCalls).toBe(1);
    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(0);
    await expect(countRows(db, 'sessions')).resolves.toBe(0);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(1);
  });

  it('prevents the resolver from rebinding an exact OIDC identity', async () => {
    const linkedProfileId = await seedProfile(db, {
      email: 'resolver-linked@example.com',
    });
    const otherProfileId = await seedProfile(db, {
      email: 'resolver-other@example.com',
    });
    await seedIdentity(db, linkedProfileId, {
      email: 'resolver-linked@example.com',
      subject: 'resolver-rebind-subject',
    });

    await expect(
      users.getOrCreateFromOidc(
        claims({
          email: 'resolver-linked@example.com',
          sub: 'resolver-rebind-subject',
        }),
        'dex',
        {
          resolveProfile: async ({ db: tx }) =>
            (await ProfileCollection.create({ db: tx })).get({
              id: otherProfileId,
            }),
        },
      ),
    ).rejects.toMatchObject({ code: 'rejected' });

    const identities = await db.query(
      'SELECT profile_id FROM oidc_identities WHERE subject = ?',
      'resolver-rebind-subject',
    );
    expect(identities.rows).toEqual([{ profile_id: linkedProfileId }]);
    await expect(countRows(db, 'users')).resolves.toBe(0);
    await expect(countRows(db, 'sessions')).resolves.toBe(0);
  });

  it('preserves the exact opaque issuer and subject claims', async () => {
    const first = await users.getOrCreateFromOidc(
      claims({
        email: 'opaque-first@example.com',
        sub: 'opaque-subject',
      }),
      'dex',
    );
    const second = await users.getOrCreateFromOidc(
      claims({
        email: 'opaque-second@example.com',
        sub: ' opaque-subject',
      }),
      'dex',
    );

    expect(second.user.id).not.toBe(first.user.id);
    expect(second.profile.id).not.toBe(first.profile.id);
    expect(second.oidcIdentity.id).not.toBe(first.oidcIdentity.id);
    expect(second.oidcIdentity.subject).toBe(' opaque-subject');
    expect(second.oidcIdentity.identityKey).toBe(
      '["https://issuer.example.com"," opaque-subject"]',
    );
    await expect(countRows(db, 'users')).resolves.toBe(2);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(2);
  });

  it('backfills a legacy null identity key during issuer and subject reuse', async () => {
    const profileId = await seedProfile(db, {
      email: 'legacy@example.com',
    });
    const userId = await seedUser(db, profileId, 'legacy@example.com');
    const identityId = await seedIdentity(db, profileId, {
      email: 'legacy@example.com',
      subject: 'legacy-subject',
    });

    const result = await users.getOrCreateFromOidc(
      claims({ email: 'legacy@example.com', sub: 'legacy-subject' }),
      'dex',
    );

    expect(result.profile.id).toBe(profileId);
    expect(result.user.id).toBe(userId);
    expect(result.oidcIdentity.id).toBe(identityId);
    expect(result.oidcIdentity.identityKey).toBe(
      '["https://issuer.example.com","legacy-subject"]',
    );
  });

  it('reuses an existing safe identity with a legacy Person discriminator', async () => {
    const profileId = await seedProfile(db, {
      email: 'legacy-person@example.com',
      metaType: 'Person',
    });
    const userId = await seedUser(db, profileId, 'legacy-person@example.com');
    await seedIdentity(db, profileId, {
      email: 'legacy-person@example.com',
      subject: 'legacy-person-subject',
    });

    const result = await users.getOrCreateFromOidc(
      claims({
        email: 'legacy-person@example.com',
        sub: 'legacy-person-subject',
      }),
      'dex',
    );

    expect(result.profile.id).toBe(profileId);
    expect(result.user.id).toBe(userId);
    await expect(countRows(db, 'profiles')).resolves.toBe(1);
  });

  it('uses the current Profile email instead of a stale identity cache', async () => {
    const first = await users.getOrCreateFromOidc(
      claims({ email: 'old@example.com', sub: 'renamed-subject' }),
      'dex',
    );
    await db.query(
      'UPDATE profiles SET email = ?, email_key = ? WHERE id = ?',
      'new@example.com',
      'new@example.com',
      first.profile.id,
    );

    const second = await users.getOrCreateFromOidc(
      claims({ email: 'new@example.com', sub: 'renamed-subject' }),
      'dex',
    );

    expect(second.profile.id).toBe(first.profile.id);
    expect(second.user.id).toBe(first.user.id);
    expect(second.oidcIdentity.email).toBe('new@example.com');

    const reservation = await db.query(
      'SELECT email_key FROM oidc_profile_email_reservations WHERE profile_id = ?',
      first.profile.id,
    );
    expect(reservation.rows).toEqual([{ email_key: 'new@example.com' }]);

    const releasedProfileId = await seedProfile(db, {
      email: 'old@example.com',
    });
    const profiles = await ProfileCollection.create({ db });
    await expect(
      profiles.reserveCanonicalIdentityEmail(
        releasedProfileId,
        'old@example.com',
      ),
    ).resolves.toMatchObject({ id: releasedProfileId });
  });

  it('removes a stale reservation when the canonical Profile email is cleared', async () => {
    const first = await users.getOrCreateFromOidc(
      claims({ email: 'clear@example.com', sub: 'clear-subject' }),
      'dex',
    );
    await db.query(
      'UPDATE profiles SET email = NULL, email_key = NULL WHERE id = ?',
      first.profile.id,
    );

    await users.getOrCreateFromOidc(
      claims({ email: 'claim-cache@example.com', sub: 'clear-subject' }),
      'dex',
    );

    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(0);
  });

  it('reconciles swapped stale reservations for existing issuer subjects', async () => {
    const first = await users.getOrCreateFromOidc(
      claims({ email: 'swap-first@example.com', sub: 'swap-first-subject' }),
      'dex',
    );
    const second = await users.getOrCreateFromOidc(
      claims({ email: 'swap-second@example.com', sub: 'swap-second-subject' }),
      'dex',
    );
    await db.query(
      'UPDATE profiles SET email = ?, email_key = ? WHERE id = ?',
      'swap-second@example.com',
      'swap-second@example.com',
      first.profile.id,
    );
    await db.query(
      'UPDATE profiles SET email = ?, email_key = ? WHERE id = ?',
      'swap-first@example.com',
      'swap-first@example.com',
      second.profile.id,
    );

    const firstReuse = await users.getOrCreateFromOidc(
      claims({ email: 'swap-second@example.com', sub: 'swap-first-subject' }),
      'dex',
    );
    const secondReuse = await users.getOrCreateFromOidc(
      claims({ email: 'swap-first@example.com', sub: 'swap-second-subject' }),
      'dex',
    );

    expect(firstReuse.profile.id).toBe(first.profile.id);
    expect(secondReuse.profile.id).toBe(second.profile.id);
    const reservations = await db.query(
      'SELECT profile_id, email_key FROM oidc_profile_email_reservations ORDER BY email_key',
    );
    expect(reservations.rows).toEqual([
      { profile_id: second.profile.id, email_key: 'swap-first@example.com' },
      { profile_id: first.profile.id, email_key: 'swap-second@example.com' },
    ]);
  });

  it('rejects an owned canonical Person supplied by a resolver', async () => {
    const profileId = await seedProfile(db, {
      email: 'owned@example.com',
    });
    await seedUser(db, profileId, 'owned@example.com');
    let resolverCalls = 0;

    await expect(
      users.getOrCreateFromOidc(
        claims({ email: 'owned@example.com', sub: 'linked-subject' }),
        'dex',
        {
          resolveProfile: async ({ claims: resolvedClaims, db: tx }) => {
            resolverCalls += 1;
            expect(resolvedClaims.email).toBe('owned@example.com');
            const profiles = await ProfileCollection.create({ db: tx });
            return profiles.get({ id: profileId });
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'profile_owned' });

    expect(resolverCalls).toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(0);
  });

  it('keeps resolver claims immutable at the authenticated identity boundary', async () => {
    const victimProfileId = await seedProfile(db, {
      email: 'victim@example.com',
    });
    const victimUserId = await seedUser(
      db,
      victimProfileId,
      'victim@example.com',
    );
    await seedIdentity(db, victimProfileId, {
      email: 'victim@example.com',
      issuer: 'https://victim-issuer.example.com',
      subject: 'victim-subject',
    });

    const result = await users.getOrCreateFromOidc(
      claims({
        email: 'attacker@example.com',
        email_verified: false,
        sub: 'attacker-subject',
      }),
      'dex',
      {
        allowUnverifiedEmail: true,
        resolveProfile: ({ claims: resolverClaims }) => {
          expect(Object.isFrozen(resolverClaims)).toBe(true);
          expect(
            Reflect.set(
              resolverClaims,
              'iss',
              'https://victim-issuer.example.com',
            ),
          ).toBe(false);
          expect(Reflect.set(resolverClaims, 'sub', 'victim-subject')).toBe(
            false,
          );
          expect(
            Reflect.set(resolverClaims, 'email', 'victim@example.com'),
          ).toBe(false);
          expect(Reflect.set(resolverClaims, 'email_verified', true)).toBe(
            false,
          );
          return undefined;
        },
      },
    );

    expect(result.user.id).not.toBe(victimUserId);
    expect(result.profile.id).not.toBe(victimProfileId);
    expect(result.oidcIdentity.subject).toBe('attacker-subject');
    expect(result.oidcIdentity.email).toBe('attacker@example.com');
    await expect(countRows(db, 'users')).resolves.toBe(2);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(2);
  });

  it('rejects resolver reuse when the OIDC email is not verified', async () => {
    const profileId = await seedProfile(db, {
      email: 'unverified@example.com',
    });

    await expect(
      users.getOrCreateFromOidc(
        claims({
          email: 'unverified@example.com',
          email_verified: false,
          sub: 'unverified-resolver-subject',
        }),
        'dex',
        {
          allowUnverifiedEmail: true,
          resolveProfile: async ({ db: tx }) =>
            (await ProfileCollection.create({ db: tx })).get({ id: profileId }),
        },
      ),
    ).rejects.toMatchObject({ code: 'rejected' });

    await expectNoProvisioningWrites(db);
  });

  it.each([
    ['tenant-scoped', 'tenant_scoped'],
    ['non-Person', 'non_person'],
    ['duplicate-email', 'ambiguous_email'],
    ['mismatched-email', 'email_mismatch'],
  ] as const)('rejects a resolver-supplied %s Profile before provisioning', async (scenario, expectedCode) => {
    const profileId = await seedProfile(db, {
      email:
        scenario === 'mismatched-email'
          ? 'other@example.com'
          : 'collision@example.com',
      metaType: scenario === 'non-Person' ? ORGANIZATION_META_TYPE : undefined,
      tenantId: scenario === 'tenant-scoped' ? randomUUID() : undefined,
    });
    if (scenario === 'duplicate-email') {
      await seedProfile(db, { email: 'Collision@Example.com' });
    }

    await expect(
      users.getOrCreateFromOidc(claims(), 'dex', {
        resolveProfile: async ({ db: tx }) =>
          (await ProfileCollection.create({ db: tx })).get({ id: profileId }),
      }),
    ).rejects.toMatchObject({ code: expectedCode });

    await expectNoProvisioningWrites(
      db,
      scenario === 'duplicate-email' ? 2 : 1,
    );
  });

  it('rolls back all provisioning when the application resolver rejects login', async () => {
    const attemptedUserId = randomUUID();
    await expect(
      users.getOrCreateFromOidc(claims(), 'dex', {
        resolveProfile: async ({ db: tx }) => {
          await tx.query(
            `INSERT INTO users
              (id, slug, context, profile_id, email, email_key, status)
             VALUES (?, ?, '', '', 'partial@example.com', 'partial@example.com', 'active')`,
            attemptedUserId,
            `partial-${attemptedUserId}`,
          );
          return null;
        },
      }),
    ).rejects.toMatchObject({ code: 'rejected' });

    await expectNoProvisioningWrites(db, 0);
  });

  it('rolls back with a standard transaction callback handle', async () => {
    await isolated.db.rollback();
    db = isolated.baseDb;
    await prepareOidcEmailKeyBackfills(db);
    const transaction = db.transaction;
    if (!transaction) {
      throw new Error('Expected a transaction-capable database.');
    }

    await expect(
      transaction.call(db, async (tx) => {
        const transactionUsers = await UserCollection.create({ db: tx });
        await transactionUsers.getOrCreateFromOidc(
          claims({ email: 'outer-rollback@example.com' }),
          'dex',
        );
        throw new Error('force outer rollback');
      }),
    ).rejects.toThrow('force outer rollback');

    await expectNoProvisioningWrites(db, 0);
  });

  it('does not repeat backfill table DDL inside a root-owned provisioning transaction', async () => {
    await isolated.db.rollback();
    db = isolated.baseDb;
    await prepareOidcEmailKeyBackfills(db);
    let transactionCreates = 0;
    const observedDb = withTransactionBackfillCreateObserver(db, () => {
      transactionCreates += 1;
    });
    const rootUsers = await UserCollection.create({ db: observedDb });

    await rootUsers.getOrCreateFromOidc(
      claims({ email: 'root-ddl@example.com', sub: 'root-ddl-subject' }),
      'dex',
    );

    expect(transactionCreates).toBe(0);
  });

  it('fails closed on an ambiguous callback-only root adapter', async () => {
    await isolated.db.rollback();
    db = isolated.baseDb;
    await prepareOidcEmailKeyBackfills(db);
    const callbackOnlyRoot = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'beginTransaction') return undefined;
        if (property === 'query') {
          return async (sql: string, ...params: unknown[]) => {
            if (/^SAVEPOINT\b/iu.test(sql)) {
              throw new Error(
                'SAVEPOINT can only be used in transaction blocks',
              );
            }
            return target.query(sql, ...params);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const callbackUsers = await UserCollection.create({
      db: callbackOnlyRoot,
    });

    await expect(
      callbackUsers.getOrCreateFromOidc(
        claims({ email: 'callback-only-root@example.com' }),
        'dex',
      ),
    ).rejects.toMatchObject({ code: 'transaction_required' });
    await expectNoProvisioningWrites(db, 0);
  });

  it('fails closed on a DuckDB manual transaction without corrupting it', async () => {
    const duckDb = (await getDatabase({
      type: 'duckdb',
      url: ':memory:',
    })) as DatabaseInterface;
    if (!duckDb.beginTransaction) {
      throw new Error('Expected DuckDB manual transaction support.');
    }
    const tx = await duckDb.beginTransaction();
    try {
      const transactionUsers = await UserCollection.create({ db: tx });
      await expect(
        transactionUsers.getOrCreateFromOidc(
          claims({ email: 'duckdb-manual-user@example.com' }),
          'dex',
        ),
      ).rejects.toMatchObject({ code: 'transaction_required' });

      expect(tx.isActive()).toBe(true);
      await tx.query('CREATE TABLE user_outer_probe (id INTEGER)');
      await tx.query('INSERT INTO user_outer_probe VALUES (1)');
      const result = await tx.query(
        'SELECT count(*) AS count FROM user_outer_probe',
      );
      expect(Number(result.rows[0]?.count)).toBe(1);
    } finally {
      if (tx.isActive()) await tx.rollback();
      await closeDatabase(duckDb);
    }
  });

  it('fails closed on a DuckDB callback transaction without corrupting it', async () => {
    const duckDb = (await getDatabase({
      type: 'duckdb',
      url: ':memory:',
    })) as DatabaseInterface;
    if (!duckDb.transaction) {
      throw new Error('Expected DuckDB callback transaction support.');
    }
    try {
      await duckDb.transaction(async (tx) => {
        const transactionUsers = await UserCollection.create({ db: tx });
        await expect(
          transactionUsers.getOrCreateFromOidc(
            claims({ email: 'duckdb-callback-user@example.com' }),
            'dex',
          ),
        ).rejects.toMatchObject({ code: 'transaction_required' });

        await tx.query('CREATE TABLE user_callback_probe (id INTEGER)');
        await tx.query('INSERT INTO user_callback_probe VALUES (1)');
        const result = await tx.query(
          'SELECT count(*) AS count FROM user_callback_probe',
        );
        expect(Number(result.rows[0]?.count)).toBe(1);
      });
    } finally {
      await closeDatabase(duckDb);
    }
  });

  it('rolls back resolver writes when provisioning owns the root transaction', async () => {
    await isolated.db.rollback();
    db = isolated.baseDb;
    await prepareOidcEmailKeyBackfills(db);
    users = await UserCollection.create({ db });
    const attemptedUserId = randomUUID();

    await expect(
      users.getOrCreateFromOidc(
        claims({ email: 'root-rejection@example.com' }),
        'dex',
        {
          resolveProfile: async ({ db: tx }) => {
            await tx.query(
              `INSERT INTO users
                (id, slug, context, profile_id, email, email_key, status)
               VALUES (?, ?, '', '', 'partial@example.com', 'partial@example.com', 'active')`,
              attemptedUserId,
              `partial-${attemptedUserId}`,
            );
            return null;
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'rejected' });

    await expectNoProvisioningWrites(db, 0);
  });

  it('does not retry an unrelated resolver unique constraint', async () => {
    const profileId = await seedProfile(db, { email: 'seed@example.com' });
    const userId = await seedUser(db, profileId, 'seed@example.com');
    const seeded = await users.get({ id: userId });
    let resolverCalls = 0;

    await expect(
      users.getOrCreateFromOidc(
        claims({ email: 'unrelated@example.com' }),
        'dex',
        {
          resolveProfile: async ({ db: tx }) => {
            resolverCalls += 1;
            await tx.query(
              `INSERT INTO users
                (id, slug, context, profile_id, email, email_key, status)
               VALUES (?, ?, '', ?, 'other@example.com', 'other@example.com', 'active')`,
              randomUUID(),
              seeded?.slug,
              randomUUID(),
            );
            return undefined;
          },
        },
      ),
    ).rejects.toThrow();

    expect(resolverCalls).toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
  });
});

function claims(overrides: Partial<OidcClaims> = {}): OidcClaims {
  return {
    email: 'collision@example.com',
    email_verified: true,
    iss: 'https://issuer.example.com',
    name: 'OIDC User',
    sub: 'oidc-subject',
    ...overrides,
  };
}

async function seedProfile(
  db: DatabaseInterface,
  options: {
    email: string;
    metaType?: string;
    tenantId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO profiles
      (id, slug, context, _meta_type, tenant_id, email, email_key, name)
     VALUES (?, ?, '', ?, ?, ?, ?, 'Seed Profile')`,
    id,
    `seed-${id}`,
    options.metaType ?? PERSON_META_TYPE,
    options.tenantId ?? null,
    options.email,
    normalizeIdentityEmail(options.email),
  );
  return id;
}

async function seedUser(
  db: DatabaseInterface,
  profileId: string,
  email: string,
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users
      (id, slug, context, profile_id, email, email_key, status)
     VALUES (?, ?, '', ?, ?, ?, 'active')`,
    id,
    `seed-${id}`,
    profileId,
    email,
    normalizeIdentityEmail(email),
  );
  return id;
}

async function seedIdentity(
  db: DatabaseInterface,
  profileId: string,
  options: { email: string; issuer?: string; subject: string },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO oidc_identities
      (id, slug, context, profile_id, provider, issuer, subject, identity_key, email)
     VALUES (?, ?, '', ?, 'dex', ?, ?, NULL, ?)`,
    id,
    `seed-${id}`,
    profileId,
    options.issuer ?? 'https://issuer.example.com',
    options.subject,
    options.email,
  );
  return id;
}

async function countRows(
  db: DatabaseInterface,
  table:
    | 'oidc_identities'
    | 'oidc_profile_email_reservations'
    | 'profiles'
    | 'sessions'
    | 'users',
): Promise<number> {
  const result = await db.query(`SELECT count(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function deleteBackfillMarker(
  db: DatabaseInterface,
  name: string,
): Promise<void> {
  await db.query('DELETE FROM _smrt_backfills WHERE name = ?', name);
}

async function expectNoProvisioningWrites(
  db: DatabaseInterface,
  expectedProfiles = 1,
): Promise<void> {
  await expect(countRows(db, 'profiles')).resolves.toBe(expectedProfiles);
  await expect(countRows(db, 'users')).resolves.toBe(0);
  await expect(countRows(db, 'sessions')).resolves.toBe(0);
  await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
  await expect(countRows(db, 'oidc_profile_email_reservations')).resolves.toBe(
    0,
  );
}

async function closeDatabase(db: DatabaseInterface): Promise<void> {
  await db.close?.();
}

function independentDatabaseHandle(db: DatabaseInterface): DatabaseInterface {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function withTransactionBackfillCreateObserver(
  db: DatabaseInterface,
  onCreate: () => void,
): DatabaseInterface {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return async <T>(
          callback: (tx: DatabaseInterface) => Promise<T>,
        ): Promise<T> => {
          if (!target.transaction) {
            throw new Error('Expected a transaction-capable database.');
          }
          return target.transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(txTarget, txProperty, txReceiver) {
                  if (txProperty === 'query') {
                    return async (sql: string, ...params: unknown[]) => {
                      if (
                        sql.includes('CREATE TABLE') &&
                        sql.includes('_smrt_backfills')
                      ) {
                        onCreate();
                      }
                      return txTarget.query(sql, ...params);
                    };
                  }
                  const value = Reflect.get(txTarget, txProperty, txReceiver);
                  return typeof value === 'function'
                    ? value.bind(txTarget)
                    : value;
                },
              }),
            ),
          );
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
