/**
 * R11 — native uuid id columns: type-system + differ-tolerance tests.
 *
 * Commit 1 of R11 makes SMRT *know* and *tolerate* the abstract `UUID`
 * SQLDataType without yet emitting it from the generator:
 *  - per-dialect mapping (Postgres `uuid`, DuckDB `UUID`, SQLite `TEXT`)
 *  - the differ tolerates `uuid` and `text` for structural id/reference columns
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { SchemaComparer } from '../differ.js';

describe('R11 UUID type mapping (per-dialect)', () => {
  it('maps UUID to native `uuid` on PostgreSQL', () => {
    expect(getDDLStrategy('postgres').mapType('UUID')).toBe('uuid');
  });

  it('maps UUID to native `UUID` on DuckDB', () => {
    expect(getDDLStrategy('duckdb').mapType('UUID')).toBe('UUID');
  });

  it('maps UUID to TEXT on the JSON adapter to preserve JS round-tripping', () => {
    expect(getDDLStrategy('json').mapType('UUID')).toBe('TEXT');
  });

  it('maps UUID to TEXT on SQLite (no native uuid type)', () => {
    expect(getDDLStrategy('sqlite').mapType('UUID')).toBe('TEXT');
  });
});

describe('R11 differ tolerance: UUID <-> TEXT are equivalent for structural ids', () => {
  let db: DatabaseProvider;
  let comparer: SchemaComparer;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    comparer = new SchemaComparer(db);
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        // ignore
      }
    }
  });

  const manifestWithIdType = (idType: 'TEXT' | 'UUID') =>
    ({
      things: {
        tableName: 'things',
        ddl: '',
        columns: {
          id: { type: idType, primaryKey: true },
          name: { type: 'TEXT' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    }) satisfies Record<string, SchemaDefinition>;

  it('does NOT flag a primary-key change when the DB has `text` and the manifest says UUID', async () => {
    // Existing deployment: text id column. Manifest now declares UUID.
    // (On SQLite the manifest UUID maps to TEXT via the dialect strategy, so
    // the suppression here is via that mapping; the Postgres side — where
    // UUID maps to native `uuid` and the equality-gate equivalence is the
    // load-bearing reason — is covered by the `mapType('UUID') === 'uuid'`
    // test above plus the db-uuid direction below.)
    await db.query('CREATE TABLE things (id TEXT PRIMARY KEY, name TEXT)', []);

    const diff = await comparer.compare(manifestWithIdType('UUID'));

    const idTypeChange = diff.changes.find(
      (c) =>
        c.table === 'things' &&
        c.name === 'id' &&
        (c.type === 'type_mismatch' || c.type === 'type_upgrade'),
    );
    expect(idTypeChange).toBeUndefined();
  });

  it('does NOT collapse uuid into text for OTHER type comparisons (no bogus upgrade)', async () => {
    // Regression guard: the text<->uuid tolerance must live ONLY at the
    // equality gate, NOT inside normalizeType. If `uuid` were folded into the
    // TEXT bucket globally, a db `uuid` column compared against a manifest
    // TIMESTAMP would be mis-read as a compatible "TEXT->TIMESTAMP" upgrade
    // and emit a failing ALTER. It must instead be flagged as a real change.
    await db.query(
      'CREATE TABLE things (id UUID PRIMARY KEY, when_at UUID)',
      [],
    );

    const diff = await comparer.compare({
      things: {
        tableName: 'things',
        ddl: '',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          when_at: { type: 'TIMESTAMP' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    // id (uuid<->uuid) is tolerated; when_at (uuid-in-db vs TIMESTAMP-in-
    // manifest) must surface as a change rather than being silently absorbed.
    const idChange = diff.changes.find(
      (c) => c.name === 'id' && c.type.startsWith('type_'),
    );
    const whenChange = diff.changes.find(
      (c) => c.name === 'when_at' && c.type.startsWith('type_'),
    );
    expect(idChange).toBeUndefined();
    expect(whenChange).toBeDefined();
  });

  it('does NOT flag a primary-key change when the DB has `uuid` and the manifest says TEXT', async () => {
    // Project hand-migrated to native uuid. Manifest still says TEXT. The
    // differ must not try to convert it back. (SQLite accepts arbitrary
    // declared type names, so we can store a column typed `UUID`.)
    await db.query('CREATE TABLE things (id UUID PRIMARY KEY, name TEXT)', []);

    const diff = await comparer.compare(manifestWithIdType('TEXT'));

    const idTypeChange = diff.changes.find(
      (c) =>
        c.table === 'things' &&
        c.name === 'id' &&
        (c.type === 'type_mismatch' || c.type === 'type_upgrade'),
    );
    expect(idTypeChange).toBeUndefined();
  });

  it('does NOT flag a reference change when the DB has `uuid` and the manifest says TEXT', async () => {
    await db.query(
      'CREATE TABLE things (id UUID PRIMARY KEY, owner_id UUID, external_id UUID)',
      [],
    );

    const diff = await comparer.compare({
      things: {
        tableName: 'things',
        ddl: '',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          owner_id: {
            type: 'TEXT',
            foreignKey: { table: 'owners', column: 'id' },
          },
          external_id: { type: 'TEXT', referenceKind: 'crossPackageRef' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const structuralChanges = diff.changes.filter(
      (c) =>
        ['id', 'owner_id', 'external_id'].includes(c.name ?? '') &&
        (c.type === 'type_mismatch' || c.type === 'type_upgrade'),
    );
    expect(structuralChanges).toEqual([]);
  });

  it('repairs plain TEXT manifest columns that drifted to uuid in the DB', async () => {
    const postgresDb = {
      url: 'postgresql://localhost/smrt_test',
      query: async () => ({ rows: [{ table_name: 'assets' }] }),
      getTableSchema: async () => ({
        tableName: 'assets',
        columns: {
          id: { name: 'id', type: 'uuid', primaryKey: true },
          external_id: { name: 'external_id', type: 'uuid' },
        },
        indexes: [],
      }),
    } as unknown as DatabaseProvider;
    const postgresComparer = new SchemaComparer(postgresDb);

    const diff = await postgresComparer.compare({
      assets: {
        tableName: 'assets',
        ddl: '',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          external_id: { type: 'TEXT' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const externalIdChange = diff.changes.find(
      (c) => c.table === 'assets' && c.name === 'external_id',
    );
    expect(externalIdChange).toEqual(
      expect.objectContaining({
        type: 'type_upgrade',
        mismatch: { expected: 'TEXT', actual: 'uuid' },
        sql: 'ALTER TABLE "assets" ALTER COLUMN "external_id" TYPE TEXT USING "external_id"::text',
      }),
    );

    const idTypeChange = diff.changes.find(
      (c) =>
        c.table === 'assets' &&
        c.name === 'id' &&
        (c.type === 'type_mismatch' || c.type === 'type_upgrade'),
    );
    expect(idTypeChange).toBeUndefined();
  });

  it('does flag plain UUID manifest columns that are still text in the DB', async () => {
    const postgresDb = {
      url: 'postgresql://localhost/smrt_test',
      query: async () => ({ rows: [{ table_name: 'assets' }] }),
      getTableSchema: async () => ({
        tableName: 'assets',
        columns: {
          id: { name: 'id', type: 'text', primaryKey: true },
          import_uuid: { name: 'import_uuid', type: 'text' },
        },
        indexes: [],
      }),
    } as unknown as DatabaseProvider;
    const postgresComparer = new SchemaComparer(postgresDb);

    const diff = await postgresComparer.compare({
      assets: {
        tableName: 'assets',
        ddl: '',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          import_uuid: { type: 'UUID' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const importUuidChange = diff.changes.find(
      (c) => c.table === 'assets' && c.name === 'import_uuid',
    );
    expect(importUuidChange).toEqual(
      expect.objectContaining({
        type: 'type_mismatch',
        mismatch: { expected: 'UUID', actual: 'text' },
      }),
    );

    const idTypeChange = diff.changes.find(
      (c) =>
        c.table === 'assets' &&
        c.name === 'id' &&
        (c.type === 'type_mismatch' || c.type === 'type_upgrade'),
    );
    expect(idTypeChange).toBeUndefined();
  });

  it('renders new UUID columns as TEXT for JSON adapter migrations', async () => {
    const jsonDb = {
      url: 'test.json',
      exportTable: () => undefined,
      query: async () => ({ rows: [{ name: 'things' }] }),
      getTableSchema: async () => ({
        tableName: 'things',
        columns: {
          id: { name: 'id', type: 'TEXT', primaryKey: true },
        },
        indexes: [],
      }),
    } as unknown as DatabaseProvider;
    const jsonComparer = new SchemaComparer(jsonDb);

    const diff = await jsonComparer.compare({
      things: {
        tableName: 'things',
        ddl: '',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          related_id: { type: 'UUID' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const addRelatedId = diff.changes.find(
      (change) => change.type === 'add_column' && change.name === 'related_id',
    );
    expect(addRelatedId?.sql).toContain(
      'ALTER TABLE "things" ADD COLUMN "related_id" TEXT',
    );
  });
});
