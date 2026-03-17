/**
 * Issue #1031: Attached fresh databases should lazily create collection tables
 *
 * Reproduces the core invariant behind the cross-package chat/content failures:
 * a collection attached to an existing fresh database should be able to
 * bootstrap its backing table on the first read operation.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
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

describe('Issue #1031: attached DB lazy schema bootstrap', () => {
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

  it('should lazily create the table on first list() against an attached fresh DB', async () => {
    const records = await Issue1031AttachedRecords.create({ db });

    expect(await db.tableExists(tableName)).toBe(false);
    await expect(records.list()).resolves.toEqual([]);
    expect(await db.tableExists(tableName)).toBe(true);
  });

  it('should lazily create the table on first get() against an attached fresh DB', async () => {
    const records = await Issue1031AttachedRecords.create({ db });

    expect(await db.tableExists(tableName)).toBe(false);
    await expect(records.get({ name: 'missing' })).resolves.toBeNull();
    expect(await db.tableExists(tableName)).toBe(true);
  });

  it('should lazily create the table on first count() against an attached fresh DB', async () => {
    const records = await Issue1031AttachedRecords.create({ db });

    expect(await db.tableExists(tableName)).toBe(false);
    await expect(records.count()).resolves.toBe(0);
    expect(await db.tableExists(tableName)).toBe(true);
  });
});
