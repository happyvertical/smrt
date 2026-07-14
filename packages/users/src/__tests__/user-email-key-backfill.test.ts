import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getDatabase, syncSchema } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backfillUserEmailKeys,
  UserEmailKeyBackfillError,
} from '../migrations/backfillUserEmailKeys.js';
import { OIDC_USERS_TEST_SCHEMA } from './helpers/oidc-test-server.js';

describe('backfillUserEmailKeys', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await syncSchema({ db, schema: OIDC_USERS_TEST_SCHEMA });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('normalizes a migrated legacy User and is idempotent', async () => {
    const userId = await seedLegacyUser(db, '\tÜser@Example.com\t');
    const blankUserId = await seedLegacyUser(db, '\t');

    await expect(backfillUserEmailKeys(db)).resolves.toEqual({ updated: 1 });
    await expect(readEmailKey(db, userId)).resolves.toBe('üser@example.com');
    await expect(readEmailKey(db, blankUserId)).resolves.toBeNull();
    await expect(readBackfillMarker(db)).resolves.toBe(true);
    await expect(backfillUserEmailKeys(db)).resolves.toEqual({ updated: 0 });
  });

  it('fails before changing rows when legacy emails normalize to a duplicate', async () => {
    const firstId = await seedLegacyUser(db, '\tÜser@Example.com\t');
    const secondId = await seedLegacyUser(db, 'üser@example.com');

    const error = await backfillUserEmailKeys(db).catch((caught) => caught);

    expect(error).toBeInstanceOf(UserEmailKeyBackfillError);
    expect(error).toMatchObject({
      code: 'duplicate_email',
      duplicates: [{ emailKey: 'üser@example.com', userCount: 2 }],
    });
    await expect(readEmailKey(db, firstId)).resolves.toBeNull();
    await expect(readEmailKey(db, secondId)).resolves.toBeNull();
    await expect(readBackfillMarker(db)).resolves.toBe(false);
  });

  it('repairs swapped stale keys without a transient uniqueness failure', async () => {
    const firstId = await seedLegacyUser(db, 'first@example.com');
    const secondId = await seedLegacyUser(db, 'second@example.com');
    await db.query(
      'UPDATE users SET email_key = ? WHERE id = ?',
      'second@example.com',
      firstId,
    );
    await db.query(
      'UPDATE users SET email_key = ? WHERE id = ?',
      'first@example.com',
      secondId,
    );

    await expect(backfillUserEmailKeys(db)).resolves.toEqual({ updated: 2 });
    await expect(readEmailKey(db, firstId)).resolves.toBe('first@example.com');
    await expect(readEmailKey(db, secondId)).resolves.toBe(
      'second@example.com',
    );
  });

  it('rolls back every key and the readiness marker when an update fails', async () => {
    const firstId = await seedLegacyUser(db, 'first@example.com');
    const secondId = await seedLegacyUser(db, 'second@example.com');
    const transaction = db.transaction;
    if (!transaction)
      throw new Error('SQLite test database requires transaction().');
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'transaction') {
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async <T>(
          callback: (tx: DatabaseInterface) => Promise<T>,
        ): Promise<T> =>
          transaction.call(target, async (tx) => {
            let updates = 0;
            const failingTx = new Proxy(tx, {
              get(txTarget, txProperty, txReceiver) {
                if (txProperty !== 'query') {
                  const value = Reflect.get(txTarget, txProperty, txReceiver);
                  return typeof value === 'function'
                    ? value.bind(txTarget)
                    : value;
                }
                return async (sql: string, ...params: unknown[]) => {
                  if (sql.startsWith('UPDATE users')) {
                    updates += 1;
                    if (updates === 2) {
                      throw new Error('forced backfill update failure');
                    }
                  }
                  return txTarget.query(sql, ...params);
                };
              },
            });
            return callback(failingTx);
          });
      },
    }) as DatabaseInterface;

    await expect(backfillUserEmailKeys(failingDb)).rejects.toThrow(
      'forced backfill update failure',
    );
    await expect(readEmailKey(db, firstId)).resolves.toBeNull();
    await expect(readEmailKey(db, secondId)).resolves.toBeNull();
    await expect(readBackfillMarker(db)).resolves.toBe(false);
  });
});

async function seedLegacyUser(
  db: DatabaseInterface,
  email: string,
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users
      (id, slug, context, profile_id, email, email_key, status)
     VALUES (?, ?, '', ?, ?, NULL, 'active')`,
    id,
    `legacy-${id}`,
    randomUUID(),
    email,
  );
  return id;
}

async function readEmailKey(
  db: DatabaseInterface,
  userId: string,
): Promise<string | null> {
  const result = await db.query(
    'SELECT email_key FROM users WHERE id = ?',
    userId,
  );
  const value = result.rows[0]?.email_key;
  return value == null ? null : String(value);
}

async function readBackfillMarker(db: DatabaseInterface): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM _smrt_backfills
     WHERE name = '@happyvertical/smrt-users:user-email-keys:v1'`,
  );
  return result.rows.length === 1;
}
