/**
 * PostgreSQL lane for UserNotification: the manifest migration creates the
 * table with native uuid recipient/tenant columns and the dedupe identity,
 * and the service round-trips on it. Skips without DATABASE_URL.
 */
import '../index';

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  type DatabaseInterface,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserNotificationService } from '../services/UserNotificationService.js';
import { withScratchDatabase } from './helpers/postgres-scratch';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

function dbMigrate(db: DatabaseInterface) {
  return migrateSmrtSchemas({
    db,
    packageName: 'user-notifications-test',
    name: `user_notifications_${crypto.randomUUID().replace(/-/g, '')}`,
    postgresSafe: false,
  });
}

describePostgres('UserNotification on PostgreSQL', { timeout: 120_000 }, () => {
  const scratch = withScratchDatabase(beforeEach, afterEach);

  it('migrates native uuid columns and dedupes through the service', async () => {
    // An empty connection brought to shape by the migration alone, as
    // `smrt db:migrate` does for a consumer.
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
          WHERE table_name = 'user_notifications'
            AND column_name IN ('tenant_id', 'recipient_user_id', 'read_at', 'source_ref')
          ORDER BY column_name`,
    );
    expect(
      Object.fromEntries(
        (columns.rows as Array<{ column_name: string; data_type: string }>).map(
          (row) => [row.column_name, row.data_type],
        ),
      ),
    ).toEqual({
      read_at: expect.stringMatching(/^timestamp/),
      recipient_user_id: 'uuid',
      source_ref: 'text',
      tenant_id: 'uuid',
    });

    const unique = await db.query(
      `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'user_notifications' AND indexdef LIKE 'CREATE UNIQUE%'`,
    );
    expect(
      (unique.rows as Array<{ indexdef: string }>).some((row) =>
        /\(tenant_id, recipient_user_id, source_ref\)/.test(row.indexdef),
      ),
    ).toBe(true);

    const service = new UserNotificationService({ db });
    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const input = {
      tenantId,
      recipientUserId: userId,
      kind: 'social-post.failed',
      title: "A post didn't go out",
      sourceRef: 'social-post:1:failed',
    };
    const first = await service.notify(input);
    const second = await service.notify(input);
    expect(second.created).toBe(false);
    expect(second.notification.id).toBe(first.notification.id);
    expect(await service.countUnread(userId, { tenantIds: [tenantId] })).toBe(
      1,
    );
    expect(
      await service.markRead(userId, [first.notification.id as string], {
        tenantId,
      }),
    ).toBe(1);
    expect(await service.countUnread(userId, { tenantIds: [tenantId] })).toBe(
      0,
    );

    // A malformed id from a request never reaches the native uuid column
    // (which would raise 22P02 and surface as a 500): it matches nothing.
    await expect(
      service.markRead(userId, ['not-a-uuid', "1' OR '1'='1"], { tenantId }),
    ).resolves.toBe(0);
    await expect(
      service.dismiss(userId, ['nope', first.notification.id as string], {
        tenantId,
      }),
    ).resolves.toBe(1);
  });
});
