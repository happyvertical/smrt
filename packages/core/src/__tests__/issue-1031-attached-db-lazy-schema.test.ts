/**
 * Issue #1031: Attached databases require upfront schema creation
 *
 * Verifies that collections attached to a fresh database work correctly
 * when tables are created upfront (via syncSchema or migrations).
 *
 * Previously, tables were lazily created on first read. This was removed
 * to align SQLite with Postgres behavior — tables must exist before queries.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { syncSchema } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({ tableName: 'issue_1031_attached_records' })
class Issue1031AttachedRecord extends SmrtObject {
  name: string = '';
}

class Issue1031AttachedRecords extends SmrtCollection<Issue1031AttachedRecord> {
  static readonly _itemClass = Issue1031AttachedRecord;
}

describe('Issue #1031: attached DB upfront schema creation', () => {
  let db: DatabaseInterface;
  const tableName = ObjectRegistry.getTableName('Issue1031AttachedRecord');

  beforeEach(async () => {
    db = await getTestDatabase({ classes: [] });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('should work after explicit schema creation via syncSchema', async () => {
    // Create table upfront using DDL from the registry
    const schema = ObjectRegistry.getSchema('Issue1031AttachedRecord');
    expect(schema).toBeDefined();
    expect(schema?.ddl).toBeDefined();
    await syncSchema({ db, schema: schema?.ddl as string });

    const records = await Issue1031AttachedRecords.create({ db });

    expect(await db.tableExists(tableName)).toBe(true);
    await expect(records.list()).resolves.toEqual([]);
    await expect(records.count()).resolves.toBe(0);
  });

  it('should fail with clear error if table not created upfront', async () => {
    const records = await Issue1031AttachedRecords.create({ db });

    expect(await db.tableExists(tableName)).toBe(false);
    // Without upfront creation, queries fail with a clear error
    await expect(records.count()).rejects.toThrow();
  });

  it('should support list and count after upfront schema creation', async () => {
    const schema = ObjectRegistry.getSchema('Issue1031AttachedRecord');
    expect(schema).toBeDefined();
    await syncSchema({ db, schema: schema?.ddl as string });

    const records = await Issue1031AttachedRecords.create({ db });

    // Table exists and is queryable
    expect(await db.tableExists(tableName)).toBe(true);
    await expect(records.list()).resolves.toEqual([]);
    await expect(records.count()).resolves.toBe(0);
  });
});
