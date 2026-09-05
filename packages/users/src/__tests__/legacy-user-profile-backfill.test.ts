import { randomUUID } from 'node:crypto';
import { backfillProfileEmailKeys } from '@happyvertical/smrt-profiles';
import {
  type DatabaseInterface,
  getDatabase,
  syncSchema,
} from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backfillLegacyUserProfiles,
  LegacyUserProfileBackfillError,
} from '../migrations/backfillLegacyUserProfiles.js';
import { backfillUserEmailKeys } from '../migrations/backfillUserEmailKeys.js';
import { OIDC_USERS_TEST_SCHEMA } from './helpers/oidc-test-server.js';

describe('backfillLegacyUserProfiles', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await syncSchema({ db, schema: OIDC_USERS_TEST_SCHEMA });
    await backfillProfileEmailKeys(db);
    await backfillUserEmailKeys(db);
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('creates and links canonical Persons without changing User data or identity authority', async () => {
    const firstId = await seedUser(db, ' Legacy.One@Example.com ');
    const secondId = await seedUser(db, 'legacy.two@example.com');
    const before = await readUser(db, firstId);

    await expect(
      backfillLegacyUserProfiles(transactionOnly(db)),
    ).resolves.toEqual({
      created: 2,
      linked: 2,
    });

    const after = await readUser(db, firstId);
    expect(after.id).toBe(before.id);
    expect(after.slug).toBe(before.slug);
    expect(after.email).toBe(before.email);
    expect(after.status).toBe(before.status);
    expect(after.last_login_at).toBe(before.last_login_at);
    expect(after.profile_id).toEqual(expect.any(String));
    await expect(
      readCanonicalProfile(db, String(after.profile_id)),
    ).resolves.toMatchObject({
      email: ' Legacy.One@Example.com ',
      email_key: 'legacy.one@example.com',
      tenant_id: null,
      type_slug: 'person',
    });
    await expect(countRows(db, 'profiles')).resolves.toBe(2);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(2);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
    await expect(readUser(db, secondId)).resolves.toMatchObject({
      profile_id: expect.any(String),
    });
    await expect(readMarker(db)).resolves.toBe(true);
  });

  it('rechecks current rows after its marker and processes later imports', async () => {
    await seedUser(db, 'first@example.com');
    await expect(backfillLegacyUserProfiles(db)).resolves.toEqual({
      created: 1,
      linked: 1,
    });
    await expect(backfillLegacyUserProfiles(db)).resolves.toEqual({
      created: 0,
      linked: 0,
    });

    await seedUser(db, 'later@example.com');
    await expect(backfillLegacyUserProfiles(db)).resolves.toEqual({
      created: 1,
      linked: 1,
    });
    await expect(countRows(db, 'profiles')).resolves.toBe(2);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
  });

  it('repairs a whitespace-only legacy Profile link', async () => {
    const userId = await seedUser(db, 'whitespace-link@example.com');
    await db.query("UPDATE users SET profile_id = '   ' WHERE id = ?", userId);

    await expect(backfillLegacyUserProfiles(db)).resolves.toEqual({
      created: 1,
      linked: 1,
    });
    await expect(readUser(db, userId)).resolves.toMatchObject({
      profile_id: expect.any(String),
    });
    await expect(countRows(db, 'profiles')).resolves.toBe(1);
  });

  it('requires both readiness markers and validates current Profile and User keys', async () => {
    await db.query(
      `DELETE FROM _smrt_backfills
       WHERE name = '@happyvertical/smrt-profiles:profile-email-keys:v1'`,
    );
    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'profile_email_backfill_required',
    });
    await backfillProfileEmailKeys(db);
    await db.query(
      `DELETE FROM _smrt_backfills
       WHERE name = '@happyvertical/smrt-users:user-email-keys:v1'`,
    );
    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'user_email_backfill_required',
    });
    await backfillUserEmailKeys(db);
    const userId = await seedUser(db, 'stale@example.com');
    const profileId = await seedProfile(db, 'unrelated@example.com');
    await db.query(
      'UPDATE profiles SET email_key = NULL WHERE id = ?',
      profileId,
    );
    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'profile_email_backfill_required',
    });
    await db.query('DELETE FROM profiles');
    await db.query('UPDATE users SET email_key = NULL WHERE id = ?', userId);
    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'stale_user_email_key',
    });
    await expect(countRows(db, 'profiles')).resolves.toBe(0);
  });

  it('rejects blank and duplicate User emails before mutation', async () => {
    await seedUser(db, '', null);
    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'missing_email',
    });
    await db.query('DELETE FROM users');
    await db.query('DROP INDEX users_email_key_idx');
    await seedUser(db, 'duplicate@example.com');
    await seedUser(db, ' Duplicate@Example.com ');
    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'duplicate_user_email',
    });
    await expect(countRows(db, 'profiles')).resolves.toBe(0);
  });

  it.each([
    ['global Person', null, '@happyvertical/smrt-profiles:Person'],
    ['tenant Person', randomUUID(), '@happyvertical/smrt-profiles:Person'],
    ['global Organization', null, '@happyvertical/smrt-profiles:Organization'],
  ])('rejects a same-email %s for explicit reconciliation', async (_label, tenantId, metaType) => {
    await seedUser(db, 'profile-conflict@example.com');
    await seedProfile(db, 'profile-conflict@example.com', {
      metaType,
      tenantId,
    });

    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'profile_conflict',
    });
    await expect(readOnlyUserProfileId(db)).resolves.toBeNull();
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
  });

  it('rejects owned, duplicate, and reserved same-email Profile state', async () => {
    const candidateId = await seedUser(db, 'owned@example.com');
    const profileId = await seedProfile(db, 'owned@example.com');
    await seedUser(db, 'owner@example.com', 'owner@example.com', profileId);
    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'profile_conflict',
    });
    await expect(readUser(db, candidateId)).resolves.toMatchObject({
      profile_id: null,
    });

    await db.query('DELETE FROM users');
    await db.query('DELETE FROM profiles');
    await seedUser(db, 'duplicate-profile@example.com');
    await seedProfile(db, 'duplicate-profile@example.com');
    await seedProfile(db, ' Duplicate-Profile@Example.com ');
    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'profile_conflict',
    });

    await db.query('DELETE FROM profiles');
    await db.query('DELETE FROM users');
    await seedUser(db, 'reserved@example.com');
    const reservationProfileId = await seedProfile(db, '');
    await seedReservation(db, 'reserved@example.com', reservationProfileId);
    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'reservation_conflict',
    });
    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(readOnlyUserProfileId(db)).resolves.toBeNull();
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
  });

  it('rejects an existing deterministic Profile slug before mutation', async () => {
    const userId = await seedUser(db, 'slug-conflict@example.com');
    await seedProfile(db, '', { slug: `legacy-user-${userId}` });

    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'profile_conflict',
    });
    await expect(readUser(db, userId)).resolves.toMatchObject({
      profile_id: null,
    });
    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(0);
  });

  it('rejects ambiguous global Person ProfileTypes before mutation', async () => {
    const userId = await seedUser(db, 'type-conflict@example.com');
    await seedProfileType(db, 'person');
    await seedProfileType(db, 'person');

    await expect(backfillLegacyUserProfiles(db)).rejects.toMatchObject({
      code: 'profile_type_conflict',
    });
    await expect(readUser(db, userId)).resolves.toMatchObject({
      profile_id: null,
    });
    await expect(countRows(db, 'profiles')).resolves.toBe(0);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(0);
  });

  it('rolls back every mutation on failure and succeeds on a clean retry', async () => {
    const userId = await seedUser(db, 'rollback@example.com');
    const failingDb = transactionOnly(db, (sql) =>
      sql.trimStart().startsWith('UPDATE users'),
    );

    await expect(backfillLegacyUserProfiles(failingDb)).rejects.toThrow(
      'forced transaction failure',
    );
    await expect(readUser(db, userId)).resolves.toMatchObject({
      profile_id: null,
    });
    await expect(countRows(db, 'profile_types')).resolves.toBe(0);
    await expect(countRows(db, 'profiles')).resolves.toBe(0);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(0);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
    await expect(readMarker(db)).resolves.toBe(false);

    await expect(backfillLegacyUserProfiles(db)).resolves.toEqual({
      created: 1,
      linked: 1,
    });
    await expect(countRows(db, 'profiles')).resolves.toBe(1);
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
  });

  it('requires a root transaction-capable database', async () => {
    const transactionless = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction') return undefined;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseInterface;
    const error = await backfillLegacyUserProfiles(transactionless).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(LegacyUserProfileBackfillError);
    expect(error).toMatchObject({ code: 'transaction_required' });
  });
});

