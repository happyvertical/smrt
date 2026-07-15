import { randomUUID } from 'node:crypto';
import {
  backfillProfileEmailKeys,
  createProfileFromOidc,
  PROFILE_EMAIL_KEY_BACKFILL_NAME,
  ProfileCollection,
} from '@happyvertical/smrt-profiles';
import {
  getTestDbConfig,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getOidcProvisioningDecisionScenario,
  getOidcProvisioningPublicErrorCode,
  OIDC_PROVISIONING_DECISION_MATRIX,
} from '../../../profiles/src/testing/oidcProvisioningDecisionMatrix.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  backfillUserEmailKeys,
  USER_EMAIL_KEY_BACKFILL_NAME,
} from '../migrations/backfillUserEmailKeys.js';
import {
  OIDC_USERS_TEST_SCHEMA,
  prepareOidcEmailKeyBackfills,
} from './helpers/oidc-test-server.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
const POSTGRES_USER_MATRIX_IDS = OIDC_PROVISIONING_DECISION_MATRIX.filter(
  (scenario) =>
    scenario.adapters.postgres.status === 'required' &&
    scenario.expectations.users !== undefined,
).map((scenario) => scenario.id);
const EXECUTED_POSTGRES_USER_MATRIX_IDS = [
  'concurrent-winner-and-observer',
  'concurrent-email-competitors',
  'owner-authorized-concurrent-callbacks',
  'owner-authorizer-durable-arbiter-retry',
  'resolver-durable-arbiter-retry',
  'caller-owned-transaction',
  'root-transaction-resolver-rollback',
] as const;
const POSTGRES_PROFILE_MATRIX_IDS = OIDC_PROVISIONING_DECISION_MATRIX.filter(
  (scenario) =>
    scenario.adapters.postgres.status === 'required' &&
    scenario.expectations.profiles !== undefined,
).map((scenario) => scenario.id);
const EXECUTED_POSTGRES_PROFILE_MATRIX_IDS = [
  'concurrent-winner-and-observer',
  'caller-owned-transaction',
] as const;

