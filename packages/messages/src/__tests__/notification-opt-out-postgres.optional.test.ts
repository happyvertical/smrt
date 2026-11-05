/**
 * PostgreSQL lane for NotificationOptOut: the manifest migration creates the
 * table with native uuid columns and the conflict identity, and the service
 * round-trips on it. Skips without DATABASE_URL.
 */
import '../index';

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  type DatabaseInterface,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationOptOutService } from '../services/NotificationOptOutService.js';
import { withScratchDatabase } from './helpers/postgres-scratch';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

function dbMigrate(db: DatabaseInterface) {
  return migrateSmrtSchemas({
    db,
    packageName: 'notification-opt-out-test',
    name: `notification_opt_outs_${crypto.randomUUID().replace(/-/g, '')}`,
    postgresSafe: false,
  });
}

describePostgres(
  'NotificationOptOut on PostgreSQL',
  { timeout: 120_000 },
  () => {
    const scratch = withScratchDatabase(beforeEach, afterEach);

    it('migrates native uuid columns and the identity, and round-trips', async () => {
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
          WHERE table_name = 'notification_opt_outs'
            AND column_name IN ('tenant_id', 'recipient_user_id', 'scope', 'opted_out_at')
          ORDER BY column_name`,
      );
      expect(
        Object.fromEntries(
          (
            columns.rows as Array<{ column_name: string; data_type: string }>
          ).map((row) => [row.column_name, row.data_type]),
        ),
      ).toEqual({
        opted_out_at: expect.stringMatching(/^timestamp/),
        recipient_user_id: 'uuid',
        scope: 'text',
        tenant_id: 'uuid',
      });

      const unique = await db.query(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'notification_opt_outs' AND indexdef LIKE 'CREATE UNIQUE%'`,
      );
      expect(
        (unique.rows as Array<{ indexdef: string }>).some((row) =>
          /\(tenant_id, recipient_user_id, channel, scope\)/.test(row.indexdef),
        ),
      ).toBe(true);

      const service = new NotificationOptOutService({ db });
      const key = {
        tenantId: crypto.randomUUID(),
        recipientUserId: crypto.randomUUID(),
        channel: 'email' as const,
        scope: `project:${crypto.randomUUID()}`,
      };
      const first = await service.optOut(key);
      const second = await service.optOut(key);
      expect(second.id).toBe(first.id);
      expect(await service.isOptedOut(key)).toBe(true);
      expect(
        await service.isOptedOut({ ...key, tenantId: crypto.randomUUID() }),
      ).toBe(false);
      await service.optIn(key);
      expect(await service.isOptedOut(key)).toBe(false);
    });
  },
);
