import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { resetVerifiedTables } from '../table-cache';
import { getTestDatabase } from '../testing/database';

@smrt({ tableName: 'issue_1034_schema_records' })
class Issue1034SchemaRecord extends SmrtObject {
  name: string = '';
  parentId: string = '';
}

class Issue1034SchemaRecords extends SmrtCollection<Issue1034SchemaRecord> {
  static readonly _itemClass = Issue1034SchemaRecord;
}

describe('Issue #1034: fail-fast schema verification', () => {
  let db: DatabaseInterface;
  let tempSqlitePath: string | undefined;

  beforeEach(async () => {
    resetVerifiedTables();
    db = await getTestDatabase({ classes: [] });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
    if (tempSqlitePath) {
      rmSync(tempSqlitePath, { force: true });
      rmSync(`${tempSqlitePath}-wal`, { force: true });
      rmSync(`${tempSqlitePath}-shm`, { force: true });
      tempSqlitePath = undefined;
    }
  });

  it('should fail collection queries with a migration hint when schema is missing', async () => {
    const collection = await Issue1034SchemaRecords.create({ db });

    await expect(collection.list()).rejects.toMatchObject({
      code: 'DB_SCHEMA_MISSING',
    });
    await expect(collection.count()).rejects.toMatchObject({
      code: 'DB_SCHEMA_MISSING',
    });
    await expect(
      collection.query(`SELECT * FROM ${collection.tableName}`),
    ).rejects.toThrow("Run 'smrt db:migrate'");
  });

  it('should fail object delete and load helpers with the same schema error', async () => {
    const byId = new Issue1034SchemaRecord({
      db,
      id: randomUUID(),
      _skipLoad: true,
    });
    await byId.initialize();

    await expect(byId.loadFromId()).rejects.toMatchObject({
      code: 'DB_SCHEMA_MISSING',
    });
    await expect(byId.delete()).rejects.toThrow("Run 'smrt db:migrate'");

    const bySlug = new Issue1034SchemaRecord({
      db,
      slug: 'missing-record',
      _skipLoad: true,
    });
    await bySlug.initialize();

    await expect(bySlug.loadFromSlug()).rejects.toMatchObject({
      code: 'DB_SCHEMA_MISSING',
    });
    await expect(bySlug.getSavedId()).rejects.toMatchObject({
      code: 'DB_SCHEMA_MISSING',
    });
  });

  it('should also fail when collections are created from raw db config options', async () => {
    tempSqlitePath = join(
      tmpdir(),
      `smrt-issue-1034-${randomUUID().slice(0, 8)}.db`,
    );

    const collection = await ObjectRegistry.getCollection(
      'Issue1034SchemaRecord',
      {
        db: {
          type: 'sqlite',
          url: tempSqlitePath,
          __smrtSkipVitestSchemaPreparation: true,
        } as any,
      },
    );

    await expect(collection.count()).rejects.toThrow("Run 'smrt db:migrate'");
  });
});