describePostgres('Postgres OIDC provisioning concurrency', () => {
  let adminDb: DatabaseInterface | undefined;
  let schemaName: string | undefined;
  const connections: DatabaseInterface[] = [];

  afterEach(async () => {
    await Promise.all(connections.splice(0).map(closeDatabase));
    if (adminDb && schemaName) {
      await adminDb.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
    await closeDatabase(adminDb);
    adminDb = undefined;
    schemaName = undefined;
  });

  it('executes every PostgreSQL-required matrix row for each applicable surface', () => {
    expect([...EXECUTED_POSTGRES_USER_MATRIX_IDS].sort()).toEqual(
      [...POSTGRES_USER_MATRIX_IDS].sort(),
    );
    expect([...EXECUTED_POSTGRES_PROFILE_MATRIX_IDS].sort()).toEqual(
      [...POSTGRES_PROFILE_MATRIX_IDS].sort(),
    );
  });

  it.each([
    getOidcProvisioningDecisionScenario('concurrent-winner-and-observer'),
  ])('$id — $title (Users)', async (scenario) => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);

    const firstDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-first-${Date.now()}`,
    });
    const secondDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-second-${Date.now()}`,
    });
    await Promise.all([
      setSearchPath(firstDb, fixture.schemaName),
      setSearchPath(secondDb, fixture.schemaName),
    ]);
    connections.push(firstDb, secondDb);
    const firstUsers = await UserCollection.create({ db: firstDb });
    const secondUsers = await UserCollection.create({ db: secondDb });

    let arrivals = 0;
    let release!: () => void;
    const bothLookupsComplete = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothLookupsComplete;
      return undefined;
    };
    const claims = {
      email: 'postgres-concurrent@example.com',
      email_verified: true,
      iss: 'https://issuer.example.com',
      name: 'Concurrent Postgres User',
      sub: 'postgres-concurrent-subject',
    };

    const [first, second] = await Promise.all([
      firstUsers.getOrCreateFromOidc(claims, 'dex', {
        resolveProfile: barrier,
      }),
      secondUsers.getOrCreateFromOidc(claims, 'dex', {
        resolveProfile: barrier,
      }),
    ]);

    expect(arrivals).toBeGreaterThanOrEqual(2);
    expect(second.profile.id).toBe(first.profile.id);
    expect(second.user.id).toBe(first.user.id);
    expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
    first.user.recordLogin();
    await expect(first.user.save()).resolves.toBe(first.user);
    await expect(first.profile.getOidcIdentities()).resolves.toHaveLength(1);
    await expect(first.oidcIdentity.recordUsage()).resolves.toBeUndefined();
    await expect(countRows(firstDb, 'profiles')).resolves.toBe(1);
    await expect(countRows(firstDb, 'users')).resolves.toBe(1);
    await expect(countRows(firstDb, 'oidc_identities')).resolves.toBe(1);
    await expect(
      countRows(firstDb, 'oidc_profile_email_reservations'),
    ).resolves.toBe(1);
  });

  it.each([
    getOidcProvisioningDecisionScenario('resolver-durable-arbiter-retry'),
  ])('$id — $title (Users)', async (scenario) => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);

    const rootDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-retry-${Date.now()}`,
    });
    await setSearchPath(rootDb, fixture.schemaName);
    connections.push(rootDb);
    let injectedConflicts = 0;
    const retryingDb = withFirstIdentityArbiterConflict(rootDb, () => {
      injectedConflicts += 1;
    });
    const users = await UserCollection.create({ db: retryingDb });
    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls += 1;
      return undefined;
    };

    const result = await users.getOrCreateFromOidc(
      {
        email: 'postgres-retry@example.com',
        email_verified: true,
        iss: 'https://issuer.example.com',
        sub: 'postgres-retry-subject',
      },
      'dex',
      { resolveProfile: resolver },
    );

    expect(injectedConflicts).toBe(1);
    expect(resolverCalls).toBe(scenario.expectations.users?.resolverCalls);
    expect(result.created).toBe(true);
    await expect(countRows(rootDb, 'profiles')).resolves.toBe(1);
    await expect(countRows(rootDb, 'users')).resolves.toBe(1);
    await expect(countRows(rootDb, 'oidc_identities')).resolves.toBe(1);
    await expect(
      countRows(rootDb, 'oidc_profile_email_reservations'),
    ).resolves.toBe(1);
  });

  it.each([
    getOidcProvisioningDecisionScenario(
      'owner-authorized-concurrent-callbacks',
    ),
  ])('$id — $title (Users)', async (scenario) => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);
    const approved = await seedAuthorizedOwner(
      fixture.rootDb,
      'postgres-approved@example.com',
    );
    const firstDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-authorized-first-${Date.now()}`,
    });
    const secondDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-authorized-second-${Date.now()}`,
    });
    await Promise.all([
      setSearchPath(firstDb, fixture.schemaName),
      setSearchPath(secondDb, fixture.schemaName),
    ]);
    connections.push(firstDb, secondDb);
    const firstUsers = await UserCollection.create({ db: firstDb });
    const secondUsers = await UserCollection.create({ db: secondDb });
    const synchronizeAuthorization = createBarrier(2);
    let authorizerCalls = 0;
    const authorizeProfileOwner = async ({
      db,
      users,
    }: {
      db: DatabaseInterface;
      users: UserCollection;
    }) => {
      authorizerCalls += 1;
      await synchronizeAuthorization();
      const profiles = await ProfileCollection.create({ db });
      const [profile, user] = await Promise.all([
        profiles.get({ id: approved.profileId }),
        users.get({ id: approved.userId }),
      ]);
      if (!profile || !user) throw new Error('Missing approved fixture.');
      return { profile, user };
    };
    const claims = {
      email: 'postgres-approved@example.com',
      email_verified: true,
      iss: 'https://issuer.example.com',
      sub: 'postgres-approved-subject',
    };

    const [first, second] = await Promise.all([
      firstUsers.getOrCreateFromOidc(claims, 'dex', {
        authorizeProfileOwner,
      }),
      secondUsers.getOrCreateFromOidc(claims, 'dex', {
        authorizeProfileOwner,
      }),
    ]);

    expect(scenario.expectations.users?.ownerAuthorizerCalls).toBe(
      'at_least_2',
    );
    expect(authorizerCalls).toBeGreaterThanOrEqual(2);
    expect(first.created).toBe(false);
    expect(second.profile.id).toBe(approved.profileId);
    expect(second.user.id).toBe(approved.userId);
    expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
    await expect(countRows(firstDb, 'profiles')).resolves.toBe(1);
    await expect(countRows(firstDb, 'users')).resolves.toBe(1);
    await expect(countRows(firstDb, 'oidc_identities')).resolves.toBe(1);
  });

  it.each([
    getOidcProvisioningDecisionScenario(
      'owner-authorizer-durable-arbiter-retry',
    ),
  ])('$id — $title (Users)', async (scenario) => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);
    const approved = await seedAuthorizedOwner(
      fixture.rootDb,
      'postgres-authorizer-retry@example.com',
    );
    const rootDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-authorizer-retry-${Date.now()}`,
    });
    await setSearchPath(rootDb, fixture.schemaName);
    connections.push(rootDb);
    let injectedConflicts = 0;
    const retryingDb = withFirstIdentityArbiterConflict(rootDb, () => {
      injectedConflicts += 1;
    });
    const users = await UserCollection.create({ db: retryingDb });
    let authorizerCalls = 0;

    const result = await users.getOrCreateFromOidc(
      {
        email: 'postgres-authorizer-retry@example.com',
        email_verified: true,
        iss: 'https://issuer.example.com',
        sub: 'postgres-authorizer-retry-subject',
      },
      'dex',
      {
        authorizeProfileOwner: async ({ db, users: transactionUsers }) => {
          authorizerCalls += 1;
          const profiles = await ProfileCollection.create({ db });
          const [profile, user] = await Promise.all([
            profiles.get({ id: approved.profileId }),
            transactionUsers.get({ id: approved.userId }),
          ]);
          if (!profile || !user) throw new Error('Missing approved fixture.');
          return { profile, user };
        },
      },
    );

    expect(injectedConflicts).toBe(1);
    expect(authorizerCalls).toBe(
      scenario.expectations.users?.ownerAuthorizerCalls,
    );
    expect(result.created).toBe(false);
    expect(result.profile.id).toBe(approved.profileId);
    expect(result.user.id).toBe(approved.userId);
    await expect(countRows(rootDb, 'profiles')).resolves.toBe(1);
    await expect(countRows(rootDb, 'users')).resolves.toBe(1);
    await expect(countRows(rootDb, 'oidc_identities')).resolves.toBe(1);
  });

  it.each([
    getOidcProvisioningDecisionScenario('concurrent-email-competitors'),
  ])('$id — $title (Users)', async (scenario) => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);

    const firstDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-owner-first-${Date.now()}`,
    });
    const secondDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-owner-second-${Date.now()}`,
    });
    await Promise.all([
      setSearchPath(firstDb, fixture.schemaName),
      setSearchPath(secondDb, fixture.schemaName),
    ]);
    connections.push(firstDb, secondDb);
    const firstUsers = await UserCollection.create({ db: firstDb });
    const secondUsers = await UserCollection.create({ db: secondDb });
    const synchronizeLookup = createBarrier(2);
    const commonClaims = {
      email: 'postgres-owned-race@example.com',
      email_verified: true,
      iss: 'https://issuer.example.com',
      name: 'Competing Postgres User',
    };

    const results = await Promise.allSettled([
      firstUsers.getOrCreateFromOidc(
        { ...commonClaims, sub: 'postgres-owner-subject-one' },
        'dex',
        { resolveProfile: synchronizeLookup },
      ),
      secondUsers.getOrCreateFromOidc(
        { ...commonClaims, sub: 'postgres-owner-subject-two' },
        'dex',
        { resolveProfile: synchronizeLookup },
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: getOidcProvisioningPublicErrorCode(scenario.expectations.users),
        }),
      }),
    ]);
    await expect(countRows(firstDb, 'profiles')).resolves.toBe(1);
    await expect(countRows(firstDb, 'users')).resolves.toBe(1);
    await expect(countRows(firstDb, 'oidc_identities')).resolves.toBe(1);
    await expect(
      countRows(firstDb, 'oidc_profile_email_reservations'),
    ).resolves.toBe(1);
  });

  it('rejects existing identities without Users when the claim email changes', async () => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);
    await seedExistingIdentity(fixture.rootDb, {
      email: 'stored-first@example.com',
      subject: 'existing-first-subject',
    });
    await seedExistingIdentity(fixture.rootDb, {
      email: 'stored-second@example.com',
      subject: 'existing-second-subject',
    });

    const firstDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-existing-email-first-${Date.now()}`,
    });
    const secondDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-existing-email-second-${Date.now()}`,
    });
    await Promise.all([
      setSearchPath(firstDb, fixture.schemaName),
      setSearchPath(secondDb, fixture.schemaName),
    ]);
    connections.push(firstDb, secondDb);
    const firstUsers = await UserCollection.create({ db: firstDb });
    const secondUsers = await UserCollection.create({ db: secondDb });
    const commonClaims = {
      email: 'shared-new@example.com',
      email_verified: true,
      iss: 'https://issuer.example.com',
      name: 'Existing Identity User',
    };

    const results = await Promise.allSettled([
      firstUsers.getOrCreateFromOidc(
        { ...commonClaims, sub: 'existing-first-subject' },
        'dex',
      ),
      secondUsers.getOrCreateFromOidc(
        { ...commonClaims, sub: 'existing-second-subject' },
        'dex',
      ),
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'email_mismatch' }),
        status: 'rejected',
      }),
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'email_mismatch' }),
        status: 'rejected',
      }),
    ]);
    await expect(countRows(firstDb, 'profiles')).resolves.toBe(2);
    await expect(countRows(firstDb, 'users')).resolves.toBe(0);
    await expect(countRows(firstDb, 'oidc_identities')).resolves.toBe(2);
    await expect(
      countRows(firstDb, 'oidc_profile_email_reservations'),
    ).resolves.toBe(2);
  });

  it('retries a deadlock while reconciling concurrently swapped reservations', async () => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);
    const firstProfileId = await seedExistingIdentity(fixture.rootDb, {
      email: 'swap-first@example.com',
      subject: 'postgres-swap-first-subject',
    });
    const secondProfileId = await seedExistingIdentity(fixture.rootDb, {
      email: 'swap-second@example.com',
      subject: 'postgres-swap-second-subject',
    });
    await fixture.rootDb.query(
      'UPDATE profiles SET email = ?, email_key = ? WHERE id = ?',
      'swap-second@example.com',
      'swap-second@example.com',
      firstProfileId,
    );
    await fixture.rootDb.query(
      'UPDATE profiles SET email = ?, email_key = ? WHERE id = ?',
      'swap-first@example.com',
      'swap-first@example.com',
      secondProfileId,
    );

    const firstDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-swap-first-${Date.now()}`,
    });
    const secondDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-swap-second-${Date.now()}`,
    });
    await Promise.all([
      setSearchPath(firstDb, fixture.schemaName),
      setSearchPath(secondDb, fixture.schemaName),
    ]);
    connections.push(firstDb, secondDb);
    const synchronizeDeletes = createBarrier(2);
    const firstUsers = await UserCollection.create({
      db: withReservationDeleteBarrier(firstDb, synchronizeDeletes),
    });
    const secondUsers = await UserCollection.create({
      db: withReservationDeleteBarrier(secondDb, synchronizeDeletes),
    });

    const [first, second] = await Promise.all([
      firstUsers.getOrCreateFromOidc(
        {
          email: 'swap-second@example.com',
          email_verified: true,
          iss: 'https://issuer.example.com',
          sub: 'postgres-swap-first-subject',
        },
        'dex',
      ),
      secondUsers.getOrCreateFromOidc(
        {
          email: 'swap-first@example.com',
          email_verified: true,
          iss: 'https://issuer.example.com',
          sub: 'postgres-swap-second-subject',
        },
        'dex',
      ),
    ]);

    expect(first.profile.id).toBe(firstProfileId);
    expect(second.profile.id).toBe(secondProfileId);
    await expect(countRows(firstDb, 'users')).resolves.toBe(2);
    const reservations = await firstDb.query(
      'SELECT profile_id, email_key FROM oidc_profile_email_reservations ORDER BY email_key',
    );
    expect(reservations.rows).toEqual([
      { profile_id: secondProfileId, email_key: 'swap-first@example.com' },
      { profile_id: firstProfileId, email_key: 'swap-second@example.com' },
    ]);
  });

  it('enforces normalized User email uniqueness across independent connections', async () => {
    const fixture = await createFixture();
    const firstDb = await getDatabase({
      ...fixture.config,
      dbid: `user-email-first-${Date.now()}`,
    });
    const secondDb = await getDatabase({
      ...fixture.config,
      dbid: `user-email-second-${Date.now()}`,
    });
    await Promise.all([
      setSearchPath(firstDb, fixture.schemaName),
      setSearchPath(secondDb, fixture.schemaName),
    ]);
    connections.push(firstDb, secondDb);
    const synchronizeUpsert = createBarrier(2);
    const firstUsers = await UserCollection.create({
      db: withUserUpsertBarrier(firstDb, synchronizeUpsert),
    });
    const secondUsers = await UserCollection.create({
      db: withUserUpsertBarrier(secondDb, synchronizeUpsert),
    });

    const results = await Promise.allSettled([
      firstUsers.create({
        email: ' Shared-New@Example.com ',
        profileId: randomUUID(),
      }),
      secondUsers.create({
        email: 'shared-new@example.com',
        profileId: randomUUID(),
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await expect(countRows(firstDb, 'users')).resolves.toBe(1);
    const storedUsers = await firstDb.query(
      'SELECT email, email_key FROM users',
    );
    expect(storedUsers.rows).toEqual([
      {
        email: 'shared-new@example.com',
        email_key: 'shared-new@example.com',
      },
    ]);
  });

  it.each([
    getOidcProvisioningDecisionScenario('caller-owned-transaction'),
  ])('$id — $title (Users)', async (scenario) => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);
    if (!fixture.rootDb.beginTransaction) {
      throw new Error('Expected PostgreSQL manual transaction support.');
    }
    const tx = await fixture.rootDb.beginTransaction();
    let trackerDdl = 0;
    let resolverCalls = 0;
    const observeTrackerDdl = (sql: string) => {
      if (/create\s+table[\s\S]*_smrt_backfills/iu.test(sql)) trackerDdl += 1;
    };
    const resolver = async () => {
      resolverCalls += 1;
      return undefined;
    };

    try {
      const firstUsers = await UserCollection.create({
        db: proxyDatabaseHandle(tx, observeTrackerDdl),
      });
      const secondUsers = await UserCollection.create({
        db: proxyDatabaseHandle(tx, observeTrackerDdl),
      });
      const [first, second] = await Promise.all([
        firstUsers.getOrCreateFromOidc(
          {
            email: 'outer-first@example.com',
            email_verified: true,
            iss: 'https://issuer.example.com',
            sub: 'outer-first-subject',
          },
          'dex',
          { resolveProfile: resolver },
        ),
        secondUsers.getOrCreateFromOidc(
          {
            email: 'outer-second@example.com',
            email_verified: true,
            iss: 'https://issuer.example.com',
            sub: 'outer-second-subject',
          },
          'dex',
          { resolveProfile: resolver },
        ),
      ]);

      expect(second.profile.id).not.toBe(first.profile.id);
      await expect(countRows(tx, 'users')).resolves.toBe(2);
      await expect(tx.query('SELECT 1 AS usable')).resolves.toMatchObject({
        rows: [{ usable: 1 }],
      });
      expect(tx.isActive()).toBe(true);
      expect(trackerDdl).toBe(0);
      expect(resolverCalls).toBe(
        (scenario.expectations.users?.resolverCalls ?? 0) * 2,
      );
      expect(await countRows(tx, 'users')).toBe(
        (scenario.expectations.users?.createdRows.user ?? 0) * 2,
      );
    } finally {
      if (tx.isActive()) await tx.rollback();
    }
  });

  it.each([
    getOidcProvisioningDecisionScenario('caller-owned-transaction'),
  ])('$id — $title (Profiles)', async (scenario) => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);
    if (!fixture.rootDb.beginTransaction) {
      throw new Error('Expected PostgreSQL manual transaction support.');
    }
    const tx = await fixture.rootDb.beginTransaction();
    try {
      const result = await createProfileFromOidc(
        {
          email: 'postgres-profile-caller@example.com',
          email_verified: true,
          iss: 'https://issuer.example.com',
          sub: 'postgres-profile-caller-subject',
        },
        'dex',
        { db: tx },
      );

      expect(result.created).toBe(true);
      expect(tx.isActive()).toBe(true);
      await expect(countRows(tx, 'profiles')).resolves.toBe(
        scenario.expectations.profiles?.createdRows.profile,
      );
      await expect(countRows(tx, 'oidc_identities')).resolves.toBe(
        scenario.expectations.profiles?.createdRows.oidcIdentity,
      );
    } finally {
      if (tx.isActive()) await tx.rollback();
    }
  });

  it.each([
    getOidcProvisioningDecisionScenario('root-transaction-resolver-rollback'),
  ])('$id — $title (Users)', async (scenario) => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);
    await fixture.rootDb.query(
      'DELETE FROM _smrt_backfills WHERE name IN (?, ?)',
      PROFILE_EMAIL_KEY_BACKFILL_NAME,
      USER_EMAIL_KEY_BACKFILL_NAME,
    );
    const users = await UserCollection.create({ db: fixture.rootDb });
    let resolverCalls = 0;
    const probeProfileId = randomUUID();

    await expect(
      users.getOrCreateFromOidc(
        {
          email: 'postgres-root-rollback@example.com',
          email_verified: true,
          iss: 'https://issuer.example.com',
          sub: 'postgres-root-rollback-subject',
        },
        'dex',
        {
          resolveProfile: async ({ db: tx }) => {
            resolverCalls += 1;
            await tx.query(
              `INSERT INTO profiles
                (id, slug, context, _meta_type, tenant_id, email, email_key, name)
               VALUES (?, ?, '', '@happyvertical/smrt-profiles:Person', NULL, ?, ?, 'Rollback Probe')`,
              probeProfileId,
              `rollback-probe-${probeProfileId}`,
              'rollback-probe@example.com',
              'rollback-probe@example.com',
            );
            return null;
          },
        },
      ),
    ).rejects.toMatchObject({
      code: getOidcProvisioningPublicErrorCode(scenario.expectations.users),
    });

    expect(resolverCalls).toBe(scenario.expectations.users?.resolverCalls);
    await expect(countRows(fixture.rootDb, 'profiles')).resolves.toBe(0);
    await expect(countRows(fixture.rootDb, 'oidc_identities')).resolves.toBe(0);
    await expect(countRows(fixture.rootDb, 'users')).resolves.toBe(0);
    await expect(countRows(fixture.rootDb, 'sessions')).resolves.toBe(0);
  });

  it('reinitializes dropped backfill state on the same root before provisioning', async () => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);
    await fixture.rootDb.query('DROP TABLE _smrt_backfills');

    await expect(backfillProfileEmailKeys(fixture.rootDb)).resolves.toEqual({
      updated: 0,
    });
    await expect(backfillUserEmailKeys(fixture.rootDb)).resolves.toEqual({
      updated: 0,
    });

    const users = await UserCollection.create({ db: fixture.rootDb });
    const result = await users.getOrCreateFromOidc(
      {
        email: 'postgres-reinitialized@example.com',
        email_verified: true,
        iss: 'https://issuer.example.com',
        sub: 'postgres-reinitialized-subject',
      },
      'dex',
    );

    expect(result.created).toBe(true);
    await expect(countRows(fixture.rootDb, 'users')).resolves.toBe(1);
  });

  it.each([
    getOidcProvisioningDecisionScenario('concurrent-winner-and-observer'),
  ])('$id — $title (Profiles)', async (scenario) => {
    const fixture = await createFixture();
    await seedPersonType(fixture.rootDb);

    const firstDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-profile-first-${Date.now()}`,
    });
    const secondDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-profile-second-${Date.now()}`,
    });
    await Promise.all([
      setSearchPath(firstDb, fixture.schemaName),
      setSearchPath(secondDb, fixture.schemaName),
    ]);
    connections.push(firstDb, secondDb);
    const synchronizeLookup = createBarrier(2);
    const claims = {
      email: 'postgres-profile-concurrent@example.com',
      email_verified: true,
      iss: 'https://issuer.example.com',
      name: 'Concurrent Postgres Profile',
      sub: 'postgres-profile-concurrent-subject',
    };

    const [first, second] = await Promise.all([
      createProfileFromOidc(claims, 'dex', {
        db: withIdentityLookupBarrier(firstDb, synchronizeLookup),
      }),
      createProfileFromOidc(claims, 'dex', {
        db: withIdentityLookupBarrier(secondDb, synchronizeLookup),
      }),
    ]);

    expect(second.profile.id).toBe(first.profile.id);
    expect(second.oidcIdentity.id).toBe(first.oidcIdentity.id);
    await expect(first.profile.getOidcIdentities()).resolves.toHaveLength(1);
    await expect(first.oidcIdentity.recordUsage()).resolves.toBeUndefined();
    await expect(countRows(firstDb, 'profiles')).resolves.toBe(1);
    await expect(countRows(firstDb, 'oidc_identities')).resolves.toBe(1);
    await expect(
      countRows(firstDb, 'oidc_profile_email_reservations'),
    ).resolves.toBe(1);
    expect(scenario.expectations.profiles?.createdRows.profile).toBe(1);
  });

  it('creates one stable Person type during unseeded independent logins', async () => {
    const fixture = await createFixture();

    const firstDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-unseeded-first-${Date.now()}`,
    });
    const secondDb = await getDatabase({
      ...fixture.config,
      dbid: `oidc-unseeded-second-${Date.now()}`,
    });
    await Promise.all([
      setSearchPath(firstDb, fixture.schemaName),
      setSearchPath(secondDb, fixture.schemaName),
    ]);
    connections.push(firstDb, secondDb);
    const firstUsers = await UserCollection.create({ db: firstDb });
    const secondUsers = await UserCollection.create({ db: secondDb });
    const synchronizeLookup = createBarrier(2);

    const [first, second] = await Promise.all([
      firstUsers.getOrCreateFromOidc(
        {
          email: 'unseeded-first@example.com',
          email_verified: true,
          iss: 'https://issuer.example.com',
          sub: 'unseeded-first-subject',
        },
        'dex',
        { resolveProfile: synchronizeLookup },
      ),
      secondUsers.getOrCreateFromOidc(
        {
          email: 'unseeded-second@example.com',
          email_verified: true,
          iss: 'https://issuer.example.com',
          sub: 'unseeded-second-subject',
        },
        'dex',
        { resolveProfile: synchronizeLookup },
      ),
    ]);

    expect(second.profile.typeId).toBe(first.profile.typeId);
    await expect(countRows(firstDb, 'profiles')).resolves.toBe(2);
    await expect(countRows(firstDb, 'users')).resolves.toBe(2);
    await expect(countRows(firstDb, 'oidc_identities')).resolves.toBe(2);
    await expect(
      countRows(firstDb, 'oidc_profile_email_reservations'),
    ).resolves.toBe(2);
    const personTypes = await firstDb.query(
      "SELECT id FROM profile_types WHERE slug = 'person'",
    );
    expect(personTypes.rows).toHaveLength(1);
    expect(personTypes.rows[0]?.id).toBe(first.profile.typeId);
  });

  async function createFixture(): Promise<{
    config: {
      __smrtSkipVitestSchemaPreparation: true;
      type: 'postgres';
      url: string;
    };
    rootDb: DatabaseInterface;
    schemaName: string;
  }> {
    const baseConfig = getTestDbConfig();
    if (baseConfig.type !== 'postgres') {
      throw new Error('Expected a Postgres test database.');
    }
    schemaName = `oidc_${randomUUID().replaceAll('-', '')}`;
    adminDb = await getDatabase({
      ...baseConfig,
      dbid: `oidc-admin-${schemaName}`,
    });
    await adminDb.query(`CREATE SCHEMA "${schemaName}"`);
    const url = new URL(baseConfig.url);
    url.searchParams.set('options', `-csearch_path=${schemaName}`);
    const config = {
      __smrtSkipVitestSchemaPreparation: true as const,
      type: 'postgres' as const,
      url: url.toString(),
    };
    const rootDb = await getDatabase({
      ...config,
      dbid: `oidc-root-${schemaName}`,
    });
    connections.push(rootDb);
    await setSearchPath(rootDb, schemaName);
    await executeSchema(rootDb, OIDC_USERS_TEST_SCHEMA);
    await prepareOidcEmailKeyBackfills(rootDb);
    return { config, rootDb, schemaName };
  }
});

async function setSearchPath(
  db: DatabaseInterface,
  schemaName: string,
): Promise<void> {
  await db.query(`SET search_path TO "${schemaName}"`);
}

async function executeSchema(
  db: DatabaseInterface,
  schema: string,
): Promise<void> {
  for (const statement of schema.split(';').map((part) => part.trim())) {
    if (statement) await db.query(statement);
  }
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

async function seedPersonType(db: DatabaseInterface): Promise<void> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO profile_types
      (id, slug, context, _meta_type, name, description)
     VALUES (?, 'person', '', '@happyvertical/smrt-profiles:ProfileType', 'Person', 'Individual person profile')
     ON CONFLICT (slug, context, _meta_type) DO NOTHING`,
    id,
  );
}

