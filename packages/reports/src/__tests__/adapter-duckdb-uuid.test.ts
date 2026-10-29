/**
 * DuckDB materialized row reads (#4459). DuckDB stores ids as native UUIDs and
 * its JavaScript binding surfaces them as lossy `{ hugeint }` wrappers, so the
 * adapter must read ids as canonical lowercase UUID strings.
 */
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryReportMaterializedRows } from '../adapter.js';

class DuckUuidReport extends SmrtObject {}

const TABLE = 'duck_uuid_reports';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function registerFixture(): void {
  ObjectRegistry.registerFromManifest(
    'DuckUuidSource',
    {
      className: 'DuckUuidSource',
      fields: {},
      methods: {},
      decoratorConfig: { tableName: 'duck_uuid_sources' },
      schema: {
        tableName: 'duck_uuid_sources',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@test/reports',
  );
  ObjectRegistry.registerFromManifest(
    'DuckUuidReport',
    {
      className: 'DuckUuidReport',
      fields: {
        employee: {
          type: 'text',
          _meta: { __report: { kind: 'group', sourceColumn: 'employee' } },
        },
      },
      methods: {},
      decoratorConfig: {
        tableName: TABLE,
        report: { source: 'DuckUuidSource', refresh: { manual: true } },
      },
      schema: {
        tableName: TABLE,
        ddl: '',
        columns: {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          slug: { type: 'TEXT' },
          employee: { type: 'TEXT', notNull: true },
        },
        indexes: [],
        version: 'test',
      },
    } as never,
    '@test/reports',
  );
}

describe('materialized report rows on DuckDB (#4459)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  const ids: string[] = [];

  beforeAll(async () => {
    ObjectRegistry.clear();
    registerFixture();
    db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['DuckUuidReport'],
    });
    for (const employee of ['Ada', 'Bo']) {
      const id = crypto.randomUUID();
      ids.push(id);
      await db.insert(TABLE, { id, slug: id, employee });
    }
  });

  afterAll(async () => {
    await db?.close?.();
    ObjectRegistry.clear();
  });

  it('returns canonical lowercase UUID strings for an unfiltered rows read', async () => {
    const result = await queryReportMaterializedRows(
      DuckUuidReport,
      {
        version: 1,
        requestId: 'duck-uuid',
        mode: 'rows',
        projection: ['id', 'employee'],
        sort: [{ field: 'employee', direction: 'asc' }],
        page: { kind: 'offset', offset: 0, limit: 10 },
      },
      { db },
    );
    expect(result.rows.map((row) => row.id)).toEqual(ids);
    for (const row of result.rows) expect(String(row.id)).toMatch(UUID_RE);
  });
});