function transactionOnly(
  db: DatabaseInterface,
  fail?: (sql: string) => boolean,
): DatabaseInterface {
  const transaction = db.transaction;
  if (!transaction) throw new Error('Test database requires transaction().');
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'query') {
        return () => {
          throw new Error('Backfill escaped its transaction executor.');
        };
      }
      if (property !== 'transaction') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async <T>(callback: (tx: DatabaseInterface) => Promise<T>) =>
        transaction.call(target, async (tx) => {
          if (!fail) return callback(tx);
          const failingTx = new Proxy(tx, {
            get(txTarget, txProperty, txReceiver) {
              if (txProperty !== 'query') {
                const value = Reflect.get(txTarget, txProperty, txReceiver);
                return typeof value === 'function'
                  ? value.bind(txTarget)
                  : value;
              }
              return async (sql: string, ...params: unknown[]) => {
                if (fail(sql)) throw new Error('forced transaction failure');
                return txTarget.query(sql, ...params);
              };
            },
          });
          return callback(failingTx);
        });
    },
  }) as DatabaseInterface;
}

async function seedUser(
  db: DatabaseInterface,
  email: string,
  emailKey: string | null = email.trim() ? email.trim().toLowerCase() : null,
  profileId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users
      (id, slug, context, profile_id, email, email_key, status, last_login_at)
     VALUES (?, ?, '', ?, ?, ?, 'active', '2024-01-02 03:04:05')`,
    id,
    `legacy-${id}`,
    profileId,
    email,
    emailKey,
  );
  return id;
}

async function seedProfile(
  db: DatabaseInterface,
  email: string,
  options: {
    metaType?: string;
    slug?: string;
    tenantId?: string | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO profiles
      (id, slug, context, _meta_type, tenant_id, email, email_key, name)
     VALUES (?, ?, '', ?, ?, ?, ?, 'Existing')`,
    id,
    options.slug ?? `profile-${id}`,
    options.metaType ?? '@happyvertical/smrt-profiles:Person',
    options.tenantId ?? null,
    email,
    email.trim() ? email.trim().toLowerCase() : null,
  );
  return id;
}