async function seedAuthorizedOwner(
  db: DatabaseInterface,
  email: string,
): Promise<{ profileId: string; userId: string }> {
  const profileId = randomUUID();
  const userId = randomUUID();
  await db.query(
    `INSERT INTO profiles
      (id, slug, context, _meta_type, tenant_id, email, email_key, name)
     VALUES (?, ?, '', '@happyvertical/smrt-profiles:Person', NULL, ?, ?, 'Approved Person')`,
    profileId,
    `profile-${profileId}`,
    email,
    email.trim().toLowerCase(),
  );
  await db.query(
    `INSERT INTO users
      (id, slug, context, profile_id, email, email_key, status)
     VALUES (?, ?, '', ?, ?, ?, 'active')`,
    userId,
    `user-${userId}`,
    profileId,
    email,
    email.trim().toLowerCase(),
  );
  return { profileId, userId };
}

async function seedExistingIdentity(
  db: DatabaseInterface,
  options: { email: string; subject: string },
): Promise<string> {
  const profileId = randomUUID();
  const identityId = randomUUID();
  await db.query(
    `INSERT INTO profiles
      (id, slug, context, _meta_type, tenant_id, email, email_key, name)
     VALUES (?, ?, '', '@happyvertical/smrt-profiles:Person', NULL, ?, ?, 'Existing Person')`,
    profileId,
    `profile-${profileId}`,
    options.email,
    options.email.trim().toLowerCase(),
  );
  await db.query(
    `INSERT INTO oidc_identities
      (id, slug, context, profile_id, provider, issuer, subject, identity_key, email)
     VALUES (?, ?, '', ?, 'dex', 'https://issuer.example.com', ?, ?, ?)`,
    identityId,
    `identity-${identityId}`,
    profileId,
    options.subject,
    JSON.stringify(['https://issuer.example.com', options.subject]),
    options.email,
  );
  const reservationId = randomUUID();
  await db.query(
    `INSERT INTO oidc_profile_email_reservations
      (id, slug, context, profile_id, email_key)
     VALUES (?, ?, '', ?, ?)`,
    reservationId,
    `reservation-${reservationId}`,
    profileId,
    options.email,
  );
  return profileId;
}

