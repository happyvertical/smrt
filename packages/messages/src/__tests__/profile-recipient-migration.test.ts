import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertNotificationProfileRecipientSchema,
  migrateNotificationProfileRecipients,
  planNotificationProfileRecipients,
} from '../migrations/profileRecipients.js';

describe('profile recipient legacy SQLite maintenance', () => {
  let db: DatabaseInterface;
  const row = {
    id: 'legacy-row',
    tenant_id: 'tenant',
    recipient_user_id: 'user',
    channel: 'email',
    source_ref: 'invoice:one',
    kind: 'ordinary',
    required_dispatch_policy: '',
    recipient_address: 'old@example.test',
    status: 'uncertain',
    attempts: 2,
    message_id: 'saved-message',
    provider_message_id: 'provider-evidence',
  };
  beforeEach(async () => {
    const { getDatabase } =
      await vi.importActual<typeof import('@happyvertical/sql')>(
        '@happyvertical/sql',
      );
    db = await getDatabase({ type: 'sqlite', url: ':memory:', cache: false });
    await db.query('CREATE TABLE users(id TEXT PRIMARY KEY)');
    await db.query('CREATE TABLE profiles(id TEXT PRIMARY KEY)');
    await db.insert('users', { id: 'user' });
    await db.query(
      'CREATE TABLE notification_deliveries(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, recipient_user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL, source_ref TEXT NOT NULL, kind TEXT NOT NULL, required_dispatch_policy TEXT, recipient_address TEXT NOT NULL, status TEXT, attempts INTEGER, message_id TEXT, provider_message_id TEXT)',
    );
    await db.query(
      'CREATE UNIQUE INDEX legacy_user_identity ON notification_deliveries(tenant_id,recipient_user_id,channel,source_ref)',
    );
    await db.insert('notification_deliveries', row);
  });
  afterEach(async () => {
    await db.close?.();
  });
  async function snapshot() {
    return {
      ddl: (
        await db.query(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='notification_deliveries'",
        )
      ).rows[0].sql,
      rows: (await db.query('SELECT * FROM notification_deliveries')).rows,
      indexes: (
        await db.query(
          "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='notification_deliveries' ORDER BY name",
        )
      ).rows,
    };
  }
  it('dry-run is read-only; apply preserves every legacy identity/FK/outcome and replays', async () => {
    const before = await snapshot();
    const plan = await planNotificationProfileRecipients(db, 'sqlite');
    expect(plan.statements.length).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
    await migrateNotificationProfileRecipients(db, 'sqlite');
    await assertNotificationProfileRecipientSchema(db);
    const after = await snapshot();
    expect(after.rows).toEqual([
      { ...row, recipient_kind: 'user', recipient_profile_id: null },
    ]);
    expect(after.ddl).toContain('REFERENCES users(id)');
    expect(after.ddl).toContain('recipient_identity_check');
    expect(
      (await migrateNotificationProfileRecipients(db, 'sqlite')).statements,
    ).toEqual([]);
    await expect(
      db.insert('notification_deliveries', { ...row, id: 'duplicate' }),
    ).rejects.toThrow();
    await expect(
      db.update(
        'notification_deliveries',
        { id: row.id },
        { recipient_user_id: null },
      ),
    ).rejects.toThrow();
    expect((await db.query('PRAGMA foreign_keys')).rows[0].foreign_keys).toBe(
      1,
    );
  });
  it('rolls back a midway DDL failure to the exact old schema, indexes and history, then retries', async () => {
    const before = await snapshot();
    const wrapped = new Proxy(db, {
      get(target, key) {
        if (key === 'transaction')
          return async (work: (tx: DatabaseInterface) => Promise<unknown>) =>
            target.transaction!(async (tx) =>
              work(
                new Proxy(tx, {
                  get(inner, property) {
                    if (property === 'query')
                      return async (sql: string, ...values: unknown[]) => {
                        if (
                          sql.startsWith(
                            'CREATE UNIQUE INDEX "notification_deliveries_profile_identity"',
                          )
                        )
                          throw new Error('injected migration failure');
                        return inner.query(sql, ...values);
                      };
                    return Reflect.get(inner, property);
                  },
                }),
              ),
            );
        return Reflect.get(target, key);
      },
    });
    await expect(
      migrateNotificationProfileRecipients(wrapped, 'sqlite'),
    ).rejects.toThrow('injected');
    expect(await snapshot()).toEqual(before);
    expect((await db.query('PRAGMA foreign_keys')).rows[0].foreign_keys).toBe(
      1,
    );
    await migrateNotificationProfileRecipients(db, 'sqlite');
    await assertNotificationProfileRecipientSchema(db);
  });
  it('refuses duplicate old logical identities without changing or repairing rows', async () => {
    await db.query('DROP INDEX legacy_user_identity');
    await db.insert('notification_deliveries', { ...row, id: 'duplicate' });
    const before = await snapshot();
    const plan = await planNotificationProfileRecipients(db, 'sqlite');
    expect(plan.invalidRowIds).toContain('duplicate');
    await expect(
      migrateNotificationProfileRecipients(db, 'sqlite'),
    ).rejects.toThrow('Invalid');
    expect(await snapshot()).toEqual(before);
  });
  it('fails closed on unexpected named index or CHECK drift', async () => {
    await migrateNotificationProfileRecipients(db, 'sqlite');
    await db.query('DROP INDEX notification_deliveries_profile_identity');
    await db.query(
      'CREATE INDEX notification_deliveries_profile_identity ON notification_deliveries(recipient_profile_id)',
    );
    await expect(
      planNotificationProfileRecipients(db, 'sqlite'),
    ).rejects.toThrow('Unexpected notification index drift');
    await expect(assertNotificationProfileRecipientSchema(db)).rejects.toThrow(
      'maintenance',
    );
  });
});