async function seedReservation(
  db: DatabaseInterface,
  emailKey: string,
  profileId: string,
): Promise<void> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO oidc_profile_email_reservations
      (id, slug, context, profile_id, email_key)
     VALUES (?, ?, '', ?, ?)`,
    id,
    `reservation-${id}`,
    profileId,
    emailKey,
  );
}

async function seedProfileType(
  db: DatabaseInterface,
  slug: string,
): Promise<void> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO profile_types
      (id, slug, context, _meta_type, tenant_id, name)
     VALUES (?, ?, '', '@happyvertical/smrt-profiles:ProfileType', NULL, 'Person')`,
    id,
    slug,
  );
}

async function readUser(db: DatabaseInterface, id: string) {
  const result = await db.query('SELECT * FROM users WHERE id = ?', id);
  return result.rows[0];
}

async function readOnlyUserProfileId(
  db: DatabaseInterface,
): Promise<string | null> {
  const result = await db.query('SELECT profile_id FROM users LIMIT 1');
  const value = result.rows[0]?.profile_id;
  return value == null || value === '' ? null : String(value);
}

async function readCanonicalProfile(db: DatabaseInterface, profileId: string) {
  const result = await db.query(
    `SELECT profiles.email, profiles.email_key, profiles.tenant_id,
            profile_types.slug AS type_slug
     FROM profiles
     JOIN profile_types ON profile_types.id = profiles.type_id
     WHERE profiles.id = ?`,
    profileId,
  );
  return result.rows[0];
}

async function countRows(
  db: DatabaseInterface,
  table: string,
): Promise<number> {
  const result = await db.query(`SELECT count(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function readMarker(db: DatabaseInterface): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM _smrt_backfills
     WHERE name = '@happyvertical/smrt-users:legacy-user-profiles:v1'`,
  );
  return result.rows.length === 1;
}
