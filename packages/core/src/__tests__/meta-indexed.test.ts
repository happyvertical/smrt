/**
 * `@meta({ indexed: true })` JSON-path indexing (R9).
 *
 * Meta fields live inside the shared `_meta_data` JSONB column, so a regular
 * column index is impossible. This test verifies that opting into `indexed`
 * emits a JSON-path index that the database actually creates.
 *
 * For SQLite that's `json_extract("_meta_data", '$.fieldName')`; for Postgres
 * it would be `("_meta_data"->>'fieldName')` (handled by the base DDL strategy,
 * tested by inspecting the schema definition shape rather than running
 * against Postgres in CI).
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meta, SmrtObject, smrt } from '../index.js';
import { ObjectRegistry } from '../registry';
import { SQLiteStrategy } from '../schema/ddl/sqlite-strategy.js';
import { getTestDatabase } from '../testing/database';

// STI base
@smrt({ tableStrategy: 'sti' })
class IdxBaseEvent extends SmrtObject {
  title: string = '';
}

// STI child with two meta fields, one indexed, one not
@smrt()
class IdxMeeting extends IdxBaseEvent {
  @meta({ indexed: true })
  roomNumber: string = '';

  @meta()
  notes: string = '';
}

describe('@meta({ indexed: true }) (R9)', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-meta-idx-${randomUUID().slice(0, 8)}.db`);
    db = await getTestDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('emits a jsonPath IndexDefinition for indexed meta fields', async () => {
    // Force schema realization
    await ObjectRegistry.getCollection<typeof IdxMeeting.prototype>(
      'IdxMeeting',
      { db },
    );

    const schema = ObjectRegistry.getSchema('IdxBaseEvent');
    expect(schema).toBeDefined();
    const metaIdx = schema?.indexes.find(
      (i) => i.jsonPath?.path === 'roomNumber',
    );
    expect(metaIdx).toBeDefined();
    expect(metaIdx?.jsonPath?.column).toBe('_meta_data');

    // Unindexed meta fields should NOT produce an IndexDefinition
    const unindexed = schema?.indexes.find((i) => i.jsonPath?.path === 'notes');
    expect(unindexed).toBeUndefined();
  });

  it('SQLite DDL renders the JSON-path index using json_extract', () => {
    const schema = ObjectRegistry.getSchema('IdxBaseEvent');
    expect(schema).toBeDefined();

    const sqlite = new SQLiteStrategy();
    const statements = sqlite.generateIndexes(schema!);

    const jsonIdxStmt = statements.find((s) =>
      s.includes('json_extract("_meta_data", \'$.roomNumber\')'),
    );
    expect(jsonIdxStmt).toBeDefined();
    expect(jsonIdxStmt).toMatch(/CREATE INDEX/);
  });

  it('actually creates the index in the live SQLite database', async () => {
    await ObjectRegistry.getCollection<typeof IdxMeeting.prototype>(
      'IdxMeeting',
      { db },
    );

    const indexList = await db.query(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
      ['idx_base_events'],
    );

    const metaIndex = indexList.rows.find((row: any) =>
      row.name?.includes('meta_room_number'),
    );

    expect(metaIndex).toBeDefined();
    expect(metaIndex?.sql).toMatch(/json_extract/);
    expect(metaIndex?.sql).toMatch(/roomNumber/);
  });
});
