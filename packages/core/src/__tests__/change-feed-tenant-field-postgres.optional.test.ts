/**
 * PostgreSQL coverage for the owner a change-feed tombstone is recorded
 * under: the stored row's owner, read before the delete.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` points at a DISPOSABLE database.
 * The suite reads exact feed contents, so it runs in a schema of its own
 * (`options=-c search_path` applies to every pooled connection).
 *
 * @example
 * ```bash
 * SMRT_TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/smrt_test \
 *   npx vitest run src/__tests__/change-feed-tenant-field-postgres.optional.test.ts
 * ```
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getChangesSince, registerChangeFeedWriter } from '../change-feed';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({ tenantScoped: { field: 'organizationId' } })
class TenantFieldPgItem extends SmrtObject {
  name: string = '';
  organizationId: string = '';
}
class TenantFieldPgItemCollection extends SmrtCollection<TenantFieldPgItem> {
  static readonly _itemClass = TenantFieldPgItem;
}

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const SCHEMA = 'change_feed_tenant_field_test';
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('change-feed delete owner on PostgreSQL (optional)', () => {
  let admin: DatabaseInterface;
  let db: DatabaseInterface;

  beforeAll(async () => {
    admin = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-tenant-field-admin-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    const separator = (pgUrl as string).includes('?') ? '&' : '?';
    db = (await getDatabase({
      type: 'postgres',
      url: `${pgUrl}${separator}options=-c%20search_path%3D${SCHEMA}`,
      dbid: `smrt-test-tenant-field-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await getTestDatabase({ db, classes: ['TenantFieldPgItem'] });
    registerChangeFeedWriter();
  });

  afterAll(async () => {
    await db?.close?.();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.close?.();
  });

  it('records a delete under the stored owner when the instance field was cleared without saving', async () => {
    const items = await TenantFieldPgItemCollection.create({ db });
    const owner = randomUUID();
    const item = await items.create({ name: 'owned', organizationId: owner });
    item.organizationId = '';
    await item.delete();

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === item.id && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe(owner);
    const otherTenant = await getChangesSince(db, {
      since: 0,
      tenantId: randomUUID(),
    });
    expect(otherTenant.changes.some((c) => c.rowId === item.id)).toBe(false);
  });
});
