/**
 * PostgreSQL coverage for the owner a change-feed tombstone is recorded
 * under: the owner the delete statement returned for the row it removed.
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

/** The owner a `beforeDelete` hook moves the stored row to. */
let pgMovedOwner = '';

@smrt({
  tenantScoped: { field: 'organizationId' },
  hooks: { beforeDelete: 'moveStoredOwner' },
})
class TenantFieldPgMoved extends SmrtObject {
  name: string = '';
  organizationId: string = '';

  async moveStoredOwner(): Promise<void> {
    await this.db.query(
      'UPDATE tenant_field_pg_moveds SET organization_id = $1 WHERE id = $2',
      pgMovedOwner,
      this.id,
    );
  }
}
class TenantFieldPgMovedCollection extends SmrtCollection<TenantFieldPgMoved> {
  static readonly _itemClass = TenantFieldPgMoved;
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
    await getTestDatabase({
      db,
      classes: ['TenantFieldPgItem', 'TenantFieldPgMoved'],
    });
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

  it('records a revision claim under the stored owner, not a cleared field', async () => {
    const items = await TenantFieldPgItemCollection.create({ db });
    const owner = randomUUID();
    const created = await items.create({
      name: 'claimed',
      organizationId: owner,
    });
    const loaded = await items.get(String(created.id));
    if (!loaded?.updated_at) throw new Error('expected a persisted row');
    const before = (await getChangesSince(db, { since: 0 })).cursor;
    loaded.organizationId = '';
    await loaded.claimRevision(loaded.updated_at);

    const { changes } = await getChangesSince(db, { since: before });
    const claim = changes.find((change) => change.rowId === created.id);
    expect(claim?.operation).toBe('update');
    expect(claim?.tenantId).toBe(owner);
  });

  it('records a delete under the owner of the row the delete removed', async () => {
    const rows = await TenantFieldPgMovedCollection.create({ db });
    const row = await rows.create({
      name: 'moved',
      organizationId: randomUUID(),
    });
    pgMovedOwner = randomUUID();
    try {
      await row.delete();
      const { changes } = await getChangesSince(db, { since: 0 });
      const tombstone = changes.find(
        (change) => change.rowId === row.id && change.operation === 'delete',
      );
      expect(tombstone?.tenantId).toBe(pgMovedOwner);
    } finally {
      pgMovedOwner = '';
    }
  });

  it('records a delete in a caller-managed transaction and leaves it usable', async () => {
    const items = await TenantFieldPgItemCollection.create({ db });
    const owner = randomUUID();
    const item = await items.create({ name: 'in-tx', organizationId: owner });
    const transaction = db.transaction;
    if (typeof transaction !== 'function')
      throw new Error('expected transactions');
    await transaction.call(db, async (tx: DatabaseInterface) => {
      const scoped = await TenantFieldPgItemCollection.create({ db: tx });
      const loaded = await scoped.get(String(item.id));
      if (!loaded) throw new Error('expected the row');
      loaded.organizationId = '';
      await loaded.delete();
      // The transaction still accepts statements after the delete.
      await tx.query('SELECT 1');
    });

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === item.id && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe(owner);
  });

  it('records a delete addressed by a non-canonical UUID spelling under the stored owner', async () => {
    const items = await TenantFieldPgItemCollection.create({ db });
    const owner = randomUUID();
    const item = await items.create({ name: 'spelled', organizationId: owner });
    const spelling = String(item.id).replace(/-/g, '').toUpperCase();
    item.id = spelling;
    item.organizationId = '';
    await item.delete();

    const { changes } = await getChangesSince(db, { since: 0 });
    const tombstone = changes.find(
      (change) => change.rowId === spelling && change.operation === 'delete',
    );
    expect(tombstone?.tenantId).toBe(owner);
  });

  it('records no tombstone when a trigger keeps the row the delete targeted', async () => {
    const items = await TenantFieldPgItemCollection.create({ db });
    const item = await items.create({
      name: 'kept',
      organizationId: randomUUID(),
    });
    await db.query(
      'CREATE FUNCTION tenant_field_pg_keep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$',
    );
    await db.query(
      'CREATE TRIGGER tenant_field_pg_keep BEFORE DELETE ON tenant_field_pg_items FOR EACH ROW EXECUTE FUNCTION tenant_field_pg_keep()',
    );
    item.organizationId = '';
    try {
      await item.delete();
    } finally {
      await db.query(
        'DROP TRIGGER tenant_field_pg_keep ON tenant_field_pg_items',
      );
      await db.query('DROP FUNCTION tenant_field_pg_keep()');
    }

    const stored = await db.query(
      'SELECT id FROM tenant_field_pg_items WHERE id = $1',
      item.id,
    );
    expect(stored.rows).toHaveLength(1);
    const { changes } = await getChangesSince(db, { since: 0 });
    expect(
      changes.some(
        (change) => change.rowId === item.id && change.operation === 'delete',
      ),
    ).toBe(false);
  });
});
