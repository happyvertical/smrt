import { randomUUID } from 'node:crypto';
import { ensureChangeFeedTable } from '@happyvertical/smrt-core';
import { backfillProfileEmailKeys } from '@happyvertical/smrt-profiles';
import {
  getTestDbConfig,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { backfillLegacyUserProfiles } from '../migrations/backfillLegacyUserProfiles.js';
import { backfillUserEmailKeys } from '../migrations/backfillUserEmailKeys.js';
import { OIDC_USERS_TEST_SCHEMA } from './helpers/oidc-test-server.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('PostgreSQL legacy User/Profile backfill', () => {
  const fixtures: Array<{
    adminDb: DatabaseInterface;
    databaseName: string;
    rootDb: DatabaseInterface;
  }> = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await closeDatabase(fixture.rootDb);
      await fixture.adminDb.query(
        `DROP DATABASE "${fixture.databaseName}" WITH (FORCE)`,
      );
      await closeDatabase(fixture.adminDb);
    }
  });

  it('creates one canonical Person, preserves the User, and remains idempotent', async () => {
    const db = await createFixture();
    const userId = await seedUser(db, 'postgres-legacy@example.com');
    const before = await readUser(db, userId);

    await expect(
      backfillLegacyUserProfiles(transactionOnly(db)),
    ).resolves.toEqual({
      created: 1,
      linked: 1,
    });
    await expect(backfillLegacyUserProfiles(db)).resolves.toEqual({
      created: 0,
      linked: 0,
    });

    const after = await readUser(db, userId);
    expect(after.id).toBe(before.id);
    expect(after.slug).toBe(before.slug);
    expect(after.email).toBe(before.email);
    expect(after.status).toBe(before.status);
    expect(after.profile_id).toEqual(expect.any(String));
    const profile = await db.query(
      `SELECT profiles.tenant_id, profiles.email_key,
              profile_types.slug AS type_slug
       FROM profiles
       JOIN profile_types ON profile_types.id = profiles.type_id
       WHERE profiles.id = ?`,
      after.profile_id,
    );
    expect(profile.rows[0]).toMatchObject({
      email_key: 'postgres-legacy@example.com',
      tenant_id: null,
      type_slug: 'person',
    });
    await expect(
      countRows(db, 'oidc_profile_email_reservations'),
    ).resolves.toBe(1);
    await expect(countRows(db, 'oidc_identities')).resolves.toBe(0);
  });

  it('rolls back ProfileType, Profile, reservation, link, and marker before retry', async () => {
    const db = await createFixture();
    const userId = await seedUser(db, 'postgres-rollback@example.com');

    await expect(
      backfillLegacyUserProfiles(
        transactionOnly(db, (sql) =>
          sql.trimStart().startsWith('UPDATE users'),
        ),
      ),
    ).rejects.toThrow('forced transaction failure');
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

  async function createFixture(): Promise<DatabaseInterface> {
    const baseConfig = getTestDbConfig();
    if (baseConfig.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database.');
    }
    const databaseName = `smrt_legacy_profile_${randomUUID().replaceAll('-', '')}`;
    const adminDb = await getDatabase({
      ...baseConfig,
      __smrtSkipVitestSchemaPreparation: true,
      dbid: `legacy-profile-admin-${databaseName}`,
    });
    await adminDb.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(baseConfig.url);
    url.pathname = `/${databaseName}`;
    const db = await getDatabase({
      __smrtSkipVitestSchemaPreparation: true,
      type: 'postgres',
      url: url.toString(),
      dbid: `legacy-profile-root-${databaseName}`,
    });
    fixtures.push({ adminDb, databaseName, rootDb: db });
    await executeSchema(
      db,
      OIDC_USERS_TEST_SCHEMA.replace(
        '"applied_at" TIMESTAMP',
        '"applied_at" TIMESTAMPTZ',
      ),
    );
    await ensureChangeFeedTable(db);
    await backfillProfileEmailKeys(db);
    await backfillUserEmailKeys(db);
    return db;
  }
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

async function executeSchema(
  db: DatabaseInterface,
  schema: string,
): Promise<void> {
  for (const statement of schema.split(';').map((part) => part.trim())) {
    if (statement) await db.query(statement);
  }
}

async function seedUser(db: DatabaseInterface, email: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users
      (id, slug, context, profile_id, email, email_key, status)
     VALUES (?, ?, '', NULL, ?, ?, 'active')`,
    id,
    `legacy-${id}`,
    email,
    email.trim().toLowerCase(),
  );
  return id;
}

async function readUser(db: DatabaseInterface, id: string) {
  const result = await db.query(
    `SELECT CAST(id AS VARCHAR) AS id, slug,
            CAST(profile_id AS VARCHAR) AS profile_id,
            email, status
     FROM users WHERE id = ?`,
    id,
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

async function closeDatabase(db: DatabaseInterface | undefined): Promise<void> {
  await db?.close?.();
}