function createBarrier(parties: number): () => Promise<undefined> {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    if (arrivals >= parties) return undefined;
    arrivals += 1;
    if (arrivals === parties) release();
    await ready;
    return undefined;
  };
}

function withIdentityLookupBarrier(
  db: DatabaseInterface,
  synchronize: () => Promise<void>,
): DatabaseInterface {
  return withQueryBarrier(
    db,
    synchronize,
    /from\s+["`]?oidc_identities["`]?/iu,
  );
}

function withFirstIdentityArbiterConflict(
  db: DatabaseInterface,
  onConflict: () => void,
): DatabaseInterface {
  const transaction = db.transaction;
  if (!transaction) {
    throw new Error('Expected a transaction-capable database.');
  }
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
                        onConflict();
                        throw new Error(
                          'duplicate key violates unique constraint "oidc_identities_identity_key_idx"',
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

function proxyDatabaseHandle(
  db: DatabaseInterface,
  observeQuery?: (sql: string) => void,
): DatabaseInterface {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'query') {
        return async (sql: string, ...params: unknown[]) => {
          observeQuery?.(sql);
          return target.query(sql, ...params);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function withUserUpsertBarrier(
  db: DatabaseInterface,
  synchronize: () => Promise<void>,
): DatabaseInterface {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'upsert') {
        return async (...args: Parameters<DatabaseInterface['upsert']>) => {
          if (args[0] === 'users') await synchronize();
          return target.upsert(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function withReservationDeleteBarrier(
  db: DatabaseInterface,
  synchronize: () => Promise<void>,
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
                  if (txProperty === 'delete') {
                    return async (
                      ...args: Parameters<DatabaseInterface['delete']>
                    ) => {
                      const result = await txTarget.delete(...args);
                      if (args[0] === 'oidc_profile_email_reservations') {
                        await synchronize();
                      }
                      return result;
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

function withQueryBarrier(
  db: DatabaseInterface,
  synchronize: () => Promise<void>,
  queryPattern: RegExp,
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
          return target.transaction(async (tx) => {
            const synchronizedTx = new Proxy(tx, {
              get(txTarget, txProperty, txReceiver) {
                if (txProperty === 'query') {
                  return async (sql: string, ...params: unknown[]) => {
                    const result = await txTarget.query(sql, ...params);
                    if (queryPattern.test(sql)) {
                      await synchronize();
                    }
                    return result;
                  };
                }
                const value = Reflect.get(txTarget, txProperty, txReceiver);
                return typeof value === 'function'
                  ? value.bind(txTarget)
                  : value;
              },
            });
            return callback(synchronizedTx);
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function closeDatabase(db: DatabaseInterface | undefined): Promise<void> {
  if (!db) return;
  const close = (db as DatabaseInterface & { close?: () => Promise<void> })
    .close;
  if (close) await close.call(db);
}
