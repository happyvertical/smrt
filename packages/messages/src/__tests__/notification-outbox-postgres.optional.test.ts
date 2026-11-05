/**
 * PostgreSQL lane for the notification outbox: the manifest migration creates
 * `notification_deliveries` with native uuid columns and the source-keyed
 * identity, and the lease compare-and-set runs as a conditional UPDATE (not
 * the embedded read/upsert fallback). Skips without DATABASE_URL.
 */
import '../index';

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  type DatabaseInterface,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmailAccount } from '../models/EmailAccount.js';
import {
  NotificationOutboxService,
  type NotificationTransport,
} from '../services/NotificationOutboxService.js';
import { withScratchDatabase } from './helpers/postgres-scratch';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

function dbMigrate(db: DatabaseInterface) {
  return migrateSmrtSchemas({
    db,
    packageName: 'notification-outbox-test',
    name: `notification_outbox_${crypto.randomUUID().replace(/-/g, '')}`,
    postgresSafe: false,
  });
}

describePostgres(
  'NotificationOutboxService on PostgreSQL',
  { timeout: 120_000 },
  () => {
    const scratch = withScratchDatabase(beforeEach, afterEach);

    it('migrates the outbox and leases each delivery to one dispatcher', async () => {
      const db = scratch.track(
        await getTestDatabase({
          type: 'postgres',
          url: scratch.url(),
          classes: [],
          includeSystemTables: false,
        }),
      );
      await dbMigrate(db);

      const columns = await db.query(
        `SELECT column_name, data_type
             FROM information_schema.columns
            WHERE table_name = 'notification_deliveries'
              AND column_name IN ('tenant_id', 'recipient_user_id', 'message_id',
                                  'state_version', 'lease_expires_at')
            ORDER BY column_name`,
      );
      expect(
        Object.fromEntries(
          (
            columns.rows as Array<{ column_name: string; data_type: string }>
          ).map((row) => [row.column_name, row.data_type]),
        ),
      ).toEqual({
        lease_expires_at: expect.stringMatching(/^timestamp/),
        message_id: 'uuid',
        recipient_user_id: 'uuid',
        state_version: expect.stringMatching(/^(integer|bigint)$/),
        tenant_id: 'uuid',
      });
      const unique = await db.query(
        `SELECT indexdef FROM pg_indexes
            WHERE tablename = 'notification_deliveries'
              AND indexdef LIKE 'CREATE UNIQUE%'`,
      );
      expect(
        (unique.rows as Array<{ indexdef: string }>).some((row) =>
          /\(tenant_id, recipient_user_id, channel, source_ref\)/.test(
            row.indexdef,
          ),
        ),
      ).toBe(true);

      const tenantId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const senderId = await withTenant({ tenantId }, async () => {
        const account = new EmailAccount({
          db,
          tenantId,
          name: 'Notifications',
          providerType: 'smtp',
          isActive: true,
        });
        await account.initialize();
        await account.save();
        return account.id as string;
      });

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sent: string[] = [];
      const transport: NotificationTransport = {
        name: 'fake',
        async send({ delivery }) {
          sent.push(delivery.id as string);
          await gate;
          return { status: 'accepted' };
        },
      };
      const outbox = () =>
        new NotificationOutboxService({
          db,
          linkBaseUrl: 'https://work.example.com',
          resolveRecipient: ({ recipientUserId }) =>
            recipientUserId === userId ? { address: 'a@example.com' } : null,
          resolveSenderAccountId: () => senderId,
          transport,
        });

      const input = {
        tenantId,
        recipientUserId: userId,
        sourceRef: 'project-question:1:asked',
        kind: 'project-question.asked',
        subject: 'A question is waiting',
        text: 'Please answer.',
        path: '/portal/questions#1',
      };
      const enqueued = await Promise.all([
        outbox().enqueueEmail(input),
        outbox().enqueueEmail(input),
      ]);
      expect(enqueued.filter((result) => result.created)).toHaveLength(1);

      const racing = Promise.all([
        outbox().dispatchDue({ tenantIds: [tenantId] }),
        outbox().dispatchDue({ tenantIds: [tenantId] }),
        outbox().dispatchDue(),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      const reports = await racing;
      expect(reports.reduce((sum, report) => sum + report.leased, 0)).toBe(1);
      expect(sent).toHaveLength(1);
      expect(reports.flatMap((report) => report.outcomes)).toEqual([
        {
          deliveryId: enqueued[0]?.delivery.id,
          tenantId,
          outcome: 'sent',
        },
      ]);
    });
  },
);
