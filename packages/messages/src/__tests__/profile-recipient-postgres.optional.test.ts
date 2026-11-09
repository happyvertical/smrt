/** Root-owned PostgreSQL execution; no server is started by this suite. */
import '../index.js';
import { migrateSmrtSchemas } from '@happyvertical/smrt-core/migrations';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertNotificationProfileRecipientSchema,
  migrateNotificationProfileRecipients,
  planNotificationProfileRecipients,
} from '../migrations/profileRecipients.js';
import { withScratchDatabase } from './helpers/postgres-scratch.js';
import { defineProfileRecipientSuite } from './helpers/profile-recipient-suite.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
describePostgres(
  'typed profile contracts on migrated PostgreSQL',
  { timeout: 120_000 },
  () => {
    const scratch = withScratchDatabase(beforeEach, afterEach);
    defineProfileRecipientSuite(async () => {
      const db = scratch.track(
        await getTestDatabase({
          type: 'postgres',
          url: scratch.url(),
          classes: [],
          includeSystemTables: false,
        }),
      );
      await migrateSmrtSchemas({
        db,
        packageName: 'profile-recipient-test',
        name: `profile_${crypto.randomUUID().replaceAll('-', '')}`,
        postgresSafe: false,
      });
      const { getDatabase } =
        await vi.importActual<typeof import('@happyvertical/sql')>(
          '@happyvertical/sql',
        );
      const raceDb = scratch.track(
        await getDatabase({
          type: 'postgres',
          url: scratch.url(),
          cache: false,
        }),
      );
      return { db, raceDb };
    }, 'postgres');
  },
);
describePostgres(
  'legacy profile recipient PostgreSQL maintenance',
  { timeout: 120_000 },
  () => {
    const scratch = withScratchDatabase(beforeEach, afterEach);
    let db: DatabaseInterface;
    const user = crypto.randomUUID(),
      tenant = crypto.randomUUID(),
      id = crypto.randomUUID();
    beforeEach(async () => {
      const { getDatabase } =
        await vi.importActual<typeof import('@happyvertical/sql')>(
          '@happyvertical/sql',
        );
      db = scratch.track(
        await getDatabase({
          type: 'postgres',
          url: scratch.url(),
          cache: false,
        }),
      );
      await db.query('CREATE TABLE users(id UUID PRIMARY KEY)');
      await db.query('CREATE TABLE profiles(id UUID PRIMARY KEY)');
      await db.insert('users', { id: user });
      await db.query(
        'CREATE TABLE notification_deliveries(id UUID PRIMARY KEY, tenant_id UUID NOT NULL, recipient_user_id UUID NOT NULL REFERENCES users(id), channel TEXT NOT NULL, source_ref TEXT NOT NULL, kind TEXT NOT NULL, required_dispatch_policy TEXT, recipient_address TEXT NOT NULL, status TEXT, attempts INTEGER, message_id UUID, provider_message_id TEXT)',
      );
      await db.query(
        'CREATE UNIQUE INDEX legacy_user_nnd ON notification_deliveries(tenant_id,recipient_user_id,channel,source_ref) NULLS NOT DISTINCT',
      );
      await db.query(
        'CREATE INDEX keep_status_history ON notification_deliveries(status, attempts)',
      );
      await db.insert('notification_deliveries', {
        id,
        tenant_id: tenant,
        recipient_user_id: user,
        channel: 'email',
        source_ref: 'invoice:one',
        kind: 'ordinary',
        required_dispatch_policy: '',
        recipient_address: 'old@example.test',
        status: 'uncertain',
        attempts: 2,
        message_id: crypto.randomUUID(),
        provider_message_id: 'provider-history',
      });
    });
    async function snapshot() {
      return {
        rows: (
          await db.query('SELECT * FROM notification_deliveries ORDER BY id')
        ).rows,
        columns: (
          await db.query(
            "SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='notification_deliveries' ORDER BY ordinal_position",
          )
        ).rows,
        indexes: (
          await db.query(
            "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename='notification_deliveries' ORDER BY indexname",
          )
        ).rows,
        constraints: (
          await db.query(
            "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='notification_deliveries'::regclass ORDER BY conname",
          )
        ).rows,
      };
    }
    it('plans read-only, removes only obsolete NND, preserves legacy history/FK, enables distinct profiles, replays', async () => {
      const before = await snapshot();
      const plan = await planNotificationProfileRecipients(db, 'postgres');
      expect(plan.obsoleteIndexes).toEqual(['legacy_user_nnd']);
      expect(await snapshot()).toEqual(before);
      await migrateNotificationProfileRecipients(db, 'postgres');
      await assertNotificationProfileRecipientSchema(db);
      const after = await snapshot();
      expect(after.rows).toEqual([
        {
          ...before.rows[0],
          recipient_kind: 'user',
          recipient_profile_id: null,
        },
      ]);
      expect(
        after.indexes.some((i) => i.indexname === 'keep_status_history'),
      ).toBe(true);
      expect(after.indexes.some((i) => i.indexname === 'legacy_user_nnd')).toBe(
        false,
      );
      expect(
        after.constraints.some((c) =>
          String(c.definition).includes('FOREIGN KEY (recipient_user_id)'),
        ),
      ).toBe(true);
      expect(
        (await migrateNotificationProfileRecipients(db, 'postgres')).statements,
      ).toEqual([]);
      const first = crypto.randomUUID(),
        second = crypto.randomUUID();
      await db.insert('profiles', [{ id: first }, { id: second }]);
      const contact = {
        ...before.rows[0],
        recipient_kind: 'profile',
        recipient_user_id: null,
        kind: 'protected:profile:fixture',
        required_dispatch_policy: 'profile:fixture',
      };
      await db.insert('notification_deliveries', {
        ...contact,
        id: crypto.randomUUID(),
        recipient_profile_id: first,
      });
      await db.insert('notification_deliveries', {
        ...contact,
        id: crypto.randomUUID(),
        recipient_profile_id: second,
      });
      await expect(
        db.insert('notification_deliveries', {
          ...contact,
          id: crypto.randomUUID(),
          recipient_profile_id: first,
        }),
      ).rejects.toThrow();
      await expect(
        db.update(
          'notification_deliveries',
          { id },
          { recipient_user_id: null },
        ),
      ).rejects.toThrow();
    });
    it('rolls back an injected DDL failure and restores exact rows/columns/indexes/FKs, then applies', async () => {
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
                            throw new Error('injected profile DDL failure');
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
        migrateNotificationProfileRecipients(wrapped, 'postgres'),
      ).rejects.toThrow('injected');
      expect(await snapshot()).toEqual(before);
      await migrateNotificationProfileRecipients(db, 'postgres');
      await assertNotificationProfileRecipientSchema(db);
    });
    it('refuses duplicate old identities and named schema drift without guessed repairs', async () => {
      await db.query('DROP INDEX legacy_user_nnd');
      const row = (await snapshot()).rows[0];
      await db.insert('notification_deliveries', {
        ...row,
        id: crypto.randomUUID(),
      });
      const before = await snapshot();
      expect(
        (await planNotificationProfileRecipients(db, 'postgres')).invalidRowIds,
      ).toHaveLength(1);
      await expect(
        migrateNotificationProfileRecipients(db, 'postgres'),
      ).rejects.toThrow('Invalid');
      expect(await snapshot()).toEqual(before);
    });
  },
);
