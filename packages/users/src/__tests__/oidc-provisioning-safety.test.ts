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
  getOidcProvisioningDecisionScenario,
  getOidcProvisioningPublicErrorCode,
  OIDC_PROVISIONING_DECISION_MATRIX,
  type OidcProvisioningScenario,
  type OidcProvisioningSurfaceExpectation,
} from '../../../profiles/src/testing/oidcProvisioningDecisionMatrix.js';
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
const USER_MATRIX_SCENARIOS: readonly OidcProvisioningScenario[] =
  OIDC_PROVISIONING_DECISION_MATRIX.filter(
    (scenario) =>
      scenario.adapters.sqlite.status === 'required' &&
      scenario.expectations.users !== undefined,
  );

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

  describe('executable decision matrix (SQLite)', () => {
    it.each(USER_MATRIX_SCENARIOS)('$id — $title', async (scenario) => {
      if (
        scenario.execution === 'concurrent_winner_and_observer' ||
        scenario.execution === 'concurrent_email_competitors' ||
        scenario.execution === 'durable_arbiter_retry' ||
        scenario.execution === 'caller_owned_transaction' ||
        scenario.execution === 'root_transaction_rollback'
      ) {
        await isolated.db.rollback();
        db = isolated.baseDb;
        await prepareOidcEmailKeyBackfills(db);
        users = await UserCollection.create({ db });
      }

      await runUserMatrixScenario({ db, scenario, users });
    });
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

  it('owner-authorizes a first binding and reuses the exact identity afterward', async () => {
    await isolated.db.rollback();
    db = isolated.baseDb;
    await prepareOidcEmailKeyBackfills(db);
    users = await UserCollection.create({ db });
    const profileId = await seedProfile(db, {
      email: ' Approved@Example.com ',
    });
    const userId = await seedUser(db, profileId, 'approved@example.com');
    const oidcClaims = claims({
      email: ' APPROVED@example.com ',
      sub: 'approved-first-subject',
    });
    let authorizerCalls = 0;

    const first = await users.getOrCreateFromOidc(oidcClaims, 'dex', {
      authorizeProfileOwner: async (context) => {
        authorizerCalls += 1;
        expect(context.db).not.toBe(db);
        expect(context.users).not.toBe(users);
        expect(context.claims.email).toBe('approved@example.com');
        expect(context.claims.email_verified).toBe(true);
        expect(Object.isFrozen(context.claims)).toBe(true);
        const profiles = await ProfileCollection.create({ db: context.db });
        const [profile, user] = await Promise.all([
          profiles.get({ id: profileId }),
          context.users.get({ id: userId }),
        ]);
        if (!profile || !user) throw new Error('Missing approved fixture.');
        return { profile, user };
      },
    });
    const second = await users.getOrCreateFromOidc(oidcClaims, 'dex');

    expect(authorizerCalls).toBe(1);
    expect(first.created).toBe(false);
    expect(first.profile.id).toBe(profileId);
    expect(first.user.id).toBe(userId);
    expect(second.profile.id).toBe(profileId);
    expect(second.user.id).toBe(userId);
    expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(countRows(db, 'users')).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(1);
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
      __smrtSkipVitestSchemaPreparation: true,
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
      __smrtSkipVitestSchemaPreparation: true,
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

  it.each([
    getOidcProvisioningDecisionScenario('duckdb-caller-owned-transaction'),
  ])('$id — $title (Users manual transaction)', async (scenario) => {
    const duckDb = (await getDatabase({
      type: 'duckdb',
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    })) as DatabaseInterface;
    await syncSchema({ db: duckDb, schema: OIDC_USERS_TEST_SCHEMA });
    const before = await provisioningRowCounts(duckDb);
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
      ).rejects.toMatchObject({
        code: getOidcProvisioningPublicErrorCode(scenario.expectations.users),
      });

      await expectUserMatrixRowDelta(tx, before, scenario.expectations.users);

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

  it.each([
    getOidcProvisioningDecisionScenario('duckdb-caller-owned-transaction'),
  ])('$id — $title (Users callback transaction)', async (scenario) => {
    const duckDb = (await getDatabase({
      type: 'duckdb',
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    })) as DatabaseInterface;
    await syncSchema({ db: duckDb, schema: OIDC_USERS_TEST_SCHEMA });
    const before = await provisioningRowCounts(duckDb);
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
        ).rejects.toMatchObject({
          code: getOidcProvisioningPublicErrorCode(scenario.expectations.users),
        });

        await expectUserMatrixRowDelta(tx, before, scenario.expectations.users);

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

interface UserMatrixRunOptions {
  db: DatabaseInterface;
  scenario: OidcProvisioningScenario;
  users: UserCollection;
}

interface UserMatrixResult {
  created: boolean;
  profile: { id?: string };
  user: { id?: string };
  oidcIdentity: { id?: string };
}

interface ProvisioningRowCounts {
  profile: number;
  oidcIdentity: number;
  user: number;
  session: number;
}

async function runUserMatrixScenario({
  db,
  scenario,
  users,
}: UserMatrixRunOptions): Promise<void> {
  const expected = scenario.expectations.users;
  if (!expected)
    throw new Error(`Missing Users expectation for ${scenario.id}`);

  const email = 'matrix@example.com';
  const subject = `matrix-${scenario.id}`;
  let identityProfileId: string | undefined;
  let identityId: string | undefined;
  let emailProfileId: string | undefined;
  let emailOwnerUserId: string | undefined;
  let authorizationUserId: string | undefined;
  let resolverProfileId: string | undefined;

  if (scenario.identity === 'exact_missing_profile') {
    identityId = await seedIdentity(db, randomUUID(), {
      email,
      identityKey: JSON.stringify(['https://issuer.example.com', subject]),
      subject,
    });
  } else if (scenario.identity !== 'none') {
    const identityEmail =
      scenario.email === 'different_global_person'
        ? 'linked-matrix@example.com'
        : email;
    identityProfileId = await seedProfile(db, {
      email: identityEmail,
      metaType:
        scenario.identity === 'exact_legacy_non_person_profile'
          ? ORGANIZATION_META_TYPE
          : undefined,
      tenantId:
        scenario.identity === 'exact_legacy_tenant_profile'
          ? randomUUID()
          : undefined,
    });
    const legacyIdentity =
      scenario.identity.startsWith('exact_legacy_') ||
      scenario.identity === 'exact_ambiguous_legacy_links';
    identityId = await seedIdentity(db, identityProfileId, {
      email: identityEmail,
      identityKey: legacyIdentity
        ? null
        : JSON.stringify(['https://issuer.example.com', subject]),
      subject,
    });
    if (scenario.identity === 'exact_ambiguous_legacy_links') {
      const duplicateProfileId = await seedProfile(db, {
        email: identityEmail,
      });
      await seedIdentity(db, duplicateProfileId, {
        email: identityEmail,
        identityKey: null,
        subject,
      });
    }
    if (scenario.email === 'already_owned_global_person') {
      emailOwnerUserId = await seedUser(
        db,
        identityProfileId,
        scenario.id === 'owner-authorized-user-email-mismatch'
          ? 'different-owner@example.com'
          : email,
      );
    }
    if (scenario.email === 'different_global_person') {
      emailProfileId = await seedProfile(db, { email });
    }
  }

  if (scenario.identity === 'none') {
    if (
      scenario.email === 'one_unowned_global_person' ||
      scenario.email === 'already_owned_global_person' ||
      scenario.email === 'tenant_scoped_collision' ||
      scenario.email === 'non_person_collision' ||
      scenario.email === 'duplicate_normalized_profiles' ||
      scenario.email === 'different_global_person'
    ) {
      emailProfileId = await seedProfile(db, {
        email:
          scenario.email === 'different_global_person'
            ? 'different-matrix@example.com'
            : email,
        metaType:
          scenario.email === 'non_person_collision'
            ? ORGANIZATION_META_TYPE
            : undefined,
        tenantId:
          scenario.email === 'tenant_scoped_collision'
            ? randomUUID()
            : undefined,
      });
      if (scenario.email === 'duplicate_normalized_profiles') {
        await seedProfile(db, { email: ' MATRIX@example.com ' });
      }
      if (scenario.email === 'already_owned_global_person') {
        emailOwnerUserId = await seedUser(
          db,
          emailProfileId,
          scenario.id === 'owner-authorized-user-email-mismatch'
            ? 'different-owner@example.com'
            : email,
        );
      }
    }
  }

  if (scenario.ownerAuthorization) {
    const authorizedProfileId = emailProfileId ?? identityProfileId;
    if (!authorizedProfileId) {
      throw new Error(`Scenario ${scenario.id} has no authorized Profile.`);
    }
    if (scenario.ownerAuthorization === 'matching_owner' && !emailOwnerUserId) {
      emailOwnerUserId = await seedUser(db, authorizedProfileId, email);
    }
    if (scenario.ownerAuthorization === 'multiple_owners') {
      await db.query('DROP INDEX users_profile_id_idx');
      emailOwnerUserId ??= await seedUser(db, authorizedProfileId, email);
      await seedUser(db, authorizedProfileId, 'second-owner@example.com');
    }
    if (
      scenario.ownerAuthorization === 'wrong_user' ||
      scenario.ownerAuthorization === 'no_owner'
    ) {
      const decoyProfileId = await seedProfile(db, {
        email: `decoy-${scenario.id}@example.com`,
      });
      authorizationUserId = await seedUser(
        db,
        decoyProfileId,
        `decoy-${scenario.id}@example.com`,
      );
    } else {
      authorizationUserId = emailOwnerUserId;
    }
  }

  if (scenario.resolver === 'different_profile') {
    resolverProfileId =
      emailProfileId ??
      (await seedProfile(db, { email: 'different-matrix@example.com' }));
  } else if (scenario.resolver === 'same_profile') {
    resolverProfileId = identityProfileId ?? emailProfileId;
  } else if (scenario.resolver === 'owned_profile') {
    resolverProfileId = emailProfileId;
  }

  if (expected.readiness === 'none') {
    await deleteBackfillMarker(
      db,
      '@happyvertical/smrt-profiles:profile-email-keys:v1',
    );
  }
  if (expected.readiness !== 'profile_and_user_email_keys') {
    await deleteBackfillMarker(
      db,
      '@happyvertical/smrt-users:user-email-keys:v1',
    );
  }

  const before = await provisioningRowCounts(db);
  const identityBindingsBefore = await userMatrixIdentityBindings(db, subject);
  let resolverCalls = 0;
  let ownerAuthorizerCalls = 0;
  const resolveProfile =
    scenario.resolver === 'absent'
      ? undefined
      : async ({ db: resolverDb }: { db: DatabaseInterface }) => {
          resolverCalls += 1;
          if (scenario.execution === 'root_transaction_rollback') {
            const probeProfileId = randomUUID();
            await resolverDb.query(
              `INSERT INTO profiles
                (id, slug, context, _meta_type, tenant_id, email, email_key, name)
               VALUES (?, ?, '', '@happyvertical/smrt-profiles:Person', NULL, ?, ?, 'Rollback Probe')`,
              probeProfileId,
              `rollback-probe-${probeProfileId}`,
              'rollback-probe@example.com',
              'rollback-probe@example.com',
            );
            return null;
          }
          if (scenario.resolver === 'undefined') return undefined;
          if (scenario.resolver === 'null') return null;
          if (scenario.resolver === 'throws') {
            throw new Error('matrix resolver failure');
          }
          const profileId = resolverProfileId;
          if (!profileId) {
            throw new Error(`Scenario ${scenario.id} has no resolver Profile.`);
          }
          return (await ProfileCollection.create({ db: resolverDb })).get({
            id: profileId,
          });
        };
  const authorizeProfileOwner =
    scenario.ownerAuthorization === undefined
      ? undefined
      : async ({
          db: authorizerDb,
          users: authorizerUsers,
        }: {
          db: DatabaseInterface;
          users: UserCollection;
        }) => {
          ownerAuthorizerCalls += 1;
          if (scenario.ownerAuthorization === 'null') return null;
          const profileId = emailProfileId ?? identityProfileId;
          if (!profileId || !authorizationUserId) {
            throw new Error(
              `Scenario ${scenario.id} has no owner authorization fixture.`,
            );
          }
          const profiles = await ProfileCollection.create({ db: authorizerDb });
          const [profile, user] = await Promise.all([
            profiles.get({ id: profileId }),
            authorizerUsers.get({ id: authorizationUserId }),
          ]);
          if (!profile || !user) {
            throw new Error(
              `Scenario ${scenario.id} could not hydrate its authorization fixture.`,
            );
          }
          return { profile, user };
        };
  const oidcClaims = claims({
    email: scenario.email === 'missing' ? undefined : email,
    email_verified:
      scenario.verification === 'claim_missing'
        ? undefined
        : scenario.verification === 'verified',
    sub: subject,
  });
  if (scenario.email === 'missing') delete oidcClaims.email;
  if (scenario.verification === 'claim_missing') {
    delete oidcClaims.email_verified;
  }

  const values: UserMatrixResult[] = [];
  const errors: unknown[] = [];
  const invoke = (collection = users, claimsOverride = oidcClaims) =>
    collection.getOrCreateFromOidc(claimsOverride, 'dex', {
      ...(scenario.ownerAuthorization && scenario.verification === 'unverified'
        ? { allowUnverifiedEmail: true }
        : {}),
      ...(authorizeProfileOwner ? { authorizeProfileOwner } : {}),
      ...(resolveProfile ? { resolveProfile } : {}),
    });

  if (
    scenario.execution === 'concurrent_winner_and_observer' ||
    scenario.execution === 'concurrent_authorized_callbacks'
  ) {
    collectSettled(
      await Promise.allSettled([invoke(), invoke()]),
      values,
      errors,
    );
  } else if (scenario.execution === 'concurrent_email_competitors') {
    collectSettled(
      await Promise.allSettled([
        invoke(users, { ...oidcClaims, sub: `${subject}-first` }),
        invoke(users, { ...oidcClaims, sub: `${subject}-second` }),
      ]),
      values,
      errors,
    );
  } else if (scenario.execution === 'durable_arbiter_retry') {
    const retryingUsers = await UserCollection.create({
      db: withFirstMatrixIdentityConflict(db),
    });
    await collectPromise(invoke(retryingUsers), values, errors);
  } else if (scenario.execution === 'caller_owned_transaction') {
    const transaction = db.transaction;
    if (!transaction) throw new Error('SQLite matrix requires transaction().');
    await collectPromise(
      transaction.call(db, async (tx) =>
        invoke(await UserCollection.create({ db: tx })),
      ),
      values,
      errors,
    );
  } else {
    await collectPromise(invoke(), values, errors);
  }

  expectMatrixOutcome(expected, values, errors);
  expectMatrixCreatedResult(expected, values);
  expectMatrixResolverCalls(resolverCalls, expected.resolverCalls);
  expectMatrixResolverCalls(
    ownerAuthorizerCalls,
    expected.ownerAuthorizerCalls,
  );
  expectMatrixRetryContract(
    scenario,
    expected,
    resolverCalls,
    ownerAuthorizerCalls,
  );
  assertSelectedProfile({
    emailProfileId,
    expected,
    identityProfileId,
    resolverProfileId,
    authorizedProfileId: emailProfileId ?? identityProfileId,
    values,
  });
  if (expected.selectedProfile === 'exact_identity_profile') {
    expect(values.every((value) => value.oidcIdentity.id === identityId)).toBe(
      true,
    );
  }

  await expectUserMatrixRowDelta(db, before, expected);
  if (scenario.identity !== 'none' && !expected.rebindAllowed) {
    await expect(userMatrixIdentityBindings(db, subject)).resolves.toEqual(
      identityBindingsBefore,
    );
  }
}

async function collectPromise(
  promise: Promise<UserMatrixResult>,
  values: UserMatrixResult[],
  errors: unknown[],
): Promise<void> {
  try {
    values.push(await promise);
  } catch (error) {
    errors.push(error);
  }
}

function collectSettled(
  results: PromiseSettledResult<UserMatrixResult>[],
  values: UserMatrixResult[],
  errors: unknown[],
): void {
  for (const result of results) {
    if (result.status === 'fulfilled') values.push(result.value);
    else errors.push(result.reason);
  }
}

function expectMatrixOutcome(
  expected: OidcProvisioningSurfaceExpectation,
  values: UserMatrixResult[],
  errors: unknown[],
): void {
  if (expected.outcome === 'success') {
    expect(values.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  } else if (expected.outcome === 'rejected') {
    expect(values).toHaveLength(0);
    expect(errors).toHaveLength(1);
  } else {
    expect(values).toHaveLength(1);
    expect(errors).toHaveLength(1);
  }
  for (const error of errors) {
    expectMatrixPublicError(error, expected.publicError);
  }
}

function expectMatrixCreatedResult(
  expected: OidcProvisioningSurfaceExpectation,
  values: UserMatrixResult[],
): void {
  const created = values.map((value) => value.created);
  if (expected.resultCreated === 'none') expect(created).toHaveLength(0);
  else if (expected.resultCreated === 'created') {
    expect(created.every(Boolean)).toBe(true);
  } else if (expected.resultCreated === 'reused') {
    expect(created.every((value) => !value)).toBe(true);
  } else {
    expect(created).toContain(true);
    expect(created).toContain(false);
  }
}

function expectMatrixResolverCalls(
  actual: number,
  expected: OidcProvisioningSurfaceExpectation['resolverCalls'],
): void {
  if (expected === 'at_least_2') expect(actual).toBeGreaterThanOrEqual(2);
  else expect(actual).toBe(expected);
}

function expectMatrixRetryContract(
  scenario: OidcProvisioningScenario,
  expected: OidcProvisioningSurfaceExpectation,
  resolverCalls: number,
  ownerAuthorizerCalls: number,
): void {
  if (expected.retry === 'once_after_race') {
    expect([
      'concurrent_winner_and_observer',
      'durable_arbiter_retry',
    ]).toContain(scenario.execution);
    expect(resolverCalls + ownerAuthorizerCalls).toBeGreaterThanOrEqual(2);
  } else if (scenario.execution === 'durable_arbiter_retry') {
    throw new Error(`${scenario.id} must declare its resolver retry contract.`);
  }
}

function expectMatrixPublicError(
  error: unknown,
  publicError: OidcProvisioningSurfaceExpectation['publicError'],
): void {
  expect(publicError).not.toBeNull();
  if (!publicError) return;
  if ('code' in publicError) {
    expect(error).toEqual(expect.objectContaining({ code: publicError.code }));
  } else if ('name' in publicError) {
    expect(error).toEqual(expect.objectContaining({ name: publicError.name }));
  } else {
    expect(error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(publicError.messageIncludes),
      }),
    );
  }
}

function assertSelectedProfile(options: {
  authorizedProfileId?: string;
  emailProfileId?: string;
  expected: OidcProvisioningSurfaceExpectation;
  identityProfileId?: string;
  resolverProfileId?: string;
  values: UserMatrixResult[];
}): void {
  const { expected, values } = options;
  if (expected.selectedProfile === null) return;
  const profileIds = values.map((value) => value.profile.id);
  if (expected.selectedProfile === 'concurrent_winner') {
    expect(new Set(profileIds)).toHaveLength(1);
    return;
  }
  const expectedId =
    expected.selectedProfile === 'authorized_profile'
      ? options.authorizedProfileId
      : expected.selectedProfile === 'email_match'
        ? options.emailProfileId
        : expected.selectedProfile === 'exact_identity_profile'
          ? options.identityProfileId
          : expected.selectedProfile === 'resolver_profile'
            ? options.resolverProfileId
            : undefined;
  if (expected.selectedProfile === 'new_profile') {
    expect(profileIds.every((id) => typeof id === 'string')).toBe(true);
    expect(profileIds).not.toContain(options.emailProfileId);
    expect(profileIds).not.toContain(options.identityProfileId);
    return;
  }
  expect(expectedId).toBeDefined();
  expect(profileIds.every((id) => id === expectedId)).toBe(true);
}

async function provisioningRowCounts(
  db: DatabaseInterface,
): Promise<ProvisioningRowCounts> {
  // Caller-owned transactions share a connection. Keep observation queries
  // ordered; DuckDB must not contend with its native connection.
  const profile = await countRows(db, 'profiles');
  const oidcIdentity = await countRows(db, 'oidc_identities');
  const user = await countRows(db, 'users');
  const session = await countRows(db, 'sessions');
  return { profile, oidcIdentity, user, session };
}

function rowCountDelta(
  before: ProvisioningRowCounts,
  after: ProvisioningRowCounts,
): ProvisioningRowCounts {
  return {
    profile: after.profile - before.profile,
    oidcIdentity: after.oidcIdentity - before.oidcIdentity,
    user: after.user - before.user,
    session: after.session - before.session,
  };
}

async function expectUserMatrixRowDelta(
  db: DatabaseInterface,
  before: ProvisioningRowCounts,
  expected: OidcProvisioningSurfaceExpectation | undefined,
): Promise<void> {
  if (!expected) throw new Error('Missing Users matrix expectation.');
  const after = await provisioningRowCounts(db);
  expect(rowCountDelta(before, after)).toEqual(expected.createdRows);
}

function withFirstMatrixIdentityConflict(
  db: DatabaseInterface,
): DatabaseInterface {
  const transaction = db.transaction;
  if (!transaction) throw new Error('SQLite matrix requires transaction().');
  let injected = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return async <T>(
          callback: (tx: DatabaseInterface) => Promise<T>,
        ): Promise<T> =>
          transaction.call(target, (tx) =>
            callback(
              new Proxy(tx, {
                get(txTarget, txProperty, txReceiver) {
                  if (txProperty === 'upsert') {
                    return async (
                      ...args: Parameters<DatabaseInterface['upsert']>
                    ) => {
                      if (!injected && args[0] === 'oidc_identities') {
                        injected = true;
                        throw new Error(
                          'UNIQUE constraint failed: oidc_identities.identity_key',
                        );
                      }
                      return txTarget.upsert(...args);
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
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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
  options: {
    email: string;
    identityKey?: string | null;
    issuer?: string;
    subject: string;
  },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO oidc_identities
      (id, slug, context, profile_id, provider, issuer, subject, identity_key, email)
     VALUES (?, ?, '', ?, 'dex', ?, ?, ?, ?)`,
    id,
    `seed-${id}`,
    profileId,
    options.issuer ?? 'https://issuer.example.com',
    options.subject,
    options.identityKey ?? null,
    options.email,
  );
  return id;
}

async function userMatrixIdentityBindings(
  db: DatabaseInterface,
  subject: string,
): Promise<Array<{ id: string; profileId: string }>> {
  const result = await db.query(
    `SELECT id, profile_id
     FROM oidc_identities
     WHERE issuer = ? AND subject = ?
     ORDER BY id`,
    'https://issuer.example.com',
    subject,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    profileId: String(row.profile_id),
  }));
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
