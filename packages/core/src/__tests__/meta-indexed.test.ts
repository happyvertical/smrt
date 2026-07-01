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
import { field, meta, SmrtObject, smrt } from '../index.js';
import { ObjectRegistry } from '../registry';
import { SQLiteStrategy } from '../schema/ddl/sqlite-strategy.js';
import { SchemaGenerator } from '../schema/generator.js';
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

// Regular (CTI) class with a column-indexed field — verifies that `indexed`
// on @field() emits a plain column index, not just a JSON-path index.
@smrt()
class IdxCustomer extends SmrtObject {
  name: string = '';

  @field({ indexed: true })
  externalRef: string = '';

  @field()
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

  it('emits a plain column index for regular fields tagged @field({ indexed: true })', async () => {
    await ObjectRegistry.getCollection<typeof IdxCustomer.prototype>(
      'IdxCustomer',
      { db },
    );

    const indexList = await db.query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
      ['idx_customers'],
    );

    const externalRefIdx = indexList.rows.find((row: any) =>
      row.name?.includes('external_ref'),
    );
    expect(externalRefIdx).toBeDefined();
    // The index targets the column itself, not a JSON expression
    expect(externalRefIdx?.sql).toMatch(/"external_ref"/);
    expect(externalRefIdx?.sql).not.toMatch(/json_extract/);

    // Unindexed fields should not produce an index
    const notesIdx = indexList.rows.find(
      (row: any) => row.name?.includes('notes') && !row.name?.includes('id'),
    );
    expect(notesIdx).toBeUndefined();
  });

  it('generateCTISchemaFromManifest emits plain column indexes for indexed fields', () => {
    // The build-time manifest path (used by db:migrate / the schema differ) must
    // honor `@field({ indexed: true })` the same way the runtime path and the STI
    // manifest path do — otherwise the declared index is silently dropped.
    const generator = new SchemaGenerator();
    const schema = generator.generateCTISchemaFromManifest(
      'IdxCustomer',
      'idx_customers',
      {
        name: { type: 'text' },
        externalRef: { type: 'text', _meta: { indexed: true } },
        notes: { type: 'text' },
      } as any,
    );

    // `schema.indexes` is the source of truth the schema differ / db:migrate
    // compares against (the manifest `ddl` string carries only CREATE TABLE).
    const refIdx = schema.indexes.find(
      (i) => i.name === 'idx_customers_external_ref_idx',
    );
    expect(refIdx).toBeDefined();
    expect(refIdx?.columns).toEqual(['external_ref']);
    expect(refIdx?.unique).toBeFalsy();

    // Unindexed columns get no index.
    expect(
      schema.indexes.find((i) => i.columns?.includes('notes')),
    ).toBeUndefined();
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
