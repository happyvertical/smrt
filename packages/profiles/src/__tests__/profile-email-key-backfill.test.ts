import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillProfileEmailKeys } from '../migrations/backfillProfileEmailKeys.js';

describe('backfillProfileEmailKeys', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      `CREATE TABLE profiles (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT,
        email_key TEXT
      )`,
    );
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('uses application Unicode and whitespace normalization idempotently', async () => {
    const profileId = randomUUID();
    const blankProfileId = randomUUID();
    await db.query(
      `INSERT INTO profiles (id, email, email_key)
       VALUES (?, ?, NULL), (?, ?, NULL)`,
      profileId,
      '\tÜser@Example.com\t',
      blankProfileId,
      '\t',
    );

    await expect(backfillProfileEmailKeys(db)).resolves.toEqual({ updated: 1 });
    const result = await db.query(
      'SELECT id, email_key FROM profiles ORDER BY id',
    );
    const keys = new Map(
      result.rows.map((row) => [String(row.id), row.email_key]),
    );
    expect(keys.get(profileId)).toBe('üser@example.com');
    expect(keys.get(blankProfileId)).toBeNull();
    await expect(readBackfillMarker(db)).resolves.toBe(true);
    await expect(backfillProfileEmailKeys(db)).resolves.toEqual({ updated: 0 });
  });

  it('rolls back every key and the readiness marker when an update fails', async () => {
    const firstId = await seedLegacyProfile(db, 'first@example.com');
    const secondId = await seedLegacyProfile(db, 'second@example.com');
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
                  if (sql.startsWith('UPDATE profiles')) {
                    updates += 1;
                    if (updates === 2) {
                      throw new Error('forced profile backfill update failure');
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

    await expect(backfillProfileEmailKeys(failingDb)).rejects.toThrow(
      'forced profile backfill update failure',
    );
    await expect(readEmailKey(db, firstId)).resolves.toBeNull();
    await expect(readEmailKey(db, secondId)).resolves.toBeNull();
    await expect(readBackfillMarker(db)).resolves.toBe(false);
  });
});

async function seedLegacyProfile(
  db: DatabaseInterface,
  email: string,
): Promise<string> {
  const id = randomUUID();
  await db.query(
    'INSERT INTO profiles (id, email, email_key) VALUES (?, ?, NULL)',
    id,
    email,
  );
  return id;
}

async function readEmailKey(
  db: DatabaseInterface,
  profileId: string,
): Promise<string | null> {
  const result = await db.query(
    'SELECT email_key FROM profiles WHERE id = ?',
    profileId,
  );
  const value = result.rows[0]?.email_key;
  return value == null ? null : String(value);
}

async function readBackfillMarker(db: DatabaseInterface): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM _smrt_backfills
     WHERE name = '@happyvertical/smrt-profiles:profile-email-keys:v1'`,
  );
  return result.rows.length === 1;
}
